#!/usr/bin/env python3
"""Watch the master list and refresh assets whenever it changes.

The heavy lifting moved to ``download_assets.py``, which is now idempotent and
reconciles the whole ``assets/`` tree against ``master.json``. This watcher just
detects a change and runs that refresh.

    python3 watch_downloads.py --execute          # act on changes
    python3 watch_downloads.py --once --execute   # one cycle then exit

Without ``--execute`` the refresh runs in dry-run mode (nothing is downloaded).
"""

from __future__ import annotations

import argparse
import logging
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import musiclib as ml

ROOT = Path(__file__).resolve().parent
DEFAULT_DOWNLOADER = ROOT / "download_assets.py"
DEFAULT_PYTHON = ROOT / ".venv" / "bin" / "python"
WATCH_EVENTS = "close_write,create,moved_to"

log = logging.getLogger("watch_master")


def run_refresh(python: str, downloader: Path, master: Path, execute: bool,
                commit: bool, forward: list[str]) -> int:
    cmd = [python, str(downloader), "--master", str(master)]
    if execute:
        cmd.append("--execute")
    if commit:
        cmd.append("--commit")
    cmd.extend(forward)
    log.info("running: %s", " ".join(cmd))
    return subprocess.call(cmd)


def watch_inotify(dir_path: Path, name: str, on_event) -> None:
    inotifywait = shutil.which("inotifywait")
    if not inotifywait:
        return
    while True:
        proc = subprocess.Popen(
            [inotifywait, "-m", "-q", "--format", "%e %f", "-e", WATCH_EVENTS, str(dir_path)],
            stdout=subprocess.PIPE, text=True, bufsize=1)
        try:
            for line in proc.stdout:
                parts = line.rstrip("\n").split(" ", 1)
                filename = parts[1] if len(parts) > 1 else line
                if filename == name:
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


def watch_poll(path: Path, interval: float, on_event) -> None:
    last = path.stat().st_mtime if path.exists() else None
    while True:
        time.sleep(interval)
        try:
            mtime = path.stat().st_mtime
        except FileNotFoundError:
            mtime = None
        if mtime != last:
            last = mtime
            on_event()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master", type=Path, default=ml.MASTER)
    parser.add_argument("--downloader", type=Path, default=DEFAULT_DOWNLOADER)
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON)
    parser.add_argument("--execute", action="store_true",
                        help="Actually download (otherwise the refresh is a dry run)")
    parser.add_argument("--commit", action="store_true",
                        help="Commit+push master.json after a refresh")
    parser.add_argument("--downloader-args", type=str, default="")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    parser.add_argument("--poll-interval", type=float, default=5.0)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    forward = args.downloader_args.split()

    def on_change() -> None:
        log.info("--- master changed ---")
        try:
            run_refresh(str(args.python), args.downloader, args.master,
                        args.execute, args.commit, forward)
        except Exception as exc:  # never let one bad change kill the watcher
            log.error("refresh failed: %s", exc)

    if args.once:
        on_change()
        return 0

    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))
    log.info("watching %s (state: stateless; refresh is idempotent)", args.master)
    try:
        on_change()
        if shutil.which("inotifywait") and args.master.parent.exists():
            watch_inotify(args.master.parent, args.master.name, on_change)
        else:
            watch_poll(args.master, args.poll_interval, on_change)
    except KeyboardInterrupt:
        log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
