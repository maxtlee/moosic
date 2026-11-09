#!/usr/bin/env python3
"""Fill in album years for master songs (used by the Apple Music export).

YouTube Music's per-song album object has no year, but album search results do.
This groups songs by (album, artist), looks each album up once and writes the
year onto every song in that album.

    detect_album_years.py                 # dry run
    detect_album_years.py --execute [--force] [--limit N] [--delay 0.2]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import musiclib as ml  # noqa: E402
from ytmusicapi import YTMusic  # noqa: E402


def artists_of(result: dict) -> str:
    return ", ".join(a.get("name", "") for a in (result.get("artists") or []) if a.get("name"))


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").casefold()
    return re.sub(r"[\W_]+", " ", s, flags=re.UNICODE).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--delay", type=float, default=0.2)
    args = parser.parse_args()

    master = ml.load_master()
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for song in master.get("songs", []):
        album = (song.get("album") or "").strip()
        if not album:
            continue
        if song.get("year") and not args.force:
            continue
        groups[(album, song.get("artist") or "")].append(song)

    keys = list(groups.keys())
    if args.limit:
        keys = keys[: args.limit]
    print(f"{len(keys)} album(s) need a year")
    if not args.execute:
        print("DRY RUN — re-run with --execute")
        return 0

    yt = YTMusic()
    found: dict[str, int] = {}
    for n, (album, artist) in enumerate(keys, 1):
        try:
            results = yt.search(f"{artist} {album}".strip(), filter="albums", limit=5) or []
        except Exception as exc:  # noqa: BLE001
            print(f"  search error: {exc}")
            results = []
        want = norm(album)
        best = None
        for r in results:
            if norm(r.get("title", "")) == want:
                best = r
                break
        if best is None and results:
            best = results[0]
        year = (best or {}).get("year")
        if year:
            print(f"[{n}/{len(keys)}] {album} ({artist}) -> {year}")
            for song in groups[(album, artist)]:
                found[song["id"]] = int(year)
        if args.delay:
            time.sleep(args.delay)

    with ml.flock():
        master = json.loads(ml.MASTER.read_text(encoding="utf-8"))
        applied = 0
        for song in master.get("songs", []):
            year = found.get(song.get("id"))
            if year:
                song["year"] = year
                applied += 1
        ml.save_master(master)

    print(f"done: {applied} song(s) got a year")
    return 0


if __name__ == "__main__":
    sys.exit(main())
