"""Firestore data layer for AURA: user accounts, saved artworks, and the
likes and comments on published artworks.

Collections:
  users/{id}             username, email, password_hash (None for Google-only
                         accounts), nickname, google_uid, created_at
  usernames/{key}        {user_id} -- claims a username (case-insensitive)
  emails/{key}           {user_id} -- claims an email address
  google_accounts/{uid}  {user_id} -- links a Google (Firebase Auth) account
  artworks/{id}          artwork details shown on the board and gallery, plus
                         like_count and comment_count
  artwork_images/{id}    the image itself, kept apart so listing artworks
                         doesn't download every image
  likes/{artwork}_{user} artwork_id, user_id, created_at -- one per like, so
                         a user can like an artwork only once
  comments/{id}          artwork_id, user_id, username, text, created_at

Credentials come from FIREBASE_CREDENTIALS (the service-account JSON itself,
used in production) or the key file at FIREBASE_CREDENTIALS_PATH (default
firebase-key.json, used locally).
"""

import hashlib
import io
import json
import os
import re
import secrets
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import auth, credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from PIL import Image

# Firestore documents max out at 1 MiB; leave room for the other fields.
MAX_IMAGE_BYTES = 900 * 1024
# Firestore batches hold at most 500 writes.
BATCH_LIMIT = 450

_client = None
_project_id = None


class AlreadyTaken(Exception):
    """The username or email is already registered."""


def _db():
    global _client, _project_id
    if _client is None:
        raw = os.environ.get("FIREBASE_CREDENTIALS")
        if raw:
            info = json.loads(raw)
        else:
            with open(os.environ.get("FIREBASE_CREDENTIALS_PATH", "firebase-key.json")) as fh:
                info = json.load(fh)
        _project_id = info.get("project_id")
        firebase_admin.initialize_app(credentials.Certificate(info))
        _client = firestore.client()
    return _client


def project_id():
    """The Firebase project id, from the service-account credentials."""
    _db()
    return _project_id


def _now():
    return datetime.now(timezone.utc)


def _claim_key(value):
    # Hashed so any username/email is a valid document id, and lowercased so
    # "Ana" and "ana" can't both register.
    return hashlib.sha256(value.strip().lower().encode("utf-8")).hexdigest()


def _commit_in_batches(db, refs_to_delete):
    refs_to_delete = list(refs_to_delete)
    for start in range(0, len(refs_to_delete), BATCH_LIMIT):
        batch = db.batch()
        for ref in refs_to_delete[start:start + BATCH_LIMIT]:
            batch.delete(ref)
        batch.commit()


# --- Users ---


def _user_dict(snap):
    data = snap.to_dict()
    return {
        "id": snap.id,
        "username": data["username"],
        "email": data["email"],
        "nickname": data.get("nickname") or "",
        "has_password": bool(data.get("password_hash")),
        "google_linked": bool(data.get("google_uid")),
    }


def get_user(user_id):
    snap = _db().collection("users").document(str(user_id)).get()
    return _user_dict(snap) if snap.exists else None


def find_user_for_login(username):
    """Returns {id, username, nickname, password_hash} or None.
    Case-insensitive. password_hash is None for Google-only accounts."""
    claim = _db().collection("usernames").document(_claim_key(username)).get()
    if not claim.exists:
        return None
    snap = _db().collection("users").document(claim.get("user_id")).get()
    if not snap.exists:
        return None
    data = snap.to_dict()
    return {
        "id": snap.id,
        "username": data["username"],
        "nickname": data.get("nickname") or "",
        "password_hash": data.get("password_hash"),
    }


def username_taken(username):
    return _db().collection("usernames").document(_claim_key(username)).get().exists


def create_user(username, email, password_hash, created_at=None, user_id=None, nickname="", google_uid=None):
    """Creates the account, raising AlreadyTaken if the username, email, or
    Google account is in use. The claims and the user are written in one
    transaction, so two simultaneous sign-ups can't both get the same name.
    Returns the new user's id."""
    db = _db()
    user_ref = db.collection("users").document(user_id) if user_id else db.collection("users").document()
    claim_refs = [
        db.collection("usernames").document(_claim_key(username)),
        db.collection("emails").document(_claim_key(email)),
    ]
    if google_uid:
        claim_refs.append(db.collection("google_accounts").document(google_uid))

    @firestore.transactional
    def create(transaction):
        if any(ref.get(transaction=transaction).exists for ref in claim_refs):
            raise AlreadyTaken()
        transaction.set(user_ref, {
            "username": username,
            "email": email,
            "password_hash": password_hash,
            "nickname": nickname,
            "google_uid": google_uid,
            "created_at": created_at or _now(),
        })
        for ref in claim_refs:
            transaction.set(ref, {"user_id": user_ref.id})

    create(db.transaction())
    return user_ref.id


def set_nickname(user_id, nickname):
    _db().collection("users").document(str(user_id)).update({"nickname": nickname})


def display_names(user_ids):
    """{user_id: nickname, or username when no nickname is set} for the
    given ids, fetched in one round trip."""
    ids = sorted({str(i) for i in user_ids if i})
    if not ids:
        return {}
    db = _db()
    names = {}
    for snap in db.get_all([db.collection("users").document(i) for i in ids]):
        if snap.exists:
            data = snap.to_dict()
            names[snap.id] = data.get("nickname") or data["username"]
    return names


# --- Google sign-in (Firebase Authentication) ---


def verify_google_token(id_token):
    """Checks a Firebase ID token from the browser's Google sign-in and
    returns its claims (uid, email, email_verified, name, ...). Raises
    ValueError if the token is invalid or expired."""
    _db()  # initializes the Firebase app
    try:
        return auth.verify_id_token(id_token)
    except Exception as exc:  # noqa: BLE001 - the SDK raises several types
        raise ValueError(f"Google sign-in could not be verified ({exc}).") from exc


def find_user_by_google(google_uid):
    claim = _db().collection("google_accounts").document(google_uid).get()
    return get_user(claim.get("user_id")) if claim.exists else None


def find_user_by_email(email):
    claim = _db().collection("emails").document(_claim_key(email)).get()
    return get_user(claim.get("user_id")) if claim.exists else None


def link_google(user_id, google_uid):
    """Attaches a Google account to an existing user. Raises AlreadyTaken if
    that Google account already belongs to someone."""
    db = _db()
    claim_ref = db.collection("google_accounts").document(google_uid)
    user_ref = db.collection("users").document(str(user_id))

    @firestore.transactional
    def link(transaction):
        claim = claim_ref.get(transaction=transaction)
        if claim.exists and claim.get("user_id") != str(user_id):
            raise AlreadyTaken()
        transaction.set(claim_ref, {"user_id": str(user_id)})
        transaction.update(user_ref, {"google_uid": google_uid})

    link(db.transaction())


def suggest_username(*candidates):
    """A free username built from the first usable candidate (e.g. the
    Google display name or the email's local part): lowercase letters,
    digits, and underscores, with a number added if it's taken."""
    base = ""
    for candidate in candidates:
        base = re.sub(r"[^a-z0-9_]+", "", (candidate or "").lower().replace(" ", "_"))[:20]
        if len(base) >= 3:
            break
    if len(base) < 3:
        base = "artist"
    if not username_taken(base):
        return base
    for _ in range(20):
        name = f"{base}{secrets.randbelow(9000) + 1000}"
        if not username_taken(name):
            return name
    return f"{base}_{secrets.token_hex(4)}"


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
    data["like_count"] = max(0, data.get("like_count") or 0)
    data["comment_count"] = max(0, data.get("comment_count") or 0)
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
        "like_count": 0,
        "comment_count": 0,
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
    """Deletes the artwork, its image, and its likes and comments."""
    db = _db()
    batch = db.batch()
    batch.delete(db.collection("artworks").document(artwork_id))
    batch.delete(db.collection("artwork_images").document(artwork_id))
    batch.commit()
    for name in ("likes", "comments"):
        query = db.collection(name).where(filter=FieldFilter("artwork_id", "==", artwork_id))
        _commit_in_batches(db, (snap.reference for snap in query.stream()))


def get_artwork_image(artwork_id):
    """Returns (bytes, mime) or None."""
    snap = _db().collection("artwork_images").document(artwork_id).get()
    if not snap.exists:
        return None
    return snap.get("data"), snap.get("mime")


# --- Likes ---


class NotAllowed(Exception):
    """The artwork can't be liked or commented on (gone or not published)."""


def toggle_like(artwork_id, user_id):
    """Likes the artwork, or removes the like if the user already liked it.
    Returns (liked, like_count). Raises NotAllowed for missing or
    unpublished artworks."""
    db = _db()
    art_ref = db.collection("artworks").document(artwork_id)
    like_ref = db.collection("likes").document(f"{artwork_id}_{user_id}")

    @firestore.transactional
    def toggle(transaction):
        art = art_ref.get(transaction=transaction)
        if not art.exists or not art.get("is_published"):
            raise NotAllowed()
        count = max(0, art.to_dict().get("like_count") or 0)
        if like_ref.get(transaction=transaction).exists:
            transaction.delete(like_ref)
            transaction.update(art_ref, {"like_count": max(0, count - 1)})
            return False, max(0, count - 1)
        transaction.set(like_ref, {"artwork_id": artwork_id, "user_id": str(user_id), "created_at": _now()})
        transaction.update(art_ref, {"like_count": count + 1})
        return True, count + 1

    return toggle(db.transaction())


def has_liked(artwork_id, user_id):
    return _db().collection("likes").document(f"{artwork_id}_{user_id}").get().exists


def liked_artwork_ids(user_id):
    """Ids of every artwork this user has liked."""
    query = _db().collection("likes").where(filter=FieldFilter("user_id", "==", str(user_id)))
    return {snap.get("artwork_id") for snap in query.stream()}


# --- Comments ---


def _comment_dict(snap):
    data = snap.to_dict()
    data["id"] = snap.id
    return data


def list_comments(artwork_id):
    """Oldest first, so a conversation reads top to bottom."""
    query = _db().collection("comments").where(filter=FieldFilter("artwork_id", "==", artwork_id))
    comments = [_comment_dict(snap) for snap in query.stream()]
    comments.sort(key=lambda c: c["created_at"])
    return comments


def add_comment(artwork_id, user, text):
    """Adds a comment and bumps the artwork's comment count. Raises
    NotAllowed for missing or unpublished artworks. Returns the comment id."""
    db = _db()
    art_ref = db.collection("artworks").document(artwork_id)
    comment_ref = db.collection("comments").document()

    @firestore.transactional
    def add(transaction):
        art = art_ref.get(transaction=transaction)
        if not art.exists or not art.get("is_published"):
            raise NotAllowed()
        transaction.set(comment_ref, {
            "artwork_id": artwork_id,
            "user_id": str(user["id"]),
            "username": user["username"],
            "text": text,
            "created_at": _now(),
        })
        transaction.update(art_ref, {"comment_count": max(0, art.to_dict().get("comment_count") or 0) + 1})

    add(db.transaction())
    return comment_ref.id


def get_comment(comment_id):
    snap = _db().collection("comments").document(comment_id).get()
    return _comment_dict(snap) if snap.exists else None


def delete_comment(comment_id):
    """Removes the comment and lowers its artwork's comment count."""
    db = _db()
    comment_ref = db.collection("comments").document(comment_id)

    @firestore.transactional
    def remove(transaction):
        comment = comment_ref.get(transaction=transaction)
        if not comment.exists:
            return
        art_ref = db.collection("artworks").document(comment.get("artwork_id"))
        art = art_ref.get(transaction=transaction)
        transaction.delete(comment_ref)
        if art.exists:
            transaction.update(art_ref, {"comment_count": max(0, (art.to_dict().get("comment_count") or 0) - 1)})

    remove(db.transaction())
