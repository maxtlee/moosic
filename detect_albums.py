#!/usr/bin/env python3
"""Auto-detect the album for each master song via YouTube Music.

For every song lacking an ``album`` (or with ``--force``), searches YouTube
Music for the song and reads the album off the best-matching "song" result.

    detect_albums.py                 # dry run
    detect_albums.py --execute [--limit N] [--delay 0.25] [--force]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import musiclib as ml  # noqa: E402
from ytmusicapi import YTMusic  # noqa: E402


def artists_of(result: dict) -> str:
    return ", ".join(a.get("name", "") for a in (result.get("artists") or []) if a.get("name"))


def album_name(result: dict) -> str:
    alb = result.get("album")
    return alb.get("name", "") if isinstance(alb, dict) else ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--delay", type=float, default=0.2)
    args = parser.parse_args()

    master = ml.load_master()
    songs = [s for s in master.get("songs", [])
             if s.get("youtube_url") and (args.force or not s.get("album"))]
    if args.limit:
        songs = songs[: args.limit]

    print(f"{len(songs)} song(s) need an album")
    if not args.execute:
        print("DRY RUN — re-run with --execute")
        return 0

    yt = YTMusic()
    found: dict[str, str] = {}
    for n, song in enumerate(songs, 1):
        key = ml.norm_key(song["title"], song.get("artist", ""))
        try:
            results = yt.search(f"{song.get('artist','')} {song['title']}".strip(),
                                filter="songs", limit=5) or []
        except Exception as exc:  # noqa: BLE001
            print(f"  search error: {exc}")
            results = []
        for r in results:
            if ml.norm_key(r.get("title", ""), artists_of(r)) == key:
                name = album_name(r)
                if name:
                    found[song["id"]] = name
                    print(f"[{n}/{len(songs)}] {song['title']} -> {name}")
                break
        if args.delay:
            time.sleep(args.delay)

    # merge under the lock so concurrent edits aren't clobbered
    with ml.flock():
        master = json.loads(ml.MASTER.read_text(encoding="utf-8"))
        applied = 0
        for song in master.get("songs", []):
            name = found.get(song.get("id"))
            if name:
                song["album"] = name
                applied += 1
        ml.save_master(master)

    print(f"done: {applied} album(s) set")
    return 0


if __name__ == "__main__":
    sys.exit(main())
