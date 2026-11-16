"""Short AI video from an artwork, via Google.

Two ways in, picked by what's configured:

- GEMINI_API_KEY set: Gemini Omni Flash through the Gemini API (720p, about
  $0.10 per second, so ~$0.80 for an 8-second clip). It always makes its own
  sound; the browser discards that and sets the clip to the listener's song.
- Otherwise: Veo on Vertex AI, signed in as the Firestore service account
  (see below).

The artwork is the video's first frame. Google only makes 16:9 or 9:16 video,
so the square artwork is centred on a 16:9 canvas and its own edges are
mirrored outward to fill the sides. The whole artwork stays in the first
frame, and with no visible border the model treats it as one wide painting
(a picture boxed between blurred bars gets replaced by a new image).

On Vertex AI it uses the cheapest Veo model by default (Veo 3.1 Lite, 720p, no generated
audio: about $0.05 per second, so ~$0.40 for an 8-second clip). VIDEO_MODEL
in .env switches models, e.g. to veo-3.1-fast-generate-001.

Signs in with the same Google service account as Firestore
(FIREBASE_CREDENTIALS or FIREBASE_CREDENTIALS_PATH). That project needs the
Vertex AI API enabled, billing turned on, and the service account given the
"Vertex AI User" role.
"""

import base64
import io
import json
import os
import time

import requests
from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account
from PIL import Image, ImageOps

DEFAULT_MODEL = "veo-3.1-lite-generate-001"
OMNI_MODEL = "gemini-omni-1.1-flash"
OMNI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
VIDEO_SECONDS = 8
POLL_SEC = 5
TIMEOUT_SEC = 6 * 60

# Omni Flash cuts between "a few different shots" unless told otherwise, and
# it will dissolve into a new image if the prompt invites new shapes, so this
# insists on one shot of this one painting. The timeline in the middle is
# written from the stretch of song the clip will be set to.
VIDEO_PROMPT = (
    "In a single unbroken, continuous shot, this exact painting comes alive, "
    "its movement choreographed to a piece of music. It stays the same "
    "painting from the first frame to the last: its composition, forms, "
    "colours and brushwork remain recognisable throughout, and only move. No "
    "scene cuts, no dissolves, no crossfades, no fades, and no change to a "
    "different image or composition. Follow this timing closely:\n"
    "{timeline}\n"
    "Purely abstract: no objects, figures, faces, landscapes or text.{mood}"
)
# A different kind of movement for each stretch of the timeline.
_EFFECTS = [
    "pigment ripples outward along the existing brushstrokes",
    "ribbons of colour flow and twist like liquid",
    "light blooms through the brightest areas and sweeps across the surface",
    "the forms turn in a swirl around the centre while fine particles of pigment scatter",
]
NEGATIVE_PROMPT = "text, letters, people, faces, animals, objects, realistic scenery, photorealism, watermark, cuts, dissolves, crossfades"
_session = None
_project = None


def _credentials_info():
    raw = os.environ.get("FIREBASE_CREDENTIALS")
    if raw:
        return json.loads(raw)
    with open(os.environ.get("FIREBASE_CREDENTIALS_PATH", "firebase-key.json")) as fh:
        return json.load(fh)


def _google():
    global _session, _project
    if _session is None:
        info = _credentials_info()
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        _session = AuthorizedSession(creds)
        _project = os.environ.get("VIDEO_PROJECT") or info["project_id"]
    return _session, _project


def _first_frame(png):
    """The square artwork centred on a 1920x1080 frame, its edges mirrored
    outward to fill the sides."""
    art = Image.open(io.BytesIO(png)).convert("RGB")
    side = min(art.size)
    art = art.crop(((art.width - side) // 2, (art.height - side) // 2, (art.width + side) // 2, (art.height + side) // 2))
    art = art.resize((1080, 1080), Image.LANCZOS)
    wing = (1920 - 1080) // 2
    frame = Image.new("RGB", (1920, 1080))
    frame.paste(ImageOps.mirror(art.crop((0, 0, wing, 1080))), (0, 0))
    frame.paste(art, (wing, 0))
    frame.paste(ImageOps.mirror(art.crop((1080 - wing, 0, 1080, 1080))), (wing + 1080, 0))
    out = io.BytesIO()
    frame.save(out, format="PNG")
    return out.getvalue()


def _explain(response):
    try:
        message = response.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        message = response.text[:300]
    return f"Google video request failed ({response.status_code}): {message}"


def parse_music(raw):
    """The browser's measurements of the stretch of song the clip is for, as
    {"seconds": n, "segments": [{"energy", "bass", "treble", "beats"}, ...]}.
    Returns the cleaned-up dict, or None if it isn't usable."""
    try:
        data = json.loads(raw)
        seconds = int(data["seconds"])
        segments = [
            {
                "energy": max(0.0, min(1.0, float(seg["energy"]))),
                "bass": max(0.0, min(1.0, float(seg["bass"]))),
                "treble": max(0.0, min(1.0, float(seg["treble"]))),
                "beats": max(0, min(32, int(seg["beats"]))),
            }
            for seg in data["segments"]
        ]
    except (TypeError, ValueError, KeyError):
        return None
    if not 3 <= seconds <= VIDEO_SECONDS or not 1 <= len(segments) <= 8:
        return None
    return {"seconds": seconds, "segments": segments}


def _timeline(music):
    """One line of direction per stretch of the music."""
    span = music["seconds"] / len(music["segments"])
    lines = []
    previous = None
    for i, seg in enumerate(music["segments"]):
        energy = seg["energy"]
        pace = "barely moving, very slow and still" if energy < 0.3 else "fast, forceful and intense" if energy > 0.7 else "at a steady, flowing pace"
        line = f"[{i * span:g}-{(i + 1) * span:g}s] {_EFFECTS[i % len(_EFFECTS)].capitalize()}, {pace}"
        if previous is not None and energy - previous > 0.2:
            line += ", the motion surging upward"
        elif previous is not None and previous - energy > 0.2:
            line += ", the motion falling back"
        if seg["beats"]:
            line += f"; it pulses {seg['beats']} times in sharp, even bursts"
        if seg["bass"] > 0.6:
            line += "; the darkest areas swell heavily"
        if seg["treble"] > 0.6:
            line += "; the highlights shimmer and flicker"
        lines.append(line + ".")
        previous = energy
    return "\n".join(lines)


def generate_video(png, music, mood=""):
    """music comes from parse_music. Returns (mp4_bytes, error_message)."""
    prompt = VIDEO_PROMPT.format(timeline=_timeline(music), mood=f" The feeling is {mood}." if mood else "")
    # Read here rather than at import, after app.py has loaded .env.
    api_key = os.environ.get("GEMINI_API_KEY")
    if api_key:
        return _omni_video(png, prompt, music["seconds"], api_key)
    return _veo_video(png, prompt, music["seconds"])


def _omni_video(png, prompt, seconds, api_key):
    body = {
        "model": os.environ.get("VIDEO_MODEL", OMNI_MODEL),
        "input": [
            {"type": "image", "data": base64.b64encode(_first_frame(png)).decode("ascii"), "mime_type": "image/png"},
            {"type": "text", "text": prompt},
        ],
        "response_format": {"type": "video", "resolution": "720p", "aspect_ratio": "16:9", "duration": f"{seconds}s"},
        "generation_config": {"video_config": {"task": "image_to_video"}},
    }
    try:
        response = requests.post(OMNI_URL, json=body, headers={"x-goog-api-key": api_key}, timeout=TIMEOUT_SEC)
    except requests.RequestException as exc:
        return None, f"Google video request failed ({exc})."
    if not response.ok:
        return None, _explain(response)
    try:
        steps = response.json().get("steps") or []
    except ValueError:
        return None, "Google sent back something that wasn't a video. Please try again."
    for step in steps:
        if step.get("type") != "model_output":
            continue
        for item in step.get("content") or []:
            if item.get("type") == "video" and item.get("data"):
                return base64.b64decode(item["data"]), None
    return None, "Google didn't return a video. Please try again."


def _veo_video(png, prompt, seconds):
    try:
        session, project = _google()
    except (OSError, ValueError, KeyError) as exc:
        return None, f"Google credentials aren't set up ({exc})."

    model = os.environ.get("VIDEO_MODEL", DEFAULT_MODEL)
    location = os.environ.get("VIDEO_LOCATION", "us-central1")
    base = (
        f"https://{location}-aiplatform.googleapis.com/v1/projects/{project}"
        f"/locations/{location}/publishers/google/models/{model}"
    )
    body = {
        "instances": [
            {
                "prompt": prompt,
                "image": {"bytesBase64Encoded": base64.b64encode(_first_frame(png)).decode("ascii"), "mimeType": "image/png"},
            }
        ],
        "parameters": {
            "durationSeconds": seconds if seconds in (4, 6, 8) else VIDEO_SECONDS,
            "aspectRatio": "16:9",
            "resolution": "720p",
            "generateAudio": False,
            "sampleCount": 1,
            "negativePrompt": NEGATIVE_PROMPT,
        },
    }
    try:
        started = session.post(f"{base}:predictLongRunning", json=body, timeout=60)
        if not started.ok:
            return None, _explain(started)
        operation = started.json()["name"]

        deadline = time.time() + TIMEOUT_SEC
        while time.time() < deadline:
            time.sleep(POLL_SEC)
            polled = session.post(f"{base}:fetchPredictOperation", json={"operationName": operation}, timeout=60)
            if not polled.ok:
                return None, _explain(polled)
            result = polled.json()
            if not result.get("done"):
                continue
            if "error" in result:
                return None, f"Google couldn't make the video: {result['error'].get('message', 'unknown error')}"
            videos = (result.get("response") or {}).get("videos") or []
            if not videos or "bytesBase64Encoded" not in videos[0]:
                filtered = (result.get("response") or {}).get("raiMediaFilteredReasons")
                reason = f" ({filtered[0]})" if filtered else ""
                return None, f"Google didn't return a video{reason}. Please try again."
            return base64.b64decode(videos[0]["bytesBase64Encoded"]), None
        return None, "Google took too long to make the video. Please try again."
    except Exception as exc:  # noqa: BLE001 - network errors become a message for the page
        return None, f"Google video request failed ({exc})."
