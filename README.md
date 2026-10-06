# Moosic (tool repo)

Code for the Moosic music/playlist system. The **data** (master list + playlists)
lives in a separate private repo, [`maxtlee/music`](https://github.com/maxtlee/music),
cloned at `~/Projects/Music` and selected with `MOOSIC_DATA`.

```
~/Projects/Music/            (maxtlee/music — data only)
  master.json                canonical list; stable id + asset path + duration
  playlists/<slug>.json      playlists referencing master ids
  assets/ -> /mnt/archive-new/moosic/library   (gitignored, mp3s on the HDD)
```

## Components

| File | Role |
|---|---|
| `musiclib.py` | shared data layer: master/playlist IO, stable ids, slugify, locking, git commit/push |
| `download_assets.py` | **asset refresher** (yt-dlp via yt-audio-api): reconciles `assets/` with `master.json` — downloads missing, renames retagged files, prunes orphans to `_trash/`, writes `asset`/`duration` back |
| `watch_downloads.py` | watches `master.json` and runs the refresher on change |
| `link_youtube.py` | resolves missing YouTube URLs in `master.json` using YTMusic |
| `search_youtube.py` | ranked YouTube Music search (reuses `link_youtube` scoring); powers the web admin panel |
| `web/` | FastAPI + vanilla-JS player with playlist/master CRUD, admin search/add/download/refresh, and a rate-limited commit button |
| `yt-audio-api/` | submodule providing the local MP3 conversion server |
| `moosic-public/` | public child submodule |

## Master list & ids

Every song has a stable id: `yt:<youtube-video-id>` (or `slug:<...>` when there
is no URL). Playlists reference those ids, so they keep pointing at the right
song even if the master list is reordered or retagged.

## Refresh assets from the master list

```bash
python3 download_assets.py                 # dry run: shows what would change
python3 download_assets.py --execute       # download/rename/prune
python3 download_assets.py --execute --commit   # ...and commit+push master.json
python3 watch_downloads.py --execute       # keep it in sync while running
```

`assets/` is gitignored in the data repo; only `master.json` and `playlists/`
are versioned. Unreferenced files are moved (never deleted) to `assets/_trash/`.

## Web player

See [`web/README.md`](web/README.md). Public at
`https://music.maxwe.me` (Vercel rewrite → Tailscale Funnel `/music`), serving
from a local `moosic.service` on `127.0.0.1:8740`. Playlists and the master list
can be edited from the UI; an **Admin** panel searches YouTube Music and adds +
downloads songs on the spot; the **Commit** button commits and pushes the data
repo (rate-limited, 1/60s). Downloads are capped at 20 songs / 30 min.

## Storage: SSD vs HDD

The audio library (~2.35 GB and growing) lives on the **HDD** at
`/mnt/archive-new/moosic/library`; the repos, code and venvs stay on the SSD.
MP3 playback is a low-bandwidth sequential read that a spinning disk handles
easily, and the root SSD is small/tight. See `web/README.md` for the full
rationale.

## Git

Private repos on this machine may be committed; the data repo is committed
automatically by the refresher and by the web commit button. The tool repo is
committed manually.
