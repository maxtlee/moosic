"use strict";

/* ------------------------------------------------------------------ *
 * Moosic web client — library, playlists, master edits, commit button.
 * ------------------------------------------------------------------ */

const BASE = new URL(".", location.href).pathname; // directory of the current URL, always ends with "/"
const $ = (sel) => document.querySelector(sel);

const audio = $("#audio");
const adminState = { candidates: [] };
const state = {
  master: [],              // slim songs from /api/library
  index: new Map(),        // id -> song
  genres: {},
  playlists: [],
  playlist: null,          // {slug,name,description,songs:[obj]}
  viewType: "all",         // all | favorites | genre | playlist
  viewValue: "",
  query: "",
  sort: "default",
  filtered: [],
  searchQuery: "",
  searchYt: [],
  searchAlbums: [],
  searchLoading: false,
  albums: [],
  album: null,
  queue: [],          // ordered play queue (song ids); current is queue[cursor]
  cursor: -1,         // index of the currently playing song
  context: [],        // ids of the view playback started from
  manualIds: new Set(),
  currentId: null,
  shuffle: "off",
  repeat: "off",
  favorites: new Set(JSON.parse(localStorage.getItem("moosic.favorites") || "[]")),
  status: null,
  commitTimer: null,
};

/* ----------------------------- helpers ----------------------------- */
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
};

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}
function paintArt(el, seed) {
  const h = hashHue(seed || "moosic");
  el.style.background = `linear-gradient(135deg, hsl(${h} 55% 42%), hsl(${(h + 70) % 360} 60% 30%))`;
}

const coverUrl = (song) => BASE + "api/cover/" + encodeURIComponent(song.id);

function artEl(song, cls) {
  const wrap = document.createElement("span");
  wrap.className = cls + " art";
  paintArt(wrap, (song.artist || "") + (song.title || ""));
  if (song.has_cover) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = coverUrl(song);
    img.onerror = () => { img.remove(); wrap.textContent = (song.title || "♪").trim().charAt(0).toUpperCase() || "♪"; };
    wrap.appendChild(img);
  } else {
    wrap.textContent = (song.title || "♪").trim().charAt(0).toUpperCase() || "♪";
  }
  return wrap;
}

function paintArtInto(el, song) {
  el.replaceChildren();
  paintArt(el, (song.artist || "") + (song.title || ""));
  if (song.has_cover) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = coverUrl(song);
    img.onerror = () => { img.remove(); el.textContent = (song.title || "♪").trim().charAt(0).toUpperCase() || "♪"; };
    el.appendChild(img);
  } else {
    el.textContent = (song.title || "♪").trim().charAt(0).toUpperCase() || "♪";
  }
}

function starWidget(song, small) {
  const el = document.createElement("span");
  el.className = "stars" + (small ? " sm" : "");
  el.dataset.rid = song.id;
  el._build = () => {
    el.replaceChildren();
    const val = Number(state.ratings[song.id]) || 0;
    for (let i = 1; i <= 5; i++) {
      const on = val >= i / 5 - 1e-9;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "star" + (on ? " on" : "");
      b.textContent = "★";
      b.title = on ? `${Math.round(i * 20)}% — click to clear` : `Rate ${Math.round(i * 20)}%`;
      b.onclick = (e) => { e.stopPropagation(); setRating(song.id, on ? 0 : i / 5); };
      el.appendChild(b);
    }
  };
  el._build();
  return el;
}

function refreshRatingWidgets(id) {
  document.querySelectorAll('.stars[data-rid="' + CSS.escape(id) + '"]')
    .forEach((el) => { if (el._build) el._build(); });
}

function rebuildPlayerRating() {
  const song = state.currentId ? songById(state.currentId) : null;
  document.querySelectorAll(".js-now-rating").forEach((box) => {
    box.replaceChildren();
    if (song && !song.missing) box.appendChild(starWidget(song, false));
  });
}

async function setRating(id, value) {
  const prev = state.ratings[id];
  state.ratings[id] = value;
  refreshRatingWidgets(id);
  if (state.currentId === id) rebuildPlayerRating();
  try {
    await api("/api/ratings/" + encodeURIComponent(id), { method: "PUT", body: { rating: value } });
    refreshStatus();
    if (state.sort === "rating") apply();
  } catch (e) {
    if (prev === undefined) delete state.ratings[id]; else state.ratings[id] = prev;
    refreshRatingWidgets(id);
    if (state.currentId === id) rebuildPlayerRating();
    toast(e.message, true);
  }
}

function renderHeroArt(songs) {
  const el = $("#hero-art");
  const picks = songs.slice(0, 4);
  el.classList.remove("mosaic");
  if (picks.length === 0) {
    el.replaceChildren();
    paintArt(el, "moosic");
    el.textContent = "♪";
    return;
  }
  if (picks.length === 1) { paintArtInto(el, picks[0]); return; }
  el.classList.add("mosaic");
  el.replaceChildren();
  for (const s of picks) {
    const cell = document.createElement("span");
    cell.className = "mosaic-cell";
    paintArt(cell, (s.artist || "") + (s.title || ""));
    if (s.has_cover) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = coverUrl(s);
      img.onerror = () => img.remove();
      cell.appendChild(img);
    }
    el.appendChild(cell);
  }
}

async function api(path, { method = "GET", body } = {}) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + String(path).replace(/^\/+/, ""), opt);
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.detail) || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.retry = res.headers.get("Retry-After");
    throw err;
  }
  return data;
}

function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ------------------------------ modal ------------------------------ */
function openModal({ title, fields = [], submit = "Save", danger = false, onSubmit }) {
  const root = $("#modal-root");
  root.hidden = false;
  root.innerHTML = "";
  const box = document.createElement("form");
  box.className = "modal";
  const h = document.createElement("h3");
  h.textContent = title;
  box.appendChild(h);

  const inputs = {};
  for (const f of fields) {
    const label = document.createElement("label");
    label.textContent = f.label;
    let input;
    if (f.type === "select") {
      input = document.createElement("select");
      for (const o of f.options || []) {
        const op = document.createElement("option");
        op.value = o.value;
        op.textContent = o.label;
        input.appendChild(op);
      }
    } else if (f.type === "textarea") {
      input = document.createElement("textarea");
    } else {
      input = document.createElement("input");
      input.type = f.type || "text";
    }
    if (f.value !== undefined) input.value = f.value;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.required) input.required = true;
    label.appendChild(input);
    box.appendChild(label);
    inputs[f.name] = input;
  }
  if (danger) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = danger === true ? "This cannot be undone from the UI (git history can roll it back)." : danger;
    box.appendChild(p);
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.className = "btn " + (danger ? "btn-danger" : "btn-primary");
  ok.textContent = submit;
  actions.append(cancel, ok);
  box.appendChild(actions);
  root.appendChild(box);

  const close = () => { root.hidden = true; root.innerHTML = ""; };
  cancel.onclick = close;
  root.onclick = (e) => { if (e.target === root) close(); };
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });
  box.onsubmit = async (e) => {
    e.preventDefault();
    const values = {};
    for (const [k, el] of Object.entries(inputs)) values[k] = el.value;
    try { await onSubmit(values); close(); }
    catch (err) { toast(err.message, true); }
  };
  (Object.values(inputs)[0] || ok).focus();
}

function confirmModal(title, message, submit = "Delete") {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    root.hidden = false;
    root.innerHTML = "";
    const box = document.createElement("form");
    box.className = "modal";
    const h = document.createElement("h3");
    h.textContent = title;
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = message;
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "btn btn-danger";
    ok.textContent = submit;
    actions.append(cancel, ok);
    box.append(h, p, actions);
    root.appendChild(box);
    const done = (val) => { root.hidden = true; root.innerHTML = ""; resolve(val); };
    cancel.onclick = () => done(false);
    box.onsubmit = (e) => { e.preventDefault(); done(true); };
    root.onclick = (e) => { if (e.target === root) done(false); };
    ok.focus();
  });
}

/* ------------------------------ rendering ---------------------------- */
function renderGenres() {
  const list = $("#genre-list");
  list.innerHTML = "";
  for (const [genre, count] of Object.entries(state.genres)) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.dataset.genre = genre;
    if (state.viewType === "genre" && state.viewValue === genre) btn.classList.add("is-active");
    const name = document.createElement("span");
    name.textContent = genre;
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = count;
    btn.append(name, c);
    btn.onclick = () => {
      if (state.viewType === "genre" && state.viewValue === genre) setView("all");
      else { state.viewType = "genre"; state.viewValue = genre; apply(); }
    };
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function miniBtn(text, title, handler) {
  const b = document.createElement("button");
  b.className = "mini-btn";
  b.textContent = text;
  b.title = title;
  b.onclick = (e) => { e.stopPropagation(); handler(); };
  return b;
}

function renderPlaylists() {
  const ul = $("#playlist-list");
  ul.innerHTML = "";
  for (const pl of state.playlists) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.className = "pl-open";
    if (state.viewType === "playlist" && state.viewValue === pl.slug) open.classList.add("is-active");
    const nm = document.createElement("span");
    nm.className = "pl-name";
    nm.textContent = pl.name;
    const ct = document.createElement("span");
    ct.className = "count";
    ct.textContent = pl.count;
    open.append(nm, ct);
    open.onclick = () => openPlaylist(pl.slug);

    const acts = document.createElement("span");
    acts.className = "pl-actions";
    acts.append(
      miniBtn("✎", "Rename", () => editPlaylist(pl)),
      miniBtn("🗑", "Delete", () => deletePlaylist(pl)),
    );
    li.append(open, acts);
    ul.appendChild(li);
  }
}

function setView(type, value = "") {
  closeDrawer();
  state.viewType = type;
  state.viewValue = value;
  if (type !== "playlist") state.playlist = null;
  apply();
}

function apply() {
  if (state.viewType === "admin") {
    $("#library-view").hidden = true;
    $("#search-view").hidden = true;
    $("#albums-view").hidden = true;
    $("#queue-view").hidden = true;
    $("#admin-panel").hidden = false;
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.view === "admin"));
    loadQuota();
    return;
  }
  if (state.viewType === "search") {
    $("#library-view").hidden = true;
    $("#admin-panel").hidden = true;
    $("#albums-view").hidden = true;
    $("#queue-view").hidden = true;
    $("#search-view").hidden = false;
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
    renderSearchPage();
    return;
  }
  if (state.viewType === "albums") {
    $("#library-view").hidden = true;
    $("#admin-panel").hidden = true;
    $("#search-view").hidden = true;
    $("#queue-view").hidden = true;
    $("#albums-view").hidden = false;
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.view === "albums"));
    reloadAlbums().then(renderAlbums);
    return;
  }
  if (state.viewType === "queue") {
    $("#library-view").hidden = true;
    $("#admin-panel").hidden = true;
    $("#search-view").hidden = true;
    $("#albums-view").hidden = true;
    $("#queue-view").hidden = false;
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.view === "queue"));
    renderQueue();
    return;
  }
  $("#library-view").hidden = false;
  $("#admin-panel").hidden = true;
  $("#search-view").hidden = true;
  $("#albums-view").hidden = true;
  $("#queue-view").hidden = true;
  const q = state.query.trim().toLowerCase();
  let rows;
  if (state.viewType === "playlist") {
    rows = (state.playlist ? state.playlist.songs : []).slice();
  } else {
    rows = state.master.slice();
    if (state.viewType === "favorites") rows = rows.filter((s) => state.favorites.has(s.id));
    else if (state.viewType === "genre") rows = rows.filter((s) => s.genre === state.viewValue);
    else if (state.viewType === "album" && state.album) {
      rows = rows.filter((s) => (s.album || "") === state.album.album
        && (s.artist || "") === state.album.artist);
    }
  }
  if (q) {
    rows = rows.filter((s) => `${s.title} ${s.artist} ${s.genre}`.toLowerCase().includes(q));
  }
  const sorters = {
    rating: (a, b) => (state.ratings[b.id] || 0) - (state.ratings[a.id] || 0),
    title: (a, b) => a.title.localeCompare(b.title),
    artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
    genre: (a, b) => a.genre.localeCompare(b.genre) || a.artist.localeCompare(b.artist),
    duration: (a, b) => (a.duration || 0) - (b.duration || 0),
  };
  // "default" keeps playlist order; every other sort applies in every view.
  if (state.sort !== "default" && sorters[state.sort]) rows = rows.sort(sorters[state.sort]);
  state.filtered = rows;
  renderRows();
  renderHero();
  renderGenres();
  renderPlaylists();

  $("#view-count").textContent = `${rows.length} track${rows.length === 1 ? "" : "s"}`;
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("is-active",
      (b.dataset.view === "all" && state.viewType === "all") ||
      (b.dataset.view === "favorites" && state.viewType === "favorites")));
  $("#empty").hidden = rows.length !== 0;
}

function renderHero() {
  let title, meta, actions = [];
  if (state.viewType === "playlist" && state.playlist) {
    title = state.playlist.name;
    meta = `${state.playlist.songs.length} tracks` + (state.playlist.description ? ` · ${state.playlist.description}` : "");
    actions = [
      ["▶ Play all", () => { if (state.filtered[0]) play(state.filtered[0].id); }],
      ["✎ Rename", () => editPlaylist(state.playlist)],
      ["🗑 Delete", () => deletePlaylist(state.playlist)],
    ];
  } else if (state.viewType === "favorites") { title = "Favorites"; meta = `${state.filtered.length} tracks`; }
  else if (state.viewType === "genre") { title = state.viewValue; meta = `${state.filtered.length} tracks`; }
  else if (state.viewType === "album" && state.album) {
    title = state.album.album;
    meta = `${state.album.artist} · ${state.filtered.length} tracks`;
    actions = [
      ["▶ Play all", () => { if (state.filtered[0]) play(state.filtered[0].id); }],
      ["＋ Playlist", () => albumToPlaylist()],
      ["⬇ Download missing", () => downloadAlbum()],
    ];
  }
  else { title = "All songs"; meta = `${state.master.length} tracks · ${Object.keys(state.genres).length} genres`; }

  $("#hero-title").textContent = title;
  $("#hero-meta").textContent = meta;
  const heroSongs = state.viewType === "playlist" && state.playlist
    ? state.playlist.songs : state.filtered;
  renderHeroArt(heroSongs);
  const box = $("#hero-actions");
  box.innerHTML = "";
  for (const [label, fn] of actions) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = label;
    b.onclick = fn;
    box.appendChild(b);
  }
}

function renderRows() {
  const root = $("#track-rows");
  const frag = document.createDocumentFragment();
  state.filtered.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "track";
    row.dataset.id = s.id;
    row.tabIndex = 0;
    if (s.id === state.currentId) row.classList.add("is-playing");
    if (s.missing) row.classList.add("missing");

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = i + 1;

    const title = document.createElement("span");
    title.className = "track-title";
    title.appendChild(artEl(s, "row-art"));
    const text = document.createElement("span");
    text.className = "track-text";
    const strong = document.createElement("strong");
    strong.textContent = s.missing ? "⚠ missing from master" : s.title;
    const artist = document.createElement("span");
    artist.textContent = (s.artist || "") + (s.has_asset === false ? " · ⏳ not downloaded" : "");
    text.append(strong, artist);
    title.appendChild(text);

    const genre = document.createElement("span");
    genre.className = "genre";
    genre.textContent = s.genre || "";

    const rating = document.createElement("span");
    rating.className = "rating";
    if (!s.missing) rating.appendChild(starWidget(s, true));

    const acts = document.createElement("span");
    acts.className = "acts";
    if (state.viewType === "playlist") {
      acts.append(
        miniBtn("↑", "Move up", () => moveInPlaylist(s.id, -1)),
        miniBtn("↓", "Move down", () => moveInPlaylist(s.id, 1)),
        miniBtn("✕", "Remove from playlist", () => removeFromPlaylist(s.id)),
      );
    } else if (!s.missing) {
      acts.append(
        miniBtn("＋", "Add to playlist", () => addToPlaylist(s)),
        miniBtn("✎", "Edit", () => editSong(s)),
        miniBtn("🗑", "Delete", () => deleteSong(s)),
      );
    }
    if (!s.missing) {
      const kebab = document.createElement("button");
      kebab.className = "mini-btn kebab";
      kebab.textContent = "⋮";
      kebab.title = "More actions";
      kebab.onclick = (e) => { e.stopPropagation(); openActionSheet(s); };
      acts.appendChild(kebab);
    }

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = s.duration ? fmtTime(s.duration) : "–";

    row.append(idx, title, genre, rating, acts, time);
    const activate = (e) => {
      if (e.target.closest("button")) return;
      play(s.id);
    };
    row.onclick = activate;
    row.onkeydown = (e) => { if (e.key === "Enter") activate(e); };
    frag.appendChild(row);
  });
  root.replaceChildren(frag);
}

/* ------------------------------ playback ---------------------------- */
function songById(id) { return state.index.get(id) || (state.playlist && state.playlist.songs.find((s) => s.id === id)); }

function syncPlayIcon() {
  const icon = audio.paused ? "▶" : "❚❚";
  document.querySelectorAll(".js-play").forEach((el) => { el.textContent = icon; });
}

function syncTimes() {
  document.querySelectorAll(".js-cur").forEach((el) => { el.textContent = fmtTime(audio.currentTime); });
  document.querySelectorAll(".js-end").forEach((el) => { el.textContent = fmtTime(audio.duration); });
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0;
  document.querySelectorAll(".js-seek").forEach((el) => { if (!el._dragging) el.value = pct; });
}

function syncVolume() {
  document.querySelectorAll(".js-vol").forEach((el) => { el.value = audio.volume * 100; });
  const icon = (audio.muted || audio.volume === 0) ? "🔇" : "🔊";
  document.querySelectorAll(".js-vol-icon").forEach((el) => { el.textContent = icon; });
}

function syncNow(song) {
  document.querySelectorAll(".js-now-title").forEach((el) => {
    el.textContent = song ? song.title : "Nothing playing";
  });
  document.querySelectorAll(".js-now-artist").forEach((el) => {
    el.textContent = song ? (song.artist + (song.genre ? " · " + song.genre : "")) : "Pick a track to begin";
  });
  document.querySelectorAll(".js-now-art").forEach((el) => { if (song) paintArtInto(el, song); });
  document.querySelectorAll(".js-now-link").forEach((el) => {
    if (song && song.youtube_url) { el.href = song.youtube_url; el.hidden = false; } else el.hidden = true;
  });
  const isFav = song ? state.favorites.has(song.id) : false;
  document.querySelectorAll(".js-fav").forEach((el) => {
    el.hidden = !song;
    el.textContent = isFav ? "♥" : "♡";
    el.classList.toggle("is-on", isFav);
  });
  rebuildPlayerRating();
}

function startAudio(id) {
  const song = songById(id);
  if (!song || song.missing) return;
  state.currentId = id;
  audio.src = BASE + "api/stream/" + encodeURIComponent(id);
  audio.play().catch(() => {});
  syncNow(song);
  document.querySelectorAll(".track").forEach((r) =>
    r.classList.toggle("is-playing", r.dataset.id === id));
  localStorage.setItem("moosic.last", id);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title, artist: song.artist, album: song.album || song.genre || "",
    });
  }
  if (state.viewType === "queue") renderQueue();
}

function shuffleArray(ids) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Rating-weighted random order (Efraimidis–Spirakis). Unrated songs are
// neutral (0.5) and weight = 0.4 + rating, so even a 0-rated song stays ~1/3
// as likely as a 5-star one — a deliberately generous randomness band.
function weightOf(id) {
  const r = state.ratings[id];
  const v = (r === undefined || r === null) ? 0.5 : r;
  return 0.4 + v;
}
function smartOrder(ids) {
  return ids
    .map((id) => ({ id, key: Math.pow(Math.random(), 1 / weightOf(id)) }))
    .sort((a, b) => b.key - a.key)
    .map((o) => o.id);
}

function buildOrder(ctx, startId) {
  const rest = ctx.filter((x) => x !== startId);
  if (state.shuffle === "smart") return [startId, ...smartOrder(rest)];
  if (state.shuffle === "on") return [startId, ...shuffleArray(rest)];
  return ctx.slice();
}

// Re-order the not-yet-played tail for the current shuffle mode, keeping the
// current track and manual queue additions where they are.
function rebuildTail() {
  if (!state.queue.length) return;
  const played = new Set(state.queue.slice(0, state.cursor + 1));
  const tail = state.queue.slice(state.cursor + 1);
  const manual = tail.filter((id) => state.manualIds.has(id));
  const rest = state.context.filter((id) => !played.has(id) && !state.manualIds.has(id));
  const ordered = state.shuffle === "smart" ? smartOrder(rest)
    : state.shuffle === "on" ? shuffleArray(rest) : rest;
  state.queue = state.queue.slice(0, state.cursor + 1).concat(manual, ordered);
}

// Play `id` now. If it is already queued, just move the cursor; otherwise start
// a fresh queue from `contextIds` (the current view by default).
function play(id, contextIds) {
  const song = songById(id);
  if (!song || song.missing) return;
  if (state.queue.includes(id)) {
    state.cursor = state.queue.indexOf(id);
    startAudio(id);
    return;
  }
  const ctx = (contextIds && contextIds.length)
    ? contextIds.slice()
    : (state.filtered.length ? state.filtered.map((s) => s.id) : [id]);
  state.context = ctx;
  state.manualIds = new Set();
  state.queue = buildOrder(ctx, id);
  state.cursor = state.queue.indexOf(id);
  startAudio(id);
}

function nextTrack() {
  if (!state.queue.length) return;
  if (state.cursor + 1 < state.queue.length) {
    state.cursor += 1;
    startAudio(state.queue[state.cursor]);
    return;
  }
  if (state.repeat === "all") {
    state.cursor = 0;
    startAudio(state.queue[0]);
    return;
  }
  audio.pause();
}

function prevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (!state.queue.length) return;
  if (state.cursor > 0) {
    state.cursor -= 1;
    startAudio(state.queue[state.cursor]);
    return;
  }
  if (state.repeat === "all") {
    state.cursor = state.queue.length - 1;
    startAudio(state.queue[state.cursor]);
    return;
  }
  audio.currentTime = 0;
}

function enqueue(id, asNext) {
  if (!songById(id)) return;
  if (state.queue.includes(id)) {
    const i = state.queue.indexOf(id);
    state.queue.splice(i, 1);
    if (i < state.cursor) state.cursor -= 1;
  }
  if (state.cursor < 0) {
    play(id, state.filtered.length ? state.filtered.map((s) => s.id) : [id]);
    return;
  }
  if (asNext) state.queue.splice(state.cursor + 1, 0, id);
  else state.queue.push(id);
  state.manualIds.add(id);
  toast(asNext ? "Playing next" : "Added to queue");
  if (state.viewType === "queue") renderQueue();
}

function removeFromQueue(index) {
  if (index < 0 || index >= state.queue.length) return;
  const wasCurrent = index === state.cursor;
  state.queue.splice(index, 1);
  if (index < state.cursor) state.cursor -= 1;
  if (wasCurrent) {
    if (state.cursor >= state.queue.length) state.cursor = state.queue.length - 1;
    if (state.cursor >= 0) startAudio(state.queue[state.cursor]);
    else audio.pause();
  }
  renderQueue();
}

function clearQueue() {
  if (state.currentId && state.queue.includes(state.currentId)) {
    state.queue = [state.currentId];
    state.cursor = 0;
  } else {
    state.queue = [];
    state.cursor = -1;
  }
  state.manualIds = new Set();
  renderQueue();
  toast("Queue cleared");
}

function renderQueue() {
  const list = $("#queue-list");
  if (!list) return;
  list.replaceChildren();
  const played = Math.max(0, state.cursor + 1);
  $("#queue-sub").textContent = state.queue.length
    ? `${played} played · ${state.queue.length - played} up next`
    : "Nothing queued.";
  if (!state.queue.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Play something, or use “Play next” / “Add to queue” on a song.";
    list.appendChild(p);
    return;
  }
  const startView = Math.max(0, state.cursor - 3);
  const endView = Math.min(state.queue.length, startView + 120);
  for (let idx = startView; idx < endView; idx++) {
    const id = state.queue[idx];
    const s = songById(id);
    if (!s) continue;
    const row = document.createElement("div");
    row.className = "queue-item" + (idx === state.cursor ? " current" : "")
      + (idx < state.cursor ? " played" : "");
    row.appendChild(artEl(s, "q-art"));
    const main = document.createElement("div");
    main.className = "q-main";
    const t = document.createElement("strong"); t.textContent = s.title;
    const a = document.createElement("span"); a.className = "muted"; a.textContent = s.artist || "";
    main.append(t, a);
    row.appendChild(main);
    if (idx === state.cursor) {
      const b = document.createElement("span"); b.className = "badge best"; b.textContent = "Now playing";
      row.appendChild(b);
    }
    const rm = document.createElement("button");
    rm.className = "mini-btn";
    rm.textContent = "✕";
    rm.title = "Remove from queue";
    rm.onclick = (e) => { e.stopPropagation(); removeFromQueue(idx); };
    row.appendChild(rm);
    row.onclick = () => play(id);
    list.appendChild(row);
  }
  if (endView < state.queue.length) {
    const more = document.createElement("p");
    more.className = "hint";
    more.textContent = `… ${state.queue.length - endView} more`;
    list.appendChild(more);
  }
  const curEl = list.querySelector(".queue-item.current");
  if (curEl) curEl.scrollIntoView({ block: "nearest" });
}

/* --------------------------- playlist ops --------------------------- */
async function openPlaylist(slug) {
  closeDrawer();
  try {
    state.playlist = await api("/api/playlists/" + encodeURIComponent(slug));
    state.viewType = "playlist";
    state.viewValue = slug;
    state.query = "";
    $("#search").value = "";
    state.sort = "default";
    $("#sort").value = "default";
    apply();
  } catch (e) { toast(e.message, true); }
}

function newPlaylist() {
  openModal({
    title: "New playlist",
    fields: [
      { name: "name", label: "Name", required: true, placeholder: "Late night K-pop" },
      { name: "description", label: "Description", type: "textarea" },
    ],
    submit: "Create",
    onSubmit: async (v) => {
      const r = await api("/api/playlists", { method: "POST", body: v });
      await reloadPlaylists();
      toast(`Created “${v.name}”`);
      await openPlaylist(r.slug);
    },
  });
}

function editPlaylist(pl) {
  openModal({
    title: "Edit playlist",
    fields: [
      { name: "name", label: "Name", value: pl.name, required: true },
      { name: "description", label: "Description", type: "textarea", value: pl.description || "" },
    ],
    submit: "Save",
    onSubmit: async (v) => {
      const r = await api("/api/playlists/" + encodeURIComponent(pl.slug), { method: "PATCH", body: v });
      await reloadPlaylists();
      if (state.viewType === "playlist") await openPlaylist(r.slug);
      toast("Playlist updated");
    },
  });
}

async function deletePlaylist(pl) {
  if (!(await confirmModal("Delete playlist", `Delete “${pl.name}”?`, "Delete"))) return;
  try {
    await api("/api/playlists/" + encodeURIComponent(pl.slug), { method: "DELETE" });
    if (state.viewType === "playlist") setView("all");
    await reloadPlaylists();
    toast(`Deleted “${pl.name}”`);
    refreshStatus();
  } catch (e) { toast(e.message, true); }
}

async function addToPlaylist(song) {
  if (!state.playlists.length) {
    toast("No playlists yet — create one first", true);
    newPlaylist();
    return;
  }
  openModal({
    title: `Add “${song.title}” to…`,
    fields: [{
      name: "slug", label: "Playlist", type: "select",
      options: state.playlists.map((p) => ({ value: p.slug, label: `${p.name} (${p.count})` })),
    }],
    submit: "Add",
    onSubmit: async (v) => {
      const pl = await api("/api/playlists/" + encodeURIComponent(v.slug));
      const ids = pl.songs.map((s) => s.id);
      if (ids.includes(song.id)) { toast("Already in that playlist"); return; }
      ids.push(song.id);
      await api("/api/playlists/" + encodeURIComponent(v.slug), { method: "PATCH", body: { songs: ids } });
      await reloadPlaylists();
      if (state.viewType === "playlist" && state.viewValue === v.slug) await openPlaylist(v.slug);
      toast(`Added to “${pl.name}”`);
      refreshStatus();
    },
  });
}

async function patchCurrentPlaylist(ids) {
  const pl = state.playlist;
  await api("/api/playlists/" + encodeURIComponent(pl.slug), { method: "PATCH", body: { songs: ids } });
  await openPlaylist(pl.slug);
  await reloadPlaylists();
  refreshStatus();
}

async function moveInPlaylist(id, delta) {
  const ids = state.playlist.songs.map((s) => s.id);
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try { await patchCurrentPlaylist(ids); } catch (e) { toast(e.message, true); }
}

async function removeFromPlaylist(id) {
  const ids = state.playlist.songs.map((s) => s.id).filter((x) => x !== id);
  try { await patchCurrentPlaylist(ids); toast("Removed"); } catch (e) { toast(e.message, true); }
}

/* ----------------------------- master ops --------------------------- */
function addSong() {
  openModal({
    title: "Add song to master list",
    fields: [
      { name: "title", label: "Title", required: true },
      { name: "artist", label: "Artist" },
      { name: "genre", label: "Genre", value: "Unsorted" },
      { name: "youtube_url", label: "YouTube URL (optional)", type: "url", placeholder: "https://www.youtube.com/watch?v=..." },
    ],
    submit: "Add",
    onSubmit: async (v) => {
      const r = await api("/api/songs", { method: "POST", body: v });
      await reloadLibrary();
      toast(`Added “${r.title}” (run a refresh to download it)`);
      refreshStatus();
    },
  });
}

function editSong(song) {
  openModal({
    title: "Edit song",
    fields: [
      { name: "title", label: "Title", value: song.title, required: true },
      { name: "artist", label: "Artist", value: song.artist },
      { name: "genre", label: "Genre", value: song.genre },
      { name: "youtube_url", label: "YouTube URL", value: song.youtube_url || "" },
    ],
    submit: "Save",
    onSubmit: async (v) => {
      await api("/api/songs/" + encodeURIComponent(song.id), { method: "PATCH", body: v });
      await reloadLibrary();
      await reloadPlaylists();
      if (state.viewType === "playlist") await openPlaylist(state.viewValue);
      toast("Song updated");
      refreshStatus();
    },
  });
}

async function deleteSong(song) {
  if (!(await confirmModal("Delete song", `Remove “${song.title}” from the master list and all playlists?`, "Delete"))) return;
  try {
    await api("/api/songs/" + encodeURIComponent(song.id), { method: "DELETE" });
    await reloadLibrary();
    await reloadPlaylists();
    if (state.viewType === "playlist") await openPlaylist(state.viewValue);
    toast("Song removed");
    refreshStatus();
  } catch (e) { toast(e.message, true); }
}

/* ------------------------------- commit ----------------------------- */
async function refreshStatus() {
  try { state.status = await api("/api/status"); } catch (_) { return; }
  state.commitUntil = Date.now() + Math.max(0, (state.status.commit_cooldown || 0)) * 1000;
  tickCommit();
  if (state.commitTimer) clearInterval(state.commitTimer);
  state.commitTimer = setInterval(tickCommit, 1000);
}

function tickCommit() {
  const s = state.status || {};
  const remaining = Math.max(0, Math.ceil(((state.commitUntil || 0) - Date.now()) / 1000));
  const dirty = s.dirty || 0;
  const btn = $("#commit");
  const label = $("#commit-label");
  if (remaining > 0) {
    btn.disabled = true;
    btn.classList.add("cooling");
    btn.classList.remove("ready");
    label.textContent = `Commit (${remaining}s)`;
  } else {
    btn.disabled = false;
    btn.classList.remove("cooling");
    btn.classList.toggle("ready", dirty > 0);
    label.textContent = dirty > 0 ? `Commit ${dirty}` : "Commit";
  }
  const badge = $("#dirty-badge");
  if (dirty > 0) {
    badge.hidden = false;
    badge.textContent = `● ${dirty} uncommitted change${dirty > 1 ? "s" : ""}`;
  } else badge.hidden = true;
}

async function doCommit() {
  try {
    const r = await api("/api/commit", { method: "POST", body: { message: "" } });
    if (!r.committed) toast(r.detail === "nothing to commit" ? "Nothing to commit" : r.detail, true);
    else toast(`Committed ${r.sha}${r.pushed ? " & pushed" : " (push failed)"}`, !r.pushed);
  } catch (e) {
    toast(e.status === 429 ? `Slow down — ${e.message}` : e.message, true);
  }
  refreshStatus();
}

/* ------------------------------- admin ------------------------------ */
function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

async function loadQuota() {
  try { state.quota = await api("/api/admin/quota"); renderQuota(); } catch (_) { /* ignore */ }
}

function renderQuota() {
  const q = state.quota;
  if (!q) return;
  const pct = q.limit ? (q.used / q.limit) * 100 : 0;
  const fill = $("#quota-fill");
  fill.style.width = pct + "%";
  fill.classList.toggle("low", q.remaining > 0 && q.remaining <= 5);
  fill.classList.toggle("out", q.remaining <= 0);
  const reset = q.remaining <= 0 ? ` · resets in ${fmtClock(q.reset_in)}` : "";
  $("#quota-text").textContent =
    `Downloads: ${q.used} / ${q.limit} used in the last ${Math.round(q.window / 60)} min${reset}`;
  document.querySelectorAll(".result .btn.add").forEach((b) => { b.disabled = q.remaining <= 0; });
}

/* --------------------- search (library + YouTube) -------------------- */
function normText(s) {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}
function songKey(s) {
  return normText(s.artist).split(" feat")[0].trim() + "|" + normText(s.title);
}
function fuzzyScore(q, song) {
  const nq = normText(q);
  if (!nq) return 0;
  const title = normText(song.title);
  const artist = normText(song.artist);
  const album = normText(song.album);
  const hay = `${title} ${artist} ${album}`;
  let score = 0;
  if (title === nq) score += 100;
  if (title.startsWith(nq)) score += 60;
  if (title.includes(nq)) score += 40;
  if (artist.includes(nq)) score += 25;
  if (album && album.includes(nq)) score += 15;
  for (const tok of nq.split(/\s+/).filter(Boolean)) if (hay.includes(tok)) score += 6;
  return score;
}
function localMatches(q, limit = 8) {
  if (!q.trim()) return [];
  const seen = new Set();
  return state.master
    .map((s) => ({ s, score: fuzzyScore(q, s) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((r) => { const k = songKey(r.s); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit)
    .map((r) => r.s);
}

function resultRow({ song, yt, onPlay, action }) {
  const row = document.createElement("div");
  row.className = "result";
  const thumb = document.createElement("span");
  thumb.className = "thumb";
  if (yt && yt.thumbnail) {
    const img = document.createElement("img");
    img.src = yt.thumbnail; img.alt = ""; img.loading = "lazy";
    img.referrerPolicy = "no-referrer"; img.onerror = () => img.remove();
    thumb.appendChild(img);
  } else if (song) {
    thumb.classList.add("thumb-art-wrap");
    thumb.appendChild(artEl(song, "thumb-art"));
  }
  const main = document.createElement("div");
  main.className = "r-main";
  const t = document.createElement("span");
  t.className = "r-title";
  t.textContent = (yt || song).title;
  const sub = document.createElement("span");
  sub.className = "r-sub";
  const bits = [];
  const art = (yt || song).artist;
  if (art) bits.push(art);
  const alb = yt ? yt.album : (song && song.album);
  if (alb) bits.push(alb);
  const dur = yt ? yt.duration : (song && song.duration);
  if (dur) bits.push(fmtTime(dur));
  if (yt && yt.kind) bits.push(yt.kind);
  if (!yt && song && song.video_id) bits.push("yt:" + song.video_id);
  sub.textContent = bits.join(" · ");
  main.append(t, sub);
  row.append(thumb, main);
  if (action) row.appendChild(action);
  if (onPlay) {
    row.style.cursor = "pointer";
    row.onclick = (e) => { if (!e.target.closest("button, a")) onPlay(); };
  }
  return row;
}

function renderSearchDropdown() {
  const q = $("#search").value.trim();
  const drop = $("#search-drop");
  if (!q) { drop.hidden = true; drop.replaceChildren(); return; }
  const local = localMatches(q, 6);
  drop.replaceChildren();
  const head = document.createElement("div");
  head.className = "drop-head";
  head.textContent = local.length ? "In your library" : "No library matches";
  drop.appendChild(head);
  for (const s of local) {
    const item = document.createElement("button");
    item.className = "drop-item";
    item.appendChild(artEl(s, "drop-art"));
    const info = document.createElement("span");
    info.className = "drop-info";
    const t = document.createElement("strong"); t.textContent = s.title;
    const a = document.createElement("span"); a.className = "muted";
    a.textContent = s.artist + (s.album ? " · " + s.album : "");
    info.append(t, a);
    item.appendChild(info);
    item.onclick = () => { closeSearchDropdown(); play(s.id); };
    drop.appendChild(item);
  }
  const ytBtn = document.createElement("button");
  ytBtn.className = "drop-item drop-yt";
  ytBtn.textContent = `Search YouTube Music for “${q}” →`;
  ytBtn.onclick = () => { closeSearchDropdown(); openSearch(q); };
  drop.appendChild(ytBtn);
  drop.hidden = false;
}
function closeSearchDropdown() {
  const d = $("#search-drop");
  d.hidden = true;
  d.replaceChildren();
}

async function openSearch(q) {
  q = (q || "").trim();
  if (!q) return;
  closeDrawer();
  closeSearchDropdown();
  state.searchQuery = q;
  state.searchYt = [];
  state.searchLoading = true;
  $("#search").value = q;
  setView("search", q);
  try {
    const [sd, ad] = await Promise.allSettled([
      api("/api/search?q=" + encodeURIComponent(q) + "&limit=12"),
      api("/api/album-search?q=" + encodeURIComponent(q) + "&limit=6"),
    ]);
    state.searchYt = sd.status === "fulfilled" ? (sd.value.results || []) : [];
    state.searchAlbums = ad.status === "fulfilled" ? (ad.value.albums || []) : [];
  } catch (e) {
    toast(e.message, true);
    state.searchYt = [];
    state.searchAlbums = [];
  }
  state.searchLoading = false;
  apply();
}

function renderSearchPage() {
  const q = state.searchQuery || "";
  $("#search-title").textContent = `Results for “${q}”`;
  const local = localMatches(q, 40);
  $("#search-sub").textContent = state.searchLoading
    ? "Searching YouTube Music…"
    : `${local.length} in your library · ${(state.searchYt || []).length} on YouTube Music`;

  const lbox = $("#search-local");
  lbox.replaceChildren();
  $("#local-count").textContent = local.length ? `(${local.length})` : "";
  if (!local.length) {
    const p = document.createElement("p"); p.className = "hint";
    p.textContent = "No library matches."; lbox.appendChild(p);
  }
  for (const s of local) {
    const actions = document.createElement("span");
    actions.className = "row-actions";
    if (s.youtube_url) {
      const ytLink = document.createElement("a");
      ytLink.className = "icon-btn";
      ytLink.href = s.youtube_url;
      ytLink.target = "_blank";
      ytLink.rel = "noopener";
      ytLink.title = `Current match: ${s.video_id || ""}`;
      ytLink.textContent = "↗";
      ytLink.onclick = (e) => e.stopPropagation();
      actions.appendChild(ytLink);
    }
    const fix = document.createElement("button");
    fix.className = "btn";
    fix.textContent = "Fix match";
    fix.onclick = (e) => { e.stopPropagation(); replaceMatch(s); };
    actions.appendChild(fix);
    const addBtn = document.createElement("button");
    addBtn.className = "btn";
    addBtn.textContent = "＋ Playlist";
    addBtn.onclick = (e) => { e.stopPropagation(); addToPlaylist(s); };
    actions.appendChild(addBtn);
    lbox.appendChild(resultRow({ song: s, onPlay: () => play(s.id), action: actions }));
  }

  const ybox = $("#search-yt");
  ybox.replaceChildren();
  const yt = state.searchYt || [];
  $("#yt-count").textContent = yt.length ? `(${yt.length})` : "";
  if (state.searchLoading) {
    const p = document.createElement("p"); p.className = "hint";
    p.textContent = "Searching…"; ybox.appendChild(p);
  } else if (!yt.length) {
    const p = document.createElement("p"); p.className = "hint";
    p.textContent = "No results."; ybox.appendChild(p);
  }
  for (const e of yt) {
    let action;
    if (e.in_library) {
      action = document.createElement("span");
      action.className = "badge best";
      action.textContent = "In library";
    } else {
      action = document.createElement("button");
      action.className = "btn btn-primary add";
      action.textContent = "Add & download";
      if (state.quota && state.quota.remaining <= 0) action.disabled = true;
      action.onclick = () => addFromYt(e, action);
    }
    ybox.appendChild(resultRow({ yt: e, action }));
  }

  const abox = $("#search-albums");
  abox.replaceChildren();
  const albs = state.searchAlbums || [];
  $("#albums-block").hidden = !albs.length;
  $("#album-count").textContent = albs.length ? `(${albs.length})` : "";
  for (const a of albs) {
    let action;
    if (a.in_library) {
      action = document.createElement("span");
      action.className = "badge best";
      action.textContent = "In library";
    } else {
      action = document.createElement("button");
      action.className = "btn";
      action.textContent = "Add album";
      if (state.quota && state.quota.remaining <= 0) action.disabled = true;
      action.onclick = () => addAlbum(a, action);
    }
    abox.appendChild(resultRow({
      yt: { title: a.title, artist: a.artist, album: a.year, thumbnail: a.thumbnail, kind: "album" },
      action,
    }));
  }
}

async function replaceMatch(song) {
  if (!song || !song.id) return;
  if (!window.confirm(`Mark the current YouTube match for “${song.title}” as wrong and download the next-best match?`)) return;
  toast("Looking for a better match…");
  try {
    const r = await api("/api/songs/" + encodeURIComponent(song.id) + "/replace-match", { method: "POST" });
    state.quota = r.quota;
    renderQuota();
    await reloadLibrary();
    apply();
    if (state.currentId === song.id) {
      const s2 = songById(song.id);
      if (s2) syncNow(s2);
    }
    toast(`Replaced → ${r.match.title} (${r.download.downloaded ? "downloaded" : "download failed"})`);
    refreshStatus();
  } catch (e) {
    toast(e.message, true);
    loadQuota();
  }
}

async function addFromYt(e, btn) {
  if (btn) { btn.classList.add("busy"); btn.textContent = "Downloading…"; }
  try {
    const r = await api("/api/admin/add", {
      method: "POST",
      body: {
        title: e.title, artist: e.artist, genre: "Unsorted",
        youtube_url: e.url, youtube_kind: e.kind, youtube_title: e.title,
        album: e.album || "",
      },
    });
    toast(`Added “${r.song.title}” — ${r.download.downloaded ? "downloaded" : "download failed"}`);
    state.quota = r.quota;
    renderQuota();
    e.in_library = true;
    await reloadLibrary();
    apply();
    refreshStatus();
  } catch (err) {
    toast(err.message, true);
    if (btn) { btn.classList.remove("busy"); btn.textContent = "Add & download"; }
    loadQuota();
  }
}

async function doRefresh() {
  const btn = $("#refresh-assets");
  const log = $("#admin-log");
  btn.classList.add("busy");
  btn.textContent = "Refreshing…";
  log.hidden = false;
  log.textContent = "Working…";
  try {
    const r = await api("/api/admin/refresh", { method: "POST" });
    const s = r.summary;
    toast(`Refresh: ${s.downloaded} downloaded · ${s.moved} renamed · ${s.trashed} trashed`);
    log.textContent = (r.log || "").trim() || "done";
    state.quota = r.quota;
    renderQuota();
    await reloadLibrary();
    refreshStatus();
  } catch (err) {
    toast(err.message, true);
    log.textContent = err.message;
  } finally {
    btn.classList.remove("busy");
    btn.textContent = "Refresh assets now";
  }
}

/* ------------------------------- albums ----------------------------- */
async function reloadAlbums() {
  try {
    const d = await api("/api/albums");
    state.albums = d.albums || [];
  } catch (_) {
    state.albums = [];
  }
}

function renderAlbums() {
  const grid = $("#album-grid");
  grid.replaceChildren();
  $("#albums-sub").textContent = `${state.albums.length} albums`;
  if (!state.albums.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No albums detected yet. Add songs from search, then run album detection.";
    grid.appendChild(p);
    return;
  }
  for (const a of state.albums) {
    const card = document.createElement("button");
    card.className = "album-card";
    const art = document.createElement("span");
    art.className = "album-art";
    paintArt(art, a.album + a.artist);
    if (a.cover_id) {
      const img = document.createElement("img");
      img.src = BASE + "api/cover/" + encodeURIComponent(a.cover_id);
      img.alt = ""; img.loading = "lazy";
      img.onerror = () => img.remove();
      art.appendChild(img);
    }
    const nm = document.createElement("strong");
    nm.textContent = a.album;
    const sub = document.createElement("span");
    sub.className = "muted";
    sub.textContent = `${a.artist} · ${a.count}`;
    card.append(art, nm, sub);
    card.onclick = () => openAlbum(a.key);
    grid.appendChild(card);
  }
}

function openAlbum(key) {
  const a = state.albums.find((x) => x.key === key);
  if (!a) return;
  state.album = a;
  setView("album", key);
}

async function albumToPlaylist() {
  if (!state.album) return;
  const ids = state.filtered.map((s) => s.id);
  if (!ids.length) return;
  const name = state.album.artist ? `${state.album.album} — ${state.album.artist}` : state.album.album;
  try {
    const r = await api("/api/playlists", { method: "POST", body: { name, description: "Album" } });
    await api("/api/playlists/" + encodeURIComponent(r.slug), { method: "PATCH", body: { songs: ids } });
    await reloadPlaylists();
    toast(`Created playlist “${name}”`);
    refreshStatus();
  } catch (e) { toast(e.message, true); }
}

async function downloadAlbum() {
  if (!state.album) return;
  try {
    const r = await api("/api/albums/download", {
      method: "POST",
      body: { album: state.album.album, artist: state.album.artist },
    });
    state.quota = r.quota; renderQuota();
    toast(`Album download: ${r.summary.downloaded} new`);
    await reloadLibrary();
    apply();
    refreshStatus();
  } catch (e) { toast(e.message, true); }
}

async function addAlbum(a, btn) {
  if (btn) { btn.classList.add("busy"); btn.textContent = "Adding…"; }
  try {
    const r = await api("/api/admin/add-album", { method: "POST", body: { browse_id: a.browse_id } });
    state.quota = r.quota; renderQuota();
    toast(`Added album “${r.album.title}” — ${r.added} tracks (${r.download.downloaded} downloaded)`);
    a.in_library = true;
    await reloadLibrary();
    await reloadAlbums();
    apply();
    refreshStatus();
  } catch (err) {
    toast(err.message, true);
    if (btn) { btn.classList.remove("busy"); btn.textContent = "Add album"; }
    loadQuota();
  }
}
async function reloadLibrary() {
  const data = await api("/api/library");
  state.master = data.songs;
  state.index = new Map(data.songs.map((s) => [s.id, s]));
  state.genres = data.genres || {};
  state.ratings = {};
  for (const s of data.songs) {
    if (s.rating !== null && s.rating !== undefined) state.ratings[s.id] = s.rating;
  }
  apply();
}

async function reloadPlaylists() {
  const data = await api("/api/playlists");
  state.playlists = data.playlists || [];
  renderPlaylists();
}

/* ------------------------------ controls ---------------------------- */
function togglePlay() {
  if (!state.currentId && state.filtered.length) { play(state.filtered[0].id); return; }
  if (!state.currentId) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function toggleShuffle() {
  state.shuffle = state.shuffle === "off" ? "on"
    : state.shuffle === "on" ? "smart" : "off";
  document.querySelectorAll(".js-shuffle").forEach((el) => {
    el.classList.toggle("is-on", state.shuffle !== "off");
    el.classList.toggle("smart", state.shuffle === "smart");
    el.textContent = state.shuffle === "smart" ? "✨" : "⤨";
    el.title = state.shuffle === "smart" ? "Smart shuffle (rating-weighted)"
      : state.shuffle === "on" ? "Shuffle" : "Shuffle off";
  });
  if (state.queue.length) rebuildTail();
  toast(state.shuffle === "smart" ? "Smart shuffle on"
    : state.shuffle === "on" ? "Shuffle on" : "Shuffle off");
}
function toggleRepeat() {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  document.querySelectorAll(".js-repeat").forEach((el) => {
    el.classList.toggle("is-on", state.repeat !== "off");
    el.title = "Repeat: " + state.repeat;
  });
  audio.loop = state.repeat === "one";
}
function toggleFav() {
  if (!state.currentId) return;
  state.favorites.has(state.currentId) ? state.favorites.delete(state.currentId) : state.favorites.add(state.currentId);
  localStorage.setItem("moosic.favorites", JSON.stringify([...state.favorites]));
  play(state.currentId);
  apply();
}

document.querySelectorAll(".js-play").forEach((el) => { el.onclick = togglePlay; });
document.querySelectorAll(".js-next").forEach((el) => { el.onclick = nextTrack; });
document.querySelectorAll(".js-prev").forEach((el) => { el.onclick = prevTrack; });
document.querySelectorAll(".js-shuffle").forEach((el) => { el.onclick = toggleShuffle; });
document.querySelectorAll(".js-repeat").forEach((el) => { el.onclick = toggleRepeat; });
document.querySelectorAll(".js-fav").forEach((el) => { el.onclick = toggleFav; });

$("#new-playlist").onclick = newPlaylist;
$("#queue-clear").onclick = clearQueue;
$("#add-song").onclick = addSong;
$("#commit").onclick = doCommit;
$("#refresh-assets").onclick = doRefresh;

audio.addEventListener("play", syncPlayIcon);
audio.addEventListener("pause", syncPlayIcon);
audio.addEventListener("loadedmetadata", syncTimes);
audio.addEventListener("timeupdate", syncTimes);
audio.addEventListener("ended", () => { if (state.repeat !== "one") nextTrack(); });
audio.addEventListener("error", () => { if (state.currentId) toast("Could not play that track", true); });

document.querySelectorAll(".js-seek").forEach((el) => {
  el.addEventListener("input", () => {
    el._dragging = true;
    if (audio.duration) audio.currentTime = (el.value / 1000) * audio.duration;
  });
  el.addEventListener("change", () => { el._dragging = false; });
});

const savedVol = localStorage.getItem("moosic.volume") ?? "90";
audio.volume = savedVol / 100;
document.querySelectorAll(".js-vol").forEach((el) => {
  el.value = savedVol;
  el.addEventListener("input", () => {
    audio.volume = el.value / 100;
    localStorage.setItem("moosic.volume", el.value);
    syncVolume();
  });
});
document.querySelectorAll(".js-vol-icon").forEach((el) => {
  el.onclick = () => { audio.muted = !audio.muted; syncVolume(); };
});
syncVolume();

/* ---------------------- mobile: drawer + sheets --------------------- */
const drawer = document.querySelector(".sidebar");
const drawerOverlay = $("#drawer-overlay");
function openDrawer() { drawer.classList.add("open"); drawerOverlay.hidden = false; }
function closeDrawer() { drawer.classList.remove("open"); drawerOverlay.hidden = true; }
$("#menu-btn").onclick = () => (drawer.classList.contains("open") ? closeDrawer() : openDrawer());
drawerOverlay.onclick = closeDrawer;

const nowSheet = $("#now-sheet");
function openNowSheet() { if (state.currentId) nowSheet.hidden = false; }
function closeNowSheet() { nowSheet.hidden = true; }
$("#expand").onclick = openNowSheet;
$("#ns-close").onclick = closeNowSheet;
$("#ns-fix").onclick = () => {
  const s = state.currentId ? songById(state.currentId) : null;
  if (s) replaceMatch(s);
};
$("#now-open").onclick = (e) => {
  if (e.target.closest("button, a, input")) return;
  if (window.matchMedia("(max-width: 820px)").matches) openNowSheet();
};

function closeActionSheet() { $("#sheet-root").hidden = true; $("#sheet-panel").replaceChildren(); }
function openActionSheet(song) {
  const panel = $("#sheet-panel");
  panel.replaceChildren();
  const head = document.createElement("div");
  head.className = "sheet-head";
  head.append(artEl(song, "sheet-thumb"));
  const info = document.createElement("div");
  info.className = "sheet-head-info";
  const t = document.createElement("strong"); t.textContent = song.title;
  const a = document.createElement("span"); a.className = "muted"; a.textContent = song.artist || "";
  info.append(t, a);
  head.append(info);
  panel.appendChild(head);
  const add = (label, danger, fn) => {
    const b = document.createElement("button");
    b.className = "sheet-item" + (danger ? " danger" : "");
    b.textContent = label;
    b.onclick = async () => { closeActionSheet(); await fn(); };
    panel.appendChild(b);
  };
  add("Play next", false, () => enqueue(song.id, true));
  add("Add to queue", false, () => enqueue(song.id, false));
  if (state.viewType === "playlist") {
    add("Move up", false, () => moveInPlaylist(song.id, -1));
    add("Move down", false, () => moveInPlaylist(song.id, 1));
    add("Remove from playlist", true, () => removeFromPlaylist(song.id));
  } else {
    add("Play", false, () => play(song.id));
    add("Add to playlist", false, () => addToPlaylist(song));
    add("Edit details", false, () => editSong(song));
    add("Wrong match — replace", false, () => replaceMatch(song));
    add("Delete from library", true, () => deleteSong(song));
  }
  const cancel = document.createElement("button");
  cancel.className = "sheet-item cancel";
  cancel.textContent = "Cancel";
  cancel.onclick = closeActionSheet;
  panel.appendChild(cancel);
  $("#sheet-root").hidden = false;
}
$("#sheet-backdrop").onclick = closeActionSheet;

document.querySelectorAll(".nav-item").forEach((b) =>
  b.onclick = () => { closeDrawer(); setView(b.dataset.view); });

const search = $("#search");
search.addEventListener("input", () => {
  state.query = search.value;
  if (state.viewType !== "search") apply();
  renderSearchDropdown();
});
search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); openSearch(search.value); }
  else if (e.key === "Escape") closeSearchDropdown();
});
search.addEventListener("blur", () => setTimeout(closeSearchDropdown, 180));
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) closeSearchDropdown();
});
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; apply(); });

document.addEventListener("keydown", (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); search.focus(); return; }
  if (typing) return;
  if (e.code === "Space") { e.preventDefault(); $("#play").click(); }
  else if (e.key === "ArrowRight") audio.currentTime += 5;
  else if (e.key === "ArrowLeft") audio.currentTime -= 5;
  else if (e.key === "n") nextTrack();
  else if (e.key === "p") prevTrack();
});

/* ------------------------------- boot ------------------------------- */
(async function boot() {
  try {
    await reloadLibrary();
    await reloadPlaylists();
  } catch (e) { toast("Failed to load library: " + e.message, true); }
  const last = localStorage.getItem("moosic.last");
  if (last && state.index.has(last)) play(last);
  refreshStatus();
  setInterval(refreshStatus, 15000);
})();
