import base64
import ctypes
import gc
import io
import json
import os
import re
import resource
import sys
import tempfile
import threading
import time
import uuid
from functools import wraps

import mutagen
from dotenv import load_dotenv
from flask import Flask, abort, flash, g, jsonify, redirect, render_template, request, send_file, session, url_for
from openai import OpenAI
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

import store
from art_generator import generate_svg
from audio_analysis import analyze_audio

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-in-production")
# Only send the login cookie over HTTPS when deployed behind it.
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("SESSION_COOKIE_SECURE") == "1"
# Browsers don't send the login cookie with form posts from other sites, so
# another page can't like, comment, or delete on a signed-in user's behalf.
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["MAX_CONTENT_LENGTH"] = 15 * 1024 * 1024  # 15 MB upload limit

# Google sign-in runs through Firebase Authentication. It's switched on by
# setting FIREBASE_WEB_API_KEY (Firebase console > Project settings > Your
# apps > Web app); the project id comes from the service-account
# credentials. Until then the Google buttons are hidden.
FIREBASE_WEB_API_KEY = os.environ.get("FIREBASE_WEB_API_KEY", "").strip()
MAX_NICKNAME_CHARS = 40

ALLOWED_AUDIO_EXTENSIONS = {"mp3", "wav"}

# OpenAI models. Sunburst is the quality-first image model; IMAGE_QUALITY
# trades speed and cost for detail (low, medium, high, xhigh, max) and can be
# overridden in .env.
AUDIO_MODEL = "gpt-audio-1.5"
IMAGE_MODEL = "gpt-image-2.5-sunburst"
IMAGE_QUALITY = os.environ.get("IMAGE_QUALITY", "high")
openai_client = OpenAI() if os.environ.get("OPENAI_API_KEY") else None


def allowed_audio_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_AUDIO_EXTENSIONS


def login_required(view):
    @wraps(view)
    def wrapped_view(**kwargs):
        if "user_id" not in session:
            flash("Please log in to continue.", "error")
            return redirect(url_for("login"))
        return view(**kwargs)

    return wrapped_view


@app.before_request
def before_request():
    # The login stores the user's id and names in the signed session cookie,
    # so ordinary page loads don't need a database round trip.
    g.user = None
    if "user_id" in session:
        if "username" not in session:
            session.clear()
        else:
            nickname = session.get("nickname") or ""
            g.user = {
                "id": session["user_id"],
                "username": session["username"],
                "nickname": nickname,
                "display_name": nickname or session["username"],
            }


def _start_session(user):
    session.clear()
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["nickname"] = user.get("nickname") or ""


def _clean_nickname(raw):
    return " ".join((raw or "").split())[:MAX_NICKNAME_CHARS]


_firebase_web_config_cache = {}


@app.context_processor
def inject_google_signin():
    """Firebase web settings for the Google button, or None while Google
    sign-in isn't configured."""
    if not FIREBASE_WEB_API_KEY:
        return {"google_signin": None}
    if not _firebase_web_config_cache:
        try:
            project = os.environ.get("FIREBASE_PROJECT_ID") or store.project_id()
        except Exception as exc:  # noqa: BLE001 - no credentials: just hide the button
            print(f"Google sign-in disabled: {exc}", flush=True)
            return {"google_signin": None}
        _firebase_web_config_cache.update(
            apiKey=FIREBASE_WEB_API_KEY,
            authDomain=os.environ.get("FIREBASE_AUTH_DOMAIN") or f"{project}.firebaseapp.com",
            projectId=project,
        )
    return {"google_signin": dict(_firebase_web_config_cache)}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if g.user:
        return redirect(url_for("index"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")
        nickname = _clean_nickname(request.form.get("nickname"))

        errors = []

        if not username:
            errors.append("Username is required.")
        elif len(username) < 3:
            errors.append("Username must be at least 3 characters.")

        if not email:
            errors.append("Email is required.")
        elif "@" not in email:
            errors.append("Please enter a valid email address.")

        if not password:
            errors.append("Password is required.")
        elif len(password) < 6:
            errors.append("Password must be at least 6 characters.")

        if password != confirm_password:
            errors.append("Passwords do not match.")

        if errors:
            for error in errors:
                flash(error, "error")
            return render_template("signup.html")

        try:
            store.create_user(
                username, email, generate_password_hash(password, method="pbkdf2:sha256"), nickname=nickname
            )
        except store.AlreadyTaken:
            flash("Username or email is already taken.", "error")
            return render_template("signup.html")

        flash("Account created successfully. Please log in.", "success")
        return redirect(url_for("login"))

    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if g.user:
        return redirect(url_for("index"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        if not username or not password:
            flash("Please enter both username and password.", "error")
            return render_template("login.html")

        user = store.find_user_for_login(username)

        if user is not None and not user["password_hash"]:
            flash("This account signs in with Google. Use “Continue with Google” below.", "error")
            return render_template("login.html")

        if user is None or not check_password_hash(user["password_hash"], password):
            flash("Invalid username or password.", "error")
            return render_template("login.html")

        _start_session(user)
        flash(f"Welcome back, {user['nickname'] or user['username']}!", "success")
        return redirect(url_for("index"))

    return render_template("login.html")


@app.route("/auth/google", methods=["POST"])
def auth_google():
    """Finishes Google sign-in: the browser signs in with Firebase and posts
    the resulting ID token here. Signs in the linked account; otherwise links
    the account with the same verified email; otherwise creates a new
    account (username made up from the Google name or email, nickname from
    the Google name)."""
    if not FIREBASE_WEB_API_KEY:
        return jsonify(error="Google sign-in isn't set up on this server."), 404
    id_token = ((request.get_json(silent=True) or {}).get("id_token") or "").strip()
    if not id_token:
        return jsonify(error="Missing Google sign-in token."), 400
    try:
        claims = store.verify_google_token(id_token)
    except ValueError as exc:
        return jsonify(error=str(exc)), 401

    google_uid = claims["uid"]
    email = (claims.get("email") or "").strip().lower()
    google_name = _clean_nickname(claims.get("name"))
    if not email or not claims.get("email_verified"):
        return jsonify(error="Your Google account needs a verified email address to sign in."), 400

    created = False
    try:
        user = store.find_user_by_google(google_uid)
        if user is None:
            user = store.find_user_by_email(email)
            if user is not None:
                store.link_google(user["id"], google_uid)
            else:
                user_id = store.create_user(
                    store.suggest_username(google_name, email.split("@")[0]),
                    email, None, nickname=google_name, google_uid=google_uid,
                )
                user = store.get_user(user_id)
                created = True
    except store.AlreadyTaken:
        return jsonify(error="That Google account is already linked to a different AURA account."), 409

    _start_session(user)
    name = user["nickname"] or user["username"]
    if created:
        flash(f"Welcome to AURA, {name}! You can change your nickname on your account page.", "success")
    else:
        flash(f"Welcome back, {name}!", "success")
    return jsonify(redirect=url_for("index"))


@app.route("/account", methods=["GET", "POST"])
@login_required
def account():
    user = store.get_user(g.user["id"])
    if user is None:
        session.clear()
        return redirect(url_for("login"))
    if request.method == "POST":
        nickname = _clean_nickname(request.form.get("nickname"))
        store.set_nickname(user["id"], nickname)
        session["nickname"] = nickname
        flash("Nickname updated." if nickname else "Nickname cleared; your username will be shown instead.", "success")
        return redirect(url_for("account"))
    return render_template("account.html", account=user, max_nickname=MAX_NICKNAME_CHARS)


@app.route("/logout")
def logout():
    session.clear()
    flash("You have been logged out.", "success")
    return redirect(url_for("index"))


@app.route("/draw")
@login_required
def draw():
    # Opened from an Analyze result (?job=...&version=...): load that artwork
    # version as a locked background so the user can sketch an edit over it.
    edit_source = None
    job_id = request.args.get("job")
    if job_id:
        job = _get_job_or_404(job_id)
        versions = job.get("versions") or []
        version = request.args.get("version", type=int)
        if version is None or not 0 <= version < len(versions):
            abort(404)
        edit_source = {
            "image_url": url_for("analyze_image", job_id=job_id, version=version),
            "edit_url": url_for("analyze_edit", job_id=job_id),
            "back_url": url_for("analyze", job=job_id),
            "version": version,
        }
    return render_template("draw.html", edit_source=edit_source)


# DSP (via librosa) measures tempo, energy, rhythm, and key directly from the
# audio signal. Those numbers are handed to GPT as quiet background context --
# GPT listens to the track itself and writes the art direction in its own
# words, so the image is an interpretation of the music rather than a readout
# of the measurements.
ANALYSIS_SYSTEM_PROMPT = (
    "You are a painter with synesthesia: when you hear music, you see it. "
    "Listen closely to the provided track and describe the artwork it becomes "
    "in your mind. Let the music lead -- its breath, grain, swells, silences, "
    "and the way sounds move against each other. Favor organic, living "
    "qualities: things that grow, flow, drift, erode, bloom, tangle, or "
    "dissolve, and textures with a natural or handmade feel. Any medium, "
    "scale, or degree of abstraction is fine if it fits what you hear; every "
    "track should feel like its own world.\n\n"
    "You'll also be given a few rough measurements of the track. Treat them "
    "as background, not instructions -- trust your ears where they disagree, "
    "and never mention numbers, BPM, keys, or music theory in the art "
    "direction.\n\n"
    "The listener may also describe the track in their own words -- what it "
    "means to them, what they picture, the feeling they want captured. When "
    "they do, let it lead: their story, imagery, and emotional reading should "
    "shape the mood, palette, and artwork, while what you hear decides how it "
    "is rendered (texture, motion, energy). Weave their ideas in as an artist "
    "would rather than illustrating them word for word. Instruments are "
    "still whatever you actually hear.\n\n"
    "Respond with ONLY a JSON object (no prose, no markdown) with these "
    "fields: mood (a short phrase in your own words), dominant_instruments "
    "(array of up to 4 short strings), color_palette (array of 3-6 hex color "
    "strings drawn from the colors you imagine), and art_prompt (a rich, "
    "sensory description of the artwork, a short paragraph, written for an "
    "image model)."
)

IMAGE_STYLE_SUFFIX = " No text, lettering, signatures, or watermarks."


def _describe_dsp(dsp):
    """Plain-language summary of the DSP measurements, used only as background
    context for GPT -- it never goes straight into the image prompt."""

    def level(value, low, high):
        if value is None:
            return "unknown"
        return low if value < 0.35 else high if value > 0.65 else "moderate"

    sections = dsp.get("sections") or []
    return (
        f"Tempo around {dsp.get('tempo_bpm', '?')} BPM; "
        f"key of {dsp.get('key', '?')}; "
        f"{len(sections)} distinct sections over {dsp.get('duration_sec', '?')} seconds; "
        f"energy {level(dsp.get('energy'), 'low', 'high')}; "
        f"tone {level(dsp.get('brightness'), 'dark/warm', 'bright')}; "
        f"rhythm {level(dsp.get('rhythm_density'), 'sparse', 'busy')}; "
        f"dynamics {level(dsp.get('dynamic_range'), 'steady', 'wide-swinging')}; "
        f"harmony {level(dsp.get('harmonic_tension'), 'settled', 'tense')}."
    )


def _parse_json_response(raw_content):
    raw_content = raw_content.strip()
    if raw_content.startswith("```"):
        raw_content = raw_content.strip("`")
        if raw_content.startswith("json"):
            raw_content = raw_content[4:]
        raw_content = raw_content.strip()
    return json.loads(raw_content)


def _get_gpt_analysis(audio_bytes, audio_format, dsp, description=""):
    """Qualitative pass via GPT: mood, instruments, palette, art direction.
    Returns {} on failure so the page can still render DSP-only art rather
    than failing outright."""
    if openai_client is None:
        return {}, "OPENAI_API_KEY is not configured on the server, so mood/instrument/color analysis was skipped."

    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
    user_text = f"Rough measurements: {_describe_dsp(dsp)}"
    if description:
        user_text += f"\n\nThe listener describes this track: {description}"
    user_text += "\n\nListen, then return the JSON object."
    try:
        completion = openai_client.chat.completions.create(
            model=AUDIO_MODEL,
            modalities=["text"],
            messages=[
                {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": user_text,
                        },
                        {"type": "input_audio", "input_audio": {"data": audio_b64, "format": audio_format}},
                    ],
                },
            ],
        )
        return _parse_json_response(completion.choices[0].message.content), None
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, DSP art still works
        return {}, f"GPT mood/instrument analysis failed ({exc}); showing DSP-only art."


def _build_image_prompt(dsp, gpt, description=""):
    """GPT's art direction already folds in what the DSP measured, so it's
    passed through as-is; only a no-text guard is added."""
    art_prompt = (gpt.get("art_prompt") or "").strip()
    if not art_prompt:
        mood = gpt.get("mood", "an unnamed feeling")
        art_prompt = (
            f"An organic, flowing artwork that feels like music with the mood of {mood}. "
            f"The sound is described as: {_describe_dsp(dsp)} Translate this into "
            "texture, movement, and color rather than literal imagery."
        )
        if description:
            art_prompt += f" The listener describes the music as: {description}"
    return f"{art_prompt}{IMAGE_STYLE_SUFFIX}"


def _generate_artwork_image(dsp, gpt, description=""):
    """Full image-generation pass: turns the track's analysis into a genuinely
    new piece of art per song (new composition, shapes, and colors each time)
    rather than recombining a fixed set of procedural shapes. Returns
    (png_bytes, warning) -- png_bytes is None on failure so the caller can
    fall back to the deterministic procedural SVG."""
    if openai_client is None:
        return None, "OPENAI_API_KEY is not configured on the server, so image generation was skipped."

    prompt = _build_image_prompt(dsp, gpt, description)
    try:
        response = openai_client.images.generate(
            model=IMAGE_MODEL, prompt=prompt, size="1024x1024", quality=IMAGE_QUALITY
        )
        return base64.b64decode(response.data[0].b64_json), None
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, procedural art still works
        return None, f"Image generation failed ({exc}); showing procedural art instead."


EDIT_TEXT_PROMPT = (
    "Edit this artwork as follows: {instruction}\n\n"
    "Change only what the instruction asks for. Keep the rest of the piece -- "
    "composition, palette, brushwork, texture, and lighting -- as close to the "
    "original as possible, and render any new elements in the same style so "
    "they look like they were always part of it."
)

EDIT_SKETCH_PROMPT = (
    "The first image is an artwork that the user has drawn rough marks on to "
    "request an edit; the second image is the same artwork before the marks. "
    "Every mark is a request to ADD or CHANGE something at that spot -- never "
    "noise to clean up. Work out what each mark depicts from its shape, size, "
    "color, and placement (a circle might be a sun, moon, or orb; small V "
    "shapes might be birds; a line might be a horizon, path, or crack of "
    "light) and paint that as a clearly visible, finished element in the "
    "artwork's existing style, palette, and texture, at the same position and "
    "roughly the same size as the mark. The new elements must be obvious when "
    "comparing the result to the second image. Outside the marked areas, keep "
    "the artwork as it is. The rough strokes themselves should be replaced by "
    "the painted elements, not left as flat lines."
)

MAX_VERSIONS = 20
MAX_SKETCH_BYTES = 12 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _edit_artwork_image(images, prompt):
    """images: list of PNG bytes (first is the one being edited). Returns
    (png_bytes, error_message)."""
    if openai_client is None:
        return None, "OPENAI_API_KEY is not configured on the server, so editing is unavailable."
    try:
        response = openai_client.images.edit(
            model=IMAGE_MODEL,
            quality=IMAGE_QUALITY,
            image=[(f"image{i}.png", png, "image/png") for i, png in enumerate(images)],
            prompt=f"{prompt}{IMAGE_STYLE_SUFFIX}",
            size="1024x1024",
        )
        return base64.b64decode(response.data[0].b64_json), None
    except Exception as exc:  # noqa: BLE001 - report the failure to the editor UI
        return None, f"Image edit failed ({exc})."


# Audio analysis is the memory- and CPU-heavy step, so only one runs at a
# time. Waiting tracks line up first-come, first-served in _dsp_queue (the
# head is the one being measured), which lets the page tell each listener
# how many tracks are ahead of theirs. GPT and image generation are network
# calls and overlap freely.
_dsp_queue = []
_dsp_cond = threading.Condition()


def _dsp_queue_position(ticket):
    """How many tracks are ahead of this one (0 = being measured now), or
    None when it isn't waiting on the analyzer."""
    with _dsp_cond:
        return _dsp_queue.index(ticket) if ticket in _dsp_queue else None


def _analyze_audio_serialized(audio_bytes, audio_format, ticket, on_start=lambda: None):
    with _dsp_cond:
        _dsp_queue.append(ticket)
        _dsp_cond.wait_for(lambda: _dsp_queue[0] == ticket)
    try:
        on_start()
        return analyze_audio(audio_bytes, audio_format)
    finally:
        with _dsp_cond:
            _dsp_queue.remove(ticket)
            _dsp_cond.notify_all()
        gc.collect()
        if sys.platform.startswith("linux"):
            # Hand freed memory back to the OS so the next track starts
            # from the same baseline.
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        # Shows up in the server logs. ru_maxrss is KB on Linux, bytes on macOS.
        peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // (1024 if sys.platform.startswith("linux") else 1024 ** 2)
        print(f"audio analysis done; peak memory so far {peak_mb} MB", flush=True)


def _warm_up_analyzer():
    """librosa compiles parts of itself (beat tracking etc.) the first time
    they run, which takes a long while on a small server. Doing it once at
    startup on a few seconds of synthetic audio spares the first listener
    after every restart or wake-up from paying that cost."""
    try:
        import numpy as np
        import soundfile as sf

        sr = 22050
        t = np.arange(sr * 4) / sr
        tone = 0.3 * np.sin(2 * np.pi * 220 * t) * (1 + np.sign(np.sin(2 * np.pi * 2 * t))) / 2
        buf = io.BytesIO()
        sf.write(buf, tone.astype(np.float32), sr, format="WAV")
        started = time.time()
        _analyze_audio_serialized(buf.getvalue(), "wav", ticket=f"warmup-{uuid.uuid4().hex}")
        print(f"audio analyzer warmed up in {time.time() - started:.1f}s", flush=True)
    except Exception as exc:  # noqa: BLE001 - warm-up is only an optimization
        print(f"audio analyzer warm-up skipped: {exc}", flush=True)


def _run_pipeline(audio_bytes, audio_format, description="", song=None, report=lambda stage: None, ticket=None):
    """DSP -> GPT listening pass -> image generation. Calls report(stage) as
    each step starts so the browser can show live progress ("queued" while
    waiting for the analyzer). Raises ValueError if the audio itself can't be
    analyzed; GPT/image failures degrade into warnings instead.

    Pass the audio bytes as the only reference to them (not also held by the
    caller): they're released once GPT has listened, so tracks waiting on
    image generation don't keep their uploads in memory."""
    warnings = []

    report("queued")
    try:
        dsp = _analyze_audio_serialized(
            audio_bytes, audio_format, ticket or uuid.uuid4().hex, on_start=lambda: report("measuring")
        )
    except Exception as exc:  # noqa: BLE001 - surface DSP failures (corrupt/short file, etc.)
        raise ValueError(f"Audio analysis failed: {exc}") from exc

    report("listening")
    gpt, gpt_warning = _get_gpt_analysis(audio_bytes, audio_format, dsp, description)
    del audio_bytes
    if gpt_warning:
        warnings.append(gpt_warning)

    analysis = {
        "tempo_bpm": dsp["tempo_bpm"],
        "duration_sec": dsp["duration_sec"],
        "key": dsp["key"],
        "mode": dsp["mode"],
        "energy": dsp["energy"],
        "brightness": dsp["brightness"],
        "rhythm_density": dsp["rhythm_density"],
        "dynamic_range": dsp["dynamic_range"],
        "harmonic_tension": dsp["harmonic_tension"],
        "timbre_sharpness": dsp["timbre_sharpness"],
        "is_stereo": dsp["is_stereo"],
        "section_count": len(dsp["sections"]),
        "note_event_count": len(dsp["note_events"]),
        "mood": gpt.get("mood", "unknown"),
        "dominant_instruments": gpt.get("dominant_instruments", []),
        "description": description,
        "song_title": (song or {}).get("title", ""),
        "song_artist": (song or {}).get("artist", ""),
    }

    report("generating")
    artwork_png, image_warning = _generate_artwork_image(dsp, gpt, description)
    artwork_svg = None
    if artwork_png is None:
        if image_warning:
            warnings.append(image_warning)
        artwork_svg = generate_svg(dsp, gpt)

    return {
        "analysis": analysis,
        "artwork_png": artwork_png,
        "artwork_svg": artwork_svg,
        "artwork_description": gpt.get("art_prompt"),
        "warnings": warnings,
    }


# In-memory job store for background analyses. Fine for a single server
# process (see render.yaml); a multi-worker deployment would need Redis or
# the database instead. A job is kept until it has gone unused for
# JOB_TTL_SEC.
JOB_TTL_SEC = 60 * 60
# How many tracks may be in progress at once across all listeners. Further
# uploads get a friendly "busy, try again shortly" instead of piling up
# until the server runs out of memory and restarts (losing everyone's work).
MAX_ACTIVE_JOBS = int(os.environ.get("MAX_ACTIVE_JOBS", "5"))
ACTIVE_STAGES = {"queued", "measuring", "listening", "generating"}
_jobs = {}
_jobs_lock = threading.Lock()

# Artwork versions are written to files here rather than held in memory:
# each is a 1-2 MB PNG and every edit adds another.
_ARTWORK_DIR = tempfile.mkdtemp(prefix="aura-artwork-")


def _store_version(job_id, png, label):
    path = os.path.join(_ARTWORK_DIR, f"{job_id}-{uuid.uuid4().hex}.png")
    with open(path, "wb") as fh:
        fh.write(png)
    return {"path": path, "label": label}


def _version_png(version):
    with open(version["path"], "rb") as fh:
        return fh.read()


def _prune_jobs():
    cutoff = time.time() - JOB_TTL_SEC
    with _jobs_lock:
        expired = [
            job_id for job_id, job in _jobs.items()
            if job["touched"] < cutoff and job["stage"] not in ACTIVE_STAGES and not job.get("editing")
        ]
        removed = [_jobs.pop(job_id) for job_id in expired]
    for job in removed:
        for version in job.get("versions") or []:
            try:
                os.remove(version["path"])
            except OSError:
                pass


JOB_GONE_MESSAGE = (
    "This artwork is no longer on the server. Unsaved artworks are cleared "
    "after an hour without activity, or when the server restarts. If it's "
    "still showing, download it with ⬇️ Save, or analyze the track again."
)


def _find_job(job_id):
    """The signed-in user's job (marking it as recently used), or None."""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None or job["user_id"] != session.get("user_id"):
            return None
        job["touched"] = time.time()
        return job


def _get_job_or_404(job_id):
    job = _find_job(job_id)
    if job is None:
        abort(404)
    return job


def _run_job(job_id, upload, audio_format, description, song):
    """upload is {"audio": bytes}; the bytes are handed to the pipeline as
    its only reference so they can be freed partway through."""
    def report(stage):
        with _jobs_lock:
            _jobs[job_id]["stage"] = stage

    try:
        result = _run_pipeline(upload.pop("audio"), audio_format, description, song, report, ticket=job_id)
        # Each edit appends a version; version 0 is the original artwork.
        artwork_png = result.pop("artwork_png")
        versions = [_store_version(job_id, artwork_png, "Original")] if artwork_png else []
        del artwork_png
        with _jobs_lock:
            _jobs[job_id].update(stage="done", result=result, versions=versions)
    except Exception as exc:  # noqa: BLE001 - report any failure back to the browser
        with _jobs_lock:
            _jobs[job_id].update(stage="error", error=str(exc))


MAX_DESCRIPTION_CHARS = 1000


MAX_SONG_FIELD_CHARS = 200


def _song_info(audio_bytes, filename):
    """The song's name and artist from its embedded ID3 tags (MP3s and many
    WAVs carry them). Falls back to a tidied-up file name, e.g.
    "03 - Night_Drive.mp3" -> "Night Drive"."""
    title = artist = ""
    try:
        tags = mutagen.File(io.BytesIO(audio_bytes)).tags or {}
        title = str(tags["TIT2"].text[0]) if "TIT2" in tags else ""
        artist = str(tags["TPE1"].text[0]) if "TPE1" in tags else ""
    except Exception:  # noqa: BLE001 - untagged or unreadable tags just mean no metadata
        pass
    if not title.strip():
        stem = filename.rsplit(".", 1)[0].replace("_", " ")
        title = re.sub(r"^\s*\d{1,3}\s*[-.)]\s*", "", stem) or stem
    return {
        "title": " ".join(title.split())[:MAX_SONG_FIELD_CHARS],
        "artist": " ".join(artist.split())[:MAX_SONG_FIELD_CHARS],
    }


def _read_upload():
    """Returns (audio_bytes, audio_format, description, song, error_message)."""
    description = (request.form.get("description") or "").strip()[:MAX_DESCRIPTION_CHARS]
    file = request.files.get("music_file")
    if not file or file.filename == "":
        return None, None, description, None, "Please choose an audio file."
    if not allowed_audio_file(file.filename):
        return None, None, description, None, "Only .mp3 and .wav files are supported."
    audio_bytes = file.read()
    song = _song_info(audio_bytes, file.filename)
    return audio_bytes, file.filename.rsplit(".", 1)[1].lower(), description, song, None


def _render_analyze(result=None, artwork_image=None, job_id=None, versions=None):
    result = result or {}
    return render_template(
        "analyze.html",
        job_id=job_id,
        versions=versions or [],
        analysis=result.get("analysis"),
        artwork_svg=result.get("artwork_svg"),
        artwork_image=artwork_image,
        artwork_description=result.get("artwork_description"),
        warnings=result.get("warnings", []),
    )


@app.route("/analyze", methods=["GET", "POST"])
@login_required
def analyze():
    # Finished background job (the page's JS swaps this in without a reload).
    job_id = request.args.get("job")
    if job_id:
        job = _get_job_or_404(job_id)
        if job["stage"] != "done":
            return redirect(url_for("analyze"))
        versions = [
            {"label": v["label"], "url": url_for("analyze_image", job_id=job_id, version=i)}
            for i, v in enumerate(job["versions"])
        ]
        image_url = versions[-1]["url"] if versions else None
        return _render_analyze(job["result"], image_url, job_id, versions)

    if request.method == "GET":
        return _render_analyze()

    # Plain form POST: only reached when JavaScript is off, so run inline.
    audio_bytes, audio_format, description, song, error = _read_upload()
    if error:
        flash(error, "error")
        return _render_analyze()
    try:
        result = _run_pipeline(audio_bytes, audio_format, description, song)
    except ValueError as exc:
        flash(str(exc), "error")
        return _render_analyze()
    image_uri = None
    if result["artwork_png"]:
        image_uri = "data:image/png;base64," + base64.b64encode(result["artwork_png"]).decode("ascii")
    return _render_analyze(result, image_uri)


@app.route("/analyze/start", methods=["POST"])
@login_required
def analyze_start():
    audio_bytes, audio_format, description, song, error = _read_upload()
    if error:
        return jsonify(error=error), 400

    _prune_jobs()
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        active = [job for job in _jobs.values() if job["stage"] in ACTIVE_STAGES]
        if any(job["user_id"] == session["user_id"] for job in active):
            return jsonify(error="You already have a track being analyzed. Let it finish, then try the next one."), 429
        if len(active) >= MAX_ACTIVE_JOBS:
            return jsonify(error="AURA is busy with other listeners' tracks right now. Please try again in a minute or two."), 503
        now = time.time()
        _jobs[job_id] = {
            "user_id": session["user_id"],
            "stage": "queued",
            "created": now,
            "touched": now,
            "result": None,
            "error": None,
        }
    threading.Thread(
        target=_run_job, args=(job_id, {"audio": audio_bytes}, audio_format, description, song), daemon=True
    ).start()
    return jsonify(job_id=job_id), 202


@app.route("/analyze/status/<job_id>")
@login_required
def analyze_status(job_id):
    job = _find_job(job_id)
    if job is None:
        return jsonify(stage="error", error=JOB_GONE_MESSAGE), 404
    ahead = _dsp_queue_position(job_id) if job["stage"] == "queued" else None
    return jsonify(stage=job["stage"], error=job["error"], has_image=bool(job.get("versions")), ahead=ahead)


@app.route("/analyze/image/<job_id>/<int:version>.png")
@login_required
def analyze_image(job_id, version):
    job = _get_job_or_404(job_id)
    versions = job.get("versions") or []
    if version >= len(versions):
        abort(404)
    return send_file(versions[version]["path"], mimetype="image/png")


@app.route("/analyze/edit/<job_id>", methods=["POST"])
@login_required
def analyze_edit(job_id):
    """Two ways to edit: mode=text (a written instruction) or mode=sketch (the
    browser sends the artwork with the user's marks flattened onto it, plus an
    optional note on what the marks should become)."""
    job = _find_job(job_id)
    if job is None:
        return jsonify(error=JOB_GONE_MESSAGE), 410
    versions = job.get("versions") or []
    if not versions:
        return jsonify(error="This artwork can't be edited."), 400
    if len(versions) >= MAX_VERSIONS:
        return jsonify(error=f"You've reached the limit of {MAX_VERSIONS - 1} edits for this artwork."), 400

    try:
        base_version = int(request.form.get("base_version", len(versions) - 1))
    except ValueError:
        base_version = -1
    if not 0 <= base_version < len(versions):
        return jsonify(error="Unknown version to edit."), 400
    base_png = _version_png(versions[base_version])

    mode = request.form.get("mode")
    note = (request.form.get("prompt") or "").strip()[:1000]
    if mode == "text":
        if not note:
            return jsonify(error="Describe the change you'd like to make."), 400
        images = [base_png]
        prompt = EDIT_TEXT_PROMPT.format(instruction=note)
        label = note
    elif mode == "sketch":
        sketch = request.files.get("sketch")
        sketch_png = sketch.read(MAX_SKETCH_BYTES + 1) if sketch else b""
        if not sketch_png.startswith(PNG_SIGNATURE) or len(sketch_png) > MAX_SKETCH_BYTES:
            return jsonify(error="Draw on the artwork first."), 400
        images = [sketch_png, base_png]
        prompt = EDIT_SKETCH_PROMPT
        if note:
            prompt += f"\n\nThe user describes what the marks should become: {note}"
        label = f"Sketch: {note}" if note else "Sketch edit"
    else:
        return jsonify(error="Unknown edit mode."), 400

    with _jobs_lock:
        if job.get("editing"):
            return jsonify(error="An edit is already in progress."), 409
        job["editing"] = True
    try:
        edited_png, error = _edit_artwork_image(images, prompt)
    finally:
        with _jobs_lock:
            job["editing"] = False
    if error:
        return jsonify(error=error), 502

    stored = _store_version(job_id, edited_png, label)
    with _jobs_lock:
        versions.append(stored)
        version = len(versions) - 1
    return jsonify(
        version=version,
        label=label,
        url=url_for("analyze_image", job_id=job_id, version=version),
    )


MAX_TITLE_CHARS = 120
MAX_ART_DESCRIPTION_CHARS = 2000
BOARD_FILTERS = {
    "all": lambda art: True,
    "drafts": lambda art: not art["is_published"],
    "published": lambda art: art["is_published"],
}


def _wants_json():
    return request.accept_mimetypes.best == "application/json"


def _read_artwork_details():
    """Returns (title, description) from the submitted form, trimmed to size."""
    title = (request.form.get("title") or "").strip()[:MAX_TITLE_CHARS]
    description = (request.form.get("description") or "").strip()[:MAX_ART_DESCRIPTION_CHARS]
    return title, description


def _board_return_url():
    """Where board actions land afterwards: the filtered board view the
    action came from, never an outside site."""
    next_url = request.form.get("next") or ""
    if next_url.startswith("/board"):
        return next_url
    return url_for("board")


def _get_own_artwork_or_404(artwork_id):
    artwork = store.get_artwork(artwork_id)
    if artwork is None or artwork["user_id"] != str(g.user["id"]):
        abort(404)
    return artwork


@app.route("/board/save", methods=["POST"])
@login_required
def board_save():
    """Saves the chosen version of an Analyze result to the artist's board,
    as a draft or published. Posting again with artwork_id updates that
    artwork instead of creating a new one."""
    title, description = _read_artwork_details()
    publish = request.form.get("action") == "publish"

    def fail(message, status=400):
        if _wants_json():
            return jsonify(error=message), status
        flash(message, "error")
        return redirect(url_for("analyze", job=request.form.get("job_id")))

    job = _find_job(request.form.get("job_id", ""))
    if job is None or job["stage"] != "done":
        if _wants_json():
            return jsonify(error=JOB_GONE_MESSAGE), 410
        flash(JOB_GONE_MESSAGE, "error")
        return redirect(url_for("analyze"))

    if publish and not title:
        return fail("Give your artwork a title before publishing it.")

    versions = job.get("versions") or []
    if versions:
        version = request.form.get("version", type=int)
        if version is None:
            version = len(versions) - 1
        if not 0 <= version < len(versions):
            return fail("Unknown version to save.")
        image, image_mime = _version_png(versions[version]), "image/png"
    elif job["result"].get("artwork_svg"):
        image, image_mime = job["result"]["artwork_svg"].encode("utf-8"), "image/svg+xml"
    else:
        return fail("There's no artwork to save.")

    analysis = job["result"].get("analysis") or {}
    summary = {
        "song_title": analysis.get("song_title"),
        "song_artist": analysis.get("song_artist"),
        "mood": analysis.get("mood"),
        "tempo_bpm": analysis.get("tempo_bpm"),
        "key": analysis.get("key"),
        "dominant_instruments": analysis.get("dominant_instruments") or [],
    }

    artwork_id = request.form.get("artwork_id") or None
    try:
        if artwork_id:
            _get_own_artwork_or_404(artwork_id)
            store.update_artwork(
                artwork_id, image=image, mime=image_mime,
                title=title, description=description, analysis=summary, is_published=publish,
            )
        else:
            artwork_id = store.create_artwork(g.user, title, description, summary, publish, image, image_mime)
    except ValueError as exc:
        return fail(str(exc))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - database outages etc.; keep the artwork on the page
        print(f"saving artwork failed: {exc!r}", flush=True)
        return fail("Couldn't reach the database to save your artwork. Please try again in a moment.", 502)

    message = "Published to the gallery." if publish else "Saved to your board as a draft."
    if _wants_json():
        return jsonify(artwork_id=artwork_id, published=publish, message=message, board_url=url_for("board"))
    flash(message, "success")
    return redirect(url_for("board"))


def _for_display(artworks, liked=frozenset()):
    """Adds what the templates show: image and page links, date, the
    artist's current display name (nickname, else username), and whether
    the signed-in user has liked each one."""
    names = store.display_names(art["user_id"] for art in artworks)
    for art in artworks:
        art["image_url"] = url_for("artwork_image", artwork_id=art["id"])
        art["page_url"] = url_for("artwork_page", artwork_id=art["id"])
        art["date"] = (art.get("published_at") or art["created_at"]).strftime("%Y-%m-%d")
        art["artist"] = names.get(art["user_id"]) or art.get("username") or "Unknown artist"
        art["liked"] = art["id"] in liked
        art["is_mine"] = bool(g.user) and art["user_id"] == str(g.user["id"])
    return artworks


@app.route("/board")
@login_required
def board():
    show = request.args.get("show", "all")
    if show not in BOARD_FILTERS:
        show = "all"
    mine = store.list_artworks(user_id=g.user["id"])
    published = sum(1 for art in mine if art["is_published"])
    return render_template(
        "board.html",
        artworks=_for_display([art for art in mine if BOARD_FILTERS[show](art)]),
        show=show,
        counts={"all": len(mine), "published": published, "drafts": len(mine) - published},
    )


@app.route("/board/<artwork_id>/details", methods=["POST"])
@login_required
def board_update_details(artwork_id):
    artwork = _get_own_artwork_or_404(artwork_id)
    title, description = _read_artwork_details()
    if artwork["is_published"] and not title:
        flash("Published artworks need a title.", "error")
    else:
        store.update_artwork(artwork_id, title=title, description=description)
        flash("Artwork details updated.", "success")
    return redirect(_board_return_url())


@app.route("/board/<artwork_id>/publish", methods=["POST"])
@login_required
def board_publish(artwork_id):
    artwork = _get_own_artwork_or_404(artwork_id)
    if not artwork["title"]:
        flash("Give your artwork a title before publishing it.", "error")
    else:
        store.update_artwork(artwork_id, is_published=True)
        flash(f"“{artwork['title']}” is now in the gallery.", "success")
    return redirect(_board_return_url())


@app.route("/board/<artwork_id>/unpublish", methods=["POST"])
@login_required
def board_unpublish(artwork_id):
    _get_own_artwork_or_404(artwork_id)
    store.update_artwork(artwork_id, is_published=False)
    flash("Moved back to drafts; it's no longer in the gallery.", "success")
    return redirect(_board_return_url())


@app.route("/board/<artwork_id>/delete", methods=["POST"])
@login_required
def board_delete(artwork_id):
    _get_own_artwork_or_404(artwork_id)
    store.delete_artwork(artwork_id)
    flash("Artwork deleted.", "success")
    return redirect(_board_return_url())


@app.route("/artworks/<artwork_id>/image")
def artwork_image(artwork_id):
    """Published artworks are public; drafts are visible only to their artist."""
    artwork = store.get_artwork(artwork_id)
    if artwork is None or not (artwork["is_published"] or artwork["user_id"] == str(session.get("user_id"))):
        abort(404)
    found = store.get_artwork_image(artwork_id)
    if found is None:
        abort(404)
    image, mime = found
    response = app.response_class(image, mimetype=mime)
    response.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'"
    return response


@app.route("/gallery")
def gallery():
    liked = store.liked_artwork_ids(g.user["id"]) if g.user else frozenset()
    return render_template("gallery.html", artworks=_for_display(store.list_artworks(published_only=True), liked))


MAX_COMMENT_CHARS = 500
COMMENT_COOLDOWN_SEC = 5
_last_comment_at = {}
_last_comment_lock = threading.Lock()


def _viewable_artwork_or_404(artwork_id):
    """Published artworks are public; drafts only to their artist."""
    artwork = store.get_artwork(artwork_id)
    if artwork is None:
        abort(404)
    if not artwork["is_published"] and not (g.user and artwork["user_id"] == str(g.user["id"])):
        abort(404)
    return artwork


def _back_to_art(artwork_id, anchor=""):
    return redirect(url_for("artwork_page", artwork_id=artwork_id) + anchor)


@app.route("/art/<artwork_id>")
def artwork_page(artwork_id):
    artwork = _viewable_artwork_or_404(artwork_id)
    comments = store.list_comments(artwork_id) if artwork["is_published"] else []
    liked = {artwork_id} if g.user and store.has_liked(artwork_id, g.user["id"]) else frozenset()
    _for_display([artwork], liked)
    names = store.display_names(c["user_id"] for c in comments)
    for comment in comments:
        comment["author"] = names.get(comment["user_id"]) or comment.get("username") or "Unknown artist"
        comment["date"] = comment["created_at"].strftime("%Y-%m-%d %H:%M")
        comment["can_delete"] = bool(g.user) and str(g.user["id"]) in (comment["user_id"], artwork["user_id"])
        comment["by_artist"] = comment["user_id"] == artwork["user_id"]
    return render_template(
        "artwork.html", art=artwork, comments=comments, max_comment=MAX_COMMENT_CHARS,
    )


@app.route("/art/<artwork_id>/like", methods=["POST"])
def artwork_like(artwork_id):
    """Toggles the signed-in user's like. Answers JSON for the page's script
    ({liked, like_count}); plain form posts go back to where they came from."""
    if not g.user:
        if _wants_json():
            return jsonify(error="Log in to like artworks.", login_url=url_for("login")), 401
        flash("Log in to like artworks.", "error")
        return redirect(url_for("login"))
    artwork = store.get_artwork(artwork_id)
    if artwork is not None and artwork["user_id"] == str(g.user["id"]):
        message = "You can't like your own artwork, but others can!"
        if _wants_json():
            return jsonify(error=message), 403
        flash(message, "error")
        return _back_to_art(artwork_id)
    try:
        liked, count = store.toggle_like(artwork_id, g.user["id"])
    except store.NotAllowed:
        if _wants_json():
            return jsonify(error="This artwork isn't in the gallery anymore."), 404
        abort(404)
    if _wants_json():
        return jsonify(liked=liked, like_count=count)
    next_url = request.form.get("next") or ""
    if next_url.startswith(("/gallery", "/art/")):
        return redirect(next_url)
    return _back_to_art(artwork_id)


@app.route("/art/<artwork_id>/comments", methods=["POST"])
@login_required
def artwork_comment(artwork_id):
    text = (request.form.get("text") or "").strip()
    if not text:
        flash("Write something before posting your comment.", "error")
        return _back_to_art(artwork_id, "#comments")
    if len(text) > MAX_COMMENT_CHARS:
        flash(f"Comments can be up to {MAX_COMMENT_CHARS} characters.", "error")
        return _back_to_art(artwork_id, "#comments")

    now = time.time()
    with _last_comment_lock:
        if now - _last_comment_at.get(g.user["id"], 0) < COMMENT_COOLDOWN_SEC:
            flash("You're commenting a little fast. Wait a few seconds and try again.", "error")
            return _back_to_art(artwork_id, "#comments")
        _last_comment_at[g.user["id"]] = now

    try:
        comment_id = store.add_comment(artwork_id, g.user, text)
    except store.NotAllowed:
        abort(404)
    return _back_to_art(artwork_id, f"#comment-{comment_id}")


@app.route("/comments/<comment_id>/delete", methods=["POST"])
@login_required
def comment_delete(comment_id):
    """The comment's author, or the artist whose artwork it's on, can
    delete it."""
    comment = store.get_comment(comment_id)
    if comment is None:
        abort(404)
    artwork = store.get_artwork(comment["artwork_id"])
    artist_id = artwork["user_id"] if artwork else None
    if str(g.user["id"]) not in (comment["user_id"], artist_id):
        abort(404)
    store.delete_comment(comment_id)
    flash("Comment deleted.", "success")
    return _back_to_art(comment["artwork_id"], "#comments")


if os.environ.get("AURA_SKIP_WARMUP") != "1":
    threading.Thread(target=_warm_up_analyzer, daemon=True).start()


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5050)))
