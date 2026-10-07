#!/usr/bin/env python3
"""Deterministically pick the best YouTube match for one song.

Rejected video ids (``bad_links.json`` plus any ``--exclude``) are filtered out,
so after marking a match wrong the next-best video is chosen. Used by the web
UI's "wrong match" flow.

    match_song.py --title "Ditto" --artist "NewJeans" [--album ...] [--exclude vid]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import musiclib as ml  # noqa: E402
from search_songs import search_entries  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True)
    parser.add_argument("--artist", default="")
    parser.add_argument("--album", default="")
    parser.add_argument("--exclude", default="", help="Comma-separated video ids to skip")
    parser.add_argument("--limit", type=int, default=15)
    args = parser.parse_args()

    bad = set(ml.load_bad_links().get("video_ids", []))
    bad |= {x.strip() for x in args.exclude.split(",") if x.strip()}
    query = f"{args.artist} {args.title}".strip()
    entries = [e for e in search_entries(query, args.limit, bad) if e["video_id"] not in bad]

    key = ml.norm_key(args.title, args.artist)
    match = next((e for e in entries if e["key"] == key), None)
    if match is None and entries:
        match = entries[0]
    if match is None:
        json.dump({"best": None, "candidates": []}, sys.stdout, ensure_ascii=False)
    else:
        json.dump({"best": match, "candidates": entries[:5]}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
