#!/usr/bin/env python3
"""Album search and track listing via YouTube Music.

    albums.py --query "aespa Armageddon"      # -> {"albums":[{browse_id,title,artist,year,thumbnail}]}
    albums.py --tracks MPrhUQfAo2gxxxxxxx    # -> {"album": {...}, "tracks":[{video_id,title,...}]}
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ytmusicapi import YTMusic  # noqa: E402


def artists(arts) -> str:
    return ", ".join(a.get("name", "") for a in (arts or []) if a.get("name"))


def thumb(thumbs) -> str:
    if not thumbs:
        return ""
    return max(thumbs, key=lambda t: (t.get("width") or 0)).get("url", "")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query")
    parser.add_argument("--tracks", metavar="BROWSE_ID")
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    yt = YTMusic()

    if args.tracks:
        alb = yt.get_album(args.tracks)
        tracks = []
        for t in alb.get("tracks", []):
            vid = t.get("videoId")
            if not vid:
                continue
            tracks.append({
                "video_id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "title": t.get("title", ""),
                "artist": artists(t.get("artists")) or artists(alb.get("artists")),
                "duration": t.get("duration_seconds"),
                "track_number": t.get("trackNumber"),
            })
        out = {"album": {
            "browse_id": args.tracks,
            "title": alb.get("title", ""),
            "artist": artists(alb.get("artists")),
            "year": alb.get("year", ""),
            "thumbnail": thumb(alb.get("thumbnails")),
            "track_count": len(tracks),
        }, "tracks": tracks}
    else:
        if not args.query:
            parser.error("--query or --tracks is required")
        results = yt.search(args.query, filter="albums", limit=args.limit) or []
        out = {"albums": [{
            "browse_id": r.get("browseId"),
            "title": r.get("title", ""),
            "artist": artists(r.get("artists")),
            "year": r.get("year", ""),
            "thumbnail": thumb(r.get("thumbnails")),
        } for r in results if r.get("browseId")]}

    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
