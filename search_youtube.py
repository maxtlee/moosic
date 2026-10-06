#!/usr/bin/env python3
"""Search YouTube Music for a song and return ranked candidates as JSON.

Reuses the ranking/classification in ``link_youtube.py`` (prefer official audio
or lyric video, penalise live/cover/remix/karaoke/etc.) so the web UI's admin
panel offers the same "good for listening" picks that the batch linker would.

Usage:
    search_youtube.py --query "IU - Blueming" [--limit 8]
    search_youtube.py --query "Blueming IU" --limit 5

Output (stdout, single JSON object):
    {
      "query": "...", "title": "...", "artist": "...",
      "best": {video_id,url,title,artist,duration,views,kind,score,confidence} | null,
      "candidates": [ ... same shape ..., sorted by score desc ]
    }
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import link_youtube as ly  # noqa: E402
from ytmusicapi import YTMusic  # noqa: E402


def parse_query(query: str) -> tuple[str, str]:
    """Split 'artist - title' into (title, artist); otherwise treat all as title."""
    q = query.strip()
    for sep in (" - ", " – ", " — ", " by "):
        if sep in q:
            left, right = q.split(sep, 1)
            # 'artist - title' is the common convention
            return right.strip(), left.strip()
    return q, ""


def candidate(song: dict, result: dict, is_best: bool = False) -> dict:
    vid = result.get("videoId")
    artists = ", ".join(ly.artist_names(result))
    score = ly.score_result(song, result)
    return {
        "video_id": vid,
        "url": f"https://www.youtube.com/watch?v={vid}",
        "title": result.get("title") or "",
        "artist": artists,
        "duration": result.get("duration_seconds"),
        "views": ly.parse_views(result.get("views")),
        "kind": ly.pick_kind(result),
        "score": round(score, 1),
        "is_best": is_best,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()

    title, artist = parse_query(args.query)
    song = {"title": title, "artist": artist}
    yt = YTMusic()
    results = ly.candidates_for(yt, song)

    best = ly.choose(song, results)
    best_vid = None
    if best and best.get("youtube_url", "").find("v=") != -1:
        best_vid = best["youtube_url"].split("v=", 1)[1].split("&", 1)[0]

    seen = set()
    cands = []
    for r in results:
        vid = r.get("videoId")
        if not vid or vid in seen:
            continue
        seen.add(vid)
        cands.append(candidate(song, r, is_best=(vid == best_vid)))
    cands.sort(key=lambda c: (c["is_best"], c["score"]), reverse=True)
    cands = cands[: max(1, args.limit)]

    payload = {
        "query": args.query,
        "title": title,
        "artist": artist,
        "best": next((c for c in cands if c["is_best"]), None),
        "candidates": cands,
    }
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
