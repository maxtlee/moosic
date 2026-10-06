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

## API

Reads
- `GET /api/library` → `{count, genres, songs:[{id,title,artist,genre,duration,youtube_url,has_asset}]}`
- `GET /api/playlists` · `GET /api/playlists/{slug}`
- `GET /api/stream/{song_id}` → MP3 with Range support (`206`)
- `GET /api/status` → git state (`dirty`, `ahead/behind`, `last_commit`) + commit cooldown
- `GET /api/health`

Writes (public, rate-limited)
- `POST /api/playlists` · `PATCH /api/playlists/{slug}` · `DELETE /api/playlists/{slug}`
- `POST /api/songs` · `PATCH /api/songs/{song_id}` · `DELETE /api/songs/{song_id}`
  - retagging moves the audio file immediately so playback keeps working
  - changing a YouTube URL regenerates the id and rewrites playlist references
  - deleting a song also strips it from every playlist
- `POST /api/commit` → `git add -A && git commit && git push` the data repo

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

## Safety model (public writes)

The site is **unauthenticated by design** — anyone can create/edit/delete
playlists *and* master-list entries. Mitigations:

- Every mutation is rate-limited per client IP (`MOOSIC_WRITE_RPM`).
- Commits are rate-limited globally (`MOOSIC_COMMIT_INTERVAL`, default 60s); the
  button shows a live cooldown.
- Input is validated and size-capped; ids must exist; slugs are regex-checked
  and paths cannot escape the assets dir.
- **The master list is public.** Since the asset refresher is *not* automatic,
  a spammer cannot cause downloads by adding songs, but they can add junk rows
  (capped at 5000). If that becomes a problem, gate the write routes behind a
  token or revert to playlist-only editing.

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
