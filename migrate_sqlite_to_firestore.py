"""One-time copy of the old SQLite database (instance/aura.db) into Firestore.

Users keep their ids and password hashes, so existing logins keep working.
Safe to re-run: accounts that already exist are skipped, and artworks are
only copied for users created in this run.

    .venv/bin/python migrate_sqlite_to_firestore.py
"""

import json
import sqlite3
from datetime import datetime, timezone

from dotenv import load_dotenv

load_dotenv()

import store  # noqa: E402 - needs the env loaded first


def parse_time(value):
    if not value:
        return None
    return datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def main():
    db = sqlite3.connect("instance/aura.db")
    db.row_factory = sqlite3.Row

    migrated = {}
    for user in db.execute("SELECT * FROM users ORDER BY id"):
        try:
            store.create_user(
                user["username"], user["email"], user["password_hash"],
                created_at=parse_time(user["created_at"]), user_id=str(user["id"]),
            )
        except store.AlreadyTaken:
            print(f"skip user {user['username']} (already in Firestore)")
            continue
        migrated[user["id"]] = {"id": str(user["id"]), "username": user["username"]}
        print(f"user {user['username']}")

    for art in db.execute("SELECT * FROM artworks ORDER BY id"):
        owner = migrated.get(art["user_id"])
        if owner is None:
            continue
        store.create_artwork(
            owner, art["title"], art["description"], json.loads(art["analysis_json"] or "{}"),
            bool(art["is_published"]), art["image"], art["image_mime"], created_at=parse_time(art["created_at"]),
        )
        print(f"artwork {art['title'] or 'Untitled'} ({owner['username']})")


if __name__ == "__main__":
    main()
