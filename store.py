"""Firestore data layer for AURA: user accounts and saved artworks.

Collections:
  users/{id}             username, email, password_hash, created_at
  usernames/{key}        {user_id} -- claims a username (case-insensitive)
  emails/{key}           {user_id} -- claims an email address
  artworks/{id}          artwork details shown on the board and gallery
  artwork_images/{id}    the image itself, kept apart so listing artworks
                         doesn't download every image

Credentials come from FIREBASE_CREDENTIALS (the service-account JSON itself,
used in production) or the key file at FIREBASE_CREDENTIALS_PATH (default
firebase-key.json, used locally).
"""

import hashlib
import io
import json
import os
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from PIL import Image

# Firestore documents max out at 1 MiB; leave room for the other fields.
MAX_IMAGE_BYTES = 900 * 1024

_client = None


class AlreadyTaken(Exception):
    """The username or email is already registered."""


def _db():
    global _client
    if _client is None:
        raw = os.environ.get("FIREBASE_CREDENTIALS")
        if raw:
            cred = credentials.Certificate(json.loads(raw))
        else:
            cred = credentials.Certificate(os.environ.get("FIREBASE_CREDENTIALS_PATH", "firebase-key.json"))
        firebase_admin.initialize_app(cred)
        _client = firestore.client()
    return _client


def _now():
    return datetime.now(timezone.utc)


def _claim_key(value):
    # Hashed so any username/email is a valid document id, and lowercased so
    # "Ana" and "ana" can't both register.
    return hashlib.sha256(value.strip().lower().encode("utf-8")).hexdigest()


# --- Users ---


def get_user(user_id):
    snap = _db().collection("users").document(str(user_id)).get()
    if not snap.exists:
        return None
    data = snap.to_dict()
    return {"id": snap.id, "username": data["username"], "email": data["email"]}


def find_user_for_login(username):
    """Returns {id, username, password_hash} or None. Case-insensitive."""
    claim = _db().collection("usernames").document(_claim_key(username)).get()
    if not claim.exists:
        return None
    snap = _db().collection("users").document(claim.get("user_id")).get()
    if not snap.exists:
        return None
    data = snap.to_dict()
    return {"id": snap.id, "username": data["username"], "password_hash": data["password_hash"]}


def create_user(username, email, password_hash, created_at=None, user_id=None):
    """Creates the account, raising AlreadyTaken if the username or email is
    in use. The claims and the user are written in one transaction, so two
    simultaneous sign-ups can't both get the same name."""
    db = _db()
    user_ref = db.collection("users").document(user_id) if user_id else db.collection("users").document()
    username_ref = db.collection("usernames").document(_claim_key(username))
    email_ref = db.collection("emails").document(_claim_key(email))

    @firestore.transactional
    def create(transaction):
        if username_ref.get(transaction=transaction).exists or email_ref.get(transaction=transaction).exists:
            raise AlreadyTaken()
        transaction.set(user_ref, {
            "username": username,
            "email": email,
            "password_hash": password_hash,
            "created_at": created_at or _now(),
        })
        transaction.set(username_ref, {"user_id": user_ref.id})
        transaction.set(email_ref, {"user_id": user_ref.id})

    create(db.transaction())
    return user_ref.id


# --- Artworks ---


def _fit_image(image, mime):
    """Generated PNGs can exceed Firestore's per-document limit, so large
    ones are re-encoded as high-quality WebP (visually the same at this size)."""
    if len(image) <= MAX_IMAGE_BYTES:
        return image, mime
    if mime != "image/png":
        raise ValueError("This artwork is too large to save.")
    picture = Image.open(io.BytesIO(image)).convert("RGB")
    for quality in (92, 85, 78, 70, 60):
        out = io.BytesIO()
        picture.save(out, "WEBP", quality=quality, method=6)
        if out.tell() <= MAX_IMAGE_BYTES:
            return out.getvalue(), "image/webp"
    raise ValueError("This artwork is too large to save.")


def _artwork_dict(snap):
    data = snap.to_dict()
    data["id"] = snap.id
    data.setdefault("analysis", {})
    return data


def get_artwork(artwork_id):
    snap = _db().collection("artworks").document(artwork_id).get()
    return _artwork_dict(snap) if snap.exists else None


def list_artworks(user_id=None, published_only=False):
    """Newest first. Filtering and sorting happen here rather than in the
    query so Firestore needs no composite indexes."""
    query = _db().collection("artworks")
    if user_id is not None:
        query = query.where(filter=FieldFilter("user_id", "==", str(user_id)))
    elif published_only:
        query = query.where(filter=FieldFilter("is_published", "==", True))
    artworks = [_artwork_dict(snap) for snap in query.stream()]
    artworks.sort(key=lambda a: a.get("published_at") or a["created_at"], reverse=True)
    return artworks


def create_artwork(user, title, description, analysis, publish, image, mime, created_at=None):
    image, mime = _fit_image(image, mime)
    db = _db()
    ref = db.collection("artworks").document()
    now = created_at or _now()
    batch = db.batch()
    batch.set(ref, {
        "user_id": str(user["id"]),
        "username": user["username"],
        "title": title,
        "description": description,
        "analysis": analysis,
        "image_mime": mime,
        "is_published": bool(publish),
        "created_at": now,
        "updated_at": now,
        "published_at": now if publish else None,
    })
    batch.set(db.collection("artwork_images").document(ref.id), {"data": image, "mime": mime})
    batch.commit()
    return ref.id


def update_artwork(artwork_id, image=None, mime=None, **fields):
    """Updates the given fields. Setting is_published keeps the original
    publish date when re-publishing and clears it when unpublishing."""
    db = _db()
    ref = db.collection("artworks").document(artwork_id)
    if "is_published" in fields:
        if not fields["is_published"]:
            fields["published_at"] = None
        elif not (ref.get().to_dict() or {}).get("published_at"):
            fields["published_at"] = _now()
    fields["updated_at"] = _now()
    batch = db.batch()
    if image is not None:
        image, mime = _fit_image(image, mime)
        fields["image_mime"] = mime
        batch.set(db.collection("artwork_images").document(artwork_id), {"data": image, "mime": mime})
    batch.update(ref, fields)
    batch.commit()


def delete_artwork(artwork_id):
    db = _db()
    batch = db.batch()
    batch.delete(db.collection("artworks").document(artwork_id))
    batch.delete(db.collection("artwork_images").document(artwork_id))
    batch.commit()


def get_artwork_image(artwork_id):
    """Returns (bytes, mime) or None."""
    snap = _db().collection("artwork_images").document(artwork_id).get()
    if not snap.exists:
        return None
    return snap.get("data"), snap.get("mime")
