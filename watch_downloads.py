#!/usr/bin/env python3
"""Watch the master songs.json and download any newly added songs.

The master playlist (music_to_extract/songs.json) can be rewritten by an
external source at any time. This script:

  * watches that file (via inotifywait, falling back to timed polling),
  * whenever it changes, diffs the new list against the previously-seen set of
    YouTube URLs stored in a state file,
  * downloads the audio for any song whose URL is new (running the local
    yt-audio-api helper through download_assets.py --only <indexes>),
  * records the new state so the next change only fetches what's genuinely new.

On the very first run there is no snapshot, so the current list is used as the
baseline and nothing is downloaded (pass --add-existing to download it all).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_SONGS = ROOT / "music_to_extract" / "songs.json"
DEFAULT_DOWNLOADER = ROOT / "download_assets.py"
DEFAULT_STATE = ROOT / ".song_download_state.json"
DEFAULT_PYTHON = ROOT / ".venv" / "bin" / "python"

log = logging.getLogger("watch_downloads")

WATCH_EVENTS = "close_write,create,moved_to"


def song_key(song: dict) -> str:
    """Stable identity for a song: its YouTube URL, else artist+title."""
    url = (song.get("youtube_url") or "").strip()
    if url:
        return url
    return f"{song.get('artist')} | {song.get('title')}".strip(" |")


def load_songs(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("songs.json must contain a list of song objects")
    return data


def load_state(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return set(data.get("known_urls", []))
    except (json.JSONDecodeError, AttributeError, KeyError):
        return set()


def save_state(path: Path, known: set[str]) -> None:
    payload = {"known_urls": sorted(known)}
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def diff_added(songs: list[dict], state_path: Path) -> list[int]:
    """Return the 1-based indexes of songs whose URL was not seen before."""
    known = load_state(state_path)
    first_seen: dict[str, int] = {}
    for i, song in enumerate(songs, start=1):
        key = song_key(song)
        if key not in first_seen:
            first_seen[key] = i
    added = sorted(idx for key, idx in first_seen.items() if key not in known)
    return added


def run_downloader(python: str, downloader: Path, indexes: list[int], forward: list[str]) -> int:
    cmd = [python, str(downloader), "--only", ",".join(str(i) for i in indexes), *forward]
    log.info("running: %s", " ".join(cmd))
    return subprocess.call(cmd)


def apply_once(songs_path: Path, state_path: Path,
               python: str, downloader: Path, forward: list[str],
               add_existing: bool) -> None:
    if not songs_path.exists():
        log.warning("%s does not exist yet; waiting for it to appear", songs_path)
        return

    songs = load_songs(songs_path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    have_state = state_path.exists()

    if not have_state and not add_existing:
        known = {song_key(s) for s in songs}
        save_state(state_path, known)
        log.info("baseline snapshot stored (%d songs); nothing downloaded. "
                 "Future changes will download only new songs.", len(known))
        return

    added = diff_added(songs, state_path)
    if added:
        log.info("%d new song(s) detected: %s", len(added), added)
        run_downloader(python, downloader, added, forward)
    else:
        log.info("no new songs")

    known = load_state(state_path) | {song_key(s) for s in songs}
    save_state(state_path, known)


def watch_inotify(dir_path: Path, songs_name: str, on_event) -> None:
    inotifywait = shutil.which("inotifywait")
    stdbuf = shutil.which("stdbuf")
    if inotifywait is None:
        log.error("inotifywait not available")
        return

    while True:
        cmd = [inotifywait, "-m", "-q", "--format", "%e %f", "-e", WATCH_EVENTS, str(dir_path)]
        if stdbuf:
            cmd = [stdbuf, "-oL", *cmd]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, bufsize=1)
        try:
            for line in proc.stdout:
                line = line.rstrip("\n")
                parts = line.split(" ", 1)
                filename = parts[1] if len(parts) > 1 else line
                if filename == songs_name:
                    on_event()
        except KeyboardInterrupt:
            break
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        time.sleep(1)


def watch_poll(songs_path: Path, interval: float, on_event) -> None:
    last_mtime = songs_path.stat().st_mtime if songs_path.exists() else None
    while True:
        time.sleep(interval)
        try:
            mtime = songs_path.stat().st_mtime
        except FileNotFoundError:
            mtime = None
        if mtime != last_mtime:
            last_mtime = mtime
            on_event()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--songs", type=Path, default=DEFAULT_SONGS,
                        help=f"Master songs JSON to watch (default: {DEFAULT_SONGS})")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE,
                        help=f"Snapshot of already-known URLs (default: {DEFAULT_STATE})")
    parser.add_argument("--downloader", type=Path, default=DEFAULT_DOWNLOADER,
                        help=f"download_assets.py to invoke (default: {DEFAULT_DOWNLOADER})")
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON,
                        help="Python interpreter used for the downloader subprocess")
    parser.add_argument("--downloader-args", type=str, default="",
                        help="Extra arguments forwarded to download_assets.py")
    parser.add_argument("--add-existing", action="store_true",
                        help="On first run, download the whole existing list (not just new songs)")
    parser.add_argument("--once", action="store_true",
                        help="Run a single diff+download cycle and exit")
    parser.add_argument("--poll-interval", type=float, default=5.0,
                        help="Fallback polling interval in seconds when inotifywait is unavailable")
    parser.add_argument("--verbose", action="store_true", help="Show extra detail")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
        stream=sys.stdout,
    )

    forward = args.downloader_args.split()
    if "--songs" not in forward:
        forward = ["--songs", str(args.songs), *forward]
    if args.python and "--python" not in forward:
        forward = [*forward, "--python", str(args.python)]

    def on_change() -> None:
        log.info("--- change detected ---")
        try:
            apply_once(args.songs, args.state, str(args.python), args.downloader,
                       forward, args.add_existing)
        except Exception as e:  # never let a bad change kill the watcher
            log.error("failed to process change: %s", e)

    if args.once:
        try:
            on_change()
        except KeyboardInterrupt:
            pass
        return 0

    log.info("watching %s for changes (state: %s)", args.songs, args.state)

    def install_handlers() -> None:
        def _sighandler(_signum, _frame):
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, _sighandler)

    install_handlers()

    try:
        if shutil.which("inotifywait") and args.songs.parent.exists():
            on_change()  # catch changes made while the watcher was off
            watch_inotify(args.songs.parent, args.songs.name, on_change)
        else:
            if not args.songs.exists():
                log.warning("%s does not exist; waiting for it to appear", args.songs)
            on_change()
            watch_poll(args.songs, args.poll_interval, on_change)
    except KeyboardInterrupt:
        log.info("stopped")

    return 0


if __name__ == "__main__":
    sys.exit(main())