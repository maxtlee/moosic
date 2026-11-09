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
| `../genre_lookup.py` | genre inference for new songs + a master-list audit CLI |
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
| `MOOSIC_SUGGESTION_RPM` | `6` | max suggestion posts/minute per client |
| `MOOSIC_GENRE_LOOKUP` | `1` | auto-categorize new songs (library + iTunes fallback); `0` disables |
| `MOOSIC_TOOL_PYTHON` | `../.venv/bin/python` | interpreter for the tool scripts (needs `ytmusicapi`) |

## API

Reads
- `GET /api/library` → `{count, genres, songs:[{id,title,artist,genre,duration,youtube_url,has_asset,has_cover}]}`
- `GET /api/playlists` · `GET /api/playlists/{slug}`
- `GET /api/stream/{song_id}` → MP3 with Range support (`206`)
- `GET /api/cover/{song_id}` → JPEG album cover (`404` if none; the UI falls back to gradient art)
- `GET /api/download/{song_id}` → the MP3 as an attachment with a friendly filename
- `GET /api/export?scope=album|playlist|library&id=…` → ZIP of tagged MP3s + `.m3u`
- `GET /manifest.webmanifest` · `GET /sw.js` → PWA manifest and service worker
- `GET /api/status` → git state (`dirty`, `ahead/behind`, `last_commit`) + commit cooldown
- `GET /api/suggestions?client_id=…` → threaded bugs/suggestions with replies and vote counts
- `GET /api/health`

Writes (public, rate-limited)
- `POST /api/playlists` · `PATCH /api/playlists/{slug}` · `DELETE /api/playlists/{slug}`
- `POST /api/songs` · `PATCH /api/songs/{song_id}` · `DELETE /api/songs/{song_id}`
  - retagging moves the audio file immediately so playback keeps working
  - changing a YouTube URL regenerates the id and rewrites playlist references
  - deleting a song also strips it from every playlist and drops its rating and gain
- `PUT /api/ratings/{song_id}` → set/clear a rating (`{"rating": 0.8}` or `{"rating": null}`)
- `PUT /api/volume/{song_id}` → set/clear a manual per-song gain
  (`{"gain_db": -4.5}` / `{"gain_db": null}`) or re-measure it with
  `{"auto": true}`
- `POST /api/suggestions` → post `{kind: "bug"|"suggestion", text, author?}` or a reply (`parent_id`; `"todo"` is accepted as a legacy alias for `"bug"`)
- `PATCH /api/suggestions/{id}` → `{done: true|false}`; applies to the **whole thread**
- `POST /api/suggestions/{id}/vote` → `{value: 1|-1|0, client_id}` (one anonymous vote per client)
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
   The server runs `search_songs.py` (ytmusicapi + the batch linker's scoring)
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

The downloaded MP3s have no embedded art. Covers are scraped from the **iTunes
Search API** (the real release artwork, looked up by artist + album, then by
artist + title), falling back to the video's YouTube thumbnail (`i.ytimg.com`,
trying `maxresdefault` → `sddefault` → `hqdefault` → `mqdefault`) when iTunes
has no match. iTunes lookups are cached per album for the duration of a run, and
the chosen source is recorded per song as `cover_source` (`itunes`/`youtube`).
Files live at `assets/_covers/<safe-id>.jpg` (gitignored, on the HDD) with a
`cover` path recorded in `master.json`; `GET /api/cover/{id}` serves them and the
UI square-crops with `object-fit: cover`. Covers are regeneratable from the
master list, so they are not versioned.

```bash
cd ~/Projects/Moosic
python3 fetch_covers.py --execute                 # backfill missing covers
python3 fetch_covers.py --execute --force         # re-fetch everything
python3 fetch_covers.py --execute --force --kinds lyric_video,other  # target bad thumbs
python3 fetch_covers.py --execute --thumbnails-only                  # skip iTunes
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
  star that matches the **current** rating clears it; clicking any other star
  sets that value (including lowering an existing rating).
- **All songs is sorted by rating by default** (highest first) and can be
  re-sorted by playlist/album order, title, artist, genre or duration. Unrated
  songs count as 0 for sorting and ties keep their existing order.
- `GET /api/library` and playlist responses include each song's `rating`.

The API accepts any float 0..1, so a finer control (slider, numeric) can be
added with no data-model change.

## Filters

The filter menu sits in the hero, directly under the **Play / Shuffle / Queue /
Shuffle queue** actions. It applies to *All songs*, genre, album, playlist and
filtered views.

- **Genres** are a multi-select chip list. Every genre is selected by default,
  and a genre seen for the first time joins the selection automatically.
  **All** and **None** set the whole set; **Invert** applies boolean NOT to the
  selection, so the view shows songs whose genre is *not* selected.
- **Rating** is an inclusive dual-thumb slider from **0★ to 5★**, defaulting to
  the full 0–5 range. Unrated songs count as 0★; both ends are included.
- **Reset** restores all genres selected, invert off and the 0–5★ range. While a
  non-default filter is active, the **Filters** button is highlighted.
- The panel closes with **Escape** (or by clicking Filters again). Filtering is
  client-side, so it immediately affects the count and the list actions.

## Loudness normalisation

Track loudness varies a lot between YouTube sources. `normalize_volume.py`
measures each MP3 with ffmpeg's EBU R128 `loudnorm` filter and stores a gain in
`gains.json` in the data repo:

- Target is **-14 LUFS**, clamped to **-20…+12 dB**. Files are never rewritten;
  the player applies the gain through a Web Audio `GainNode`, so quiet tracks can
  be boosted above the element's 1.0 volume ceiling.
- New downloads and re-downloads are measured automatically by the add/refresh
  pipeline. To backfill or redo the library:

  ```bash
  python3 normalize_volume.py                    # dry-run
  python3 normalize_volume.py --execute          # fill missing gains
  python3 normalize_volume.py --execute --force  # re-measure everything
  ```

- Right-click (or long-press) a song → **Volume** to tweak its gain in
  −20…+12 dB. **Auto** re-runs the measurement for that track. Manual values
  persist in `gains.json` across refreshes; deleting a song removes its gain.

## Bugs & Suggestions

The **Bugs & Suggestions** nav page is a public forum-style board. Anyone can
post a bug or suggestion, reply to it in a nested chain, and like/dislike any
post.
Posts live in `$MOOSIC_DATA/suggestions.json`, so they are versioned with the
rest of the data and land in the working tree until the **Commit** button pushes
them.

- `GET /api/suggestions?client_id=…` returns roots as a tree (`replies` nested),
  open threads first (most recent activity), then finished ones (most recently
  finished), with `count`/`open`/`done`/`replies` totals. `client_id` is an
  anonymous random token kept in `localStorage`; it only personalises `my_vote`.
- `POST /api/suggestions` accepts `{kind, text, author?, parent_id?}`. Omit
  `parent_id` for a new thread; include it to reply. Text is capped at 600
  characters, author at 60, the board at 1000 items, and reply depth at 8.
- `PATCH /api/suggestions/{id}` takes `{done}` and applies to the **entire
  thread** (root + all descendants). Replying to a finished thread reopens the
  whole chain automatically.
- `POST /api/suggestions/{id}/vote` takes `{value: 1|-1|0, client_id}`. One vote
  per client per item; voting the same direction again clears it, the opposite
  direction switches it. Counts are derived from the stored vote map.
- Posting/replies are limited to `MOOSIC_SUGGESTION_RPM` (default 6/minute per
  client) on top of the normal write limit; votes and finish toggles use the
  normal write limit.
- There is no public delete: finished items and replies stay as a record, and
  anything abusive can be removed from `suggestions.json` and rolled back via git.

## Genres

New songs are auto-categorized when added (web UI, YouTube search/album add):

1. soundtrack cues in the title/album, then language script (K-pop / J-pop /
   Mandopop), then a clear album/artist majority in the existing library;
2. otherwise the iTunes Search API (best-effort, no key);
3. otherwise `Unsorted`.

Set `MOOSIC_GENRE_LOOKUP=0` to disable the network fallback. To audit or fill the
existing master list:

```bash
python3 genre_lookup.py --online        # dry-run: fill Unsorted (online)
python3 genre_lookup.py --online --execute  # write those fills
python3 genre_lookup.py --all           # dry-run: local consistency audit
python3 genre_lookup.py --all --online  # also ask iTunes (slow)
```

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

## Playback: explicit queue + autoplay, shuffle, smart shuffle

Playback has two layers: an **explicit queue** (`state.queue`) for songs you add
by hand, and a separate **autoplay order** (`state.auto`) built from the view
you started playing. The explicit queue always runs first; when it empties,
autoplay resumes where it left off, in the current shuffle order. That means
*Add to queue* appends to the small up-next list — not to the end of a 500-song
view — and a full listening history keeps back/next exact inverses.

- **Click vs double-click:** on mouse/trackpad devices, **double-click** a row to
  play (a single click does nothing, avoiding accidental playback); touch
  devices keep single-tap. Right-click / ⋮ opens the song menu.
- **Song menu:** right-click a song row (desktop) or use the **⋮** kebab
  (touch) to open the same menu — Play, Play next, Add to queue, Add to
  playlist, Stop after this song (for the current track), Download, Save
  offline, Edit details, Wrong match — replace, and Delete. The browser's
  native context menu is suppressed site-wide (except inside text fields, so
  paste still works).
- **Queue sidebar:** toggle the **Queue** nav item (or ✕) to manage playback
  while you keep browsing. It shows the current track, the **Queue** (explicit
  up-next list) and an **Autoplay** preview. **Play next** prepends to the
  queue, **Add to queue** appends, and ✕ removes an item. *Clear queue* empties
  both layers but keeps the current track playing. On mobile it becomes a
  right-hand drawer.
- **Playlists:** the playlist header has **＋ Add songs** (search your library
  and select without scrolling the whole list), **＋ Queue** (append the whole
  playlist to the explicit queue), **⤨ Shuffle queue** (append it in a fresh
  random order) and **Play all**. Playing any playlist row re-seeds autoplay
  from that playlist, even if the song was already queued from another view.
  The same four list actions (**Play**, **Shuffle**, **Queue**, **Shuffle
  queue**) are available on *All songs*, genre, album and filtered views.
- **History:** the **History** nav page shows recently played songs (newest
  first, deduplicated, capped at 200) with a *Clear history* button. It lives in
  `localStorage`, so it is per-browser and never enters the data repo.
- **Shuffle** cycles **off → shuffle → smart shuffle** (the button shows ⤨ / ✨).
  Both modes build a stable autoplay order up front; toggling modes re-orders
  only the unplayed autoplay tail and refreshes the queue sidebar immediately.
- **Smart shuffle** builds a rating-weighted random permutation
  (Efraimidis–Spirakis): unrated = `1.0`, rated = `0.25 + 8 × rating` (so 0.4 →
  3.45, 0.6 → 5.05, 0.8 → 6.65, 1.0 → 8.25, 0 → 0.25). Higher-rated songs come
  up much earlier on average, while the wide spread keeps it unpredictable and
  still lets unrated/low-rated songs through. Ratings changed during playback
  re-order the remaining tail immediately.
- **Transport:** *next* consumes the explicit queue, then advances autoplay and
  stops at the end unless repeat is *all* (then wraps); *back* restarts the
  track if more than 3 s in, otherwise steps back through the play history.
  Repeat cycles **off → all → one** with distinct ↻ / 🔁 / 🔂 glyphs. The **⏹**
  button (player bar and Now Playing sheet) stops after the current song.
- **Volume** uses a squared slider curve (50% ≈ 25% gain) for more even
  perceived loudness changes; the slider position is still what is saved.

## Standalone builds

`web/packaging/` builds a single-file server with PyInstaller:

```bash
cd web
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pyinstaller
cd packaging
../.venv/bin/pyinstaller --noconfirm --clean moosic.spec   # -> dist/moosic
MOOSIC_DATA=~/Music ./dist/moosic                          # http://127.0.0.1:8740
```

It starts the server and opens a browser; point it at an existing library with
`MOOSIC_DATA` (default `~/Moosic`). The bundled build is **player-only** —
search, add, download and refresh need the full source install (Python +
yt-audio-api + ffmpeg) and return `503` otherwise.

Cross-platform binaries (Linux / macOS / Windows) are built natively on GitHub
Actions by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
when a `v*` tag is pushed, and attached to the GitHub Release.

## Listen on iPhone / Apple Music

### PWA (recommended)

- Open the site in **Safari**, then **Share → Add to Home Screen**. It launches
  full-screen (standalone) with the Moosic icon; lock-screen / Control Center
  play-pause, next/prev and seek work through the Media Session API (metadata +
  cover art, `setPositionState`).
- **Offline:** use **Save offline** on a song (⋮ / right-click menu), an album,
  or a playlist. The service worker caches the MP3 (max 60 tracks) and serves
  Range requests from the cache, so cached tracks play without a connection.
  **Download MP3** instead saves the file to the iOS Files app.
- The PWA needs HTTPS (this deployment is `music.maxwe.me`) or `localhost`.

### Apple Music (via a Mac)

Apple Music **cannot import arbitrary files from Safari/Files on iOS**. The only
Apple-sanctioned route is **iCloud Music Library**: add files to the Music app
on a Mac/PC with an Apple Music subscription and *Sync Library* on, after which
they appear on the iPhone. Apple Music *streaming* tracks are DRM-protected and
cannot be downloaded into Moosic — only your own library files are involved.

1. In Moosic, open an album/playlist (or **Admin → Export library**) and tap
   **Export for Apple Music**.
2. On a Mac, download and unzip the ZIP. The MP3s are **ID3v2-tagged** (title,
   artist, album, track number, year where known) with an **embedded cover**,
   and include an `.m3u` playlist; filenames are `NN - Artist - Title.mp3`.
3. In the **Music** app: **File → Add to Library…** and choose the unzipped
   folder/files.
4. On the iPhone: **Settings → Music → Sync Library** must be on (requires an
   Apple Music subscription); the tracks then appear in the iPhone Music app.
5. (Windows alternative: add them in the Apple Music/iTunes app with Sync
   Library enabled.)

Export is rate-limited (5/min) and one export runs at a time; whole-library
exports can be large.

### Third-party iOS clients (Subsonic) — proposed, not built

A minimal Subsonic API (`ping`, `getMusicFolders`, `getIndexes`,
`getMusicDirectory`, `stream` with Range, `getCoverArt`, `search3`, playlists)
is feasible and would let clients like Amperfy / play:Sub do offline downloads
and lock-screen controls with no Mac. It is a meaningful API surface (auth
token/salt, XML/JSON, id mapping) rather than a trivial addition, so it is left
as a future option.

## Safety model (public writes)

The site is **unauthenticated by design** — anyone can create/edit/delete
playlists *and* master-list entries. Mitigations:

- Every mutation is rate-limited per client IP (`MOOSIC_WRITE_RPM`).
- Downloads (add-and-download and refresh) share a **global 20 / 30 min** quota,
  one at a time; searches are capped at `MOOSIC_SEARCH_RPM` per client.
- Commits are rate-limited globally (`MOOSIC_COMMIT_INTERVAL`, default 60s); the
  button shows a live cooldown.
- Public suggestion posts are separately rate-limited and cannot be deleted from
  the UI; git history is the moderation path.
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
