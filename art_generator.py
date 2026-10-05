"""Procedural SVG generation from combined DSP + GPT music analysis.

Design: each analyzed feature drives a genuinely different part of the visual
grammar, rather than just recoloring one shape. Composition, from back to
front:

  1. Background glow      <- key (hue, circle of fifths) + brightness/mode/mood
  2. Background grain      <- noisiness (zero-crossing rate)
  3. Note constellation    <- note_events: pitch -> Y, stereo pan -> X,
                              beat strength -> dot size
  4. Section timeline (top) <- sections: self-similarity segments, drawn
                              left-to-right in track order; same "type" gets
                              the same hue stamp (repeats look alike)
  5. Energy waveform (bottom) <- energy_timeline (one bar per time-slice,
                              left-to-right), tempo_stability (bar jitter),
                              dynamic_range (contrast between quiet/loud bars)
  6. Harmonic bloom        <- chroma_vector (real per-pitch-class energy)
                              scattered outward by seeded angle/distance
                              (not a fixed ring), harmonic_tension (web of
                              connecting lines when tense)
  7. Instrument mandala    <- one layer per dominant_instrument (GPT), each
                              with its own shape vocabulary; tempo sets spoke
                              count, rhythm_density + harmonic_ratio +
                              timbre_sharpness set jaggedness, loudness sets
                              scale
  8. Core                  <- overall energy/loudness

track_seed (from the track's MFCC timbre fingerprint) seeds every random
choice, so two songs with similar high-level stats still don't render
identically.
"""

import colorsys
import math
import random

DEFAULT_PALETTE = ["#a78bfa", "#67e8f9", "#f472b6", "#e8e8f0"]

_INSTRUMENT_KEYWORDS = [
    (("drum", "percussion", "beat", "kick", "snare", "cymbal"), "percussion"),
    (("bass",), "bass"),
    (("flute", "piccolo", "clarinet"), "flute"),
    (("guitar",), "guitar"),
    (("piano", "keys", "keyboard", "organ"), "keys"),
    (("synth", "electronic", "pad", "sequencer"), "synth"),
    (("string", "violin", "cello", "viola", "orchestra"), "strings"),
    (("vocal", "voice", "singer", "choir", "vox"), "vocal"),
]

_MOOD_BRIGHT = {"energetic", "happy", "joyful", "upbeat", "triumphant", "excited", "euphoric", "playful", "bright"}
_MOOD_DARK = {"sad", "melancholic", "tense", "dark", "anxious", "somber", "gloomy", "moody", "mournful", "eerie"}


def _clamp01(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, value))


def _classify_instrument(name):
    name_l = (name or "").lower()
    for keywords, category in _INSTRUMENT_KEYWORDS:
        if any(k in name_l for k in keywords):
            return category
    return "default"


def _boost_saturation(hex_color, amount):
    """Loudness -> stronger color contrast: nudges a hex color's HSL
    saturation up (loud) or down (quiet)."""
    try:
        hex_color = hex_color.lstrip("#")
        r, g, b = (int(hex_color[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    except (ValueError, IndexError):
        return f"#{hex_color}" if not hex_color.startswith("#") else hex_color
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    s = max(0.0, min(1.0, s + amount))
    r2, g2, b2 = colorsys.hls_to_rgb(h, l, s)
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in (r2, g2, b2))


def _spoke_count(tempo):
    return max(6, min(48, round(tempo / 4)))


def _spiky_layer(cx, cy, radius, color, opacity, rhythm_density, tempo, energy, edge_sharpness, seed):
    """Drums/percussion: sharp, irregular star polygon."""
    spokes = _spoke_count(tempo)
    jag = (0.2 + rhythm_density * 0.7) * (0.65 + edge_sharpness * 0.9)
    rng = random.Random(seed)
    points = []
    for i in range(spokes):
        angle = (2 * math.pi / spokes) * i
        r = radius * (1 + rng.uniform(-jag, jag))
        points.append(f"{cx + math.cos(angle) * r:.1f},{cy + math.sin(angle) * r:.1f}")
    return (
        f'<polygon points="{" ".join(points)}" fill="{color}" fill-opacity="{opacity:.2f}" '
        f'stroke="{color}" stroke-width="2" stroke-linejoin="miter" />'
    )


def _ribbon_layer(cx, cy, radius, color, opacity, rhythm_density, tempo, energy, edge_sharpness, seed):
    """Guitar/strings: a smooth flowing wavy ribbon. Calmer waves when the
    edges are soft (harmonic/tonal); tighter and more agitated when sharp."""
    rng = random.Random(seed)
    points_n = 72
    wave_count = 3 + round(rhythm_density * 4 * (0.7 + edge_sharpness * 0.8))
    phase = rng.uniform(0, 2 * math.pi)
    amp = radius * (0.08 + energy * 0.14) * rng.uniform(0.85, 1.15)
    pts = []
    for i in range(points_n + 1):
        angle = (2 * math.pi / points_n) * i
        r = radius + amp * math.sin(angle * wave_count + phase)
        pts.append(f"{cx + math.cos(angle) * r:.1f},{cy + math.sin(angle) * r:.1f}")
    path = " L ".join(pts)
    stroke_width = 3 + energy * 4
    return (
        f'<path d="M {path} Z" fill="none" stroke="{color}" '
        f'stroke-width="{stroke_width:.1f}" stroke-opacity="{opacity:.2f}" stroke-linejoin="round" />'
    )


def _bass_layer(cx, cy, radius, color, opacity, rhythm_density, tempo, energy, edge_sharpness, seed):
    """Bass: one large, heavy, low-detail disc -- grounding rather than busy.
    Still simple/low-detail per track, but its offset and companion lobe are
    seeded so it doesn't render as an identical centered circle every time."""
    rng = random.Random(seed)
    r = radius * (1.25 + energy * 0.3)
    stroke_width = 6 + energy * 10
    off_angle = rng.uniform(0, 2 * math.pi)
    off_dist = r * rng.uniform(0.0, 0.18)
    ox = cx + math.cos(off_angle) * off_dist
    oy = cy + math.sin(off_angle) * off_dist
    parts = [
        f'<circle cx="{ox:.1f}" cy="{oy:.1f}" r="{r:.1f}" fill="{color}" fill-opacity="{opacity * 0.6:.2f}" '
        f'stroke="{color}" stroke-width="{stroke_width:.1f}" stroke-opacity="{opacity:.2f}" />'
    ]
    if rng.random() > 0.4:
        lobe_angle = off_angle + math.pi + rng.uniform(-0.6, 0.6)
        lobe_r = r * rng.uniform(0.3, 0.5)
        lx = cx + math.cos(lobe_angle) * r * rng.uniform(0.5, 0.85)
        ly = cy + math.sin(lobe_angle) * r * rng.uniform(0.5, 0.85)
        parts.append(
            f'<circle cx="{lx:.1f}" cy="{ly:.1f}" r="{lobe_r:.1f}" fill="{color}" '
            f'fill-opacity="{opacity * 0.35:.2f}" />'
        )
    return "".join(parts)


def _flute_layer(cx, cy, radius, color, opacity, rhythm_density, tempo, energy, edge_sharpness, seed):
    """Flute/woodwinds: thin, bright radiating lines."""
    rng = random.Random(seed)
    spokes = max(8, min(28, round(tempo / 6)))
    parts = []
    for i in range(spokes):
        angle = (2 * math.pi / spokes) * i + rng.uniform(-0.05, 0.05)
        length = radius * rng.uniform(0.7, 1.15)
        x1 = cx + math.cos(angle) * radius * 0.35
        y1 = cy + math.sin(angle) * radius * 0.35
        x2 = cx + math.cos(angle) * (radius * 0.35 + length)
        y2 = cy + math.sin(angle) * (radius * 0.35 + length)
        parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{color}" stroke-width="1.2" stroke-opacity="{opacity:.2f}" stroke-linecap="round" />'
        )
    return "".join(parts)


def _blob_layer(cx, cy, radius, color, opacity, rhythm_density, tempo, energy, edge_sharpness, seed):
    """Vocals: soft overlapping blurred blobs, organic and warm."""
    rng = random.Random(seed)
    n_blobs = 4 + round(energy * 4)
    parts = []
    for _ in range(n_blobs):
        angle = rng.uniform(0, 2 * math.pi)
        dist = radius * rng.uniform(0.25, 0.95)
        x = cx + math.cos(angle) * dist
        y = cy + math.sin(angle) * dist
        r = radius * rng.uniform(0.15, 0.32)
        parts.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{color}" '
            f'fill-opacity="{opacity:.2f}" filter="url(#softBlur)" />'
        )
    return "".join(parts)


def _grid_layer(cx, cy, radius, color, opacity, rhythm_density, tempo, energy, edge_sharpness, seed):
    """Synth/keys: a crisp geometric polygon, mechanical and precise. Side
    count and rotation are seeded so the shape's silhouette varies per track,
    not just its size."""
    rng = random.Random(seed)
    sides = rng.choice([5, 6, 6, 7, 8])
    rotation = rng.uniform(0, 2 * math.pi / sides)
    points = []
    for i in range(sides):
        angle = (2 * math.pi / sides) * i + rotation
        points.append(f"{cx + math.cos(angle) * radius:.1f},{cy + math.sin(angle) * radius:.1f}")
    stroke_width = 2 + rhythm_density * 3
    return (
        f'<polygon points="{" ".join(points)}" fill="none" stroke="{color}" '
        f'stroke-width="{stroke_width:.1f}" stroke-opacity="{min(1.0, opacity + 0.2):.2f}" '
        f'stroke-linejoin="miter" />'
    )


def _default_layer(cx, cy, radius, color, opacity, rhythm_density, tempo, energy, edge_sharpness, seed):
    rng = random.Random(seed)
    off_angle = rng.uniform(0, 2 * math.pi)
    off_dist = radius * rng.uniform(0.0, 0.1)
    ox = cx + math.cos(off_angle) * off_dist
    oy = cy + math.sin(off_angle) * off_dist
    stroke_width = 2 + energy * 3
    return (
        f'<circle cx="{ox:.1f}" cy="{oy:.1f}" r="{radius:.1f}" fill="none" stroke="{color}" '
        f'stroke-width="{stroke_width:.1f}" stroke-opacity="{opacity:.2f}" />'
    )


_SHAPE_BY_CATEGORY = {
    "percussion": _spiky_layer,
    "guitar": _ribbon_layer,
    "strings": _ribbon_layer,
    "bass": _bass_layer,
    "flute": _flute_layer,
    "vocal": _blob_layer,
    "synth": _grid_layer,
    "keys": _grid_layer,
}


def _harmonic_bloom(cx, cy, spread, chroma_vector, harmonic_tension, seed, opacity):
    """An organic scatter of the track's 12 real pitch-class energies -- no
    fixed ring. Each pitch class blooms outward from center at a seeded
    angle/distance (louder pitch classes drift further out) instead of
    sitting at a fixed slot, so the shape is never the same wheel twice. Hue
    still follows the circle of fifths (lining up with the key-driven
    background). When harmonic_tension is high (energy spread across many
    pitch classes = more dissonant/chromatic), thin lines connect
    musically-adjacent pitch classes across their scattered positions,
    forming an irregular web rather than a ring."""
    if not chroma_vector or len(chroma_vector) != 12:
        return ""

    rng = random.Random(seed ^ 0x8ADE)
    positions = []
    parts = []
    for i, energy_value in enumerate(chroma_vector):
        e = _clamp01(energy_value)
        hue = ((i * 7) % 12) / 12.0 * 360.0
        angle = rng.uniform(0, 2 * math.pi)
        dist = spread * (0.15 + rng.uniform(0.0, 0.85) * (0.35 + e * 0.65))
        x = cx + math.cos(angle) * dist
        y = cy + math.sin(angle) * dist
        r = 10 + e * 38
        positions.append((x, y))
        parts.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="hsl({hue:.0f},70%,60%)" '
            f'fill-opacity="{opacity * (0.35 + e * 0.55):.2f}" filter="url(#softBlur)" />'
        )

    if harmonic_tension > 0.55:
        link_opacity = (harmonic_tension - 0.55) / 0.45 * 0.35
        for i in range(12):
            x1, y1 = positions[i]
            x2, y2 = positions[(i + 1) % 12]
            parts.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                f'stroke="#ffffff" stroke-width="0.75" stroke-opacity="{link_opacity:.2f}" />'
            )
    return "".join(parts)


def _background_grain(size, noisiness, seed):
    """Fine scattered dots, density set by zero-crossing-rate "noisiness" and
    placed via the track's own seed, so texture is unique per track."""
    if noisiness <= 0.02:
        return ""
    rng = random.Random(seed ^ 0x5EED)
    count = round(noisiness * 260)
    parts = []
    for _ in range(count):
        x = rng.uniform(0, size)
        y = rng.uniform(0, size)
        r = rng.uniform(0.5, 1.6)
        op = rng.uniform(0.05, 0.18)
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}" fill="#ffffff" fill-opacity="{op:.2f}" />')
    return "".join(parts)


def _note_constellation(size, note_events, palette):
    """One dot per detected note/beat onset: pitch (spectral-centroid proxy)
    sets vertical position (high pitch = near the top), stereo pan sets
    horizontal position (left channel = left side), and onset strength sets
    dot size -- a literal scatter of the track's individual events."""
    if not note_events:
        return ""
    margin = size * 0.08
    usable_w = size - margin * 2
    usable_h = size - margin * 2
    parts = []
    for i, ev in enumerate(note_events):
        x = size / 2 + _clamp01((ev.get("pan", 0.0) + 1) / 2 - 0.5) * usable_w
        y = margin + (1 - _clamp01(ev.get("pitch", 0.5))) * usable_h
        strength = _clamp01(ev.get("strength", 0.3))
        r = 1.5 + strength * 5.5
        color = palette[i % len(palette)]
        op = 0.12 + strength * 0.35
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{color}" fill-opacity="{op:.2f}" />')
    return "".join(parts)


def _choose_layout(size, seed):
    """Seeded per-track layout: which edge gets the section timeline vs. the
    energy waveform (top/bottom/left/right, never the same edge), and where
    the harmonic bloom + instrument mandala + core cluster sits. Without
    this, every track shared one fixed template (sections always on top,
    waveform always on bottom, cluster always dead-center) -- only the
    content inside those slots varied. Deterministic per track_seed, so the
    same song always re-renders the same way, but different songs land in
    genuinely different arrangements."""
    rng = random.Random(seed ^ 0x1EAF)
    edges = ["top", "bottom", "left", "right"]
    rng.shuffle(edges)
    section_edge, energy_edge = edges[0], edges[1]

    cluster_rng = random.Random(seed ^ 0x2C1A)
    offset_r = size * 0.09 * cluster_rng.random()
    offset_a = cluster_rng.uniform(0, 2 * math.pi)
    cluster_x = size / 2 + math.cos(offset_a) * offset_r
    cluster_y = size / 2 + math.sin(offset_a) * offset_r

    return {
        "section_edge": section_edge,
        "energy_edge": energy_edge,
        "cluster_x": cluster_x,
        "cluster_y": cluster_y,
    }


def _edge_axis_pos(size, edge, inset_frac):
    """Translate a named edge into (axis, pos): axis 'x' runs the strip
    horizontally at a fixed y; axis 'y' runs it vertically at a fixed x."""
    inset = size * inset_frac
    if edge == "top":
        return "x", inset
    if edge == "bottom":
        return "x", size - inset
    if edge == "left":
        return "y", inset
    return "y", size - inset  # "right"


def _section_strip(size, sections, key_hue, edge, thickness):
    """Structural sections drawn as a literal timeline bar (track start ->
    end) along one edge of the canvas -- which edge is chosen per track by
    _choose_layout, instead of always sitting at the top. Sections that
    sound alike (e.g. repeated choruses) were clustered to the same 'type'
    by the DSP pass and so share the same hue stamp here."""
    if not sections:
        return ""
    axis, pos = _edge_axis_pos(size, edge, 0.035)
    margin = size * 0.07
    usable = size - margin * 2
    parts = []
    for sec in sections:
        s0 = margin + _clamp01(sec.get("start", 0.0)) * usable
        s1 = margin + _clamp01(sec.get("end", 1.0)) * usable
        length = max(1.5, s1 - s0)
        type_id = sec.get("type", 0)
        hue = (key_hue + type_id * 37) % 360
        sec_energy = _clamp01(sec.get("energy", 0.5))
        opacity = 0.25 + sec_energy * 0.45
        if axis == "x":
            x, y, w, h = s0, pos - thickness / 2, length, thickness
        else:
            x, y, w, h = pos - thickness / 2, s0, thickness, length
        parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{thickness / 3:.1f}" '
            f'fill="hsl({hue:.0f},60%,55%)" fill-opacity="{opacity:.2f}" />'
        )
    return "".join(parts)


def _energy_waveform(size, energy_timeline, tempo_stability, dynamic_range, palette, seed, edge, band_height):
    """The literal energy fingerprint, one bar per time-slice, drawn along
    one edge of the canvas like an audio waveform -- which edge is chosen
    per track by _choose_layout, instead of always sitting at the bottom.
    tempo_stability jitters bar spacing (a steady tempo -> evenly spaced
    bars); dynamic_range widens or flattens the contrast between the
    quietest and loudest bars."""
    n = len(energy_timeline)
    if n == 0:
        return ""
    axis, pos = _edge_axis_pos(size, edge, 0.045)
    margin = size * 0.07
    usable = size - margin * 2
    jitter_rng = random.Random(seed)
    max_jitter = (1 - tempo_stability) * 0.4 * (usable / n)
    contrast = 0.6 + dynamic_range * 0.8
    parts = []
    for i, e in enumerate(energy_timeline):
        coord = margin + (usable / max(n - 1, 1)) * i + jitter_rng.uniform(-max_jitter, max_jitter)
        e_contrast = _clamp01(0.5 + (_clamp01(e) - 0.5) * contrast)
        half_h = band_height * (0.1 + e_contrast * 0.9)
        color = palette[i % len(palette)]
        if axis == "x":
            x1 = x2 = coord
            y1, y2 = pos - half_h, pos + half_h
        else:
            y1 = y2 = coord
            x1, x2 = pos - half_h, pos + half_h
        parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{color}" stroke-width="4" stroke-linecap="round" opacity="0.85" />'
        )
    return "".join(parts)


def generate_svg(dsp, gpt):
    """dsp: dict from audio_analysis.analyze_audio(). gpt: dict from the GPT
    qualitative pass (mood, dominant_instruments, color_palette), or {} if
    that step failed/was skipped."""
    dsp = dsp or {}
    gpt = gpt or {}

    size = 800

    key_hue = dsp.get("key_hue", 200)
    brightness = _clamp01(dsp.get("brightness", 0.5))
    energy = _clamp01(dsp.get("energy", 0.5))  # "Volume/Loudness"
    rhythm_density = _clamp01(dsp.get("rhythm_density", 0.5))
    tempo = dsp.get("tempo_bpm") or 100
    energy_timeline = dsp.get("energy_timeline") or [0.5] * 48
    tempo_stability = _clamp01(dsp.get("tempo_stability", 0.5))
    dynamic_range = _clamp01(dsp.get("dynamic_range", 0.3))
    chroma_vector = dsp.get("chroma_vector") or [0.5] * 12
    harmonic_ratio = _clamp01(dsp.get("harmonic_ratio", 0.5))
    harmonic_tension = _clamp01(dsp.get("harmonic_tension", 0.5))
    timbre_sharpness = _clamp01(dsp.get("timbre_sharpness", 0.3))
    noisiness = _clamp01(dsp.get("noisiness", 0.1))
    track_seed = dsp.get("track_seed") or 42
    mode = dsp.get("mode", "major")
    sections = dsp.get("sections") or []
    note_events = dsp.get("note_events") or []

    # Timbre: combine "how noisy/harsh" (spectral flatness) with "how
    # percussive vs. tonal" (inverse harmonic ratio) into one edge-sharpness
    # factor used by every shape layer.
    edge_sharpness = _clamp01(0.5 * (1 - harmonic_ratio) + 0.5 * timbre_sharpness)

    # Major/minor + GPT mood together nudge overall brightness -- neither one
    # fixes it alone, per the brief.
    mood = (gpt.get("mood") or "").strip().lower()
    mood_bias = 0.12 if mood in _MOOD_BRIGHT else (-0.12 if mood in _MOOD_DARK else 0.0)
    mode_bias = 0.12 if mode == "major" else (-0.12 if mode == "minor" else 0.0)
    brightness_adj = _clamp01(brightness + mode_bias * 0.6 + mood_bias * 0.6)

    palette = [c for c in (gpt.get("color_palette") or []) if isinstance(c, str) and c.startswith("#")]
    if not palette:
        palette = DEFAULT_PALETTE
    while len(palette) < 4:
        palette += palette
    # Loudness -> stronger or weaker color contrast.
    saturation_shift = (energy - 0.5) * 0.3
    palette = [_boost_saturation(c, saturation_shift) for c in palette]

    instruments = (gpt.get("dominant_instruments") or [])[:4] or ["texture"]

    # Loudness -> overall scale of the instrument mandala.
    size_multiplier = 0.85 + energy * 0.3

    center_light = 14 + brightness_adj * 22
    edge_light = 6 + brightness_adj * 4

    parts = [
        f'<svg viewBox="0 0 {size} {size}" xmlns="http://www.w3.org/2000/svg" '
        f'role="img" aria-label="Generated artwork">',
        "<defs>",
        '<radialGradient id="bgGlow" cx="50%" cy="50%" r="75%">',
        f'<stop offset="0%" stop-color="hsl({key_hue:.0f},60%,{center_light:.0f}%)" />',
        f'<stop offset="100%" stop-color="hsl({key_hue:.0f},45%,{edge_light:.0f}%)" />',
        "</radialGradient>",
        '<filter id="softBlur" x="-50%" y="-50%" width="200%" height="200%">',
        '<feGaussianBlur stdDeviation="9" />',
        "</filter>",
        "</defs>",
        f'<rect width="{size}" height="{size}" fill="url(#bgGlow)" />',
        _background_grain(size, noisiness, track_seed),
        _note_constellation(size, note_events, palette),
    ]

    # Per-track layout: which edge gets which strip, and where the center
    # cluster (bloom + mandala + core) sits -- seeded so the arrangement
    # itself varies between songs, not just the content within a fixed template.
    layout = _choose_layout(size, track_seed)
    mx, my = layout["cluster_x"], layout["cluster_y"]

    # Section timeline along a seeded edge: same "type" (self-similar section) gets the same hue stamp.
    parts.append(_section_strip(size, sections, key_hue, layout["section_edge"], thickness=size * 0.02))

    # Energy waveform along a seeded edge: literal energy fingerprint through the track.
    parts.append(
        _energy_waveform(
            size, energy_timeline, tempo_stability, dynamic_range, palette, track_seed,
            layout["energy_edge"], band_height=size * 0.045,
        )
    )

    # Harmonic bloom: the track's real pitch-class energy distribution, scattered rather than ringed.
    parts.append(_harmonic_bloom(mx, my, 240, chroma_vector, harmonic_tension, track_seed, opacity=0.8))

    # Inner mandala: one layer per dominant instrument, each with its own shape language.
    # Which ring size (idx) each instrument LANDS ON is shuffled per track, seeded --
    # otherwise two songs where GPT lists instruments in the same order (very common,
    # e.g. "vocals, guitar, drums, bass" for most pop/rock) would always assign the
    # same instrument to the big outer ring, regardless of how different the songs
    # actually sound. Color/opacity still follow GPT's listed order (its dominance
    # ranking), only the size slot is shuffled.
    slot_rng = random.Random(track_seed ^ 0x51A7)
    radius_slots = list(range(len(instruments)))
    slot_rng.shuffle(radius_slots)
    for idx, instrument in enumerate(instruments):
        category = _classify_instrument(instrument)
        shape_fn = _SHAPE_BY_CATEGORY.get(category, _default_layer)
        seed = track_seed ^ ((idx + 1) * 7919)  # per-layer variation, still unique per track
        radius_jitter = 0.85 + (seed % 1000) / 1000 * 0.3  # +/-15%, seeded not random
        slot = radius_slots[idx]
        base_radius = (55 + slot * (195 / max(len(instruments), 1))) * size_multiplier * radius_jitter
        color = palette[idx % len(palette)]
        opacity = max(0.2, 0.55 - idx * 0.08)
        parts.append(
            shape_fn(mx, my, base_radius, color, opacity, rhythm_density, tempo, energy, edge_sharpness, seed)
        )

    # Central core, sized by overall loudness.
    core_r = 18 + energy * 40
    parts.append(
        f'<circle cx="{mx:.1f}" cy="{my:.1f}" r="{core_r:.1f}" '
        f'fill="hsl({key_hue:.0f},70%,{60 + brightness_adj * 20:.0f}%)" opacity="0.9" />'
    )

    parts.append("</svg>")
    return "".join(parts)
