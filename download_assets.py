#!/usr/bin/env python3
"""Reconcile the assets folder against the master list (the yt-dlp refresher).

The master list (`$MOOSIC_DATA/master.json`) is the single source of truth.
For every song this script:

  1. ensures the file exists at ``<Genre>/<Artist>/<Title>.mp3`` under the
     assets dir, downloading it through the local yt-audio-api (yt-dlp) server
     if needed;
  2. moves an existing asset if the song was retagged (path changed);
  3. writes ``asset`` + ``duration`` back into master.json;
  4. optionally moves assets that are no longer referenced by master.json into
     ``assets/_trash/<timestamp>/`` (never deletes).

Dry-run by default; pass ``--execute`` to act. Safe to re-run: already-present
files are skipped, so it resumes cleanly.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import musiclib as ml

ROOT = Path(__file__).resolve().parent
DEFAULT_SERVER_DIR = ROOT / "yt-audio-api"
DEFAULT_PYTHON = ROOT / ".venv" / "bin" / "python"

log = logging.getLogger("refresh_assets")

_SERVER_CODE = r"""
import sys
import threading

sys.path.insert(0, ".")

from main import app          # noqa: E402
from access_manager import manage_tokens  # noqa: E402

port = int(sys.argv[1])
threading.Thread(target=manage_tokens, daemon=True).start()
app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False)
"""


def try_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def find_server_python(python: Path | None) -> str:
    if python and Path(python).is_file():
        return str(python)
    return sys.executable or "python3"


def request(session: urllib.request.OpenerDirector, url: str, timeout: float):
    req = urllib.request.Request(url, headers={"User-Agent": "moosic-refresh/2.0"})
    try:
        with session.open(req, timeout=timeout) as resp:
            body = resp.read()
            ct = resp.headers.get("Content-Type", "").split(";")[0]
            data = json.loads(body) if "json" in ct else None
            return resp.status, data, body
    except urllib.error.HTTPError as e:
        body = e.read()
        ct = e.headers.get("Content-Type", "").split(";")[0]
        data = json.loads(body) if "json" in ct else None
        return e.code, data, body
    except urllib.error.URLError as e:
        return None, {"error": f"connection failed: {e.reason}"}, None


def start_server(server_dir: Path, python: str, port: int, log_file: Path) -> subprocess.Popen:
    return subprocess.Popen(
        [python, "-c", _SERVER_CODE, str(port)],
        cwd=str(server_dir), stdout=log_file.open("w"), stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def wait_ready(base: str, timeout: float = 60.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, _, _ = request(urllib.request.build_opener(), f"{base}/", timeout=5)
        if status is not None:
            return True
        time.sleep(0.5)
    return False


def download_mp3(base: str, youtube_url: str, destination: Path) -> bool:
    session = urllib.request.build_opener()
    token_url = f"{base}/?url={urllib.parse.quote(youtube_url, safe='')}"
    status, data, _ = request(session, token_url, timeout=600)
    if status != 200 or not data or "token" not in data:
        log.warning("    token request failed: %s",
                    (data or {}).get("error") or f"HTTP {status}")
        return False
    download_url = f"{base}/download?token={urllib.parse.quote(data['token'], safe='')}"
    status, data, body = request(session, download_url, timeout=600)
    if status != 200 or body is None:
        log.warning("    download failed: %s", (data or {}).get("error") or f"HTTP {status}")
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_suffix(destination.suffix + ".part")
    temp.write_bytes(body)
    temp.replace(destination)
    return True


def probe_duration(path: Path) -> float | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30)
        return round(float(out.stdout.strip()), 3) if out.stdout.strip() else None
    except (ValueError, subprocess.SubprocessError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master", type=Path, default=ml.MASTER)
    parser.add_argument("--assets", type=Path, default=ml.ASSETS_DIR)
    parser.add_argument("--server-dir", type=Path, default=DEFAULT_SERVER_DIR)
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON)
    parser.add_argument("--execute", action="store_true", help="Actually download/move (default: dry run)")
    parser.add_argument("--prune", dest="prune", action="store_true", default=True,
                        help="Move unreferenced assets to _trash/ (default)")
    parser.add_argument("--no-prune", dest="prune", action="store_false")
    parser.add_argument("--commit", action="store_true", help="Commit+push master.json when done")
    parser.add_argument("--only", type=str, default=None,
                        help="Comma-separated master ids (or id substrings) to limit to")
    parser.add_argument("--delay", type=float, default=0.0)
    parser.add_argument("--max-downloads", type=int, default=0,
                        help="Cap successful downloads this run (0 = unlimited)")
    parser.add_argument("--summary-json", type=Path, default=None,
                        help="Write a machine-readable result summary to this path")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)

    master = json.loads(args.master.read_text(encoding="utf-8"))
    songs = master.get("songs", [])
    if args.only:
        wanted = {x.strip() for x in args.only.split(",") if x.strip()}
        songs = [s for s in songs if s.get("id") in wanted or any(w in (s.get("id") or "") for w in wanted)]
        # Never prune when restricting to specific songs: the "referenced" set
        # would only cover the subset and trash everything else.
        args.prune = False
        log.info("limiting to %d song(s); pruning disabled", len(songs))

    # --- plan ---------------------------------------------------------------
    to_download: list[dict] = []
    to_move: list[tuple[Path, Path, dict]] = []
    need_duration: list[dict] = []
    referenced: set[Path] = set()
    no_url = 0
    for song in songs:
        expected_rel = ml.expected_asset(song)
        expected_abs = (args.assets / expected_rel).resolve()
        referenced.add(expected_abs)
        current = song.get("asset")
        current_abs = (args.assets / current).resolve() if current else None
        if current_abs and current_abs != expected_abs and current_abs.is_file():
            to_move.append((current_abs, expected_abs, song))
        if not expected_abs.is_file() or expected_abs.stat().st_size == 0:
            if song.get("youtube_url"):
                to_download.append(song)
            else:
                no_url += 1
        else:
            need_duration.append(song)

    # referenced must also include destinations of moves
    for _src, dst, _s in to_move:
        referenced.add(dst)

    if args.max_downloads and len(to_download) > args.max_downloads:
        log.info("capping downloads to %d (of %d missing)", args.max_downloads, len(to_download))
        to_download = to_download[: args.max_downloads]

    # --- prune candidates ---------------------------------------------------
    orphans: list[Path] = []
    if args.prune:
        for p in args.assets.rglob("*.mp3"):
            if "_trash" in p.parts or p.name.endswith(".part"):
                continue
            if p.resolve() not in referenced:
                orphans.append(p)

    log.info("songs=%d  download=%d  move/rename=%d  missing-url=%d  orphans=%d",
             len(songs), len(to_download), len(to_move), no_url, len(orphans))
    for _src, dst, song in to_move[:8]:
        log.info("   rename  %s -> %s", song.get("asset"), ml.expected_asset(song))
    for song in to_download[:8]:
        log.info("   fetch   %s — %s", song.get("artist"), song.get("title"))
    for p in orphans[:8]:
        log.info("   trash   %s", p.relative_to(args.assets))
    if not args.execute:
        log.info("DRY RUN — re-run with --execute to apply.")
        return 0

    # --- download server ----------------------------------------------------
    proc = None
    base = None
    if to_download:
        python = find_server_python(args.python)
        port = try_port()
        base = f"http://127.0.0.1:{port}"
        log_file = ROOT / ".download_assets_server.log"
        proc = start_server(args.server_dir, python, port, log_file)
        if not wait_ready(base):
            log.error("yt-audio-api server did not start; see %s", log_file)
            proc.send_signal(signal.SIGINT)
            return 1

    moved = downloaded = failed = trashed = 0
    downloaded_ids: list[str] = []
    failed_ids: list[str] = []
    try:
        for src, dst, song in to_move:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            moved += 1
        for song in to_download:
            dst = args.assets / ml.expected_asset(song)
            log.info("fetch  %s — %s", song.get("artist"), song.get("title"))
            if download_mp3(base, song["youtube_url"], dst):
                downloaded += 1
                downloaded_ids.append(song.get("id", ""))
            else:
                failed += 1
                failed_ids.append(song.get("id", ""))
            if args.delay:
                time.sleep(args.delay)
    finally:
        if proc and proc.poll() is None:
            proc.send_signal(signal.SIGINT)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    if args.prune and orphans:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        trash = args.assets / "_trash" / stamp
        for p in orphans:
            dest = trash / p.relative_to(args.assets)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(dest))
            trashed += 1

    # --- write asset + duration back to master ------------------------------
    changed = 0
    for song in songs:
        rel = ml.expected_asset(song)
        abs_path = args.assets / rel
        song["asset"] = rel
        if abs_path.is_file():
            dur = probe_duration(abs_path)
            if dur is not None and song.get("duration") != dur:
                song["duration"] = dur
                changed += 1
    args.master.write_text(json.dumps(master, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    log.info("done: moved=%d downloaded=%d trashed=%d failed=%d (duration updates=%d)",
             moved, downloaded, trashed, failed, changed)

    if args.summary_json:
        args.summary_json.parent.mkdir(parents=True, exist_ok=True)
        args.summary_json.write_text(json.dumps({
            "downloaded": downloaded, "moved": moved, "trashed": trashed,
            "failed": failed, "attempted": downloaded + failed,
            "downloaded_ids": downloaded_ids, "failed_ids": failed_ids,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.commit:
        with ml.flock():
            res = ml.commit_push(f"refresh assets: +{downloaded} downloaded, {moved} renamed, "
                                 f"{trashed} trashed")
        log.info("commit: %s", res)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
