#!/usr/bin/env python3
"""Genre inference for the Moosic master list.

Order of evidence:

1. an existing album in the library (same artist + album) — strongest local signal
2. the artist's other songs (a clear majority genre)
3. soundtrack cues in the title/album (OST, "From ...", 片尾曲, …)
4. script: Hangul -> K-pop, kana -> J-pop, Han -> Mandopop
5. the iTunes Search API (best-effort, no key required)
6. ``Unsorted``

The web app uses :func:`infer_genre` for new songs. The CLI audits the master
list and can fill in missing genres (or, with ``--all``, report inconsistent
ones) without touching Spotify/YouTube credentials.

    genre_lookup.py --online                # dry-run: fill Unsorted (online)
    genre_lookup.py --online --execute      # write those fills
    genre_lookup.py --all                   # dry-run: local consistency audit
    genre_lookup.py --all --online          # also ask iTunes (slow)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import musiclib as ml  # noqa: E402

ITUNES_SEARCH = "https://itunes.apple.com/search"
USER_AGENT = "Moosic/1.0 (self-hosted music library)"
SOUNDTRACK = re.compile(
    r"(original\s+(motion\s+picture\s+)?soundtrack|\bost\b|soundtrack|"
    r"from\s+[\"“”']|theme\s+from|片尾曲|主题曲|主題曲|片頭曲|片头曲|插曲|"
    r"原声带|原聲帶|电影|電影|电视剧|電視劇|動畫|动画)",
    re.IGNORECASE,
)
HANGUL = re.compile(r"[\uac00-\ud7af]")
KANA = re.compile(r"[\u3040-\u30ff]")
HAN = re.compile(r"[\u4e00-\u9fff]")

GENRE_MAP = {
    "k-pop": "K-pop",
    "kpop": "K-pop",
    "korean": "K-pop",
    "korean pop": "K-pop",
    "mandopop": "Mandopop",
    "mandarin": "Mandopop",
    "mandarin pop": "Mandopop",
    "chinese": "Mandopop",
    "chinese pop": "Mandopop",
    "c-pop": "Mandopop",
    "j-pop": "J-pop",
    "jpop": "J-pop",
    "japanese": "J-pop",
    "japanese pop": "J-pop",
    "pop": "Pop",
    "dance": "EDM",
    "electronic": "EDM",
    "edm": "EDM",
    "house": "EDM",
    "techno": "EDM",
    "r&b/soul": "R&B",
    "r&b": "R&B",
    "soul": "Soul",
    "hip-hop/rap": "Hip-hop",
    "hip-hop": "Hip-hop",
    "rap": "Hip-hop",
    "rock": "Rock",
    "alternative": "Rock",
    "indie rock": "Indie rock",
    "indie pop": "Indie pop",
    "pop rock": "Pop rock",
    "dance-pop": "Dance-pop",
    "synth-pop": "Synth-pop",
    "soundtrack": "Soundtrack",
    "country": "Country",
    "folk": "Folk",
    "folk rock": "Folk rock",
    "comedy": "Comedy",
    "classical": "Classical",
    "jazz": "Jazz",
    "latin": "Latin",
}


def _norm(value: str) -> str:
    return unicodedata.normalize("NFKC", value or "").strip().lower()


def _primary_artist(artist: str) -> str:
    return re.split(r"\s*(?:,|&|feat\.?|ft\.?|with)\s*", artist or "", maxsplit=1)[0].strip()


def normalize_genre(raw: str) -> str | None:
    value = _norm(raw)
    if not value:
        return None
    if value in GENRE_MAP:
        return GENRE_MAP[value]
    # Preserve an unknown but usable genre, title-cased ("Singer/Songwriter").
    return raw.strip() if raw and raw.strip() else None


def _records(songs: list[dict], exclude_id: str | None = None) -> list[dict]:
    return [s for s in songs
            if s.get("id") != exclude_id
            and s.get("genre") and s.get("genre") != "Unsorted"]


def _majority(genres: list[str], minimum: int = 2) -> str | None:
    if len(genres) < minimum:
        return None
    counts = Counter(genres)
    genre, count = counts.most_common(1)[0]
    if count / len(genres) >= 0.6:
        return genre
    return None


def local_genre(title: str, artist: str, album: str = "",
                songs: list[dict] | None = None,
                exclude_id: str | None = None,
                artist_fallback: bool = True,
                use_script: bool = True,
                use_soundtrack: bool = True) -> str | None:
    """Guess from the existing master list / title text; never uses the network."""
    songs = _records(songs or [], exclude_id)
    title, artist, album = title or "", artist or "", album or ""

    if use_soundtrack and (SOUNDTRACK.search(title) or SOUNDTRACK.search(album)):
        return "Soundtrack"

    # Language script is a strong signal for this library's taxonomy.
    text = f"{title} {artist}"
    if use_script and HANGUL.search(text):
        return "K-pop"
    if use_script and KANA.search(text):
        return "J-pop"
    if use_script and HAN.search(text):
        return "Mandopop"

    if album and artist:
        album_key = ml.norm_key(album, artist)
        matches = [s.get("genre") for s in songs
                   if ml.norm_key(s.get("album", ""), s.get("artist", "")) == album_key]
        guess = _majority([g for g in matches if g])
        if guess:
            return guess

    if artist and artist_fallback:
        artist_key = _norm(artist)
        primary_key = _norm(_primary_artist(artist))
        matches = [s.get("genre") for s in songs
                   if _norm(s.get("artist", "")) == artist_key
                   or _norm(_primary_artist(s.get("artist", ""))) == primary_key]
        guess = _majority([g for g in matches if g])
        if guess:
            return guess

    return None


def _get_json(url: str, timeout: float) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except Exception:
        return None


def _itunes(params: dict, timeout: float) -> list[dict]:
    url = ITUNES_SEARCH + "?" + urllib.parse.urlencode(params)
    data = _get_json(url, timeout)
    if not isinstance(data, dict):
        return []
    return [r for r in data.get("results", []) if isinstance(r, dict)]


def lookup_itunes_song(title: str, artist: str, album: str = "",
                       timeout: float = 5.0) -> str | None:
    """iTunes Search API -> primaryGenreName for the best artist/title match."""
    if not title:
        return None
    term = " ".join(part for part in (artist, title) if part)
    results = _itunes(
        {"term": term, "entity": "song", "limit": 8, "country": "US"}, timeout)
    want_title, want_artist = _norm(title), _norm(_primary_artist(artist))
    best, best_score = None, 0
    for r in results:
        r_title = _norm(r.get("trackName", ""))
        r_artist = _norm(_primary_artist(r.get("artistName", "")))
        r_album = _norm(r.get("collectionName", ""))
        score = 0
        if r_title == want_title:
            score += 4
        elif want_title and want_title in r_title:
            score += 2
        if want_artist and r_artist == want_artist:
            score += 4
        elif want_artist and (want_artist in r_artist or r_artist in want_artist):
            score += 1
        if album and r_album == _norm(album):
            score += 2
        if score > best_score:
            best, best_score = r, score
    if best and best_score >= 4:
        return normalize_genre(best.get("primaryGenreName", ""))
    return None


def lookup_itunes_album(album: str, artist: str = "",
                        timeout: float = 5.0) -> str | None:
    if not album:
        return None
    term = " ".join(part for part in (artist, album) if part)
    results = _itunes(
        {"term": term, "entity": "album", "limit": 8, "country": "US"}, timeout)
    want_album, want_artist = _norm(album), _norm(_primary_artist(artist))
    best, best_score = None, 0
    for r in results:
        r_album = _norm(r.get("collectionName", ""))
        r_artist = _norm(_primary_artist(r.get("artistName", "")))
        score = 0
        if r_album == want_album:
            score += 4
        elif want_album and (want_album in r_album or r_album in want_album):
            score += 2
        if want_artist and r_artist == want_artist:
            score += 4
        elif want_artist and (want_artist in r_artist or r_artist in want_artist):
            score += 1
        if score > best_score:
            best, best_score = r, score
    if best and best_score >= 4:
        return normalize_genre(best.get("primaryGenreName", ""))
    return None


def infer_genre(title: str, artist: str, album: str = "",
                songs: list[dict] | None = None,
                exclude_id: str | None = None,
                online: bool = True,
                timeout: float = 5.0) -> tuple[str, str]:
    """Return ``(genre, source)``; source is library/title/itunes/none."""
    local = local_genre(title, artist, album, songs, exclude_id)
    if local:
        return local, "library"
    if online:
        guess = lookup_itunes_song(title, artist, album, timeout=timeout)
        if guess:
            return guess, "itunes"
        guess = lookup_itunes_album(album, artist, timeout=timeout)
        if guess:
            return guess, "itunes"
    return "Unsorted", "none"


def _audit(songs: list[dict], all_songs: bool, online: bool,
           sleep: float = 0.0, limit: int = 0) -> list[dict]:
    proposals = []
    for song in songs:
        old = song.get("genre") or "Unsorted"
        if not all_songs and old != "Unsorted":
            continue
        if all_songs:
            guess = local_genre(
                song.get("title", ""), song.get("artist", ""), song.get("album", ""),
                songs, exclude_id=song.get("id"), artist_fallback=False,
                use_script=False,
            )
            source = "library"
            if not guess and online:
                guess = lookup_itunes_song(
                    song.get("title", ""), song.get("artist", ""), song.get("album", ""))
                source = "itunes"
                if sleep > 0:
                    time.sleep(sleep)
        else:
            guess, source = infer_genre(
                song.get("title", ""), song.get("artist", ""), song.get("album", ""),
                songs, exclude_id=song.get("id"), online=online,
            )
            if online and source == "itunes" and sleep > 0:
                time.sleep(sleep)
        if guess and guess != "Unsorted" and guess != old:
            proposals.append({
                "id": song.get("id"),
                "artist": song.get("artist", ""),
                "title": song.get("title", ""),
                "album": song.get("album", ""),
                "old": old,
                "new": guess,
                "source": source,
            })
            if limit and len(proposals) >= limit:
                break
    return proposals


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master", type=Path, default=ml.MASTER)
    parser.add_argument("--all", action="store_true",
                        help="audit every song, not just Unsorted (local evidence only)")
    parser.add_argument("--online", action="store_true",
                        help="allow iTunes lookups (slow; ~20 requests/minute)")
    parser.add_argument("--execute", action="store_true",
                        help="write the proposed genres to the master list")
    parser.add_argument("--sleep", type=float, default=3.0,
                        help="seconds between iTunes lookups (default 3)")
    parser.add_argument("--limit", type=int, default=0,
                        help="cap the number of changes (0 = no cap)")
    args = parser.parse_args()

    master = ml.load_master() if args.master == ml.MASTER else json.loads(
        args.master.read_text(encoding="utf-8"))
    songs = master.get("songs", [])
    proposals = _audit(songs, args.all, args.online, args.sleep, args.limit)

    for p in proposals:
        print(f"{p['old']:>10} -> {p['new']:<12} [{p['source']}] "
              f"{p['artist']} - {p['title']}")
    print(f"\n{len(proposals)} proposed change(s); "
          f"{'applied' if args.execute else 'dry-run'}.")

    if args.execute and proposals:
        by_id = {p["id"]: p["new"] for p in proposals}
        if args.master == ml.MASTER:
            with ml.flock():
                master = ml.load_master()
                songs = master.get("songs", [])
                for song in songs:
                    if song.get("id") in by_id:
                        song["genre"] = by_id[song["id"]]
                        ml.retag_asset(song)  # genre is part of the asset path
                master["songs"] = songs
                ml.save_master(master)
        else:
            master = json.loads(args.master.read_text(encoding="utf-8"))
            songs = master.get("songs", [])
            for song in songs:
                if song.get("id") in by_id:
                    song["genre"] = by_id[song["id"]]
            master["songs"] = songs
            args.master.write_text(json.dumps(master, ensure_ascii=False, indent=2) + "\n",
                                   encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
