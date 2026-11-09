# Moosic

A self-hosted music library and web player. Moosic resolves songs on YouTube
Music, downloads and organises the audio, and serves a Spotify-like UI with
playlists, albums, ratings, a queue and smart shuffle.

> **Visibility:** this repository is **private** on GitHub for now (as are the
> `yt-audio-api` submodule and the `Music` data repo), and it is intended to be
> open-sourced. Clone over SSH until then. Keep code, docs, and git history
> publication-ready.

## Features

- **Song-first search** — results are deduplicated songs (one canonical video
  each) with album metadata, so the same song is never recommended twice.
- **Add & download on the spot** through a local
  [yt-audio-api](https://github.com/alperensumeroglu/yt-audio-api) (yt-dlp) service.
- **Albums** — auto-detected per song, searchable and downloadable as a whole,
  and playable as an ordered list.
- **Ratings & custom sort** — rate songs 0–1 (including from the right-click
  menu); "All songs" sorts by rating by default and can be re-sorted by title,
  artist, genre or duration.
- **Smart shuffle** — rating-weighted randomness: higher-rated songs come up
  more often, with a generous random spread so it never feels deterministic.
- **Queue + autoplay** — an explicit up-next queue (*Play next* prepends,
  *Add to queue* appends) that runs before shuffle-weighted autoplay resumes
  from the view you started. Manage it in a live sidebar.
- **Playlists** — create, edit, search-to-add and queue entire playlists from the
  UI, in order or shuffled; they reference stable song ids, so reordering or
  retagging is safe.
- **History & transport** — recently played list, *stop after this song*, repeat
  off/all/one, and a perceptual (squared) volume curve.
- **Even volume** — every track is loudness-measured (EBU R128, -14 LUFS target)
  and played through a per-song gain, with a manual dB override in the song
  menu; gains live in the data repo.
- **Bugs & Suggestions forum** — a public page where anyone can report bugs or
  post ideas, reply in nested threads, and like/dislike posts. Finishing a
  thread closes the whole chain; a new reply reopens it. Posts are rate-limited
  and versioned with the data repo.
- **Filters** — multi-select genres (all selected by default, with invert) and an
  inclusive min–max rating slider, applied to the song list and playlists; play,
  shuffle, queue or shuffle-queue the filtered list.
- **Auto-genre** — new songs are categorized from soundtrack cues, language,
  the existing library, then iTunes, instead of always landing in *Unsorted*.
- **Album covers** — real album art scraped from iTunes, falling back to the
  YouTube thumbnail when no match is found.
- **Wrong-match replacement** — reject a bad video and deterministically pick
  the next-best match, then re-download.
- **Versioned data** — the master list, playlists, ratings and rejection list
  live in a git repo; a rate-limited **Commit** button in the UI pushes changes.

## Architecture

The **code** (this repo) is separate from the **data** (your library). The tools
read/write a data directory selected with `MOOSIC_DATA` (default
`~/Projects/Music`), which can be its own git repo:

```
Moosic/                     # this repo: pipeline + web app
$MOOSIC_DATA/               # your data (kept out of version control except json)
  master.json               # canonical song list (id, metadata, asset path, album)
  ratings.json              # custom ordering: song id -> 0..1
  gains.json                # per-song loudness gain in dB (auto + overrides)
  bad_links.json            # rejected song<->video matches
  suggestions.json          # public bugs / suggestions
  playlists/<slug>.json      # playlists referencing master ids
  assets/                   # downloaded mp3s + covers (gitignore this)
```

## Repository layout

| Path | Role |
|---|---|
| `musiclib.py` | shared data layer: master/playlist/rating IO, ids, locking, git commit/push |
| `genre_lookup.py` | genre inference for new songs + master-list audit/fill CLI |
| `normalize_volume.py` | per-song loudness measurement → playback gain in `gains.json` |
| `download_assets.py` | reconciles `assets/` with `master.json` (download, rename, prune, covers) |
| `fetch_covers.py` | album covers from iTunes art (+ YouTube thumbnail fallback) |
| `search_songs.py` | song-first, deduplicated YouTube Music search |
| `match_song.py` | deterministic best video for a song, skipping rejected links |
| `albums.py` | album search + track listing |
| `detect_albums.py` | auto-detect each song's album |
| `link_youtube.py` | batch-resolve missing YouTube URLs in the master list |
| `watch_downloads.py` | watch the master list and refresh assets on change |
| `web/` | FastAPI + vanilla-JS player (see [`web/README.md`](web/README.md)) |
| `yt-audio-api/` | submodule: local MP3 conversion service |

## Quick start

```bash
git clone --recurse-submodules git@github.com:maxtlee/moosic Moosic
cd Moosic

# pipeline deps (ytmusicapi, opencc, yt-dlp)
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# web deps
cd web && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ..

export MOOSIC_DATA=~/Music            # where master.json / playlists / assets live
mkdir -p "$MOOSIC_DATA/playlists"
```

Add songs through the web UI (see below), or maintain `$MOOSIC_DATA/master.json`
yourself and run:

```bash
python3 download_assets.py --execute          # fetch missing audio + covers
python3 detect_albums.py --execute            # fill in albums
python3 download_assets.py --execute          # (re-run; picks up new albums)
```

## Web player

```bash
cd web
scripts/run.sh            # http://127.0.0.1:8740
# or, to run as a systemd service:
scripts/install-service.sh
```

The UI supports search + add, albums, playlists, ratings, a queue, smart
shuffle, right-click song menus, and a rate-limited **Commit** button that
version-controls the data repo. See [`web/README.md`](web/README.md) for the API
and deployment details.

Single-file **standalone servers** for Linux, macOS and Windows are built by the
`release` GitHub Actions workflow on a version tag; they are player-only builds
(search/add/download need the full source install). See
[`web/README.md`](web/README.md#standalone-builds).

**On iPhone:** the web app is a PWA (Add to Home Screen, offline track caching,
lock-screen controls). For the Apple Music app, export an album/playlist as a
tagged ZIP and import it via a Mac + iCloud Music Library — see
[`web/README.md`](web/README.md#listen-on-iphone--apple-music).

## Notes

- Audio is downloaded with `yt-dlp`; respect YouTube's Terms of Service and only
  use this for content you are entitled to.
- The web app is read/write and, when exposed publicly, is unauthenticated;
  it rate-limits writes and downloads. See the safety notes in
  [`web/README.md`](web/README.md).
