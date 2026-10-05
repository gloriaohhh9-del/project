import base64
import json
import os
import sqlite3
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, flash, g, redirect, render_template, request, session, url_for
from openai import OpenAI
from werkzeug.security import check_password_hash, generate_password_hash

from art_generator import generate_svg
from audio_analysis import analyze_audio

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-in-production")
app.config["DATABASE"] = os.path.join(app.instance_path, "aura.db")
app.config["MAX_CONTENT_LENGTH"] = 15 * 1024 * 1024  # 15 MB upload limit

ALLOWED_AUDIO_EXTENSIONS = {"mp3", "wav"}
openai_client = OpenAI() if os.environ.get("OPENAI_API_KEY") else None


def allowed_audio_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_AUDIO_EXTENSIONS


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(app.instance_path, exist_ok=True)
    db = sqlite3.connect(app.config["DATABASE"])
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    db.commit()
    db.close()


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
    g.user = None
    if "user_id" in session:
        db = get_db()
        g.user = db.execute(
            "SELECT id, username, email FROM users WHERE id = ?",
            (session["user_id"],),
        ).fetchone()


with app.app_context():
    init_db()


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

        db = get_db()
        existing = db.execute(
            "SELECT id FROM users WHERE username = ? OR email = ?",
            (username, email),
        ).fetchone()

        if existing:
            flash("Username or email is already taken.", "error")
            return render_template("signup.html")

        db.execute(
            "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
            (username, email, generate_password_hash(password, method="pbkdf2:sha256")),
        )
        db.commit()

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

        db = get_db()
        user = db.execute(
            "SELECT id, username, password_hash FROM users WHERE username = ?",
            (username,),
        ).fetchone()

        if user is None or not check_password_hash(user["password_hash"], password):
            flash("Invalid username or password.", "error")
            return render_template("login.html")

        session.clear()
        session["user_id"] = user["id"]
        session["username"] = user["username"]
        flash(f"Welcome back, {user['username']}!", "success")
        return redirect(url_for("index"))

    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    flash("You have been logged out.", "success")
    return redirect(url_for("index"))


@app.route("/draw")
@login_required
def draw():
    return render_template("draw.html")


# DSP (via librosa) now measures tempo, energy, rhythm, and key directly from
# the audio signal, so GPT is only asked for the qualitative layer it's
# actually suited to: mood, instrumentation, and a creative color palette.
ANALYSIS_SYSTEM_PROMPT = (
    "You are a music analysis engine for a generative art tool. Listen to the "
    "provided audio and respond with ONLY a JSON object (no prose, no markdown) "
    "with these fields: mood (one short word, e.g. 'energetic', 'calm', "
    "'melancholic', 'triumphant'), dominant_instruments (array of up to 4 short "
    "strings, e.g. 'drums', 'synth bass', 'lead vocal', 'strings'), "
    "color_palette (array of exactly 4 hex color strings that visually "
    "represent the track's mood and energy), and art_prompt (a vivid, specific "
    "2-4 sentence description of a standalone piece of abstract generative art "
    "that captures how THIS track actually sounds and feels -- its own shapes, "
    "composition, textures, and color treatment. Make it distinct: invent "
    "concrete visual details tied to what you hear (e.g. specific forms, "
    "materials, lighting, motion) rather than generic mood words, so that a "
    "different-sounding track would clearly get a different description)."
)

IMAGE_STYLE_SUFFIX = (
    " The image itself must be abstract generative art only: no text, no "
    "letters, no words, no watermarks, no photographic people or faces. "
    "Square composition, full-bleed, gallery quality."
)


def _parse_json_response(raw_content):
    raw_content = raw_content.strip()
    if raw_content.startswith("```"):
        raw_content = raw_content.strip("`")
        if raw_content.startswith("json"):
            raw_content = raw_content[4:]
        raw_content = raw_content.strip()
    return json.loads(raw_content)


def _get_gpt_analysis(audio_bytes, audio_format):
    """Qualitative pass via GPT: mood, instruments, palette. Returns {} on failure
    so the page can still render DSP-only art rather than failing outright."""
    if openai_client is None:
        return {}, "OPENAI_API_KEY is not configured on the server, so mood/instrument/color analysis was skipped."

    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
    try:
        completion = openai_client.chat.completions.create(
            model="gpt-audio",
            modalities=["text"],
            messages=[
                {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Analyze this track and return the JSON object described."},
                        {"type": "input_audio", "input_audio": {"data": audio_b64, "format": audio_format}},
                    ],
                },
            ],
        )
        return _parse_json_response(completion.choices[0].message.content), None
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, DSP art still works
        return {}, f"GPT mood/instrument analysis failed ({exc}); showing DSP-only art."


def _build_image_prompt(dsp, gpt):
    """Ground GPT's freeform art_prompt with a few hard facts from the DSP
    pass and the measured color palette, so the generated image still traces
    back to the actual track rather than being pure GPT improvisation."""
    art_prompt = (gpt.get("art_prompt") or "").strip()
    if not art_prompt:
        mood = gpt.get("mood", "neutral")
        art_prompt = f"An abstract piece of generative art capturing a {mood}-sounding track."

    palette = [c for c in (gpt.get("color_palette") or []) if isinstance(c, str) and c.startswith("#")]
    facts = [
        f"tempo {dsp.get('tempo_bpm', '?')} BPM",
        f"key {dsp.get('key', '?')}",
        f"{'high' if dsp.get('energy', 0.5) > 0.6 else 'low' if dsp.get('energy', 0.5) < 0.4 else 'moderate'} loudness",
        f"{dsp.get('section_count', len(dsp.get('sections', [])))} structural sections",
    ]
    if palette:
        facts.append("color palette of " + ", ".join(palette))

    return f"{art_prompt} Ground the piece in these real measurements from the track: {'; '.join(facts)}.{IMAGE_STYLE_SUFFIX}"


def _generate_artwork_image(dsp, gpt):
    """Full image-generation pass: turns the track's analysis into a genuinely
    new piece of art per song (new composition, shapes, and colors each time)
    rather than recombining a fixed set of procedural shapes. Returns
    (data_uri, warning) -- data_uri is None on failure so the caller can fall
    back to the deterministic procedural SVG."""
    if openai_client is None:
        return None, "OPENAI_API_KEY is not configured on the server, so image generation was skipped."

    prompt = _build_image_prompt(dsp, gpt)
    try:
        response = openai_client.images.generate(model="gpt-image-1", prompt=prompt, size="1024x1024")
        b64_data = response.data[0].b64_json
        return f"data:image/png;base64,{b64_data}", None
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, procedural art still works
        return None, f"Image generation failed ({exc}); showing procedural art instead."


@app.route("/analyze", methods=["GET", "POST"])
@login_required
def analyze():
    analysis = None
    artwork_svg = None
    artwork_image = None
    artwork_description = None

    if request.method == "POST":
        file = request.files.get("music_file")
        if not file or file.filename == "":
            flash("Please choose an audio file.", "error")
            return render_template("analyze.html", analysis=None, artwork_svg=None, artwork_image=None, artwork_description=None)

        if not allowed_audio_file(file.filename):
            flash("Only .mp3 and .wav files are supported.", "error")
            return render_template("analyze.html", analysis=None, artwork_svg=None, artwork_image=None, artwork_description=None)

        audio_format = file.filename.rsplit(".", 1)[1].lower()
        audio_bytes = file.read()

        try:
            dsp = analyze_audio(audio_bytes, audio_format)
        except Exception as exc:  # noqa: BLE001 - surface DSP failures (corrupt/short file, etc.)
            flash(f"Audio analysis failed: {exc}", "error")
            return render_template("analyze.html", analysis=None, artwork_svg=None, artwork_image=None, artwork_description=None)

        gpt, gpt_warning = _get_gpt_analysis(audio_bytes, audio_format)
        if gpt_warning:
            flash(gpt_warning, "error")

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
        }

        artwork_image, image_warning = _generate_artwork_image(dsp, gpt)
        if artwork_image is None:
            if image_warning:
                flash(image_warning, "error")
            artwork_svg = generate_svg(dsp, gpt)
        artwork_description = gpt.get("art_prompt")

    return render_template(
        "analyze.html",
        analysis=analysis,
        artwork_svg=artwork_svg,
        artwork_image=artwork_image,
        artwork_description=artwork_description,
    )


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5050)))
