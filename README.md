# Moosic

A self-hosted music library and web player. Moosic resolves songs on YouTube
Music, downloads and organises the audio, and serves a Spotify-like UI with
playlists, albums, ratings, a queue and smart shuffle.

## Features

- **Song-first search** — results are deduplicated songs (one canonical video
  each) with album metadata, so the same song is never recommended twice.
- **Add & download on the spot** through a local
  [yt-audio-api](https://github.com/alperensumeroglu/yt-audio-api) (yt-dlp) service.
- **Albums** — auto-detected per song, searchable and downloadable as a whole,
  and playable as an ordered list.
- **Ratings & custom sort** — rate songs 0–1; "All songs" sorts by rating by
  default and can be re-sorted by title, artist, genre or duration.
- **Smart shuffle** — rating-weighted randomness: higher-rated songs come up
  more often, with a generous random spread so it never feels deterministic.
- **Queue** — *Play next* / *Add to queue* and a manage-as-you-browse sidebar.
- **Playlists** — create, edit and delete from the UI; they reference stable
  song ids, so reordering or retagging the library is safe.
- **Album covers** — fetched from YouTube thumbnails.
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
  bad_links.json            # rejected song<->video matches
  playlists/<slug>.json      # playlists referencing master ids
  assets/                   # downloaded mp3s + covers (gitignore this)
```

## Repository layout

| Path | Role |
|---|---|
| `musiclib.py` | shared data layer: master/playlist/rating IO, ids, locking, git commit/push |
| `download_assets.py` | reconciles `assets/` with `master.json` (download, rename, prune, covers) |
| `fetch_covers.py` | album covers from YouTube thumbnails |
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
git clone --recurse-submodules https://github.com/maxtlee/moosic Moosic
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

## Notes

- Audio is downloaded with `yt-dlp`; respect YouTube's Terms of Service and only
  use this for content you are entitled to.
- The web app is read/write and, when exposed publicly, is unauthenticated;
  it rate-limits writes and downloads. See the safety notes in
  [`web/README.md`](web/README.md).
