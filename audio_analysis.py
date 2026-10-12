"""Local DSP analysis of an uploaded track.

This runs entirely on-device (via librosa) so tempo, energy, rhythm, key,
pitch, stereo position, structure, and timbre are measured directly from the
audio signal rather than estimated by a language model. GPT is still used
separately for the one thing DSP can't determine: the qualitative "what does
this actually sound like" layer (mood, instrumentation, color intent).

A few features are approximated with a fast, robust proxy rather than a
"true" (but slow/noisy) measurement -- each is called out below.
"""

import hashlib
import io
import math

import librosa
import numpy as np
import soundfile as sf
import soxr

SAMPLE_RATE = 22050
# Memory grows with track length, so very long tracks are measured from
# their first 6 minutes (the reported duration is still the full length).
MAX_ANALYSIS_SEC = 6 * 60
ENERGY_SEGMENTS = 48  # slices around the "energy fingerprint" ring
HOP_LENGTH = 512
MIN_NOTE_EVENTS = 24
MAX_NOTE_EVENTS = 220

# Krumhansl-Kessler key profiles, used to correlate against a track's chroma
# vector and estimate its most likely musical key.
_MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
_MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)

_PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Position of each pitch class around the circle of fifths (C=0, G=1, D=2, ...)
# so that harmonically related keys/colors land near each other on the wheel.
_FIFTHS_POSITION = [(i * 7) % 12 for i in range(12)]

_SECTION_SIMILARITY_THRESHOLD = 0.82

# The heaviest steps (constant-Q chroma, harmonic/percussive separation) run
# over the track in pieces of this many frames (~48 s) so memory stays flat
# however long the song is.
CHUNK_FRAMES = 2048
# Constant-Q chroma and HPSS are the heaviest per frame, so they use smaller
# pieces (~24 s and ~12 s).
CQT_CHUNK_FRAMES = 1024
HPSS_CHUNK_FRAMES = 512


def _clamp01(value):
    return float(max(0.0, min(1.0, value)))


def _estimate_key(chroma_mean):
    best_score = -np.inf
    best_root = 0
    best_mode = "major"

    for root in range(12):
        major_rot = np.roll(_MAJOR_PROFILE, root)
        minor_rot = np.roll(_MINOR_PROFILE, root)

        major_score = np.corrcoef(chroma_mean, major_rot)[0, 1]
        minor_score = np.corrcoef(chroma_mean, minor_rot)[0, 1]

        if major_score > best_score:
            best_score = major_score
            best_root = root
            best_mode = "major"
        if minor_score > best_score:
            best_score = minor_score
            best_root = root
            best_mode = "minor"

    return best_root, best_mode


def _seed_from_vector(vec):
    """A deterministic seed derived from a track's timbre (MFCC) fingerprint,
    so two songs with similar tempo/energy/key still get different fine-grained
    randomness (shape wobble, grain placement) instead of looking near-identical."""
    rounded = np.round(np.asarray(vec, dtype=float), 3)
    digest = hashlib.sha256(rounded.tobytes()).hexdigest()
    return int(digest[:8], 16)


def _segment_structure(chroma, mfcc, rms, centroid, n_frames, duration_sec):
    """Coarse structural segmentation via self-similarity: windows of the
    track get grouped into 'types' by timbral/harmonic similarity (pure
    cosine-similarity clustering, no ML section-naming). Two windows that
    get the same type number sound alike -- e.g. repeated choruses will
    naturally land on the same type -- but we don't claim to know which
    type IS the chorus, only that they recur."""
    if duration_sec <= 0 or n_frames < 4:
        return [{"start": 0.0, "end": 1.0, "type": 0, "energy": 0.5, "brightness": 0.5}]

    n_windows = int(max(3, min(12, round(duration_sec / 6.0))))
    bounds = np.linspace(0, n_frames, n_windows + 1, dtype=int)

    window_feats = []
    window_stats = []
    for i in range(n_windows):
        a, b = int(bounds[i]), int(bounds[i + 1])
        if b <= a:
            b = min(a + 1, n_frames)
        chroma_slice = chroma[:, a:b].mean(axis=1)
        chroma_slice = chroma_slice / (np.linalg.norm(chroma_slice) or 1.0)
        mfcc_slice = mfcc[:, a:b].mean(axis=1)
        mfcc_slice = mfcc_slice / (np.linalg.norm(mfcc_slice) or 1.0)
        window_feats.append(np.concatenate([chroma_slice, mfcc_slice]))

        e_mean = _clamp01(float(rms[a:b].mean()) / (float(rms.max()) or 1.0))
        b_mean = _clamp01(float(centroid[a:b].mean()) / 4000.0)
        window_stats.append((e_mean, b_mean, a / n_frames, b / n_frames))

    type_reps = []
    labels = []
    for feat in window_feats:
        best_idx, best_sim = -1, -1.0
        for i, rep in enumerate(type_reps):
            sim = float(np.dot(feat, rep))
            if sim > best_sim:
                best_sim, best_idx = sim, i
        if best_idx >= 0 and best_sim >= _SECTION_SIMILARITY_THRESHOLD:
            labels.append(best_idx)
        else:
            type_reps.append(feat)
            labels.append(len(type_reps) - 1)

    sections = []
    for (e_mean, b_mean, start_frac, end_frac), label in zip(window_stats, labels):
        sections.append({
            "start": round(_clamp01(start_frac), 3),
            "end": round(_clamp01(end_frac), 3),
            "type": int(label),
            "energy": round(e_mean, 3),
            "brightness": round(b_mean, 3),
        })
    return sections


def _load_audio(file_bytes):
    """Same result as librosa.load(sr=SAMPLE_RATE, mono=False,
    duration=MAX_ANALYSIS_SEC), but decodes and resamples in 10-second
    blocks so the full-rate decode never sits in memory at once. Returns
    (y, sr, full_duration_sec)."""
    try:
        f = sf.SoundFile(io.BytesIO(file_bytes))
    except sf.LibsndfileError:
        full_duration = librosa.get_duration(path=io.BytesIO(file_bytes))
        y, sr = librosa.load(io.BytesIO(file_bytes), sr=SAMPLE_RATE, mono=False, duration=MAX_ANALYSIS_SEC)
        return y, sr, full_duration

    with f:
        native_sr, channels = f.samplerate, f.channels
        full_duration = f.frames / native_sr if f.frames > 0 else 0.0
        frames = min(f.frames, MAX_ANALYSIS_SEC * native_sr) if f.frames > 0 else 0
        stream = None
        if native_sr != SAMPLE_RATE:
            stream = soxr.ResampleStream(native_sr, SAMPLE_RATE, channels, dtype="float32", quality="HQ")
        parts = []
        for block in f.blocks(blocksize=native_sr * 10, dtype="float32", always_2d=True, frames=frames or -1):
            parts.append(stream.resample_chunk(block) if stream else block)
        if stream:
            parts.append(stream.resample_chunk(np.zeros((0, channels), dtype=np.float32), last=True))

    y = np.empty((channels, sum(len(p) for p in parts)), dtype=np.float32)
    pos = 0
    while parts:
        part = parts.pop(0)
        y[:, pos:pos + len(part)] = part.T
        pos += len(part)
    if stream and frames > 0:
        y = librosa.util.fix_length(y, size=math.ceil(frames * SAMPLE_RATE / native_sr))
    return (y[0] if channels == 1 else y), SAMPLE_RATE, full_duration or y.shape[-1] / SAMPLE_RATE


def _magnitude_spectrogram(y, hop_length, n_fft=2048):
    """np.abs(librosa.stft(y)) built piecewise: the full complex STFT is
    twice the size of the magnitudes we keep. Padding once up front and
    running each piece uncentered yields exactly the same frames."""
    padded = np.pad(y, n_fft // 2, mode="constant")
    n_frames = 1 + (len(padded) - n_fft) // hop_length
    spec = np.empty((1 + n_fft // 2, n_frames), dtype=np.float32)
    for start in range(0, n_frames, CHUNK_FRAMES):
        stop = min(start + CHUNK_FRAMES, n_frames)
        piece = padded[start * hop_length:(stop - 1) * hop_length + n_fft]
        spec[:, start:stop] = np.abs(librosa.stft(piece, n_fft=n_fft, hop_length=hop_length, center=False))
    return spec


def _estimate_tempo(onset_env, sr, hop_length):
    """The tempo beat_track would estimate on its own, with the tempogram
    averaged piecewise rather than built for the whole song at once (that
    full tempogram was the biggest single allocation in the analysis)."""
    win_length = librosa.time_to_frames(8.0, sr=sr, hop_length=hop_length).item()
    n = len(onset_env)
    # Same padding tempogram(center=True) applies; each uncentered piece
    # then produces exactly the same frames.
    padded = np.pad(onset_env, win_length // 2, mode="linear_ramp", end_values=[0, 0])
    total = np.zeros(win_length)
    for start in range(0, n, CHUNK_FRAMES):
        stop = min(start + CHUNK_FRAMES, n)
        tg = librosa.feature.tempogram(
            onset_envelope=padded[start:stop + win_length - 1], sr=sr, hop_length=hop_length,
            win_length=win_length, center=False,
        )
        total += tg.sum(axis=1)
    return librosa.feature.tempo(tg=(total / n)[:, None], sr=sr, hop_length=hop_length, aggregate=None)


def _per_frame(feature, spec, **kwargs):
    """Runs a per-frame spectral feature (centroid, flatness) piecewise --
    each frame only depends on itself, so the result is identical, without
    the feature's full-song temporary arrays."""
    return np.concatenate(
        [feature(S=spec[:, start:start + CHUNK_FRAMES], **kwargs)[0] for start in range(0, spec.shape[1], CHUNK_FRAMES)]
    )


def _rms(y, hop_length, frame_length=2048):
    """librosa.feature.rms(y=y) computed over frames piecewise; the
    one-shot version squares every overlapping frame at once."""
    padded = np.pad(y, frame_length // 2, mode="constant")
    frames = librosa.util.frame(padded, frame_length=frame_length, hop_length=hop_length)  # a view, no copy
    rms = np.empty(frames.shape[1], dtype=np.float32)
    for start in range(0, frames.shape[1], CHUNK_FRAMES):
        piece = frames[:, start:start + CHUNK_FRAMES]
        rms[start:start + CHUNK_FRAMES] = np.sqrt(np.mean(np.square(piece), axis=0))
    return rms


def _chroma_cqt_chunked(y, sr, hop_length):
    """chroma_cqt over the whole track, computed piecewise. Pieces are
    hop-aligned so their frames line up exactly with the other features'
    frames; a short tail is folded into the last piece rather than analyzed
    on its own."""
    step = CQT_CHUNK_FRAMES * hop_length
    parts = []
    start = 0
    while start < len(y):
        end = start + step
        if len(y) - end < step // 2:
            end = len(y)
        chroma = librosa.feature.chroma_cqt(y=y[start:end], sr=sr, hop_length=hop_length)
        # Each centered piece has one extra trailing frame that belongs to
        # the next piece.
        parts.append(chroma if end == len(y) else chroma[:, : (end - start) // hop_length])
        start = end
    return np.concatenate(parts, axis=1)


def _harmonic_percussive_energy(spec):
    """Total harmonic and percussive energy, from HPSS on the magnitude
    spectrogram piece by piece (its median filters span only ~31 frames, so
    piece boundaries barely matter)."""
    harmonic = percussive = 0.0
    for start in range(0, spec.shape[1], HPSS_CHUNK_FRAMES):
        h, p = librosa.decompose.hpss(spec[:, start:start + HPSS_CHUNK_FRAMES])
        harmonic += float(np.sum(h ** 2))
        percussive += float(np.sum(p ** 2))
    return np.sqrt(harmonic), np.sqrt(percussive)


def analyze_audio(file_bytes, audio_format):
    """Return a dict of DSP-measured features for the given audio bytes."""
    y_raw, sr, full_duration = _load_audio(file_bytes)

    if y_raw.ndim == 1:
        y = y_raw
        is_stereo = False
        y_left = y_right = y
    else:
        y = librosa.to_mono(y_raw)
        is_stereo = True
        y_left, y_right = y_raw[0], y_raw[1]

    duration_sec = float(len(y) / sr) if sr else 0.0
    if len(y) < sr * 0.5:
        raise ValueError("Audio is too short to analyze (need at least half a second).")

    hop_length = HOP_LENGTH

    # One magnitude spectrogram (and its log-mel form) shared by the spectral
    # features below. Letting each feature recompute it from the audio peaked
    # around 750 MB on a 4-minute song, more than a small server has.
    spec = _magnitude_spectrogram(y, hop_length)
    mel_db = librosa.power_to_db(librosa.feature.melspectrogram(S=spec ** 2, sr=sr))

    # --- Rhythm density (onsets per second, normalized) + onset strengths for "Beat" ---
    onset_env = librosa.onset.onset_strength(S=mel_db, sr=sr, hop_length=hop_length)
    onset_frames = librosa.onset.onset_detect(sr=sr, hop_length=hop_length, onset_envelope=onset_env)
    onsets_per_sec = len(onset_frames) / duration_sec if duration_sec > 0 else 0.0
    rhythm_density = _clamp01(onsets_per_sec / 8.0)

    # --- Tempo + beat regularity ("Rhythm" regularity) ---
    # The beat tracker's own onset curve aggregates mel bands by median.
    beat_env = librosa.onset.onset_strength(S=mel_db, sr=sr, hop_length=hop_length, aggregate=np.median)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=beat_env, sr=sr, hop_length=hop_length, bpm=_estimate_tempo(beat_env, sr, hop_length)
    )
    tempo_bpm = float(np.atleast_1d(tempo)[0]) if np.size(tempo) else 0.0

    if len(beat_frames) >= 3:
        beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)
        intervals = np.diff(beat_times)
        cv = float(np.std(intervals) / (np.mean(intervals) or 1.0))
        tempo_stability = _clamp01(1.0 - cv * 2.0)
    else:
        tempo_stability = 0.5

    # --- Energy fingerprint (RMS, binned into fixed-size segments) ---
    rms = _rms(y, hop_length)
    if len(rms) >= ENERGY_SEGMENTS:
        bin_edges = np.linspace(0, len(rms), ENERGY_SEGMENTS + 1, dtype=int)
        energy_timeline = [
            float(rms[bin_edges[i]:bin_edges[i + 1]].mean()) if bin_edges[i + 1] > bin_edges[i] else 0.0
            for i in range(ENERGY_SEGMENTS)
        ]
    else:
        energy_timeline = [float(v) for v in rms] + [0.0] * (ENERGY_SEGMENTS - len(rms))

    max_energy = max(energy_timeline) or 1.0
    energy_timeline = [_clamp01(v / max_energy) for v in energy_timeline]
    overall_energy = _clamp01(float(np.mean(rms)) / (float(np.max(rms)) or 1.0))  # "Volume/Loudness"
    dynamic_range = _clamp01(float(np.std(energy_timeline)) * 3.0)  # "Dynamics" spread

    # --- Brightness (spectral centroid) -- also doubles as a pitch-height proxy ---
    centroid = _per_frame(librosa.feature.spectral_centroid, spec, sr=sr)
    brightness = _clamp01(float(np.mean(centroid)) / 4000.0)

    # --- Timbre sharpness (spectral flatness: noise-like/harsh vs. tonal/smooth) ---
    flatness = _per_frame(librosa.feature.spectral_flatness, spec)
    timbre_sharpness = _clamp01(float(np.mean(flatness)) * 6.0)

    # --- Key, mode, and full harmonic fingerprint ---
    chroma = _chroma_cqt_chunked(y, sr, hop_length)
    chroma_mean = chroma.mean(axis=1)
    root, mode = _estimate_key(chroma_mean)
    key_name = f"{_PITCH_CLASSES[root]} {mode.capitalize()}"
    hue = (_FIFTHS_POSITION[root] / 12.0) * 360.0
    chroma_max = float(chroma_mean.max()) or 1.0
    chroma_vector = [_clamp01(float(v) / chroma_max) for v in chroma_mean]

    # --- Harmonic tension: how concentrated (stable) vs. spread out (tense)
    # the track's pitch-class energy is, via normalized entropy. ---
    probs = chroma_mean / (chroma_mean.sum() or 1.0)
    probs = np.clip(probs, 1e-9, None)
    entropy = float(-np.sum(probs * np.log(probs)) / np.log(12))
    harmonic_tension = _clamp01(entropy)

    # --- Harmonic vs. percussive balance (source separation) ---
    harmonic_energy, percussive_energy = _harmonic_percussive_energy(spec)
    del spec  # the largest array here; nothing below needs it
    harmonic_ratio = _clamp01(harmonic_energy / ((harmonic_energy + percussive_energy) or 1.0))

    # --- Noisiness (zero-crossing rate) -> background grain density ---
    zcr = librosa.feature.zero_crossing_rate(y, hop_length=hop_length)[0]
    noisiness = _clamp01(float(np.mean(zcr)) / 0.3)

    # --- Timbre fingerprint -> deterministic per-track random seed ---
    mfcc = librosa.feature.mfcc(S=mel_db, n_mfcc=13)
    mfcc_mean = mfcc.mean(axis=1)
    track_seed = _seed_from_vector(mfcc_mean)

    # --- Structure: coarse self-similarity segmentation ("Section") ---
    n_frames = min(len(rms), chroma.shape[1], mfcc.shape[1], len(centroid))
    sections = _segment_structure(
        chroma[:, :n_frames], mfcc[:, :n_frames], rms[:n_frames], centroid[:n_frames], n_frames, duration_sec
    )

    # --- Note events: one per detected onset -- "Pitch" (Y), "Stereo Position"
    # (X), and "Beat" strength (size) combined into a single scattered layer.
    # Pitch here is approximated by spectral centroid at that instant, not a
    # true fundamental-frequency track (pYIN is far slower and noisier on
    # polyphonic/percussive material). ---
    max_events = int(max(MIN_NOTE_EVENTS, min(MAX_NOTE_EVENTS, round(tempo_bpm * 1.2))))
    if len(onset_frames) > max_events:
        sample_idx = np.linspace(0, len(onset_frames) - 1, max_events).astype(int)
        chosen_frames = onset_frames[sample_idx]
    else:
        chosen_frames = onset_frames

    c_min, c_max = float(centroid.min()), float(centroid.max())
    c_range = (c_max - c_min) or 1.0
    onset_env_max = float(onset_env.max()) or 1.0
    pan_window = int(sr * 0.05)

    note_events = []
    for frame_idx in chosen_frames:
        frame_idx = int(frame_idx)
        t_sec = frame_idx * hop_length / sr
        t_norm = _clamp01(t_sec / duration_sec) if duration_sec else 0.0

        c_idx = min(frame_idx, len(centroid) - 1)
        pitch_norm = _clamp01((centroid[c_idx] - c_min) / c_range)

        e_idx = min(frame_idx, len(onset_env) - 1)
        strength = _clamp01(onset_env[e_idx] / onset_env_max)

        if is_stereo:
            samp = frame_idx * hop_length
            lo = max(0, samp - pan_window // 2)
            hi = min(len(y_left), samp + pan_window // 2)
            l_rms = float(np.sqrt(np.mean(y_left[lo:hi] ** 2))) if hi > lo else 0.0
            r_rms = float(np.sqrt(np.mean(y_right[lo:hi] ** 2))) if hi > lo else 0.0
            pan = (r_rms - l_rms) / ((r_rms + l_rms) or 1e-6)
            pan = max(-1.0, min(1.0, pan))
        else:
            pan = 0.0

        note_events.append({
            "t": round(t_norm, 3),
            "pitch": round(pitch_norm, 3),
            "pan": round(pan, 3),
            "strength": round(strength, 3),
        })

    return {
        "tempo_bpm": round(tempo_bpm, 1),
        "tempo_stability": round(tempo_stability, 3),
        "duration_sec": round(max(full_duration, duration_sec), 1),
        "energy": round(overall_energy, 3),
        "energy_timeline": [round(v, 3) for v in energy_timeline],
        "dynamic_range": round(dynamic_range, 3),
        "rhythm_density": round(rhythm_density, 3),
        "brightness": round(brightness, 3),
        "timbre_sharpness": round(timbre_sharpness, 3),
        "key": key_name,
        "mode": mode,
        "key_hue": round(hue, 1),
        "chroma_vector": [round(v, 3) for v in chroma_vector],
        "harmonic_tension": round(harmonic_tension, 3),
        "harmonic_ratio": round(harmonic_ratio, 3),
        "noisiness": round(noisiness, 3),
        "track_seed": track_seed,
        "is_stereo": is_stereo,
        "sections": sections,
        "note_events": note_events,
    }
