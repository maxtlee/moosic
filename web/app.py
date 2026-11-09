#!/usr/bin/env python3
"""Moosic web — read/write server for the master list, playlists and assets.

Read side
    GET  /api/library                 master list (slim)
    GET  /api/playlists               playlist summaries
    GET  /api/playlists/{slug}        one playlist with resolved songs
    GET  /api/stream/{song_id}        MP3 with HTTP Range support
    GET  /api/status                  git state + rate-limit cooldowns
    GET  /api/health

Write side (public, rate-limited, committed through the data repo)
    POST   /api/playlists             create
    PATCH  /api/playlists/{slug}      rename / reorder / set songs
    DELETE /api/playlists/{slug}      delete
    POST   /api/songs                 add to master list
    PATCH  /api/songs/{song_id}       edit / retag
    DELETE /api/songs/{song_id}       remove from master (and from playlists)
    POST   /api/suggestions           post a public bug / suggestion (or a reply)
    PATCH  /api/suggestions/{id}      finish/reopen a whole thread
    POST   /api/suggestions/{id}/vote like/dislike a suggestion or reply
    PUT    /api/volume/{song_id}      per-song playback gain (dB) / auto
    POST   /api/commit                git add/commit/push the data repo

Changes are written to disk immediately; the Commit button (rate-limited to once
per COMMIT_INTERVAL seconds, globally) makes them durable and rollback-able.

Environment
    MOOSIC_DATA       data repo (default ~/Projects/Music)
    MOOSIC_HOST/PORT  bind (default 127.0.0.1:8740)
    MOOSIC_ROOT_PATH  URL prefix to strip (e.g. /music)
    MOOSIC_WRITE_RPM  per-client writes/min (default 40)
    MOOSIC_COMMIT_INTERVAL  seconds between commits (default 60)
    MOOSIC_GENRE_LOOKUP  auto-categorize new songs via iTunes (default 1)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

FROZEN = bool(getattr(sys, "frozen", False))
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
import musiclib as ml  # noqa: E402
try:  # optional: iTunes-backed auto-categorization for new songs
    import genre_lookup  # noqa: E402
except Exception:  # pragma: no cover - keep the app usable without it
    genre_lookup = None

ROOT_PATH = os.environ.get("MOOSIC_ROOT_PATH", "").rstrip("/")
WRITE_RPM = int(os.environ.get("MOOSIC_WRITE_RPM", "40"))
COMMIT_INTERVAL = float(os.environ.get("MOOSIC_COMMIT_INTERVAL", "60"))
DOWNLOAD_LIMIT = int(os.environ.get("MOOSIC_DOWNLOAD_LIMIT", "20"))
DOWNLOAD_WINDOW = float(os.environ.get("MOOSIC_DOWNLOAD_WINDOW", "1800"))
SEARCH_RPM = int(os.environ.get("MOOSIC_SEARCH_RPM", "20"))
SUGGESTION_RPM = int(os.environ.get("MOOSIC_SUGGESTION_RPM", "6"))
GENRE_LOOKUP = os.environ.get("MOOSIC_GENRE_LOOKUP", "1").strip().lower() not in ("0", "false", "no", "off")
STATIC = ROOT / "static"
# In a frozen (PyInstaller) build the tool scripts + venv are not present, so
# tool-backed endpoints return a clear 503 instead of crashing (see run_tool).
TOOL_DIR = Path(sys.executable).resolve().parent if FROZEN else ROOT.parent
TOOL_PYTHON = Path(os.environ.get("MOOSIC_TOOL_PYTHON", str(TOOL_DIR / ".venv" / "bin" / "python")))

MAX_PLAYLISTS = 500
MAX_PLAYLIST_SONGS = 2000
MAX_MASTER_SONGS = 5000
MAX_SUGGESTIONS = 1000
MAX_SUGGESTION_TEXT = 600
MAX_SUGGESTION_AUTHOR = 60
MAX_SUGGESTION_DEPTH = 8

app = FastAPI(title="Moosic", docs_url=None, redoc_url=None, openapi_url=None)


# --------------------------------------------------------------------------- #
# rate limiting
# --------------------------------------------------------------------------- #
class SlidingWindow:
    def __init__(self, limit: int, window: float):
        self.limit, self.window = limit, window
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, key: str) -> float:
        """Return 0 if allowed, else seconds to wait."""
        now = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return max(0.0, self.window - (now - q[0]))
            q.append(now)
            return 0.0


write_limiter = SlidingWindow(WRITE_RPM, 60.0)
_commit_lock = threading.Lock()
_commit_last = 0.0


def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def enforce_write(request: Request) -> None:
    wait = write_limiter.check(client_ip(request))
    if wait > 0:
        raise HTTPException(status_code=429,
                            detail=f"slow down; retry in {wait:.0f}s",
                            headers={"Retry-After": str(int(wait) + 1)})


def enforce_suggestion_write(request: Request) -> None:
    """Suggestions are public; allow fewer posts/min than normal writes."""
    enforce_write(request)
    wait = suggestion_limiter.check(client_ip(request))
    if wait > 0:
        raise HTTPException(status_code=429,
                            detail=f"too many suggestion posts; retry in {wait:.0f}s",
                            headers={"Retry-After": str(int(wait) + 1)})


def commit_cooldown() -> float:
    with _commit_lock:
        return max(0.0, COMMIT_INTERVAL - (time.monotonic() - _commit_last))


# --------------------------------------------------------------------------- #
# download quota (20 songs / 30 min by default) and tool subprocesses
# --------------------------------------------------------------------------- #
class DownloadQuota:
    def __init__(self, limit: int, window: float):
        self.limit, self.window = limit, window
        self.times: deque = deque()
        self.lock = threading.Lock()

    def _prune(self) -> None:
        now = time.monotonic()
        while self.times and now - self.times[0] > self.window:
            self.times.popleft()

    def remaining(self) -> int:
        with self.lock:
            self._prune()
            return max(0, self.limit - len(self.times))

    def reset_in(self) -> float:
        with self.lock:
            self._prune()
            if len(self.times) < self.limit:
                return 0.0
            return max(0.0, self.window - (time.monotonic() - self.times[0]))

    def record(self, n: int) -> None:
        if n <= 0:
            return
        now = time.monotonic()
        with self.lock:
            self._prune()
            self.times.extend([now] * n)


download_quota = DownloadQuota(DOWNLOAD_LIMIT, DOWNLOAD_WINDOW)
download_limiter = SlidingWindow(WRITE_RPM, 60.0)
search_limiter = SlidingWindow(SEARCH_RPM, 60.0)
suggestion_limiter = SlidingWindow(SUGGESTION_RPM, 60.0)
_download_lock = threading.Lock()
_search_lock = threading.Lock()
_album_lock = threading.Lock()
_export_lock = threading.Lock()
export_limiter = SlidingWindow(5, 60.0)


def run_tool(args: list[str], timeout: int) -> subprocess.CompletedProcess:
    if not TOOL_PYTHON.exists():
        raise HTTPException(
            status_code=503,
            detail="This build is player-only. Search, add, download and refresh "
                   "need the full source install (Python + yt-audio-api).",
        )
    env = {**os.environ, "MOOSIC_DATA": str(ml.DATA_DIR)}
    env.setdefault("HOME", str(Path.home()))
    return subprocess.run(
        [str(TOOL_PYTHON), *args], capture_output=True, text=True,
        env=env, timeout=timeout, cwd=str(TOOL_DIR),
    )


def quota_state() -> dict:
    rem = download_quota.remaining()
    return {
        "limit": DOWNLOAD_LIMIT,
        "window": DOWNLOAD_WINDOW,
        "used": DOWNLOAD_LIMIT - rem,
        "remaining": rem,
        "reset_in": round(download_quota.reset_in(), 1),
    }


def _download_and_summarize(extra: list[str], timeout: int) -> tuple[dict, str]:
    """Run download_assets.py --execute and return (summary, log tail)."""
    with tempfile.NamedTemporaryFile("r", suffix=".json", delete=False) as fh:
        summary_path = fh.name
    cmd = [str(TOOL_DIR / "download_assets.py"), "--execute", "--summary-json", summary_path, *extra]
    proc = run_tool(cmd, timeout=timeout)
    try:
        summary = json.loads(Path(summary_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        summary = {"downloaded": 0, "failed": 0, "attempted": 0, "detail": (proc.stdout + proc.stderr)[-500:]}
    finally:
        Path(summary_path).unlink(missing_ok=True)
    log_tail = (proc.stdout + proc.stderr)[-800:]
    downloaded = summary.get("downloaded_ids") or []
    if downloaded:
        # New/replaced audio needs a loudness measurement; keep this best-effort
        # so a slow or missing ffmpeg never fails the download itself.
        try:
            vproc = run_tool(
                [str(TOOL_DIR / "normalize_volume.py"),
                 "--only", ",".join(downloaded), "--execute", "--force"],
                timeout=max(120, 30 * len(downloaded)),
            )
            log_tail = (log_tail + "\n" + (vproc.stdout + vproc.stderr)[-500:])[-1000:]
        except Exception as exc:
            log_tail = (log_tail + f"\nvolume analysis skipped: {exc}")[-1000:]
    return summary, log_tail


# --------------------------------------------------------------------------- #
# models
# --------------------------------------------------------------------------- #
class PlaylistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class PlaylistPatch(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    songs: list[str] | None = None


class SongInput(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=300)
    genre: str = Field(default="Unsorted", max_length=60)
    youtube_url: str = Field(default="", max_length=500)
    youtube_kind: str = Field(default="", max_length=40)
    album: str = Field(default="", max_length=300)


class SongPatch(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    artist: str | None = Field(default=None, max_length=300)
    genre: str | None = Field(default=None, max_length=60)
    youtube_url: str | None = Field(default=None, max_length=500)


class CommitInput(BaseModel):
    message: str = Field(default="", max_length=ml.MAX_MESSAGE)


class AddSongInput(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=300)
    genre: str = Field(default="Unsorted", max_length=60)
    youtube_url: str = Field(min_length=8, max_length=500)
    youtube_kind: str = Field(default="", max_length=40)
    youtube_title: str = Field(default="", max_length=300)
    album: str = Field(default="", max_length=300)


class AddAlbumInput(BaseModel):
    browse_id: str = Field(min_length=4, max_length=80)


class DownloadAlbumInput(BaseModel):
    album: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=300)


class RatingInput(BaseModel):
    rating: float | None = None  # 0..1, or null to clear


class VolumeInput(BaseModel):
    gain_db: float | None = Field(default=None, ge=-24.0, le=24.0)  # null = clear
    auto: bool = False  # re-measure from the audio file


class SuggestionInput(BaseModel):
    kind: Literal["bug", "suggestion", "todo"] = "suggestion"  # "todo" = legacy alias
    text: str = Field(min_length=1, max_length=MAX_SUGGESTION_TEXT)
    author: str = Field(default="", max_length=MAX_SUGGESTION_AUTHOR)
    parent_id: str | None = Field(default=None, max_length=40)


class SuggestionPatch(BaseModel):
    done: bool


class SuggestionVote(BaseModel):
    value: int = Field(ge=-1, le=1)  # 1 = like, -1 = dislike, 0 = clear
    client_id: str = Field(min_length=8, max_length=64)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def slim(song: dict, ratings: dict | None = None,
         gains: dict | None = None) -> dict:
    cf = ml.cover_file(song)
    return {
        "id": song.get("id", ""),
        "title": song.get("title", ""),
        "artist": song.get("artist", ""),
        "genre": song.get("genre", ""),
        "duration": song.get("duration"),
        "youtube_url": song.get("youtube_url", ""),
        "video_id": ml.video_id_of(song),
        "album": song.get("album", ""),
        "has_asset": ml.asset_file(song).is_file(),
        "has_cover": bool(cf and cf.is_file()),
        "rating": (ratings or {}).get(song.get("id")),
        "gain_db": (gains or {}).get(song.get("id")),
    }


def genres_of(songs: list[dict]) -> dict:
    out: dict[str, int] = {}
    for s in songs:
        g = s.get("genre") or "Unsorted"
        out[g] = out.get(g, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def auto_genre(title: str, artist: str, album: str, genre: str,
               songs: list[dict]) -> str:
    """Fill an empty/Unsorted genre from the library or iTunes (best effort)."""
    genre = (genre or "").strip()
    if genre and genre != "Unsorted":
        return genre
    if not GENRE_LOOKUP or genre_lookup is None:
        return genre or "Unsorted"
    try:
        guess, _source = genre_lookup.infer_genre(
            title, artist, album, songs, online=True, timeout=4.0)
    except Exception:
        guess = ""
    return guess or "Unsorted"


def auto_album_genre(title: str, artist: str, songs: list[dict]) -> str:
    if not GENRE_LOOKUP or genre_lookup is None:
        return "Unsorted"
    try:
        guess = genre_lookup.local_genre("", artist, title, songs)
        if guess:
            return guess
        guess = genre_lookup.lookup_itunes_album(title, artist, timeout=4.0)
    except Exception:
        guess = None
    return guess or "Unsorted"


def resolve_stream(song: dict) -> Path:
    root = ml.ASSETS_DIR.resolve()
    target = (root / song.get("asset", "")).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="invalid asset path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="asset not downloaded yet")
    return target


# --------------------------------------------------------------------------- #
# reads
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict:
    master = ml.load_master()
    return {
        "status": "ok",
        "data": str(ml.DATA_DIR),
        "tracks": len(master.get("songs", [])),
        "root_path": ROOT_PATH,
    }


@app.get("/api/library")
def get_library() -> dict:
    songs = ml.load_master().get("songs", [])
    ratings = ml.load_ratings()
    gains = ml.load_gains()
    return {"count": len(songs), "genres": genres_of(songs),
            "songs": [slim(s, ratings, gains) for s in songs]}


@app.get("/api/albums")
def get_albums() -> dict:
    songs = ml.load_master().get("songs", [])
    by_id = {s["id"]: s for s in songs}
    groups: dict[str, dict] = {}
    for s in songs:
        album = (s.get("album") or "").strip()
        if not album:
            continue
        key = ml.norm_key(album, s.get("artist", ""))
        g = groups.setdefault(key, {"key": key, "album": album,
                                    "artist": s.get("artist", ""), "song_ids": []})
        g["song_ids"].append(s["id"])
    out = []
    for g in groups.values():
        first = by_id.get(g["song_ids"][0], {})
        cf = ml.cover_file(first)
        out.append({
            "key": g["key"], "album": g["album"], "artist": g["artist"],
            "count": len(g["song_ids"]),
            "cover_id": g["song_ids"][0] if (cf and cf.is_file()) else None,
            "songs": g["song_ids"],
        })
    out.sort(key=lambda a: (a["album"].lower(), a["artist"].lower()))
    return {"albums": out}


@app.get("/api/album-search")
def album_search(q: str, request: Request, limit: int = 8) -> dict:
    wait = search_limiter.check(client_ip(request))
    if wait > 0:
        raise HTTPException(status_code=429, detail="search slow down",
                            headers={"Retry-After": str(int(wait) + 1)})
    q = (q or "").strip()[:200]
    if not q:
        raise HTTPException(status_code=400, detail="empty query")
    if not _album_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="an album search is already running")
    try:
        proc = run_tool([str(TOOL_DIR / "albums.py"), "--query", q,
                         "--limit", str(max(1, min(limit, 15)))], timeout=60)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="album search timed out")
    finally:
        _album_lock.release()
    if proc.returncode != 0:
        raise HTTPException(status_code=502, detail=("album search failed: " + (proc.stderr or proc.stdout))[-200:])
    data = json.loads(proc.stdout)
    data["albums"] = (data.get("albums") or [])[: max(1, min(limit, 15))]
    master = ml.load_master()
    have_albums = {ml.norm_key(s.get("album", ""), s.get("artist", ""))
                   for s in master.get("songs", []) if s.get("album")}
    for a in data.get("albums", []):
        a["in_library"] = ml.norm_key(a.get("title", ""), a.get("artist", "")) in have_albums
    return data


@app.get("/api/album-tracks")
def album_tracks(browse_id: str, request: Request) -> dict:
    wait = search_limiter.check(client_ip(request))
    if wait > 0:
        raise HTTPException(status_code=429, detail="search slow down")
    if not _album_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="an album search is already running")
    try:
        proc = run_tool([str(TOOL_DIR / "albums.py"), "--tracks", browse_id], timeout=60)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="album fetch timed out")
    finally:
        _album_lock.release()
    if proc.returncode != 0:
        raise HTTPException(status_code=502, detail=("album fetch failed: " + (proc.stderr or proc.stdout))[-200:])
    return json.loads(proc.stdout)


@app.post("/api/albums/download")
def download_album(body: DownloadAlbumInput, request: Request) -> dict:
    enforce_write(request)
    if download_quota.remaining() < 1:
        raise HTTPException(status_code=429, detail="download quota exhausted",
                            headers={"Retry-After": str(int(download_quota.reset_in()) + 1)})
    if not _download_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="a download is already in progress")
    try:
        with ml.flock():
            songs = ml.load_master().get("songs", [])
            ids = [s["id"] for s in songs
                   if (s.get("album") or "") == body.album
                   and (not body.artist or (s.get("artist") or "") == body.artist)]
        if not ids:
            raise HTTPException(status_code=404, detail="album not found in library")
        summary, log_tail = _download_and_summarize(
            ["--only", ",".join(ids), "--max-downloads", str(download_quota.remaining())], timeout=900)
        download_quota.record(max(0, summary.get("attempted", 0)))
        return {"summary": summary, "quota": quota_state(), "log": log_tail}
    finally:
        _download_lock.release()


@app.post("/api/admin/add-album")
def add_album(body: AddAlbumInput, request: Request) -> dict:
    enforce_write(request)
    if not _download_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="a download is already in progress")
    try:
        proc = run_tool([str(TOOL_DIR / "albums.py"), "--tracks", body.browse_id], timeout=60)
        if proc.returncode != 0:
            raise HTTPException(status_code=502, detail="album fetch failed")
        data = json.loads(proc.stdout)
        album, tracks = data.get("album") or {}, data.get("tracks") or []
        if not tracks:
            raise HTTPException(status_code=404, detail="album has no tracks")
        album_genre = auto_album_genre(album.get("title", ""), album.get("artist", ""),
                                       ml.load_master().get("songs", []))
        with ml.flock():
            master = ml.load_master()
            songs = master.get("songs", [])
            if len(songs) + len(tracks) > MAX_MASTER_SONGS:
                raise HTTPException(status_code=429, detail="master list full")
            vids = {ml.video_id_of(s) for s in songs}
            keys = {ml.song_key_of(s) for s in songs}
            added = []
            for t in tracks:
                artist = t.get("artist") or album.get("artist", "")
                key = ml.norm_key(t["title"], artist)
                if t["video_id"] in vids or key in keys:
                    continue
                track_genre = album_genre
                if track_genre == "Unsorted" and genre_lookup is not None:
                    track_genre = genre_lookup.local_genre(
                        t["title"], artist, album.get("title", ""), songs) or "Unsorted"
                song = {
                    "id": "", "title": t["title"], "artist": artist,
                    "genre": track_genre, "youtube_url": t["url"], "video_id": t["video_id"],
                    "youtube_kind": "song", "youtube_title": t["title"],
                    "duration": t.get("duration"), "album": album.get("title", ""),
                }
                song["id"] = ml.make_song_id(song)
                song["asset"] = ml.expected_asset(song)
                songs.append(song)
                added.append(song)
                vids.add(t["video_id"])
                keys.add(key)
            master["songs"] = songs
            ml.save_master(master)
        summary = {"downloaded": 0, "failed": 0, "attempted": 0}
        if added and download_quota.remaining() > 0:
            ids = ",".join(s["id"] for s in added)
            summary, _log = _download_and_summarize(
                ["--only", ids, "--max-downloads", str(download_quota.remaining())], timeout=900)
            download_quota.record(max(0, summary.get("attempted", 0)))
        return {"album": album, "added": len(added), "skipped": len(tracks) - len(added),
                "download": summary, "quota": quota_state()}
    finally:
        _download_lock.release()


@app.get("/api/playlists")
def get_playlists() -> dict:
    out = []
    for pl in ml.list_playlists():
        out.append({
            "slug": pl["slug"],
            "name": pl.get("name", pl["slug"]),
            "description": pl.get("description", ""),
            "count": len(pl.get("songs", [])),
            "updated": pl.get("updated", ""),
        })
    return {"playlists": out}


@app.get("/api/playlists/{slug}")
def get_playlist(slug: str) -> dict:
    try:
        pl = ml.load_playlist(slug)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid slug")
    if pl is None:
        raise HTTPException(status_code=404, detail="playlist not found")
    master = ml.load_master()
    ratings = ml.load_ratings()
    gains = ml.load_gains()
    songs = []
    for sid in pl.get("songs", []):
        song = ml.song_by_id(master, sid)
        songs.append(slim(song, ratings, gains) if song else {"id": sid, "missing": True})
    pl["songs"] = songs
    return pl


@app.get("/api/stream/{sid}")
def stream(sid: str) -> FileResponse:
    song = ml.song_by_id(ml.load_master(), sid)
    if song is None:
        raise HTTPException(status_code=404, detail="song not found")
    return FileResponse(resolve_stream(song), media_type="audio/mpeg",
                        filename=Path(song.get("asset", "audio.mp3")).name)


@app.get("/api/cover/{sid}")
def cover(sid: str) -> FileResponse:
    song = ml.song_by_id(ml.load_master(), sid)
    if song is None:
        raise HTTPException(status_code=404, detail="song not found")
    path = ml.cover_file(song)
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="no cover")
    root = ml.ASSETS_DIR.resolve()
    target = path.resolve()
    if root != target and root not in target.parents:
        raise HTTPException(status_code=400, detail="invalid cover path")
    # The cover file lives at a stable id-based path and is overwritten when a
    # wrong match is replaced, so make browsers revalidate instead of trusting
    # a day-long max-age and showing the previous video's thumbnail.
    return FileResponse(target, media_type="image/jpeg",
                        headers={"Cache-Control": "no-cache"})


@app.get("/api/status")
def status() -> dict:
    st = ml.git_status()
    st["commit_cooldown"] = round(commit_cooldown(), 1)
    st["commit_interval"] = COMMIT_INTERVAL
    return st


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", media_type="text/html",
                        headers={"Cache-Control": "no-cache"})


# Icons live in static/ (mounted at /static); also serve them at the site root
# so browsers' default /favicon.ico probe never 404s under /music.
@app.get("/favicon.ico", include_in_schema=False)
def favicon_ico() -> FileResponse:
    return FileResponse(STATIC / "favicon.ico", media_type="image/x-icon")


@app.get("/favicon.svg", include_in_schema=False)
def favicon_svg() -> FileResponse:
    return FileResponse(STATIC / "favicon.svg", media_type="image/svg+xml")


@app.get("/apple-touch-icon.png", include_in_schema=False)
def apple_touch_icon() -> FileResponse:
    return FileResponse(STATIC / "apple-touch-icon.png", media_type="image/png")


@app.get("/favicon.gif", include_in_schema=False)
def favicon_gif() -> FileResponse:
    return FileResponse(STATIC / "favicon.gif", media_type="image/gif")


@app.get("/favicon-32.png", include_in_schema=False)
def favicon_32() -> FileResponse:
    return FileResponse(STATIC / "favicon-32.png", media_type="image/png")


# --------------------------------------------------------------------------- #
# PWA + downloads + Apple Music export
# --------------------------------------------------------------------------- #
@app.get("/manifest.webmanifest", include_in_schema=False)
def web_manifest() -> FileResponse:
    return FileResponse(STATIC / "manifest.webmanifest",
                        media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})


@app.get("/sw.js", include_in_schema=False)
def service_worker() -> FileResponse:
    # Served from the app root so its scope covers the whole app.
    return FileResponse(STATIC / "sw.js", media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"})


@app.get("/api/download/{sid}")
def download_track(sid: str) -> FileResponse:
    """Direct file download with a friendly, tagged filename (attachment)."""
    song = ml.song_by_id(ml.load_master(), sid)
    if song is None:
        raise HTTPException(status_code=404, detail="song not found")
    path = resolve_stream(song)
    name = (f"{ml.sanitize(song.get('artist') or 'Unknown Artist')} - "
            f"{ml.sanitize(song.get('title') or 'Untitled')}.mp3")
    return FileResponse(path, media_type="audio/mpeg", filename=name)


def _scope_songs(scope: str, ident: str | None) -> tuple[str, list[dict]]:
    songs = ml.load_master().get("songs", [])
    if scope == "library":
        return "Moosic Library", songs
    if scope == "playlist":
        if not ident:
            raise HTTPException(status_code=400, detail="id required")
        try:
            pl = ml.load_playlist(ident)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid playlist")
        if pl is None:
            raise HTTPException(status_code=404, detail="playlist not found")
        by_id = {s["id"]: s for s in songs}
        return (pl.get("name") or ident), [by_id[i] for i in pl.get("songs", []) if i in by_id]
    if scope == "album":
        if not ident:
            raise HTTPException(status_code=400, detail="id required")
        sel = [s for s in songs
               if s.get("album") and ml.norm_key(s["album"], s.get("artist", "")) == ident]
        if not sel:
            raise HTTPException(status_code=404, detail="album not found")
        return (sel[0].get("album") or "Album"), sel
    raise HTTPException(status_code=400, detail="scope must be album, playlist or library")


def _export_dir() -> Path:
    try:
        base = ml.ASSETS_DIR.resolve().parent  # keep big temp zips off the OS disk
        if base.is_dir() and os.access(base, os.W_OK):
            d = base / ".exports"
            d.mkdir(exist_ok=True)
            return d
    except OSError:
        pass
    return Path(tempfile.gettempdir())


def _apply_id3(path: Path, song: dict, track_no: int) -> None:
    """Write ID3v2 tags + embedded cover (best-effort if mutagen is absent)."""
    try:
        from mutagen.id3 import APIC, ID3, TALB, TDRC, TIT2, TPE1, TRCK
    except ImportError:
        return
    tags = ID3()
    tags.add(TIT2(encoding=3, text=song.get("title", "")))
    tags.add(TPE1(encoding=3, text=song.get("artist", "")))
    if song.get("album"):
        tags.add(TALB(encoding=3, text=song["album"]))
    tags.add(TRCK(encoding=3, text=str(track_no)))
    if song.get("year"):
        tags.add(TDRC(encoding=3, text=str(song["year"])))
    cover = ml.cover_file(song)
    if cover and cover.is_file():
        tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover",
                      data=cover.read_bytes()))
    tags.save(path)


@app.get("/api/export")
def export_archive(request: Request, scope: str = "album", id: str | None = None) -> FileResponse:
    """ZIP of tagged MP3s + .m3u for import into Apple Music (via a Mac)."""
    wait = export_limiter.check(client_ip(request))
    if wait > 0:
        raise HTTPException(status_code=429, detail="export slow down",
                            headers={"Retry-After": str(int(wait) + 1)})
    if not _export_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="an export is already being generated")
    out: Path | None = None
    try:
        title, songs = _scope_songs(scope, id)
        if not songs:
            raise HTTPException(status_code=404, detail="nothing to export")
        folder = ml.sanitize(title)[:80] or "Moosic"
        fd, name = tempfile.mkstemp(dir=_export_dir(), prefix="moosic-", suffix=".zip")
        os.close(fd)
        out = Path(name)
        m3u = ["#EXTM3U"]
        written = 0
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
            for idx, song in enumerate(songs, 1):
                src = ml.asset_file(song)
                if not src.is_file():
                    continue
                written += 1
                artist = song.get("artist") or "Unknown Artist"
                track = song.get("title") or "Untitled"
                fname = f"{idx:02d} - {ml.sanitize(artist)} - {ml.sanitize(track)}.mp3"
                tmp = Path(tempfile.mkstemp(suffix=".mp3")[1])
                try:
                    shutil.copyfile(src, tmp)
                    _apply_id3(tmp, song, idx)
                    zf.write(tmp, arcname=f"{folder}/{fname}")
                finally:
                    tmp.unlink(missing_ok=True)
                m3u.append(f"#EXTINF:{int(song.get('duration') or 0)},{artist} - {track}")
                m3u.append(fname)
            if not written:
                raise HTTPException(status_code=404, detail="no downloaded tracks to export")
            zf.writestr(f"{folder}/{folder}.m3u", "\n".join(m3u) + "\n")
        return FileResponse(out, media_type="application/zip", filename=f"{folder}.zip",
                            background=BackgroundTask(lambda: out.unlink(missing_ok=True)))
    except Exception:
        if out is not None:
            out.unlink(missing_ok=True)
        raise
    finally:
        _export_lock.release()


# --------------------------------------------------------------------------- #
# writes
# --------------------------------------------------------------------------- #
@app.post("/api/playlists")
def create_playlist(body: PlaylistCreate, request: Request) -> dict:
    enforce_write(request)
    with ml.flock():
        if len(ml.list_playlists()) >= MAX_PLAYLISTS:
            raise HTTPException(status_code=429, detail="too many playlists")
        slug = ml.unique_slug(body.name)
        ml.save_playlist(slug, {"name": body.name.strip(), "description": body.description,
                                "songs": [], "created": ml.now_iso()})
    return {"slug": slug, "name": body.name.strip()}


@app.patch("/api/playlists/{slug}")
def update_playlist(slug: str, body: PlaylistPatch, request: Request) -> dict:
    enforce_write(request)
    with ml.flock():
        pl = ml.load_playlist(slug)
        if pl is None:
            raise HTTPException(status_code=404, detail="playlist not found")
        pl.pop("slug", None)
        if body.description is not None:
            pl["description"] = body.description
        if body.songs is not None:
            if len(body.songs) > MAX_PLAYLIST_SONGS:
                raise HTTPException(status_code=413, detail="playlist too long")
            master = ml.load_master()
            known = {s["id"] for s in master.get("songs", [])}
            unknown = [s for s in body.songs if s not in known]
            if unknown:
                raise HTTPException(status_code=400, detail=f"unknown song id: {unknown[0]}")
            pl["songs"] = body.songs
        new_slug = slug
        if body.name is not None and body.name.strip() and body.name.strip() != pl.get("name"):
            new_slug = ml.unique_slug(body.name, exclude=slug)
            pl["name"] = body.name.strip()
        ml.save_playlist(new_slug, pl)
        if new_slug != slug:
            ml.delete_playlist(slug)
    return {"slug": new_slug}


@app.delete("/api/playlists/{slug}")
def remove_playlist(slug: str, request: Request) -> dict:
    enforce_write(request)
    with ml.flock():
        if not ml.delete_playlist(slug):
            raise HTTPException(status_code=404, detail="playlist not found")
    return {"deleted": slug}


@app.post("/api/songs")
def create_song(body: SongInput, request: Request) -> dict:
    enforce_write(request)
    songs_before = ml.load_master().get("songs", [])
    genre = auto_genre(body.title, body.artist, body.album, body.genre, songs_before)
    with ml.flock():
        master = ml.load_master()
        songs = master.get("songs", [])
        if len(songs) >= MAX_MASTER_SONGS:
            raise HTTPException(status_code=429, detail="master list full")
        song = {"id": "", "title": body.title.strip(), "artist": body.artist.strip(),
                "genre": genre,
                "youtube_url": body.youtube_url.strip(),
                "youtube_kind": body.youtube_kind.strip(),
                "youtube_title": "", "duration": None,
                "album": body.album.strip()}
        sid = ml.make_song_id(song)
        key = ml.song_key_of(song)
        if ml.song_by_id(master, sid) or any(ml.song_key_of(s) == key for s in songs):
            raise HTTPException(status_code=409, detail="song already in the master list")
        song["id"] = sid
        song["asset"] = ml.expected_asset(song)
        songs.append(song)
        master["songs"] = songs
        ml.save_master(master)
    return slim(song, ml.load_ratings(), ml.load_gains())


@app.patch("/api/songs/{sid}")
def update_song(sid: str, body: SongPatch, request: Request) -> dict:
    enforce_write(request)
    with ml.flock():
        master = ml.load_master()
        song = ml.song_by_id(master, sid)
        if song is None:
            raise HTTPException(status_code=404, detail="song not found")
        old_url = song.get("youtube_url", "")
        for field in ("title", "artist", "genre", "youtube_url"):
            val = getattr(body, field)
            if val is not None and val.strip():
                song[field] = val.strip()
        old_asset = ml.ASSETS_DIR / song.get("asset", "")
        # Only a changed YouTube URL changes the id. Regenerating on every edit
        # used to *silently* re-key a song (breaking playlists/history/offline
        # references), especially after a wrong-match replacement where the id
        # still carries the original video id.
        new_id = ml.make_song_id(song) if song.get("youtube_url", "") != old_url else sid
        new_asset_rel = ml.expected_asset(song)
        new_asset = ml.ASSETS_DIR / new_asset_rel
        # keep the audio file in place for a retag/rename
        if old_asset.is_file() and old_asset.resolve() != new_asset.resolve() and not new_asset.exists():
            new_asset.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old_asset), str(new_asset))
        song["asset"] = new_asset_rel
        if new_id != sid:
            pls = ml.list_playlists()
            for pl in pls:
                if sid in pl.get("songs", []):
                    pl_slug = pl.pop("slug")
                    pl["songs"] = [new_id if x == sid else x for x in pl["songs"]]
                    ml.save_playlist(pl_slug, pl)
            # Ratings and gains are keyed by song id too; keep them attached
            # instead of orphaning them under the old id.
            ratings = ml.load_ratings()
            if sid in ratings:
                ratings[new_id] = ratings.pop(sid)
                ml.save_ratings(ratings)
            gains = ml.load_gains()
            if sid in gains:
                gains[new_id] = gains.pop(sid)
                ml.save_gains(gains)
            song["id"] = new_id
        ml.save_master(master)
    return slim(song, ml.load_ratings(), ml.load_gains())


@app.delete("/api/songs/{sid}")
def remove_song(sid: str, request: Request) -> dict:
    enforce_write(request)
    with ml.flock():
        master = ml.load_master()
        before = len(master.get("songs", []))
        master["songs"] = [s for s in master.get("songs", []) if s.get("id") != sid]
        if len(master["songs"]) == before:
            raise HTTPException(status_code=404, detail="song not found")
        ml.save_master(master)
        ratings = ml.load_ratings()
        if sid in ratings:
            ratings.pop(sid)
            ml.save_ratings(ratings)
        gains = ml.load_gains()
        if sid in gains:
            gains.pop(sid)
            ml.save_gains(gains)
        for pl in ml.list_playlists():
            if sid in pl.get("songs", []):
                pl_slug = pl.pop("slug")
                pl["songs"] = [x for x in pl["songs"] if x != sid]
                ml.save_playlist(pl_slug, pl)
    return {"deleted": sid}


@app.put("/api/ratings/{sid}")
def set_rating(sid: str, body: RatingInput, request: Request) -> dict:
    enforce_write(request)
    if body.rating is not None and not (0.0 <= body.rating <= 1.0):
        raise HTTPException(status_code=400, detail="rating must be between 0 and 1")
    with ml.flock():
        if body.rating is not None and ml.song_by_id(ml.load_master(), sid) is None:
            raise HTTPException(status_code=404, detail="song not found")
        ratings = ml.load_ratings()
        if body.rating is None:
            ratings.pop(sid, None)
        else:
            ratings[sid] = round(body.rating, 3)
        ml.save_ratings(ratings)
    return {"id": sid, "rating": ratings.get(sid)}


@app.put("/api/volume/{sid}")
def set_volume(sid: str, body: VolumeInput, request: Request) -> dict:
    """Set a manual per-song gain, clear it, or re-measure it (``auto``)."""
    enforce_write(request)
    if body.auto:
        with ml.flock():
            song = ml.song_by_id(ml.load_master(), sid)
        if song is None:
            raise HTTPException(status_code=404, detail="song not found")
        if not ml.asset_file(song).is_file():
            raise HTTPException(status_code=404, detail="audio file not downloaded")
        try:
            run_tool([str(TOOL_DIR / "normalize_volume.py"),
                      "--only", sid, "--execute", "--force", "--workers", "1"],
                     timeout=360)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="loudness analysis timed out")
        gain = ml.load_gains().get(sid)
        return {"id": sid, "gain_db": gain}
    with ml.flock():
        if body.gain_db is not None and ml.song_by_id(ml.load_master(), sid) is None:
            raise HTTPException(status_code=404, detail="song not found")
        gains = ml.load_gains()
        if body.gain_db is None:
            gains.pop(sid, None)
        else:
            gains[sid] = round(body.gain_db, 2)
        ml.save_gains(gains)
    return {"id": sid, "gain_db": gains.get(sid)}


def _valid_client_id(value: str) -> bool:
    return 8 <= len(value) <= 64 and all(c.isalnum() or c in "_-" for c in value)


def _suggestion_root(items: list[dict], item: dict) -> dict:
    by_id = {s["id"]: s for s in items}
    cur, seen = item, set()
    while cur.get("parent_id") and cur["parent_id"] in by_id and cur["id"] not in seen:
        seen.add(cur["id"])
        cur = by_id[cur["parent_id"]]
    return cur


def _suggestion_subtree(items: list[dict], root_id: str) -> set[str]:
    children: dict[str, list[dict]] = defaultdict(list)
    for s in items:
        pid = s.get("parent_id")
        if pid:
            children[pid].append(s)
    out: set[str] = set()
    stack = [root_id]
    while stack:
        sid = stack.pop()
        if sid in out:
            continue
        out.add(sid)
        stack.extend(c["id"] for c in children.get(sid, []))
    return out


def _suggestion_depth(items: list[dict], item: dict) -> int:
    by_id = {s["id"]: s for s in items}
    cur, seen, depth = item, set(), 0
    while cur.get("parent_id") and cur["parent_id"] in by_id and cur["id"] not in seen:
        seen.add(cur["id"])
        depth += 1
        cur = by_id[cur["parent_id"]]
    return depth


def _suggestion_activity(item: dict, children: dict[str, list[dict]]) -> str:
    latest = item.get("created") or ""
    stack, seen = [item["id"]], set()
    while stack:
        sid = stack.pop()
        if sid in seen:
            continue
        seen.add(sid)
        for child in children.get(sid, []):
            latest = max(latest, child.get("created") or "")
            stack.append(child["id"])
    return latest


def _normalize_kind(kind: str | None) -> str:
    """Map old board data and cached clients ("todo") onto the bug taxonomy."""
    return "bug" if kind in ("bug", "todo") else "suggestion"


def _suggestion_node(item: dict, children: dict[str, list[dict]],
                     client_id: str, depth: int = 0) -> dict:
    votes = item.get("votes") if isinstance(item.get("votes"), dict) else {}
    likes = sum(1 for v in votes.values() if v == 1)
    dislikes = sum(1 for v in votes.values() if v == -1)
    node = {
        "id": item["id"],
        "kind": _normalize_kind(item.get("kind")),
        "text": item.get("text", ""),
        "author": item.get("author", ""),
        "created": item.get("created", ""),
        "done": bool(item.get("done")),
        "done_at": item.get("done_at"),
        "parent_id": item.get("parent_id"),
        "likes": likes,
        "dislikes": dislikes,
        "my_vote": int(votes.get(client_id, 0)) if client_id else 0,
        "replies": [],
    }
    if depth < MAX_SUGGESTION_DEPTH:
        kids = sorted(children.get(item["id"], []), key=lambda s: s.get("created") or "")
        node["replies"] = [_suggestion_node(c, children, client_id, depth + 1) for c in kids]
    return node


@app.get("/api/suggestions")
def get_suggestions(request: Request) -> dict:
    """Public board: a tree of threads, open first, then recently finished."""
    client_id = (request.query_params.get("client_id") or "").strip()
    if not _valid_client_id(client_id):
        client_id = ""
    items = ml.load_suggestions()
    children: dict[str, list[dict]] = defaultdict(list)
    for s in items:
        pid = s.get("parent_id")
        if pid:
            children[pid].append(s)
    roots = [s for s in items if not s.get("parent_id")]
    open_roots = sorted((s for s in roots if not s.get("done")),
                        key=lambda s: _suggestion_activity(s, children), reverse=True)
    done_roots = sorted((s for s in roots if s.get("done")),
                        key=lambda s: (s.get("done_at") or "", s.get("created") or ""),
                        reverse=True)
    ordered = open_roots + done_roots
    return {
        "count": len(roots),
        "open": len(open_roots),
        "done": len(done_roots),
        "replies": max(0, len(items) - len(roots)),
        "total": len(items),
        "suggestions": [_suggestion_node(s, children, client_id) for s in ordered],
    }


@app.post("/api/suggestions", status_code=201)
def create_suggestion(body: SuggestionInput, request: Request) -> dict:
    text = "".join(ch for ch in body.text.replace("\r\n", "\n")
                   if ch in "\n\t" or ord(ch) >= 32).strip()
    if not text:
        raise HTTPException(status_code=400, detail="write a bug or suggestion first")
    author = " ".join(body.author.split())[:MAX_SUGGESTION_AUTHOR]
    parent_id = (body.parent_id or "").strip() or None
    enforce_suggestion_write(request)
    with ml.flock():
        items = ml.load_suggestions()
        if len(items) >= MAX_SUGGESTIONS:
            raise HTTPException(status_code=429, detail="the suggestion board is full")
        parent = None
        if parent_id:
            parent = next((s for s in items if s.get("id") == parent_id), None)
            if parent is None:
                raise HTTPException(status_code=404, detail="parent suggestion not found")
            if _suggestion_depth(items, parent) >= MAX_SUGGESTION_DEPTH:
                raise HTTPException(status_code=400, detail="reply chain is too deep")
        item = {
            "id": ml.new_suggestion_id(),
            "kind": _normalize_kind(parent.get("kind") if parent else body.kind),
            "text": text,
            "author": author,
            "created": ml.now_iso("milliseconds"),
            "done": False,
        }
        if parent_id:
            item["parent_id"] = parent_id
            # Replying to a finished thread reopens the whole chain.
            root = _suggestion_root(items, parent)
            chain = _suggestion_subtree(items, root["id"])
            for s in items:
                if s["id"] in chain:
                    s["done"] = False
                    s.pop("done_at", None)
        items.append(item)
        ml.save_suggestions(items)
    return _suggestion_node(item, {}, "")


@app.patch("/api/suggestions/{sid}")
def update_suggestion(sid: str, body: SuggestionPatch, request: Request) -> dict:
    """Finish or reopen the entire thread that contains ``sid``."""
    enforce_write(request)
    with ml.flock():
        items = ml.load_suggestions()
        item = next((s for s in items if s.get("id") == sid), None)
        if item is None:
            raise HTTPException(status_code=404, detail="suggestion not found")
        root = _suggestion_root(items, item)
        chain = _suggestion_subtree(items, root["id"])
        now = ml.now_iso("milliseconds")
        for s in items:
            if s["id"] in chain:
                s["done"] = body.done
                if body.done:
                    s["done_at"] = now
                else:
                    s.pop("done_at", None)
        ml.save_suggestions(items)
        children: dict[str, list[dict]] = defaultdict(list)
        for s in items:
            pid = s.get("parent_id")
            if pid:
                children[pid].append(s)
        return _suggestion_node(root, children, "")


@app.post("/api/suggestions/{sid}/vote")
def vote_suggestion(sid: str, body: SuggestionVote, request: Request) -> dict:
    enforce_write(request)
    client_id = body.client_id.strip()
    if not _valid_client_id(client_id):
        raise HTTPException(status_code=400, detail="invalid client id")
    with ml.flock():
        items = ml.load_suggestions()
        item = next((s for s in items if s.get("id") == sid), None)
        if item is None:
            raise HTTPException(status_code=404, detail="suggestion not found")
        votes = item.get("votes") if isinstance(item.get("votes"), dict) else {}
        if body.value == 0:
            votes.pop(client_id, None)
        else:
            votes[client_id] = body.value
        if votes:
            item["votes"] = votes
        else:
            item.pop("votes", None)
        ml.save_suggestions(items)
    likes = sum(1 for v in votes.values() if v == 1)
    dislikes = sum(1 for v in votes.values() if v == -1)
    return {"id": sid, "likes": likes, "dislikes": dislikes,
            "my_vote": int(votes.get(client_id, 0))}


_REPLACE_FIELDS = ("youtube_url", "video_id", "youtube_kind", "youtube_title",
                   "album", "duration", "cover", "asset", "year")


def _stage_replace_file(path: Path | None) -> tuple[Path, Path] | None:
    """Move an existing asset/cover aside so a re-download can replace it.

    Returns ``(backup, original)`` or None. The backup is restored if the
    replacement download fails, so a bad match can never destroy the old audio.
    """
    if not path or not path.is_file():
        return None
    backup = path.with_name(path.name + ".replace-bak")
    try:
        backup.unlink(missing_ok=True)
        path.replace(backup)
        return backup, path
    except OSError:
        return None


def _restore_replace_files(staged: list[tuple[Path, Path]], new_asset: Path | None) -> None:
    """Drop a partial re-download and put the staged originals back."""
    for p in (new_asset,
              new_asset.with_name(new_asset.name + ".part") if new_asset else None):
        try:
            if p and p.is_file():
                p.unlink()
        except OSError:
            pass
    for backup, original in staged:
        try:
            if backup.is_file():
                original.parent.mkdir(parents=True, exist_ok=True)
                backup.replace(original)
        except OSError:
            pass


def _discard_replace_files(staged: list[tuple[Path, Path]]) -> None:
    for backup, _original in staged:
        try:
            backup.unlink(missing_ok=True)
        except OSError:
            pass


def _restore_replace_master(sid: str, old_fields: dict) -> None:
    with ml.flock():
        master = ml.load_master()
        song = ml.song_by_id(master, sid)
        if song is None:
            return
        # Restore only the fields this endpoint touched, so a concurrent edit
        # to another field (or another song) survives the rollback.
        for field in _REPLACE_FIELDS:
            if field in old_fields:
                song[field] = old_fields[field]
            else:
                song.pop(field, None)
        ml.save_master(master)


@app.post("/api/songs/{sid}/replace-match")
def replace_match(sid: str, request: Request) -> dict:
    """Reject the current video, pick the next-best match, and swap the audio.

    The old match is only retired once the replacement has actually downloaded.
    If the search or download fails, the previous metadata *and* audio are
    restored instead of leaving the song without a file and without metadata.
    """
    enforce_write(request)
    if download_quota.remaining() < 1:
        raise HTTPException(status_code=429, detail="download quota exhausted",
                            headers={"Retry-After": str(int(download_quota.reset_in()) + 1)})
    if not _download_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="a download is already in progress")
    try:
        with ml.flock():
            master = ml.load_master()
            song = ml.song_by_id(master, sid)
            if song is None:
                raise HTTPException(status_code=404, detail="song not found")
            old_vid = ml.video_id_of(song)
            title, artist, album = song.get("title", ""), song.get("artist", ""), song.get("album", "")
        try:
            # Exclude the current video for this search only. Persisting the
            # rejection up front used to blacklist a perfectly good video even
            # when no alternative was found or the download failed.
            proc = run_tool([str(TOOL_DIR / "match_song.py"),
                             "--title", title, "--artist", artist, "--album", album,
                             "--exclude", old_vid or ""], timeout=60)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="match search timed out")
        if proc.returncode != 0:
            raise HTTPException(status_code=502, detail=("match failed: " + (proc.stderr or proc.stdout))[-200:])
        try:
            best = (json.loads(proc.stdout) or {}).get("best")
        except json.JSONDecodeError:
            raise HTTPException(status_code=502, detail="match returned invalid JSON")
        if not best or not best.get("url") or not best.get("video_id"):
            raise HTTPException(status_code=409, detail="no alternative match found")
        if old_vid and best["video_id"] == old_vid:
            raise HTTPException(status_code=409, detail="no alternative match found")

        staged: list[tuple[Path, Path]] = []
        old_fields: dict = {}
        new_asset: Path | None = None
        try:
            with ml.flock():
                master = ml.load_master()
                song = ml.song_by_id(master, sid)
                if song is None:
                    raise HTTPException(status_code=404, detail="song not found")
                old_fields = {k: song[k] for k in _REPLACE_FIELDS if k in song}
                old_asset = ml.asset_file(song)
                old_cover = ml.cover_file(song)
                for path in (old_asset, old_cover):
                    entry = _stage_replace_file(path)
                    if entry:
                        staged.append(entry)
                song["youtube_url"] = best["url"]
                song["video_id"] = best["video_id"]
                song["youtube_kind"] = best.get("kind", "")
                song["youtube_title"] = best.get("title", "")
                new_album = (best.get("album") or "").strip()
                if new_album:
                    if old_fields.get("album") and new_album != old_fields["album"]:
                        # The old year belonged to the old album.
                        song.pop("year", None)
                    song["album"] = new_album
                song["duration"] = None
                song.pop("cover", None)
                new_asset = ml.ASSETS_DIR / ml.expected_asset(song)
                ml.save_master(master)

            summary, log_tail = _download_and_summarize(["--only", sid, "--max-downloads", "1"], timeout=300)
            download_quota.record(max(1, summary.get("attempted", 0)))
            if not (new_asset and new_asset.is_file() and new_asset.stat().st_size > 0):
                raise RuntimeError("replacement download failed" + ((": " + log_tail) if log_tail else ""))

            _discard_replace_files(staged)

            # The swap succeeded: reject the old video and fill duration from
            # the match metadata if ffprobe was unavailable on this machine.
            with ml.flock():
                master = ml.load_master()
                song = ml.song_by_id(master, sid)
                if song is not None and not song.get("duration"):
                    fallback = best.get("duration")
                    if isinstance(fallback, (int, float)) and fallback > 0:
                        song["duration"] = round(float(fallback), 3)
                ml.save_master(master)
            if old_vid:
                with ml.flock():
                    ml.add_bad_link(old_vid)
        except Exception as exc:
            _restore_replace_files(staged, new_asset)
            if old_fields:
                _restore_replace_master(sid, old_fields)
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(status_code=502, detail=str(exc)[-300:])

        fresh = ml.song_by_id(ml.load_master(), sid)
        if fresh is None:
            raise HTTPException(status_code=404, detail="song was deleted during replacement")
        return {"song": slim(fresh, ml.load_ratings(), ml.load_gains()), "match": best,
                "download": summary, "quota": quota_state()}
    finally:
        _download_lock.release()


@app.post("/api/commit")
def commit(body: CommitInput, request: Request) -> JSONResponse:
    global _commit_last
    enforce_write(request)
    wait = commit_cooldown()
    if wait > 0:
        raise HTTPException(status_code=429, detail=f"commit cooling down for {wait:.0f}s",
                            headers={"Retry-After": str(int(wait) + 1)})
    with _commit_lock:
        _commit_last = time.monotonic()
    message = body.message.strip() or f"web edit by {client_ip(request)}"
    with ml.flock():
        result = ml.commit_push(message, push=True)
    return JSONResponse({**result, "message": message, "status": ml.git_status()})


# --------------------------------------------------------------------------- #
# admin: search YouTube Music, add + download, refresh assets
# --------------------------------------------------------------------------- #
@app.get("/api/admin/quota")
def admin_quota() -> dict:
    return quota_state()


@app.get("/api/search")
def search_songs(q: str, request: Request, limit: int = 12) -> dict:
    """Song-first YouTube Music search: one canonical video per song, deduped."""
    wait = search_limiter.check(client_ip(request))
    if wait > 0:
        raise HTTPException(status_code=429, detail=f"search slow down; retry in {wait:.0f}s",
                            headers={"Retry-After": str(int(wait) + 1)})
    q = (q or "").strip()[:200]
    if not q:
        raise HTTPException(status_code=400, detail="empty query")
    limit = max(1, min(int(limit), 15))
    if not _search_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="a search is already running")
    try:
        try:
            proc = run_tool([str(TOOL_DIR / "search_songs.py"),
                             "--query", q, "--limit", str(limit)], timeout=60)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="search timed out")
        if proc.returncode != 0:
            raise HTTPException(status_code=502,
                                detail=("search failed: " + (proc.stderr or proc.stdout))[-300:])
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError:
            raise HTTPException(status_code=502, detail="search returned invalid JSON")
    finally:
        _search_lock.release()


@app.post("/api/admin/add")
def admin_add(body: AddSongInput, request: Request) -> dict:
    enforce_write(request)
    url = body.youtube_url.strip()
    if ml.video_id(url) is None:
        raise HTTPException(status_code=400, detail="not a valid YouTube URL")
    if download_quota.remaining() < 1:
        raise HTTPException(status_code=429, detail="download quota exhausted",
                            headers={"Retry-After": str(int(download_quota.reset_in()) + 1)})
    if not _download_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="a download is already in progress")
    try:
        if download_quota.remaining() < 1:
            raise HTTPException(status_code=429, detail="download quota exhausted",
                                headers={"Retry-After": str(int(download_quota.reset_in()) + 1)})
        songs_before = ml.load_master().get("songs", [])
        genre = auto_genre(body.title, body.artist, body.album, body.genre, songs_before)
        with ml.flock():
            master = ml.load_master()
            songs = master.get("songs", [])
            if len(songs) >= MAX_MASTER_SONGS:
                raise HTTPException(status_code=429, detail="master list full")
            song = {
                "id": "", "title": body.title.strip(), "artist": body.artist.strip(),
                "genre": genre, "youtube_url": url,
                "youtube_kind": body.youtube_kind.strip(),
                "youtube_title": body.youtube_title.strip(), "duration": None,
                "album": body.album.strip(),
            }
            sid = ml.make_song_id(song)
            key = ml.song_key_of(song)
            if ml.song_by_id(master, sid) or any(ml.song_key_of(s) == key for s in songs):
                raise HTTPException(status_code=409, detail="song already in the master list")
            song["id"] = sid
            song["asset"] = ml.expected_asset(song)
            songs.append(song)
            master["songs"] = songs
            ml.save_master(master)
        summary, log_tail = _download_and_summarize(["--only", sid, "--max-downloads", "1"], timeout=300)
        download_quota.record(max(1, summary.get("attempted", 0)))
        # The downloader merged asset/duration into master; return the fresh
        # entry rather than the pre-download snapshot (which had duration None).
        fresh = ml.song_by_id(ml.load_master(), sid) or song
        return {"song": slim(fresh, ml.load_ratings(), ml.load_gains()),
                "download": summary, "quota": quota_state(), "log": log_tail}
    finally:
        _download_lock.release()


@app.post("/api/admin/refresh")
def admin_refresh(request: Request) -> dict:
    enforce_write(request)
    if not _download_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="a download is already in progress")
    try:
        remaining = download_quota.remaining()
        if remaining < 1:
            raise HTTPException(status_code=429, detail="download quota exhausted",
                                headers={"Retry-After": str(int(download_quota.reset_in()) + 1)})
        summary, log_tail = _download_and_summarize(
            ["--max-downloads", str(remaining)], timeout=900)
        download_quota.record(max(0, summary.get("attempted", 0)))
        return {"summary": summary, "quota": quota_state(), "log": log_tail}
    finally:
        _download_lock.release()


# --------------------------------------------------------------------------- #
# optional prefix stripping
# --------------------------------------------------------------------------- #
class PrefixMiddleware:
    def __init__(self, asgi_app, prefix: str):
        self.app, self.prefix = asgi_app, prefix

    async def __call__(self, scope, receive, send):
        if self.prefix and scope["type"] in ("http", "websocket"):
            path = scope.get("path", "/")
            if path == self.prefix:
                await RedirectResponse(url=self.prefix + "/", status_code=307)(scope, receive, send)
                return
            if path.startswith(self.prefix + "/"):
                scope = dict(scope)
                # Strip the prefix from the path; Starlette must not also treat
                # the prefix as root_path or it will fail to match /static/*.
                scope["path"] = path[len(self.prefix):]
                scope["root_path"] = ""
        await self.app(scope, receive, send)


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
asgi_app = PrefixMiddleware(app, ROOT_PATH)
