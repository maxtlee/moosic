#!/usr/bin/env python3
"""Fetch album covers for master songs.

The downloaded MP3s have no embedded art, so covers are downloaded separately
and stored under ``assets/_covers/<safe-id>.jpg`` (the assets tree is
gitignored); the master entry gets a ``cover`` path.

Cover sources, best first:

1. **iTunes album art** — looked up by artist + album (or artist + title when
   the album is unknown). This is the *actual* release artwork, avoiding the
   lyric-video thumbnails that used to end up as covers.
2. **YouTube video thumbnail** (`i.ytimg.com`) as a fallback, starting at
   `maxresdefault` and falling back to progressively smaller sizes.

iTunes lookups are cached per album for the duration of a run, so an album's
art is fetched once and reused for every track on it.

    python3 fetch_covers.py                 # dry run
    python3 fetch_covers.py --execute       # download missing covers
    python3 fetch_covers.py --execute --force --commit   # replace all covers

``ensure_covers()`` is imported by ``download_assets.py`` so an asset refresh
also backfills covers, and by the web app's add flow via that same refresher.
"""

from __future__ import annotations

import argparse
import difflib
import json
import logging
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import musiclib as ml

log = logging.getLogger("fetch_covers")

# Best → worst. YouTube returns 404 for sizes it does not have.
THUMBNAILS = ("maxresdefault.jpg", "sddefault.jpg", "hqdefault.jpg", "mqdefault.jpg")
UA = {"User-Agent": "moosic-covers/1.0"}
ITUNES_UA = "Moosic/1.0 (self-hosted music library)"
ITUNES_SEARCH = "https://itunes.apple.com/search"
MIN_BYTES = 2000  # filters YouTube's tiny "missing" placeholder

# Script detection picks the iTunes storefront most likely to carry the song
# (the US store often only has the English/translated release).
HANGUL = re.compile(r"[\uac00-\ud7af]")
KANA = re.compile(r"[\u3040-\u30ff]")
HAN = re.compile(r"[\u4e00-\u9fff]")


# --------------------------------------------------------------------------- #
# album art (iTunes)
# --------------------------------------------------------------------------- #
def _norm(value: str) -> str:
    return unicodedata.normalize("NFKC", value or "").strip().casefold()


def _primary_artist(artist: str) -> str:
    return re.split(r"\s*(?:,|&|feat\.?|ft\.?|with)\s*", artist or "", maxsplit=1)[0].strip()


def _title_key(value: str) -> str:
    """Loose song/album key: drop parentheticals, edition tags and punctuation."""
    return re.sub(r"[^0-9a-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+", "",
                  _search_text(value))


def _search_text(value: str) -> str:
    """Query-friendly text: drop parentheticals / edition tags, keep spacing."""
    s = _norm(value)
    s = re.sub(r"[\(\[（【].*?[\)\]）】]", " ", s)
    s = re.sub(r"\s*[-–—]\s*(?:remaster(?:ed)?\b.*|.*\bremaster(?:ed)?\b.*)$", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _title_score(want: str, got: str) -> int:
    if not want or not got:
        return 0
    if want == got:
        return 4
    if (want in got or got in want) and min(len(want), len(got)) >= 4:
        return 2
    if difflib.SequenceMatcher(None, want, got).ratio() >= 0.86:
        return 3
    return 0


def _get_json(url: str, timeout: float, attempts: int = 3) -> dict | None:
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": ITUNES_UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            # Apple throttles bursts; back off and retry, otherwise give up.
            if exc.code in (403, 429) and attempt + 1 < attempts:
                time.sleep(1.5 * (attempt + 1))
                continue
            return None
        except Exception:  # noqa: BLE001 — network/JSON errors are non-fatal
            return None
    return None


def _itunes(params: dict, timeout: float) -> list[dict]:
    url = ITUNES_SEARCH + "?" + urllib.parse.urlencode(params)
    data = _get_json(url, timeout)
    if not isinstance(data, dict):
        return []
    return [r for r in data.get("results", []) if isinstance(r, dict)]


def _art_url(result: dict) -> str | None:
    url = (result.get("artworkUrl100") or result.get("artworkUrl60")
           or result.get("artworkUrl30") or "")
    if not url:
        return None
    # Apple serves arbitrary sizes from the same path; ask for 600×600.
    return re.sub(r"/\d+x\d+(bb)?\.(jpg|jpeg|png)",
                  r"/600x600bb.\2", url, flags=re.I)


def find_itunes_art(title: str, artist: str, album: str = "",
                    timeout: float = 8.0) -> str | None:
    """Return a 600×600 album-art URL from the iTunes Search API, or None."""
    text = f"{title} {artist} {album}"
    for country in _countries_for(text):
        art = _find_itunes_art_country(title, artist, album, country, timeout)
        if art:
            return art
    return None


def _countries_for(text: str) -> list[str]:
    """Storefronts to try, best guess first, US as the fallback."""
    order: list[str] = []
    if HANGUL.search(text):
        order.append("KR")
    elif KANA.search(text):
        order.append("JP")
    elif HAN.search(text):
        order.append("TW")
    order.append("US")
    out: list[str] = []
    for c in order:
        if c not in out:
            out.append(c)
    return out


def _find_itunes_art_country(title: str, artist: str, album: str,
                             country: str, timeout: float) -> str | None:
    want_title = _title_key(title)
    want_album = _title_key(album)
    want_artist = _norm(_primary_artist(artist))

    best, best_score = None, 0
    if album:
        term = " ".join(part for part in (artist, _search_text(album)) if part)
        for r in _itunes({"term": term, "entity": "album",
                          "limit": 8, "country": country}, timeout):
            r_album = _title_key(r.get("collectionName", ""))
            r_artist = _norm(_primary_artist(r.get("artistName", "")))
            score = _title_score(want_album, r_album)
            if r_artist == want_artist:
                score += 4
            elif want_artist and (want_artist in r_artist or r_artist in want_artist):
                score += 1
            if score > best_score:
                best, best_score = r, score
        if best and best_score >= 8:
            return _art_url(best)

    # No usable album match: look the song up instead (handles singles and
    # missing album metadata).
    best, best_score = None, 0
    term = " ".join(part for part in (artist, _search_text(title)) if part)
    for r in _itunes({"term": term, "entity": "song",
                      "limit": 8, "country": country}, timeout):
        r_title = _title_key(r.get("trackName", ""))
        r_artist = _norm(_primary_artist(r.get("artistName", "")))
        r_album = _title_key(r.get("collectionName", ""))
        score = _title_score(want_title, r_title)
        if r_artist == want_artist:
            score += 4
        elif want_artist and (want_artist in r_artist or r_artist in want_artist):
            score += 1
        if want_album and r_album == want_album:
            score += 2
        if score > best_score:
            best, best_score = r, score
    if best and best_score >= 6:
        return _art_url(best)
    return None


def download_image(url: str, dest: Path, timeout: int = 30) -> bool:
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = resp.headers.get("Content-Type", "")
            data = resp.read()
    except Exception:  # noqa: BLE001
        return False
    if "image" not in ctype or len(data) < MIN_BYTES:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return True


# --------------------------------------------------------------------------- #
# YouTube thumbnail fallback
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
def _cache_key(song: dict) -> tuple[str, str, str]:
    """One iTunes lookup per album; per-title when there is no album."""
    artist = _norm(_primary_artist(song.get("artist", "")))
    album = _title_key(song.get("album", ""))
    if album:
        return ("album", artist, album)
    return ("song", artist, _title_key(song.get("title", "")))


def fetch_one(song: dict, covers_dir: Path | None = None, force: bool = False,
              timeout: int = 30, art_cache: dict | None = None,
              use_itunes: bool = True) -> bool:
    """Ensure one song has a cover file; set ``song['cover']``. Returns success."""
    sid = song.get("id") or ""
    video_id = ml.video_id(song.get("youtube_url", ""))
    if not sid:
        return False
    dest = (covers_dir or ml.COVERS_DIR) / f"{ml.safe_id(sid)}.jpg"
    existing = dest.is_file() and dest.stat().st_size >= MIN_BYTES
    if existing and not force:
        song["cover"] = ml.cover_rel(sid)
        return True

    # Prefer the real release artwork over the video thumbnail.
    if use_itunes:
        key = _cache_key(song)
        if art_cache is not None and key in art_cache:
            art = art_cache[key]
        else:
            art = find_itunes_art(song.get("title", ""), song.get("artist", ""),
                                  song.get("album", ""), timeout=timeout)
            if art_cache is not None:
                art_cache[key] = art
        if art and download_image(art, dest, timeout):
            song["cover"] = ml.cover_rel(sid)
            song["cover_source"] = "itunes"
            return True

    # Re-fetching an existing cover but no album art was found: keep what we
    # already have instead of re-downloading the same lyric thumbnail.
    if existing and force:
        song["cover"] = ml.cover_rel(sid)
        return True

    if not video_id:
        return False
    if download_thumbnail(video_id, dest, timeout):
        song["cover"] = ml.cover_rel(sid)
        song["cover_source"] = "youtube"
        return True
    return False


def ensure_covers(songs: list[dict], covers_dir: Path | None = None, force: bool = False,
                  delay: float = 0.0, limit: int = 0, timeout: int = 30,
                  use_itunes: bool = True) -> dict:
    """Backfill covers for a list of songs. Mutates the song dicts in place."""
    ok = failed = skipped = attempted = 0
    art_cache: dict = {}
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
        if fetch_one(song, covers_dir, force, timeout, art_cache, use_itunes):
            ok += 1
        else:
            failed += 1
            log.warning("  no cover for %s", song.get("id"))
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
    parser.add_argument("--kinds", type=str, default=None,
                        help="Comma-separated youtube_kind values to limit to "
                             "(e.g. lyric_video,other)")
    parser.add_argument("--delay", type=float, default=0.4,
                        help="seconds between songs (iTunes is rate-limited; default 0.4)")
    parser.add_argument("--thumbnails-only", action="store_true",
                        help="Skip iTunes and use YouTube video thumbnails")
    parser.add_argument("--commit", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)

    master = json.loads(args.master.read_text(encoding="utf-8"))
    songs = master.get("songs", [])
    if args.only:
        wanted = {x.strip() for x in args.only.split(",") if x.strip()}
        songs = [s for s in songs if s.get("id") in wanted]
    if args.kinds:
        wanted_kinds = {x.strip() for x in args.kinds.split(",") if x.strip()}
        songs = [s for s in songs if (s.get("youtube_kind") or "other") in wanted_kinds]

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
    sources: dict[str, str] = {}
    art_cache: dict = {}
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
        if fetch_one(song, args.covers, args.force, art_cache=art_cache,
                     use_itunes=not args.thumbnails_only):
            covers[sid] = song["cover"]
            if song.get("cover_source"):
                sources[sid] = song["cover_source"]
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
                if song.get("id") in sources:
                    song["cover_source"] = sources[song["id"]]
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
