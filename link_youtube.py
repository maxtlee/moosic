#!/usr/bin/env python3
"""Find a YouTube lyric video or official audio URL for each song in songs.json."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
from pathlib import Path

from opencc import OpenCC
from ytmusicapi import YTMusic

_TO_SIMP = OpenCC("t2s")

ROOT = Path(__file__).resolve().parent
DEFAULT_JSON = ROOT / "music_to_extract" / "songs.json"
DEFAULT_HTML = ROOT / "playlist.html"

LYRIC_RE = re.compile(
    r"lyric|lyrics|가사|歌詞|歌词|動態歌詞|动态歌词|pinyin\s*lyrics|colour coded|color coded",
    re.I,
)
AUDIO_RE = re.compile(r"official audio|\bofficial sound\b|\baudio\b|纯享|音源|주제음원", re.I)
MV_RE = re.compile(r"\bm/?v\b|music video|official video|뮤직비디오|musicvideo", re.I)
LIVE_RE = re.compile(r"\blive\b|concert|tour\b|performance|fancam|직캠|\bstage\b|콘서트", re.I)
BAD_RE = re.compile(
    r"dance practice|choreography|reaction|nightcore|sped up|speed up|slowed|"
    r"8d audio|\b8d\b|karaoke|instrumental|behind the scenes|teaser|trailer|"
    r"challenge|\bshorts?\b|1 hour|10 hour|\bhours\b|compilation|\bmashup\b|"
    r"lofi|lofi",
    re.I,
)
COVER_RE = re.compile(r"\bcover\b|커버", re.I)
REMIX_RE = re.compile(r"\bremix\b|sped|1\.\d+x", re.I)
DECORATION_RE = re.compile(
    r"【.*?】|『.*?』|「.*?」|\[.*?\]|"
    r"（原唱[:：].*?）|\(原唱[:：].*?\)|"
    r"（电视剧.*?）|\(电视剧.*?\)|"
    r"动态歌词.*$|動態歌詞.*$|Pinyin Lyrics.*$",
    re.I,
)
STOP_TOKENS = {
    "lyrics",
    "lyric",
    "official",
    "audio",
    "video",
    "color",
    "colour",
    "coded",
    "eng",
    "han",
    "rom",
    "mv",
    "ost",
    "theme",
    "song",
    "ver",
    "version",
    "hq",
    "hd",
    "4k",
    "dynamic",
    "pinyin",
    "the",
    "and",
    "from",
}


def nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "")


def alnum(s: str) -> str:
    s = nfkc(s).casefold().replace("&", "and")
    return re.sub(r"[^0-9a-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+", "", s)


def tokens(s: str) -> list[str]:
    s = nfkc(s).casefold()
    return re.findall(
        r"[0-9a-z]+|[\u4e00-\u9fff]+|[\u3040-\u30ff]+|[\uac00-\ud7af]+",
        s,
    )


def clean_text(s: str) -> str:
    s = nfkc(s)
    s = DECORATION_RE.sub(" ", s)
    s = re.sub(r"[♪【】\[\]]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def parse_views(v) -> float:
    if not v:
        return 0.0
    raw = str(v).replace(",", "").strip().upper()
    mult = 1.0
    if raw.endswith("B"):
        mult, raw = 1e9, raw[:-1]
    elif raw.endswith("M"):
        mult, raw = 1e6, raw[:-1]
    elif raw.endswith("K"):
        mult, raw = 1e3, raw[:-1]
    try:
        return float(raw) * mult
    except ValueError:
        return 0.0


def artist_names(result: dict) -> list[str]:
    artists = result.get("artists") or []
    names = [a.get("name", "") for a in artists if isinstance(a, dict)]
    if result.get("author"):
        names.append(str(result["author"]))
    return [n for n in names if n]


def artist_is_reliable(artist: str) -> bool:
    a = (artist or "").strip()
    if len(a) < 2:
        return False
    if a.startswith(("(", "[", "《", "『")):
        return False
    if "OCR" in a or "also showed" in a:
        return False
    return True


def to_simp(s: str) -> str:
    return _TO_SIMP.convert(nfkc(s or ""))


def artist_matches(song_artist: str, result: dict) -> bool:
    want = [p for p in re.split(r"[,/&]| and ", song_artist) if alnum(p)]
    if not want:
        return False
    got_names = artist_names(result)
    got = [alnum(n) for n in got_names]
    got_blob = "".join(got)
    title_blob = alnum(result.get("title") or "")
    for w in want:
        wn = alnum(w)
        if len(wn) < 2:
            continue
        if any(wn in g or g in wn for g in got if g) or wn in got_blob or wn in title_blob:
            return True
    want_toks = {alnum(t) for t in tokens(song_artist) if len(alnum(t)) >= 2 and t.isascii()}
    got_toks = {
        alnum(t)
        for n in got_names + [result.get("title") or ""]
        for t in tokens(n)
        if t.isascii()
    }
    if want_toks and want_toks <= got_toks:
        return True
    if want_toks and got_toks and len(want_toks & got_toks) >= min(2, len(want_toks)):
        return True
    return False


def cjk_core(s: str) -> str:
    head = re.split(r"[\(\（\[]", s, maxsplit=1)[0]
    head = re.split(r"\s[-–—]\s", head, maxsplit=1)[0]
    chars = re.findall(r"[\u4e00-\u9fff]+", to_simp(head))
    return "".join(chars)


def same_cjk_title(song_title: str, result_title: str) -> bool:
    a, b = cjk_core(song_title), cjk_core(result_title)
    return len(a) >= 2 and a == b


def significant_tokens(s: str) -> list[str]:
    out = []
    for t in tokens(s):
        if t in STOP_TOKENS:
            continue
        if t.isascii() and len(t) <= 1:
            continue
        out.append(t)
    return out


def latin_token_in(token: str, result_tokens: set[str]) -> bool:
    if token in result_tokens:
        return True
    if token + "s" in result_tokens:
        return True
    if token.endswith("s") and token[:-1] in result_tokens:
        return True
    return False


def title_relevant(song_title: str, result_title: str) -> bool:
    """Song title words must appear in the YouTube title; extra lyrics/audio tags are fine."""
    main = re.sub(r"[\(\（].*?[\)\）]", " ", song_title)
    main_toks = significant_tokens(clean_text(main) or song_title)
    paren_bits = re.findall(r"[\(\（](.*?)[\)\）]", song_title)
    rt = set(tokens(result_title))
    result_text = nfkc(result_title)

    def main_hits() -> bool:
        if not main_toks:
            return alnum(song_title) and alnum(song_title) in alnum(result_title)
        hits = 0
        for t in main_toks:
            if re.fullmatch(r"[0-9a-z]+", t):
                if latin_token_in(t, rt):
                    hits += 1
            elif t in result_text or to_simp(t) in to_simp(result_text):
                hits += 1
        if len(main_toks) <= 3:
            return hits == len(main_toks)
        return hits / len(main_toks) >= 0.75

    if main_hits():
        return True
    for bit in paren_bits:
        alt = clean_text(bit)
        if not alt or alt.casefold() in {"taylor's version", "taylors version"}:
            continue
        alt_toks = significant_tokens(alt)
        if not alt_toks:
            continue
        if all(
            (latin_token_in(t, rt) if re.fullmatch(r"[0-9a-z]+", t) else t in result_text)
            for t in alt_toks
        ):
            return True
    return False


def classify(result: dict) -> str:
    title = result.get("title") or ""
    vtype = result.get("videoType") or ""
    if LYRIC_RE.search(title):
        return "lyric_video"
    if vtype == "MUSIC_VIDEO_TYPE_ATV" or AUDIO_RE.search(title):
        return "official_audio"
    if vtype == "MUSIC_VIDEO_TYPE_OMV" or MV_RE.search(title):
        return "music_video"
    if result.get("resultType") == "song":
        return "official_audio"
    return "other"


def score_result(song: dict, result: dict) -> float:
    if not result.get("videoId"):
        return -999
    if result.get("resultType") in {"playlist", "album", "artist"}:
        return -999

    title = result.get("title") or ""
    vtype = result.get("videoType") or ""
    duration = result.get("duration_seconds") or 0
    song_title = song["title"]
    song_artist = song["artist"]

    score = 0.0
    kind_atv = vtype == "MUSIC_VIDEO_TYPE_ATV" or result.get("resultType") == "song"
    has_lyrics = bool(LYRIC_RE.search(title))
    has_audio = bool(AUDIO_RE.search(title))
    is_mv = vtype == "MUSIC_VIDEO_TYPE_OMV" or (
        bool(MV_RE.search(title)) and not has_lyrics
    )

    if has_lyrics:
        score += 24
    if kind_atv:
        score += 18
    if has_audio:
        score += 16
    if is_mv:
        score -= 32

    if artist_matches(song_artist, result):
        score += 16
    else:
        score -= 10

    if title_relevant(song_title, title):
        score += 16
        if alnum(clean_text(song_title)) == alnum(title):
            score += 8
    else:
        return -999.0

    song_has_cover = bool(COVER_RE.search(song_title))
    song_has_remix = bool(REMIX_RE.search(song_title))
    if COVER_RE.search(title) and not song_has_cover:
        score -= 18
    if REMIX_RE.search(title) and not song_has_remix:
        score -= 14
    if LIVE_RE.search(title):
        score -= 22
    if BAD_RE.search(title):
        score -= 22

    if duration:
        if duration < 45:
            score -= 25
        elif duration > 720:
            score -= 18
        elif 80 <= duration <= 420:
            score += 3

    # Prefer more-watched lyric videos when the rest of the score is close.
    views = parse_views(result.get("views"))
    score += min(views / 5e8, 3.0)
    return score


def pick_kind(result: dict) -> str:
    kind = classify(result)
    if kind == "music_video":
        return "music_video"
    if kind == "lyric_video":
        return "lyric_video"
    if kind == "official_audio":
        return "official_audio"
    return "other"


def search_once(yt: YTMusic, query: str, filt: str | None, limit: int) -> list[dict]:
    try:
        return yt.search(query, filter=filt, limit=limit) or []
    except Exception as exc:  # noqa: BLE001 — keep going on a single failed query
        print(f"  search error ({filt or 'mixed'} {query!r}): {exc}", file=sys.stderr)
        return []


def candidates_for(yt: YTMusic, song: dict) -> list[dict]:
    title = clean_text(song["title"]) or song["title"]
    artist = clean_text(song["artist"]) or song["artist"]
    # Drop OCR / parenthetical junk from artist for querying.
    artist_q = re.split(r"[;|(]", artist, maxsplit=1)[0].strip()
    blob = f"{title} {artist_q}".strip()

    queries: list[tuple[str, str | None, int]] = [
        (f"{blob} lyrics", "videos", 8),
        (blob, "songs", 5),
    ]
    if re.search(r"[\u4e00-\u9fff]", title):
        queries.append((f"{title} {artist_q} 動態歌詞", "videos", 5))
        queries.append((title, "songs", 5))
        queries.append((title, "videos", 5))

    seen: set[str] = set()
    out: list[dict] = []
    for query, filt, limit in queries:
        if not query.strip():
            continue
        for result in search_once(yt, query, filt, limit):
            vid = result.get("videoId")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            out.append(result)
        time.sleep(0.12)
    return out


def choose(song: dict, results: list[dict]) -> dict | None:
    ranked = []
    for result in results:
        s = score_result(song, result)
        ranked.append((s, parse_views(result.get("views")), result))
    ranked = [row for row in ranked if row[0] >= 10]
    if artist_is_reliable(song["artist"]):
        matched = [
            row
            for row in ranked
            if artist_matches(song["artist"], row[2])
            or same_cjk_title(song["title"], row[2].get("title") or "")
        ]
        if matched:
            ranked = matched
        else:
            ranked = []
    ranked.sort(key=lambda x: (x[0], x[1]), reverse=True)
    if not ranked:
        return None
    score, _views, result = ranked[0]
    return {
        "youtube_url": f"https://www.youtube.com/watch?v={result['videoId']}",
        "youtube_title": result.get("title") or "",
        "youtube_kind": pick_kind(result),
        "youtube_confidence": "high" if score >= 20 else "low",
        "_score": score,
        "_artists": ", ".join(artist_names(result)),
    }


def atomic_write_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def write_html(songs: list[dict], path: Path) -> None:
    rows = []
    for i, song in enumerate(songs):
        url = song.get("youtube_url") or ""
        vid = ""
        if "v=" in url:
            vid = url.split("v=", 1)[1].split("&", 1)[0]
        conf = song.get("youtube_confidence") or ""
        kind = song.get("youtube_kind") or ""
        missing = " missing" if not url else ""
        low = " low" if conf == "low" else ""
        yt_title = (song.get("youtube_title") or "").replace("<", "&lt;")
        title = song["title"].replace("<", "&lt;")
        artist = song["artist"].replace("<", "&lt;")
        rows.append(
            f'<tr class="song{missing}{low}" data-id="{vid}" data-i="{i}">'
            f"<td>{i + 1}</td>"
            f"<td>{title}</td>"
            f"<td>{artist}</td>"
            f"<td>{song.get('genre', '')}</td>"
            f"<td>{kind}</td>"
            f'<td><a href="{url}" target="_blank" rel="noopener">{yt_title or url or "—"}</a></td>'
            f"</tr>"
        )
    linked = sum(1 for s in songs if s.get("youtube_url"))
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Moosic playlist</title>
  <style>
    :root {{ color-scheme: dark; }}
    body {{ font: 15px/1.4 system-ui, sans-serif; margin: 0; background: #111; color: #eee; }}
    header {{ padding: 16px 20px; background: #1b1b1b; border-bottom: 1px solid #333; }}
    h1 {{ margin: 0 0 8px; font-size: 1.3rem; }}
    #player {{ width: min(960px, 100%); aspect-ratio: 16/9; border: 0; background: #000; }}
    .wrap {{ display: grid; grid-template-columns: minmax(280px, 960px) 1fr; gap: 16px; padding: 16px; }}
    @media (max-width: 900px) {{ .wrap {{ grid-template-columns: 1fr; }} }}
    input {{ width: 100%; max-width: 420px; padding: 8px 10px; border-radius: 8px; border: 1px solid #444; background: #222; color: inherit; }}
    table {{ width: 100%; border-collapse: collapse; }}
    th, td {{ text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }}
    tr.song {{ cursor: pointer; }}
    tr.song:hover {{ background: #1c1c1c; }}
    tr.active {{ background: #143322; }}
    tr.missing {{ opacity: 0.45; }}
    tr.low td:nth-child(5) {{ color: #e6b84d; }}
    a {{ color: #8ec8ff; }}
    .meta {{ color: #aaa; font-size: 0.9rem; }}
  </style>
</head>
<body>
  <header>
    <h1>Moosic</h1>
    <p class="meta">{linked} / {len(songs)} songs linked · lyric video or official audio</p>
    <iframe id="player" allow="autoplay; encrypted-media" allowfullscreen></iframe>
  </header>
  <div class="wrap">
    <div>
      <p><input id="q" type="search" placeholder="Filter title or artist"></p>
      <table>
        <thead><tr><th>#</th><th>Title</th><th>Artist</th><th>Genre</th><th>Kind</th><th>YouTube</th></tr></thead>
        <tbody>
          {"".join(rows)}
        </tbody>
      </table>
    </div>
  </div>
  <script>
    const player = document.getElementById("player");
    const rows = [...document.querySelectorAll("tr.song")];
    function play(row) {{
      const id = row.dataset.id;
      if (!id) return;
      rows.forEach(r => r.classList.remove("active"));
      row.classList.add("active");
      player.src = "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0";
      row.scrollIntoView({{ block: "nearest" }});
    }}
    rows.forEach(row => row.addEventListener("click", e => {{
      if (e.target.closest("a")) return;
      play(row);
    }}));
    document.getElementById("q").addEventListener("input", e => {{
      const q = e.target.value.toLowerCase();
      rows.forEach(row => {{
        row.style.display = row.textContent.toLowerCase().includes(q) ? "" : "none";
      }});
    }});
  </script>
</body>
</html>
"""
    path.write_text(html, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--html", type=Path, default=DEFAULT_HTML)
    parser.add_argument("--limit", type=int, default=0, help="Only process the first N unlinked songs")
    parser.add_argument("--force", action="store_true", help="Re-search songs that already have a URL")
    parser.add_argument("--save-every", type=int, default=1)
    args = parser.parse_args()

    songs = json.loads(args.json.read_text(encoding="utf-8"))
    yt = YTMusic()

    todo = []
    for i, song in enumerate(songs):
        if args.force or not song.get("youtube_url"):
            todo.append(i)
    if args.limit:
        todo = todo[: args.limit]

    print(f"Linking {len(todo)} of {len(songs)} songs from {args.json}")
    linked = 0
    failed = 0
    for n, idx in enumerate(todo, 1):
        song = songs[idx]
        label = f"{song['title']} — {song['artist']}"
        if len(label) > 90:
            label = label[:87] + "..."
        results = candidates_for(yt, song)
        choice = choose(song, results)
        if not choice:
            failed += 1
            print(f"[{n}/{len(todo)}] MISS  {label}")
            continue
        song["youtube_url"] = choice["youtube_url"]
        song["youtube_title"] = choice["youtube_title"]
        song["youtube_kind"] = choice["youtube_kind"]
        song["youtube_confidence"] = choice["youtube_confidence"]
        linked += 1
        print(
            f"[{n}/{len(todo)}] {choice['youtube_kind']:15} "
            f"{choice['youtube_confidence']:4}  {label}\n"
            f"         {choice['youtube_url']}  ({choice['youtube_title'][:70]})"
        )
        if n % args.save_every == 0:
            atomic_write_json(args.json, songs)
            write_html(songs, args.html)

    atomic_write_json(args.json, songs)
    write_html(songs, args.html)
    kinds = {}
    for song in songs:
        k = song.get("youtube_kind") or "unlinked"
        kinds[k] = kinds.get(k, 0) + 1
    print(f"\nDone. linked={linked} missed={failed} kinds={kinds}")
    print(f"Wrote {args.json}")
    print(f"Wrote {args.html}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
