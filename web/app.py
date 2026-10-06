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
    POST   /api/commit                git add/commit/push the data repo

Changes are written to disk immediately; the Commit button (rate-limited to once
per COMMIT_INTERVAL seconds, globally) makes them durable and rollback-able.

Environment
    MOOSIC_DATA       data repo (default ~/Projects/Music)
    MOOSIC_HOST/PORT  bind (default 127.0.0.1:8740)
    MOOSIC_ROOT_PATH  URL prefix to strip (e.g. /music)
    MOOSIC_WRITE_RPM  per-client writes/min (default 40)
    MOOSIC_COMMIT_INTERVAL  seconds between commits (default 60)
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
from collections import defaultdict, deque
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
import musiclib as ml  # noqa: E402

ROOT_PATH = os.environ.get("MOOSIC_ROOT_PATH", "").rstrip("/")
WRITE_RPM = int(os.environ.get("MOOSIC_WRITE_RPM", "40"))
COMMIT_INTERVAL = float(os.environ.get("MOOSIC_COMMIT_INTERVAL", "60"))
DOWNLOAD_LIMIT = int(os.environ.get("MOOSIC_DOWNLOAD_LIMIT", "20"))
DOWNLOAD_WINDOW = float(os.environ.get("MOOSIC_DOWNLOAD_WINDOW", "1800"))
SEARCH_RPM = int(os.environ.get("MOOSIC_SEARCH_RPM", "20"))
STATIC = ROOT / "static"
TOOL_DIR = ROOT.parent
TOOL_PYTHON = Path(os.environ.get("MOOSIC_TOOL_PYTHON", str(TOOL_DIR / ".venv" / "bin" / "python")))

MAX_PLAYLISTS = 500
MAX_PLAYLIST_SONGS = 2000
MAX_MASTER_SONGS = 5000

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
_download_lock = threading.Lock()
_search_lock = threading.Lock()


def run_tool(args: list[str], timeout: int) -> subprocess.CompletedProcess:
    env = {**os.environ, "MOOSIC_DATA": str(ml.DATA_DIR)}
    env.setdefault("HOME", "/home/max")
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
    return summary, (proc.stdout + proc.stderr)[-800:]


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


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def slim(song: dict) -> dict:
    return {
        "id": song.get("id", ""),
        "title": song.get("title", ""),
        "artist": song.get("artist", ""),
        "genre": song.get("genre", ""),
        "duration": song.get("duration"),
        "youtube_url": song.get("youtube_url", ""),
        "has_asset": ml.asset_file(song).is_file(),
    }


def genres_of(songs: list[dict]) -> dict:
    out: dict[str, int] = {}
    for s in songs:
        g = s.get("genre") or "Unsorted"
        out[g] = out.get(g, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


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
    return {"count": len(songs), "genres": genres_of(songs), "songs": [slim(s) for s in songs]}


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
    songs = []
    for sid in pl.get("songs", []):
        song = ml.song_by_id(master, sid)
        songs.append(slim(song) if song else {"id": sid, "missing": True})
    pl["songs"] = songs
    return pl


@app.get("/api/stream/{sid}")
def stream(sid: str) -> FileResponse:
    song = ml.song_by_id(ml.load_master(), sid)
    if song is None:
        raise HTTPException(status_code=404, detail="song not found")
    return FileResponse(resolve_stream(song), media_type="audio/mpeg",
                        filename=Path(song.get("asset", "audio.mp3")).name)


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
    with ml.flock():
        master = ml.load_master()
        songs = master.get("songs", [])
        if len(songs) >= MAX_MASTER_SONGS:
            raise HTTPException(status_code=429, detail="master list full")
        song = {"id": "", "title": body.title.strip(), "artist": body.artist.strip(),
                "genre": body.genre.strip() or "Unsorted",
                "youtube_url": body.youtube_url.strip(),
                "youtube_kind": body.youtube_kind.strip(),
                "youtube_title": "", "duration": None}
        sid = ml.make_song_id(song)
        if ml.song_by_id(master, sid):
            raise HTTPException(status_code=409, detail="song already in the master list")
        song["id"] = sid
        song["asset"] = ml.expected_asset(song)
        songs.append(song)
        master["songs"] = songs
        ml.save_master(master)
    return slim(song)


@app.patch("/api/songs/{sid}")
def update_song(sid: str, body: SongPatch, request: Request) -> dict:
    enforce_write(request)
    with ml.flock():
        master = ml.load_master()
        song = ml.song_by_id(master, sid)
        if song is None:
            raise HTTPException(status_code=404, detail="song not found")
        for field in ("title", "artist", "genre", "youtube_url"):
            val = getattr(body, field)
            if val is not None and val.strip():
                song[field] = val.strip()
        old_asset = ml.ASSETS_DIR / song.get("asset", "")
        new_id = ml.make_song_id(song)
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
            song["id"] = new_id
        ml.save_master(master)
    return slim(song)


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
        for pl in ml.list_playlists():
            if sid in pl.get("songs", []):
                pl_slug = pl.pop("slug")
                pl["songs"] = [x for x in pl["songs"] if x != sid]
                ml.save_playlist(pl_slug, pl)
    return {"deleted": sid}


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
def search_youtube(q: str, request: Request, limit: int = 8) -> dict:
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
            proc = run_tool([str(TOOL_DIR / "search_youtube.py"),
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
        with ml.flock():
            master = ml.load_master()
            songs = master.get("songs", [])
            if len(songs) >= MAX_MASTER_SONGS:
                raise HTTPException(status_code=429, detail="master list full")
            song = {
                "id": "", "title": body.title.strip(), "artist": body.artist.strip(),
                "genre": body.genre.strip() or "Unsorted", "youtube_url": url,
                "youtube_kind": body.youtube_kind.strip(),
                "youtube_title": body.youtube_title.strip(), "duration": None,
            }
            sid = ml.make_song_id(song)
            if ml.song_by_id(master, sid):
                raise HTTPException(status_code=409, detail="song already in the master list")
            song["id"] = sid
            song["asset"] = ml.expected_asset(song)
            songs.append(song)
            master["songs"] = songs
            ml.save_master(master)
        summary, log_tail = _download_and_summarize(["--only", sid, "--max-downloads", "1"], timeout=300)
        download_quota.record(max(1, summary.get("attempted", 0)))
        song["duration"] = None
        return {"song": slim(song), "download": summary, "quota": quota_state(), "log": log_tail}
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
                scope["path"] = path[len(self.prefix):]
                scope["root_path"] = self.prefix
        await self.app(scope, receive, send)


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
asgi_app = PrefixMiddleware(app, ROOT_PATH)
