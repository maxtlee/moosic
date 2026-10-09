#!/usr/bin/env python3
"""Shared access layer for the Moosic data repo (`maxtlee/music`).

Single source of truth for the master list and playlists:

    $MOOSIC_DATA/                 (default: ~/Projects/Music)
      master.json                 {"version", "updated", "songs": [{id, ..., asset, duration}]}
      playlists/<slug>.json       {"name","description","created","updated","songs":[<id>,...]}
      assets/ -> HDD library      (gitignored symlink; mp3s live here)

Pure stdlib. Callers that mutate files should wrap the whole
validate->write->commit sequence in ``with flock():`` so concurrent editors
(and the git push) serialize.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import subprocess
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(os.environ.get("MOOSIC_DATA", Path.home() / "Projects" / "Music")).expanduser()
MASTER = DATA_DIR / "master.json"
RATINGS = DATA_DIR / "ratings.json"
BAD_LINKS = DATA_DIR / "bad_links.json"
PLAYLISTS_DIR = DATA_DIR / "playlists"
ASSETS_DIR = DATA_DIR / "assets"
COVERS_DIR = ASSETS_DIR / "_covers"
LOCK_PATH = DATA_DIR / ".locks" / "music.lock"

SAFE_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_MESSAGE = 200

GIT_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
}


# --------------------------------------------------------------------------- #
# text helpers
# --------------------------------------------------------------------------- #
def sanitize(name: str) -> str:
    """Filename-component sanitizer (matches the asset layout)."""
    name = unicodedata.normalize("NFKC", name or "").strip()
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name or "untitled"


def slugify(name: str) -> str:
    name = unicodedata.normalize("NFKD", name or "")
    name = name.encode("ascii", "ignore").decode("ascii").lower()
    name = re.sub(r"[^a-z0-9]+", "-", name).strip("-")
    return name[:56] or "playlist"


def video_id(url: str) -> str | None:
    if not url:
        return None
    for pat in (r"[?&]v=([A-Za-z0-9_-]{6,})", r"youtu\.be/([A-Za-z0-9_-]{6,})",
                r"/embed/([A-Za-z0-9_-]{6,})", r"/shorts/([A-Za-z0-9_-]{6,})"):
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return None


def norm_key(title: str, artist: str) -> str:
    """Dedup key: primary artist + title, Unicode-aware (keeps CJK)."""
    def n(s: str) -> str:
        s = unicodedata.normalize("NFKC", s or "").casefold()
        return re.sub(r"[\W_]+", " ", s, flags=re.UNICODE).strip()
    a = re.split(r" feat ", n(artist))[0].strip() or n(artist)
    return f"{a}|{n(title)}"


def song_key_of(song: dict) -> str:
    return norm_key(song.get("title", ""), song.get("artist", ""))


def make_song_id(song: dict) -> str:
    vid = video_id(song.get("youtube_url", ""))
    if vid:
        return f"yt:{vid}"
    base = f"{song.get('artist', '')}-{song.get('title', '')}"
    return "slug:" + re.sub(r"[^a-z0-9]+", "-",
                            unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode().lower()
                            ).strip("-")[:40]


def expected_asset(song: dict) -> str:
    return (f"{sanitize(song.get('genre') or 'Unsorted')}/"
            f"{sanitize(song.get('artist') or 'Unknown Artist')}/"
            f"{sanitize(song.get('title') or 'Untitled')}.mp3")


def safe_id(sid: str) -> str:
    """Filesystem-safe form of a song id (ids look like ``yt:<videoId>``)."""
    return re.sub(r"[^A-Za-z0-9_.-]", "_", sid or "unknown")


def cover_rel(sid: str) -> str:
    return f"_covers/{safe_id(sid)}.jpg"


def cover_file(song: dict) -> Path | None:
    rel = song.get("cover")
    return (ASSETS_DIR / rel) if rel else None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# atomic json io
# --------------------------------------------------------------------------- #
def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# master list
# --------------------------------------------------------------------------- #
def load_master() -> dict:
    if not MASTER.is_file():
        return {"version": 1, "updated": now_iso(), "songs": []}
    data = json.loads(MASTER.read_text(encoding="utf-8"))
    if isinstance(data, list):  # tolerate a bare list
        data = {"version": 1, "updated": now_iso(), "songs": data}
    data.setdefault("songs", [])
    return data


def save_master(master: dict) -> None:
    master["updated"] = now_iso()
    _write_json(MASTER, master)


def song_by_id(master: dict, sid: str) -> dict | None:
    return next((s for s in master.get("songs", []) if s.get("id") == sid), None)


# --------------------------------------------------------------------------- #
# ratings (custom ordering; 0..1 today, designed to grow to multiple raters)
# --------------------------------------------------------------------------- #
def load_ratings() -> dict[str, float]:
    if not RATINGS.is_file():
        return {}
    try:
        data = json.loads(RATINGS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    # current shape: {"version":1,"ratings":{id: value}}
    raw = data.get("ratings") if isinstance(data, dict) and "ratings" in data else data
    if not isinstance(raw, dict):
        return {}
    out: dict[str, float] = {}
    for sid, value in raw.items():
        if isinstance(value, (int, float)):
            out[sid] = float(value)
    return out


def save_ratings(ratings: dict[str, float]) -> None:
    _write_json(RATINGS, {
        "version": 1,
        "updated": now_iso(),
        "ratings": {sid: round(float(v), 3) for sid, v in sorted(ratings.items())},
    })


# --------------------------------------------------------------------------- #
# bad youtube links (rejected song<->video matches)
# --------------------------------------------------------------------------- #
def load_bad_links() -> dict:
    if not BAD_LINKS.is_file():
        return {"video_ids": []}
    try:
        data = json.loads(BAD_LINKS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"video_ids": []}
    ids = data.get("video_ids") if isinstance(data, dict) else data
    return {"video_ids": [v for v in (ids or []) if isinstance(v, str)]}


def save_bad_links(data: dict) -> None:
    _write_json(BAD_LINKS, {
        "version": 1,
        "updated": now_iso(),
        "video_ids": sorted(set(v for v in data.get("video_ids", []) if v)),
    })


def add_bad_link(video_id: str) -> None:
    if not video_id:
        return
    data = load_bad_links()
    if video_id not in data["video_ids"]:
        data["video_ids"].append(video_id)
        save_bad_links(data)


def video_id_of(song: dict) -> str | None:
    return song.get("video_id") or video_id(song.get("youtube_url", ""))


def asset_file(song: dict) -> Path:
    return ASSETS_DIR / song.get("asset", expected_asset(song))


# --------------------------------------------------------------------------- #
# playlists
# --------------------------------------------------------------------------- #
def playlist_path(slug: str) -> Path:
    if not SAFE_SLUG.match(slug):
        raise ValueError("invalid playlist slug")
    return PLAYLISTS_DIR / f"{slug}.json"


def list_playlists() -> list[dict]:
    out = []
    if not PLAYLISTS_DIR.is_dir():
        return out
    for p in sorted(PLAYLISTS_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append({"slug": p.stem, **data})
    return out


def load_playlist(slug: str) -> dict | None:
    p = playlist_path(slug)
    if not p.is_file():
        return None
    return {"slug": slug, **json.loads(p.read_text(encoding="utf-8"))}


def save_playlist(slug: str, data: dict) -> None:
    data = dict(data)
    data["updated"] = now_iso()
    data.setdefault("created", now_iso())
    _write_json(playlist_path(slug), data)


def delete_playlist(slug: str) -> bool:
    p = playlist_path(slug)
    if p.is_file():
        p.unlink()
        return True
    return False


def unique_slug(name: str, exclude: str | None = None) -> str:
    base = slugify(name)
    slug = base
    n = 2
    existing = {p.stem for p in PLAYLISTS_DIR.glob("*.json")} if PLAYLISTS_DIR.is_dir() else set()
    while slug in existing and slug != exclude:
        slug = f"{base}-{n}"
        n += 1
    return slug


# --------------------------------------------------------------------------- #
# locking
# --------------------------------------------------------------------------- #
@contextlib.contextmanager
def flock():
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_PATH, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


# --------------------------------------------------------------------------- #
# git
# --------------------------------------------------------------------------- #
def _git(*args: str, check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(DATA_DIR), *args],
        capture_output=True, text=True, env=GIT_ENV, timeout=timeout, check=check,
    )


def git_status() -> dict:
    try:
        porcelain = _git("status", "--porcelain").stdout
        changes = [ln for ln in porcelain.splitlines() if ln.strip()]
        last = _git("log", "-1", "--format=%h %s").stdout.strip()
        ahead = behind = 0
        counts = _git("rev-list", "--left-right", "--count", "@{upstream}...HEAD",
                      check=False).stdout.split()
        if len(counts) == 2:
            behind, ahead = int(counts[0]), int(counts[1])
        return {
            "data_dir": str(DATA_DIR),
            "dirty": len(changes),
            "changes": changes[:50],
            "ahead": ahead,
            "behind": behind,
            "last_commit": last,
        }
    except (subprocess.SubprocessError, OSError) as exc:
        return {"data_dir": str(DATA_DIR), "error": str(exc), "dirty": 0, "changes": []}


def commit_push(message: str, push: bool = True) -> dict:
    """Stage everything, commit, and (optionally) push. Caller should hold flock()."""
    message = " ".join((message or "").split())[:MAX_MESSAGE] or "web edit"
    try:
        _git("add", "-A")
        if not _git("status", "--porcelain").stdout.strip():
            return {"committed": False, "pushed": False, "detail": "nothing to commit"}
        commit = _git("commit", "-m", message, check=False)
        if commit.returncode != 0:
            return {"committed": False, "pushed": False,
                    "detail": (commit.stdout + commit.stderr).strip()[:400]}
        sha = _git("rev-parse", "--short", "HEAD").stdout.strip()
        result = {"committed": True, "sha": sha, "pushed": False}
        if push:
            try:
                p = _git("push", check=False, timeout=120)
                result["pushed"] = p.returncode == 0
                if p.returncode != 0:
                    result["detail"] = (p.stdout + p.stderr).strip()[:400]
            except subprocess.TimeoutExpired:
                result["detail"] = "push timed out (commit is local)"
        return result
    except (subprocess.SubprocessError, OSError) as exc:
        return {"committed": False, "pushed": False, "detail": str(exc)[:400]}
