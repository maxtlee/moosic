#!/usr/bin/env python3
"""Download an MP3 for every song in songs.json via the local yt-audio-api server.

The yt-audio-api helper (https://github.com/alperensumeroglu/yt-audio-api) is a
Flask app with two endpoints:
    GET /?url=<youtube_url>          -> {"token": "<one-time download token>"}
    GET /download?token=<token>      -> the converted MP3 file

This script boots that server on a local port, iterates over every entry in
songs.json, requests a token for each youtube_url, downloads the resulting MP3,
and stores it in an assets folder. Songs that already have a file in the assets
folder are skipped, so the script can be re-run safely and resumes cleanly.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import signal
import socket
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_SONGS = ROOT / "music_to_extract" / "songs.json"
DEFAULT_ASSETS = ROOT / "assets"
DEFAULT_SERVER_DIR = ROOT / "yt-audio-api"
DEFAULT_PYTHON = ROOT / ".venv" / "bin" / "python"

log = logging.getLogger("download_assets")

_SERVER_CODE = r"""
import sys
import threading

sys.path.insert(0, ".")

from main import app          # noqa: E402
from access_manager import manage_tokens  # noqa: E402

port = int(sys.argv[1])

# Mirror main()'s background cleanup so expired tokens/files are purged.
threading.Thread(target=manage_tokens, daemon=True).start()

app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False)
"""


def try_port() -> int:
    """Return a currently free TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def find_server_python(python: Path | None) -> str:
    if python and Path(python).is_file():
        return str(python)
    return sys.executable or "python3"


def sanitize(name: str) -> str:
    """Turn an arbitrary artist/title into a safe filename component."""
    name = unicodedata.normalize("NFKC", name or "").strip()
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name or "untitled"


def request(session: urllib.request.OpenerDirector, url: str, timeout: float):
    """GET a URL and return (status, json_dict_or_None, raw_bytes_or_None)."""
    req = urllib.request.Request(url, headers={"User-Agent": "download_assets/1.0"})
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
    cmd = [python, "-c", _SERVER_CODE, str(port)]
    proc = subprocess.Popen(
        cmd,
        cwd=str(server_dir),
        stdout=log_file.open("w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc


def wait_ready(base: str, timeout: float = 60.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, _, _ = request(urllib.request.build_opener(), f"{base}/", timeout=5)
        if status is not None:
            return True
        time.sleep(0.5)
    return False


def download_mp3(base: str, youtube_url: str, destination: Path) -> bool:
    """Ask the server to convert youtube_url and save the MP3 to destination."""
    session = urllib.request.build_opener()

    token_url = f"{base}/?url={urllib.parse.quote(youtube_url, safe='')}"
    status, data, _ = request(session, token_url, timeout=600)
    if status != 200 or not data or "token" not in data:
        msg = (data or {}).get("error") or (data or {}).get("detail") or f"HTTP {status}"
        log.warning("  token request failed: %s", msg)
        return False

    token = data["token"]
    download_url = f"{base}/download?token={urllib.parse.quote(token, safe='')}"
    status, data, body = request(session, download_url, timeout=600)
    if status != 200 or body is None:
        msg = (data or {}).get("error") or f"HTTP {status}"
        log.warning("  download failed: %s", msg)
        return False

    temp = destination.with_suffix(destination.suffix + ".part")
    temp.write_bytes(body)
    temp.replace(destination)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--songs", type=Path, default=DEFAULT_SONGS,
                        help=f"JSON file of songs (default: {DEFAULT_SONGS})")
    parser.add_argument("--assets", type=Path, default=DEFAULT_ASSETS,
                        help=f"Output folder for the mp3 assets (default: {DEFAULT_ASSETS})")
    parser.add_argument("--server-dir", type=Path, default=DEFAULT_SERVER_DIR,
                        help=f"Path to the yt-audio-api helper repo (default: {DEFAULT_SERVER_DIR})")
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON,
                        help="Python interpreter used to launch the helper server "
                             "(default: the repo's .venv interpreter)")
    parser.add_argument("--start", type=int, default=1,
                        help="1-based index of the first song to download")
    parser.add_argument("--limit", type=int, default=0,
                        help="Maximum number of songs to download (0 = all)")
    parser.add_argument("--delay", type=float, default=0.0,
                        help="Seconds to sleep between songs")
    parser.add_argument("--verbose", action="store_true", help="Show server log output")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
        stream=sys.stdout,
    )

    songs = json.loads(args.songs.read_text(encoding="utf-8"))
    if not isinstance(songs, list):
        log.error("songs.json must contain a list of song objects")
        return 1

    args.assets.mkdir(parents=True, exist_ok=True)

    python = find_server_python(args.python)
    port = try_port()
    base = f"http://127.0.0.1:{port}"
    log_file = ROOT / ".download_assets_server.log"

    proc = start_server(args.server_dir, python, port, log_file)
    try:
        if not wait_ready(base):
            log.error("yt-audio-api server did not start; check %s", log_file)
            if args.verbose:
                log.error(log_file.read_text(encoding="utf-8", errors="replace"))
            return 1
        log.info("yt-audio-api server ready at %s", base)
        log.info("Downloading into %s", args.assets)

        selected = songs[max(0, args.start - 1):]
        if args.limit:
            selected = selected[:args.limit]

        ok = skip = fail = 0
        for i, song in enumerate(selected, start=max(1, args.start)):
            title, artist = song.get("title", ""), song.get("artist", "")
            label = f"{artist} - {title}" if artist else title
            destination = args.assets / f"{i:04d} - {sanitize(artist)} - {sanitize(title)}.mp3"

            if destination.exists() and destination.stat().st_size > 0:
                log.info("[%d/%d] SKIP  %s (already downloaded)", i, len(songs), label)
                skip += 1
                continue

            url = song.get("youtube_url")
            if not url:
                log.warning("[%d/%d] FAIL  %s (no youtube_url)", i, len(songs), label)
                fail += 1
                continue

            log.info("[%d/%d] fetch %s", i, len(songs), label)
            if download_mp3(base, url, destination):
                log.info("  saved %s", destination.name)
                ok += 1
            else:
                log.warning("  FAILED %s", url)
                fail += 1

            if args.delay:
                time.sleep(args.delay)

        log.info("%d of %d songs saved (%d skipped, %d failed)", ok, len(selected), skip, fail)
        return 0
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGINT)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    sys.exit(main())