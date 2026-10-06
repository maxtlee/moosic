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
  currentId: null,
  shuffle: false,
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
  state.viewType = type;
  state.viewValue = value;
  if (type !== "playlist") state.playlist = null;
  apply();
}

function apply() {
  if (state.viewType === "admin") {
    $("#library-view").hidden = true;
    $("#admin-panel").hidden = false;
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.view === "admin"));
    loadQuota();
    return;
  }
  $("#library-view").hidden = false;
  $("#admin-panel").hidden = true;
  const q = state.query.trim().toLowerCase();
  let rows;
  if (state.viewType === "playlist") {
    rows = (state.playlist ? state.playlist.songs : []).slice();
  } else {
    rows = state.master.slice();
    if (state.viewType === "favorites") rows = rows.filter((s) => state.favorites.has(s.id));
    else if (state.viewType === "genre") rows = rows.filter((s) => s.genre === state.viewValue);
  }
  if (q) {
    rows = rows.filter((s) => `${s.title} ${s.artist} ${s.genre}`.toLowerCase().includes(q));
  }
  if (state.viewType !== "playlist") {
    const sorters = {
      title: (a, b) => a.title.localeCompare(b.title),
      artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
      genre: (a, b) => a.genre.localeCompare(b.genre) || a.artist.localeCompare(b.artist),
      duration: (a, b) => (a.duration || 0) - (b.duration || 0),
    };
    if (sorters[state.sort]) rows = rows.sort(sorters[state.sort]);
  }
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

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = s.duration ? fmtTime(s.duration) : "–";

    row.append(idx, title, genre, acts, time);
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

function play(id) {
  const song = songById(id);
  if (!song || song.missing) return;
  state.currentId = id;
  audio.src = BASE + "api/stream/" + encodeURIComponent(id);
  audio.play().catch(() => {});
  $("#now-title").textContent = song.title;
  $("#now-artist").textContent = song.artist + (song.genre ? " · " + song.genre : "");
  paintArtInto($("#now-art"), song);
  const link = $("#now-link");
  if (song.youtube_url) { link.href = song.youtube_url; link.hidden = false; } else link.hidden = true;
  const fav = $("#fav");
  fav.hidden = false;
  fav.textContent = state.favorites.has(song.id) ? "♥" : "♡";
  fav.classList.toggle("is-on", state.favorites.has(song.id));
  document.querySelectorAll(".track").forEach((r) =>
    r.classList.toggle("is-playing", r.dataset.id === id));
  localStorage.setItem("moosic.last", id);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title, artist: song.artist, album: song.genre,
    });
  }
}

function step(delta) {
  if (!state.filtered.length) return;
  if (state.shuffle && delta > 0) {
    const others = state.filtered.filter((s) => s.id !== state.currentId);
    if (others.length) play(others[Math.floor(Math.random() * others.length)].id);
    return;
  }
  let i = state.filtered.findIndex((s) => s.id === state.currentId);
  if (i === -1) i = 0;
  let next = i + delta;
  if (next >= state.filtered.length) {
    if (state.repeat === "off") { audio.pause(); return; }
    next = 0;
  }
  if (next < 0) next = state.filtered.length - 1;
  play(state.filtered[next].id);
}

/* --------------------------- playlist ops --------------------------- */
async function openPlaylist(slug) {
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

async function doSearch(e) {
  if (e) e.preventDefault();
  const q = $("#admin-q").value.trim();
  if (!q) return;
  const btn = $("#search-btn");
  btn.classList.add("busy");
  btn.textContent = "Searching…";
  const box = $("#search-results");
  box.innerHTML = '<p class="hint">Searching YouTube Music…</p>';
  try {
    const data = await api("/api/search?q=" + encodeURIComponent(q) + "&limit=8");
    adminState.candidates = data.candidates || [];
    renderResults();
  } catch (err) {
    box.innerHTML = "";
    toast(err.message, true);
  } finally {
    btn.classList.remove("busy");
    btn.textContent = "Search";
  }
}

function renderResults() {
  const box = $("#search-results");
  box.innerHTML = "";
  const cands = adminState.candidates;
  if (!cands.length) { box.innerHTML = '<p class="hint">No results.</p>'; return; }
  const q = state.quota;
  for (const c of cands) {
    const row = document.createElement("div");
    row.className = "result" + (c.is_best ? " best" : "");
    const main = document.createElement("div");
    main.className = "r-main";
    const t = document.createElement("span");
    t.className = "r-title";
    t.textContent = c.title;
    const sub = document.createElement("span");
    sub.className = "r-sub";
    sub.textContent = `${c.artist || "unknown"} · ${c.duration ? fmtTime(c.duration) : "—"} · ${c.kind}`;
    main.append(t, sub);
    const kind = document.createElement("span");
    kind.className = "badge" + (c.is_best ? " best" : "");
    kind.textContent = c.is_best ? "★ best" : c.kind;
    const score = document.createElement("span");
    score.className = "r-score";
    score.textContent = c.score;
    const add = document.createElement("button");
    add.className = "btn btn-primary add";
    add.textContent = "Add & download";
    if (q && q.remaining <= 0) add.disabled = true;
    add.onclick = () => addCandidate(c, add);
    const thumb = document.createElement("span");
    thumb.className = "thumb";
    if (c.thumbnail) {
      const img = document.createElement("img");
      img.src = c.thumbnail;
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.onerror = () => img.remove();
      thumb.appendChild(img);
    }
    row.append(thumb, main, kind, score, add);
    box.appendChild(row);
  }
}

async function addCandidate(c, btn) {
  if (btn) { btn.classList.add("busy"); btn.textContent = "Downloading…"; }
  try {
    const r = await api("/api/admin/add", {
      method: "POST",
      body: {
        title: c.title, artist: c.artist, genre: "Unsorted",
        youtube_url: c.url, youtube_kind: c.kind, youtube_title: c.title,
      },
    });
    toast(`Added “${r.song.title}” — ${r.download.downloaded ? "downloaded" : "download failed"}`);
    state.quota = r.quota;
    renderQuota();
    await reloadLibrary();
    refreshStatus();
    if (btn) { btn.textContent = r.download.downloaded ? "✓ Added" : "⚠ Retry"; btn.disabled = r.download.downloaded; }
    if (btn) btn.classList.remove("busy");
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

/* ------------------------------- loaders ---------------------------- */
async function reloadLibrary() {
  const data = await api("/api/library");
  state.master = data.songs;
  state.index = new Map(data.songs.map((s) => [s.id, s]));
  state.genres = data.genres || {};
  apply();
}

async function reloadPlaylists() {
  const data = await api("/api/playlists");
  state.playlists = data.playlists || [];
  renderPlaylists();
}

/* ------------------------------ controls ---------------------------- */
$("#play").onclick = () => {
  if (!state.currentId && state.filtered.length) return play(state.filtered[0].id);
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
};
$("#next").onclick = () => step(1);
$("#prev").onclick = () => { if (audio.currentTime > 3) audio.currentTime = 0; else step(-1); };
$("#shuffle").onclick = (e) => { state.shuffle = !state.shuffle; e.currentTarget.classList.toggle("is-on", state.shuffle); };
$("#repeat").onclick = (e) => {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  e.currentTarget.classList.toggle("is-on", state.repeat !== "off");
  e.currentTarget.title = "Repeat: " + state.repeat;
  audio.loop = state.repeat === "one";
};
$("#fav").onclick = () => {
  if (!state.currentId) return;
  state.favorites.has(state.currentId) ? state.favorites.delete(state.currentId) : state.favorites.add(state.currentId);
  localStorage.setItem("moosic.favorites", JSON.stringify([...state.favorites]));
  play(state.currentId);
  apply();
};
$("#new-playlist").onclick = newPlaylist;
$("#add-song").onclick = addSong;
$("#commit").onclick = doCommit;
$("#search-form").addEventListener("submit", doSearch);
$("#refresh-assets").onclick = doRefresh;

audio.addEventListener("play", () => { $("#play").textContent = "❚❚"; });
audio.addEventListener("pause", () => { $("#play").textContent = "▶"; });
audio.addEventListener("loadedmetadata", () => { $("#end-time").textContent = fmtTime(audio.duration); });
audio.addEventListener("timeupdate", () => {
  $("#cur-time").textContent = fmtTime(audio.currentTime);
  if (audio.duration) $("#seek").value = (audio.currentTime / audio.duration) * 1000;
});
audio.addEventListener("ended", () => { if (state.repeat !== "one") step(1); });
audio.addEventListener("error", () => { if (state.currentId) toast("Could not play that track", true); });

$("#seek").addEventListener("input", (e) => {
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
});
const vol = $("#volume");
vol.value = localStorage.getItem("moosic.volume") ?? "90";
audio.volume = vol.value / 100;
vol.addEventListener("input", () => {
  audio.volume = vol.value / 100;
  localStorage.setItem("moosic.volume", vol.value);
  $("#vol-icon").textContent = audio.volume === 0 ? "🔇" : "🔊";
});
$("#vol-icon").onclick = () => {
  audio.muted = !audio.muted;
  $("#vol-icon").textContent = audio.muted || audio.volume === 0 ? "🔇" : "🔊";
};

document.querySelectorAll(".nav-item").forEach((b) =>
  b.onclick = () => setView(b.dataset.view));

const search = $("#search");
search.addEventListener("input", () => { state.query = search.value; apply(); });
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; apply(); });

document.addEventListener("keydown", (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); search.focus(); return; }
  if (typing) return;
  if (e.code === "Space") { e.preventDefault(); $("#play").click(); }
  else if (e.key === "ArrowRight") audio.currentTime += 5;
  else if (e.key === "ArrowLeft") audio.currentTime -= 5;
  else if (e.key === "n") step(1);
  else if (e.key === "p") step(-1);
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
