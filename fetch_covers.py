#!/usr/bin/env python3
"""Fetch album covers for master songs from YouTube thumbnails.

The downloaded MP3s have no embedded art, so the cover is the video's thumbnail
(`i.ytimg.com`), starting at `maxresdefault` and falling back to progressively
smaller sizes. Covers are stored under ``assets/_covers/<safe-id>.jpg`` (the
assets tree is gitignored) and the master entry gets a ``cover`` path.

    python3 fetch_covers.py                 # dry run
    python3 fetch_covers.py --execute       # download missing covers
    python3 fetch_covers.py --execute --force --commit

``ensure_covers()`` is imported by ``download_assets.py`` so an asset refresh
also backfills covers, and by the web app's add flow via that same refresher.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import urllib.request
from pathlib import Path

import musiclib as ml

log = logging.getLogger("fetch_covers")

# Best → worst. YouTube returns 404 for sizes it does not have.
THUMBNAILS = ("maxresdefault.jpg", "sddefault.jpg", "hqdefault.jpg", "mqdefault.jpg")
UA = {"User-Agent": "moosic-covers/1.0"}
MIN_BYTES = 2000  # filters YouTube's tiny "missing" placeholder


def download_thumbnail(video_id: str, dest: Path, timeout: int = 30) -> str | None:
    for name in THUMBNAILS:
        url = f"https://i.ytimg.com/vi/{video_id}/{name}"
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                ctype = resp.headers.get("Content-Type", "")
                data = resp.read()
        except Exception:  # noqa: BLE001 — try the next size
            continue
        if "image" in ctype and len(data) >= MIN_BYTES:
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return name
    return None


def fetch_one(song: dict, covers_dir: Path | None = None, force: bool = False,
              timeout: int = 30) -> bool:
    """Ensure one song has a cover file; set ``song['cover']``. Returns success."""
    sid = song.get("id") or ""
    video_id = ml.video_id(song.get("youtube_url", ""))
    if not sid or not video_id:
        return False
    dest = (covers_dir or ml.COVERS_DIR) / f"{ml.safe_id(sid)}.jpg"
    if dest.is_file() and dest.stat().st_size >= MIN_BYTES and not force:
        song["cover"] = ml.cover_rel(sid)
        return True
    if download_thumbnail(video_id, dest, timeout):
        song["cover"] = ml.cover_rel(sid)
        return True
    return False


def ensure_covers(songs: list[dict], covers_dir: Path | None = None, force: bool = False,
                  delay: float = 0.0, limit: int = 0, timeout: int = 30) -> dict:
    """Backfill covers for a list of songs. Mutates the song dicts in place."""
    ok = failed = skipped = attempted = 0
    for song in songs:
        if not song.get("youtube_url"):
            failed += 1
            continue
        existing = ml.cover_file(song)
        if existing and existing.is_file() and existing.stat().st_size >= MIN_BYTES and not force:
            skipped += 1
            continue
        if limit and attempted >= limit:
            break
        attempted += 1
        log.info("cover  %s — %s", song.get("artist"), song.get("title"))
        if fetch_one(song, covers_dir, force, timeout):
            ok += 1
        else:
            failed += 1
            log.warning("  no thumbnail for %s", song.get("id"))
        if delay:
            time.sleep(delay)
    return {"ok": ok, "failed": failed, "skipped": skipped, "attempted": attempted}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master", type=Path, default=ml.MASTER)
    parser.add_argument("--covers", type=Path, default=ml.COVERS_DIR)
    parser.add_argument("--execute", action="store_true", help="Actually download (default: dry run)")
    parser.add_argument("--force", action="store_true", help="Re-download existing covers")
    parser.add_argument("--only", type=str, default=None, help="Comma-separated song ids to limit to")
    parser.add_argument("--delay", type=float, default=0.15)
    parser.add_argument("--commit", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)

    master = json.loads(args.master.read_text(encoding="utf-8"))
    songs = master.get("songs", [])
    if args.only:
        wanted = {x.strip() for x in args.only.split(",") if x.strip()}
        songs = [s for s in songs if s.get("id") in wanted]

    missing = [s for s in songs if not (ml.cover_file(s) and ml.cover_file(s).is_file())
               and s.get("youtube_url")]
    log.info("songs=%d  with youtube_url=%d  missing cover=%d",
             len(songs), sum(1 for s in songs if s.get("youtube_url")), len(missing))
    for s in missing[:8]:
        log.info("   fetch  %s — %s", s.get("artist"), s.get("title"))
    if len(missing) > 8:
        log.info("   ... and %d more", len(missing) - 8)

    if not args.execute:
        log.info("DRY RUN — re-run with --execute to download covers.")
        return 0

    # Download without holding the write lock (network-bound), then merge the
    # results into a freshly-loaded master under the lock so concurrent edits
    # from the web UI are never clobbered.
    covers: dict[str, str] = {}
    ok = failed = skipped = 0
    for song in songs:
        sid = song.get("id") or ""
        if not song.get("youtube_url"):
            failed += 1
            continue
        existing = ml.cover_file(song)
        if existing and existing.is_file() and existing.stat().st_size >= MIN_BYTES and not args.force:
            covers[sid] = ml.cover_rel(sid)
            skipped += 1
            continue
        if fetch_one(song, args.covers, args.force):
            covers[sid] = song["cover"]
            ok += 1
        else:
            failed += 1
        if args.delay:
            time.sleep(args.delay)

    with ml.flock():
        master = json.loads(args.master.read_text(encoding="utf-8"))
        applied = 0
        for song in master.get("songs", []):
            rel = covers.get(song.get("id"))
            if rel:
                song["cover"] = rel
                applied += 1
        ml.save_master(master)

    log.info("done: added=%d skipped=%d failed=%d applied=%d",
             ok, skipped, failed, applied)
    if args.commit:
        with ml.flock():
            res = ml.commit_push(f"covers: {ok} added ({skipped} already present)")
        log.info("commit: %s", res)
    return 0


if __name__ == "__main__":
    sys.exit(main())
