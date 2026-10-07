# Moosic web

A Spotify-like player and editor for the local Moosic library. FastAPI backend,
one static page (vanilla JS/CSS), HTTP Range streaming. The **master list and
playlists are editable from the web**, and a rate-limited **Commit** button
versions every change in the private data repo.

```
browser
  │  https://music.maxwe.me            ──Vercel rewrite──┐
  │  https://agentmaxxer.tail6ca935.ts.net/music          │ (Tailscale Funnel)
  ▼                                                       │
127.0.0.1:8740  moosic.service (systemd)  ◀───────────────┘
  │  reads/writes  $MOOSIC_DATA (~/Projects/Music)
  │      master.json · playlists/*.json
  └── streams      $MOOSIC_DATA/assets -> /mnt/archive-new/moosic/library
```

## Layout

| Path | Purpose |
|---|---|
| `app.py` | FastAPI: library/playlist/song CRUD, streaming, commit, rate limiting |
| `static/` | `index.html`, `app.js`, `style.css` |
| `scripts/run.sh` | loads `.env`, execs uvicorn |
| `scripts/install-service.sh` | installs `/etc/systemd/system/moosic.service` (sets `HOME`, `MOOSIC_DATA`, `MOOSIC_ROOT_PATH`) |
| `deploy/vercel.json` | rewrite config for `music.maxwe.me` (already deployed) |
| `.venv/` | fastapi + uvicorn (gitignored) |

Config (environment, or `.env`):

| Var | Default | Meaning |
|---|---|---|
| `MOOSIC_DATA` | `~/Projects/Music` | data repo root |
| `MOOSIC_HOST` / `MOOSIC_PORT` | `127.0.0.1` / `8740` | bind |
| `MOOSIC_ROOT_PATH` | *(empty)* | URL prefix to strip (e.g. `/music`) |
| `MOOSIC_WRITE_RPM` | `40` | per-client write requests/minute |
| `MOOSIC_COMMIT_INTERVAL` | `60` | global seconds between commits |
| `MOOSIC_DOWNLOAD_LIMIT` | `20` | max song downloads per window |
| `MOOSIC_DOWNLOAD_WINDOW` | `1800` | download window in seconds (30 min) |
| `MOOSIC_SEARCH_RPM` | `20` | max YouTube searches/minute per client |
| `MOOSIC_TOOL_PYTHON` | `../.venv/bin/python` | interpreter for the tool scripts (needs `ytmusicapi`) |

## API

Reads
- `GET /api/library` → `{count, genres, songs:[{id,title,artist,genre,duration,youtube_url,has_asset,has_cover}]}`
- `GET /api/playlists` · `GET /api/playlists/{slug}`
- `GET /api/stream/{song_id}` → MP3 with Range support (`206`)
- `GET /api/cover/{song_id}` → JPEG album cover (`404` if none; the UI falls back to gradient art)
- `GET /api/status` → git state (`dirty`, `ahead/behind`, `last_commit`) + commit cooldown
- `GET /api/health`

Writes (public, rate-limited)
- `POST /api/playlists` · `PATCH /api/playlists/{slug}` · `DELETE /api/playlists/{slug}`
- `POST /api/songs` · `PATCH /api/songs/{song_id}` · `DELETE /api/songs/{song_id}`
  - retagging moves the audio file immediately so playback keeps working
  - changing a YouTube URL regenerates the id and rewrites playlist references
  - deleting a song also strips it from every playlist and drops its rating
- `PUT /api/ratings/{song_id}` → set/clear a rating (`{"rating": 0.8}` or `{"rating": null}`)
- `POST /api/songs/{song_id}/replace-match` → mark the current YouTube video as
  wrong (adds it to `bad_links.json`), pick the next-best match and re-download;
  works for already-downloaded songs and consumes the download quota.
- `POST /api/admin/add-album` → add every track of an album (by `browse_id`) and
  download as many as the quota allows.
- `POST /api/albums/download` → download missing tracks for a library album.
- `POST /api/commit` → `git add -A && git commit && git push` the data repo

Albums
- `GET /api/albums` → library albums grouped by (album, artist) with counts.
- `GET /api/album-search?q=` · `GET /api/album-tracks?browse_id=` → YouTube Music
  album search / track listing (`albums.py`).

Search & add (public, rate-limited)
- `GET /api/search?q=<query>` → **song-first** YouTube Music results
  (`search_songs.py`): one entry per song, each with a single canonical
  `video_id`/`url`, album, duration and thumbnail, deduplicated by
  (artist, title). Songs already in the library are flagged `in_library`
  so the UI can't add them twice.
- `POST /api/admin/add` → add a chosen result to the master list and download
  it immediately (rejects duplicates by video id *or* song key).
- `POST /api/admin/refresh` → reconcile `assets/` with `master.json`
  (download missing, rename retagged, prune orphans to `_trash/`).
- `GET /api/admin/quota` → `{limit, used, remaining, window, reset_in}`.

The home **search bar** drives this: typing shows a live dropdown of closest
library matches plus a "Search YouTube Music" action; Enter opens a search page
with *In your library* and *Add from YouTube Music* sections.

**Download quota:** a global sliding window of **20 downloads / 30 min**
(`MOOSIC_DOWNLOAD_LIMIT` / `MOOSIC_DOWNLOAD_WINDOW`). Both add-and-download and
refresh consume it (refresh caps itself to the remaining quota); when exhausted
the API returns `429` with `Retry-After`. Only one download runs at a time
(concurrent requests get `409`). The counter lives in memory, so it resets when
`moosic.service` restarts.

All writes are validated (lengths, slug regex, id existence), capped (500
playlists, 2000 songs/playlist, 5000 master songs), guarded by a `flock`, and
written atomically. Writes are stored immediately in the working tree; the
Commit button makes them durable on GitHub.

## Running

```bash
cd ~/Projects/Moosic/web
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
scripts/run.sh              # http://127.0.0.1:8740
scripts/install-service.sh  # boot service + restart
```

## Admin panel

The **Admin** item in the sidebar is the "add music" workflow:

1. Type a query (e.g. `NewJeans - Ditto` or just a title) and hit **Search**.
   The server runs `search_youtube.py` (ytmusicapi + the batch linker's scoring)
   and returns ranked candidates, marking the recommended one **★ best**.
2. Click **Add & download** on a result. The server:
   - writes the song into `master.json` with a stable id and its asset path,
   - downloads it on the spot via `download_assets.py --only <id> --execute`
     (which also fetches its cover),
   - returns the song plus the download summary and updated quota.
3. **Refresh assets now** runs the full reconciler (up to the remaining quota).

Everything the admin panel does lands in the working tree; use the **Commit**
button to version it. Searches are rate-limited separately (`MOOSIC_SEARCH_RPM`)
so the YouTube Music API isn't hammered.

## Albums

Each song carries an auto-detected `album`. `detect_albums.py` fills them in
from YouTube Music (`--execute [--limit N] [--force]`). The sidebar **Albums**
view groups the library into album cards; opening one plays it like a playlist,
creates a playlist from it, or downloads its missing tracks. Album search
appears on the search page with an **Add album** button that adds every track
and downloads up to the quota.

## Album covers

The downloaded MP3s have no embedded art, so the cover is the video's YouTube
thumbnail (`i.ytimg.com`, trying `maxresdefault` → `sddefault` → `hqdefault` →
`mqdefault`). Files live at `assets/_covers/<safe-id>.jpg` (gitignored, on the
HDD) with a `cover` path recorded in `master.json`; `GET /api/cover/{id}` serves
them and the UI square-crops with `object-fit: cover`. Covers are regeneratable
from the master list, so they are not versioned.

```bash
cd ~/Projects/Moosic
python3 fetch_covers.py --execute           # backfill missing covers
python3 fetch_covers.py --execute --force   # re-fetch everything
```

`download_assets.py` — and therefore the admin **Refresh assets** button and the
add-and-download flow — also backfills missing covers. A missing cover degrades
to a deterministic gradient tile.

## Ratings & custom sort

Every song can carry a rating from **0 to 1**, stored in `ratings.json` in the
data repo — kept separate from `master.json` so it can grow into a multi-rater
model ("how much I like it" vs "how much a friend likes it") later.

- The UI shows a 5-star control (0.2 steps) in **every track row** and in the
  **player bar**, so you can rate while listening or from any list. Clicking the
  active star clears the rating.
- **All songs is sorted by rating by default** (highest first) and can be
  re-sorted by playlist/album order, title, artist, genre or duration. Unrated
  songs count as 0 for sorting and ties keep their existing order.
- `GET /api/library` and playlist responses include each song's `rating`.

The API accepts any float 0..1, so a finer control (slider, numeric) can be
added with no data-model change.

## Mobile

The layout adapts at ≤820px:

- The sidebar becomes a **slide-in drawer** (hamburger in the top bar) with all
  nav, playlists and genres, plus an overlay that closes on tap.
- A compact top bar: hamburger, search, Commit; the Sort select wraps to a
  second row, and the manual "＋ Song" button is dropped (Admin covers adds).
- Track rows become **cover + title/artist + rating + a ⋮ kebab**; the kebab
  opens a **bottom action sheet** (Play / Add to playlist / Edit / Delete, or
  move/remove inside a playlist) since hover-only controls don't work on touch.
- The player collapses to a compact bar (cover, title, prev/play/next); tapping
  it (or the ⌃ chevron) opens a **full-screen Now Playing sheet** with large art,
  seek, transport, 5-star rating and volume.

## Playback: queue, shuffle, smart shuffle

Playback is driven by a single ordered **queue** (`state.queue`) with a cursor,
so next/back are exact inverses and the behaviour doesn't change as complexity
grows.

- **Song menu:** right-click a song row (desktop) or use the **⋮** kebab
  (touch) to open the same menu — Play, Play next, Add to queue, Add to
  playlist, Edit details, Wrong match — replace, and Delete. The browser's
  native context menu is suppressed site-wide (except inside text fields, so
  paste still works).
- **Queue:** playing from a view seeds the queue with that view's songs. The row
  action sheet has **Play next** (insert after the current track) and **Add to
  queue** (append). The **Queue** view shows the current track + upcoming, lets
  you remove items, and **Clear queue**.
- **Shuffle** cycles **off → shuffle → smart shuffle** (the button shows ⤨ / ✨).
  Both modes build a **stable play order up front**, so *back* retraces exactly
  what *next* played — even while shuffling.
- **Smart shuffle** builds a rating-weighted random permutation
  (Efraimidis–Spirakis): weight = `0.4 + rating`, unrated = neutral `0.5`. A
  5-star song is ~3.5× as likely to come up early as an unrated one, and even a
  0-rated song stays ~1/3 as likely — deliberately generous randomness so it
  never feels deterministic. Toggling modes re-orders only the unplayed tail and
  keeps manual queue additions and the current track in place.
- **Skip / back:** *next* advances the play order and stops at the end unless
  repeat is *all* (then wraps); *back* restarts the track if more than 3 s in,
  otherwise steps back one. Repeat *one* loops the current track but manual
  next/back still move.

## Safety model (public writes)

The site is **unauthenticated by design** — anyone can create/edit/delete
playlists *and* master-list entries. Mitigations:

- Every mutation is rate-limited per client IP (`MOOSIC_WRITE_RPM`).
- Downloads (add-and-download and refresh) share a **global 20 / 30 min** quota,
  one at a time; searches are capped at `MOOSIC_SEARCH_RPM` per client.
- Commits are rate-limited globally (`MOOSIC_COMMIT_INTERVAL`, default 60s); the
  button shows a live cooldown.
- Input is validated and size-capped; ids must exist; slugs are regex-checked
  and paths cannot escape the assets dir.
- **The master list and admin panel are public.** Anyone can trigger downloads,
  bounded by the 20/30 min quota and by the 5000-song master cap; they can also
  add junk metadata rows (which cost nothing until downloaded). If that becomes a
  problem, gate `/api/admin/*` (and/or the write routes) behind a token, or
  revert to playlist-only editing.

### Rollback

Everything is in git, so any vandalism is one command away:

```bash
git -C ~/Projects/Music log --oneline -20      # find a good commit
git -C ~/Projects/Music revert <sha>           # or: git reset --hard <sha> && git push -f
```

The commit message records the action; commit pushes are made by
`user.name=Moosic`.

## Hosting on `music.maxwe.me`

Funnel mount (already live):

```bash
sudo tailscale funnel --bg --yes --https=443 --set-path=/music http://127.0.0.1:8740
tailscale funnel status     # / -> board :8720, /music -> moosic :8740
```

The custom domain is a Vercel project with `deploy/vercel.json`
(`/(.*)` → `https://agentmaxxer.tail6ca935.ts.net/music/$1`). Caveat: Vercel's
proxy may drop byte-range requests, so seeking can be flaky on the custom domain;
the Funnel URL itself always supports Range.

## Storage: SSD or HDD?

**Library on the HDD; app/repos on the SSD.** The root SSD (`/dev/sdb5`, 85 GB)
runs ~70% full; the archive HDD (`/dev/sda4`) has ~965 GB free. MP3 playback is
a ~24 KB/s sequential read that a spinning disk serves easily, so the SSD's
speed buys nothing for storage. The HDD is in `fstab` with `nofail` and SMART
`PASSED` (a 2013-era Seagate — keep backups). If the HDD is unmounted the
`assets` symlink dangles and the UI shows 0 tracks until
`sudo mount /mnt/archive-new`.

## Refreshing assets

Adding a song in the UI only writes `master.json`; run the refresher in the
tool repo to download it:

```bash
cd ~/Projects/Moosic
python3 download_assets.py --execute --commit
```
