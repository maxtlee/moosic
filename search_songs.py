#!/usr/bin/env python3
"""Song-first YouTube Music search.

Unlike ``search_youtube.py`` (which ranks raw videos), this returns
**deduplicated songs** — one entry per (artist, title) with exactly one
canonical YouTube video id, so the UI can never recommend the same song twice.
YouTube Music's own "songs" results also carry the **album**, which the app
uses for auto-detection.

Output:
    {"query": ..., "results": [
        {key, title, artist, album, duration, video_id, url, kind,
         thumbnail, score, source, in_library}
    ]}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import link_youtube as ly  # noqa: E402
import musiclib as ml  # noqa: E402
from search_youtube import parse_query  # noqa: E402
from ytmusicapi import YTMusic  # noqa: E402


def norm_key(title: str, artist: str) -> str:
    def n(s: str) -> str:
        s = unicodedata.normalize("NFKC", s or "").casefold()
        return re.sub(r"[\W_]+", " ", s, flags=re.UNICODE).strip()
    t = n(title)
    a = n(artist)
    a = re.split(r" feat ", a)[0].strip() or a
    return f"{a}|{t}"


def artist_of(result: dict) -> str:
    arts = result.get("artists") or []
    return ", ".join(a.get("name", "") for a in arts if a.get("name"))


def album_of(result: dict) -> str:
    alb = result.get("album")
    if isinstance(alb, dict):
        return alb.get("name") or ""
    return ""


def thumb_of(result: dict) -> str:
    thumbs = result.get("thumbnails") or []
    if not thumbs:
        return ""
    return max(thumbs, key=lambda t: (t.get("width") or 0)).get("url", "")


def entry_song(result: dict, bad: set[str]) -> dict | None:
    vid = result.get("videoId")
    if not vid or vid in bad:
        return None
    title, artist = result.get("title") or "", artist_of(result)
    return {
        "key": norm_key(title, artist), "title": title, "artist": artist,
        "album": album_of(result), "duration": result.get("duration_seconds"),
        "video_id": vid, "url": f"https://www.youtube.com/watch?v={vid}",
        "kind": "song", "thumbnail": thumb_of(result), "source": "ytmusic", "score": 0,
    }


def entry_video(result: dict, bad: set[str], song: dict) -> dict | None:
    vid = result.get("videoId")
    if not vid or vid in bad:
        return None
    title, artist = result.get("title") or "", artist_of(result)
    return {
        "key": norm_key(title, artist), "title": title, "artist": artist,
        "album": "", "duration": result.get("duration_seconds"),
        "video_id": vid, "url": f"https://www.youtube.com/watch?v={vid}",
        "kind": ly.pick_kind(result), "thumbnail": thumb_of(result),
        "source": "youtube", "score": round(ly.score_result(song, result), 1),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=12)
    args = parser.parse_args()

    bad = set(ml.load_bad_links().get("video_ids", [])) if hasattr(ml, "load_bad_links") else set()
    title, artist = parse_query(args.query)
    song = {"title": title, "artist": artist}
    yt = YTMusic()

    entries: dict[str, dict] = {}
    for r in (yt.search(args.query, filter="songs", limit=15) or []):
        e = entry_song(r, bad)
        if e:
            entries[e["key"]] = e  # canonical song result wins
    for r in (yt.search(args.query, filter="videos", limit=10) or []):
        e = entry_video(r, bad, song)
        if e and e["key"] not in entries:
            entries[e["key"]] = e

    results = sorted(
        entries.values(),
        key=lambda e: (0 if e["source"] == "ytmusic" else 1, -(e.get("score") or 0)),
    )[: args.limit]

    master = ml.load_master()
    lib_keys = {norm_key(s.get("title", ""), s.get("artist", "")) for s in master.get("songs", [])}
    lib_vids = {ml.video_id(s.get("youtube_url", "")) for s in master.get("songs", [])}
    for e in results:
        e["in_library"] = e["key"] in lib_keys or e["video_id"] in lib_vids

    json.dump({"query": args.query, "results": results}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
