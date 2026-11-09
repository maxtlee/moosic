"use strict";

/* ------------------------------------------------------------------ *
 * Moosic web client — library, playlists, master edits, commit button.
 * ------------------------------------------------------------------ */

const BASE = new URL(".", location.href).pathname; // directory of the current URL, always ends with "/"
const $ = (sel) => document.querySelector(sel);

const audio = $("#audio");
const HISTORY_LIMIT = 200; // how many recently played entries to keep

const state = {
  master: [],              // slim songs from /api/library
  index: new Map(),        // id -> song
  genres: {},
  playlists: [],
  playlist: null,          // {slug,name,description,songs:[obj]}
  viewType: "all",         // all | history | albums | suggestions | queue | search | playlist | album | admin
  viewValue: "",
  suggestions: [],
  suggestionsLoaded: false,
  suggestionsLoading: false,
  query: "",
  sort: "rating",
  // Genre selection starts with every option selected (and new genres join it
  // automatically). "invert" applies boolean NOT to that selection. Rating is an
  // inclusive 0–5★ range; unrated songs count as 0★.
  filters: {
    genres: new Set(),
    genresKnown: new Set(),
    invert: false,
    ratingMin: 0,
    ratingMax: 5,
  },
  filtered: [],
  searchQuery: "",
  searchYt: [],
  searchAlbums: [],
  searchLoading: false,
  albums: [],
  album: null,
  offline: new Set(JSON.parse(localStorage.getItem("moosic.offline") || "[]")),
  // Playback is split into an explicit queue (user-added, played first) and an
  // autoplay order built from the view playback started from.
  queue: [],          // explicit queue (ids): front = "play next", back = "add to queue"
  auto: [],           // autoplay order (ids) for the current context
  autoPos: -1,        // index in auto of the current autoplay track
  currentSource: "auto", // "auto" | "explicit"
  context: [],        // ids of the view autoplay was built from
  history: loadPlayHistory(), // [{id, source, autoPos}], most recent first
  currentId: null,
  shuffle: "off",
  repeat: "off",
  stopAfter: false,
  status: null,
  commitTimer: null,
};

function loadPlayHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem("moosic.history") || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e) => e && typeof e.id === "string")
      .map((e) => ({
        id: e.id,
        source: e.source === "explicit" ? "explicit" : "auto",
        autoPos: Number.isInteger(e.autoPos) ? e.autoPos : -1,
      }))
      .slice(0, HISTORY_LIMIT);
  } catch (_) {
    return [];
  }
}
function savePlayHistory() {
  try {
    localStorage.setItem("moosic.history", JSON.stringify(state.history.slice(0, HISTORY_LIMIT)));
  } catch (_) { /* storage full / disabled */ }
}

/* ----------------------------- helpers ----------------------------- */
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
};

// Play from lists on double-click on mouse/trackpad devices to avoid accidental
// playback; touch devices keep single-tap (double-tap is unreliable on mobile).
const DOUBLE_CLICK_TO_PLAY = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
function bindPlayGesture(el, handler) {
  if (DOUBLE_CLICK_TO_PLAY) el.ondblclick = handler;
  else el.onclick = handler;
}

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
      const exact = Math.abs(val - i / 5) < 1e-6; // this star is the current rating
      const b = document.createElement("button");
      b.type = "button";
      b.className = "star" + (on ? " on" : "");
      b.textContent = "★";
      b.title = exact ? `${Math.round(i * 20)}% — click to clear` : `Rate ${Math.round(i * 20)}%`;
      // Clicking the star that matches the current rating clears it; clicking any
      // other star sets that value (including lowering a rating).
      b.onclick = (e) => { e.stopPropagation(); setRating(song.id, exact ? 0 : i / 5); };
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
    // Smart shuffle should react immediately to a new rating.
    if (state.shuffle === "smart") {
      rebuildAuto();
      if (queuePanelOpen()) renderQueue();
    }
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

const FILTER_RATING_MAX = 5; // star scale (ratings are stored as 0..1)

function genreNames() {
  return Object.keys(state.genres).sort((a, b) => a.localeCompare(b));
}

// Keep the selected set in sync with the library: a genre seen for the first
// time defaults to selected; genres that disappear are dropped.
function syncGenreSelection() {
  const f = state.filters;
  const names = genreNames();
  const present = new Set(names);
  for (const name of names) {
    if (!f.genresKnown.has(name)) {
      f.genresKnown.add(name);
      f.genres.add(name);
    }
  }
  for (const name of [...f.genresKnown]) {
    if (!present.has(name)) { f.genresKnown.delete(name); f.genres.delete(name); }
  }
  return names;
}

function allGenresSelected(names) {
  return names.every((name) => state.filters.genres.has(name));
}

function filtersActive() {
  const f = state.filters;
  return f.invert
    || f.ratingMin > 0
    || f.ratingMax < FILTER_RATING_MAX
    || !allGenresSelected(genreNames());
}

function filterSummary() {
  const f = state.filters;
  const names = genreNames();
  const selected = names.filter((name) => f.genres.has(name)).length;
  const genres = f.invert
    ? `NOT ${selected}/${names.length} genres`
    : `${selected}/${names.length} genres`;
  const rating = f.ratingMin === f.ratingMax
    ? `${f.ratingMin}★`
    : `${f.ratingMin}★–${f.ratingMax}★`;
  return `${genres} · ${rating}`;
}

function updateRatingFill() {
  const fill = $("#rating-fill");
  if (!fill) return;
  const lo = (state.filters.ratingMin / FILTER_RATING_MAX) * 100;
  const hi = (state.filters.ratingMax / FILTER_RATING_MAX) * 100;
  fill.style.left = `${lo}%`;
  fill.style.width = `${Math.max(0, hi - lo)}%`;
}

function renderFilters() {
  const names = syncGenreSelection();
  const box = $("#filter-genre-list");
  if (!box) return;
  box.replaceChildren();
  if (!names.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "No genres yet.";
    box.appendChild(empty);
  }
  for (const name of names) {
    const on = state.filters.genres.has(name);
    const label = document.createElement("label");
    label.className = "genre-check" + (on ? " is-on" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.onchange = () => {
      if (cb.checked) state.filters.genres.add(name);
      else state.filters.genres.delete(name);
      apply();
    };
    const text = document.createElement("span");
    text.textContent = name;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = state.genres[name];
    label.append(cb, text, count);
    box.appendChild(label);
  }
  syncFilterUI();
}

function syncFilterUI() {
  const f = state.filters;
  const min = $("#filter-rating-min");
  const max = $("#filter-rating-max");
  if (min) min.value = String(f.ratingMin);
  if (max) max.value = String(f.ratingMax);
  updateRatingFill();
  const label = $("#filter-rating-label");
  if (label) {
    label.textContent = f.ratingMin === f.ratingMax
      ? `${f.ratingMin}★` : `${f.ratingMin}★ – ${f.ratingMax}★`;
  }
  const invert = $("#filter-invert");
  if (invert) {
    invert.classList.toggle("is-on", f.invert);
    invert.setAttribute("aria-pressed", String(f.invert));
    invert.textContent = f.invert ? "Inverted" : "Invert";
  }
  const summary = $("#filter-summary");
  if (summary) summary.textContent = filterSummary();
  const toggle = $("#filter-toggle");
  if (toggle) toggle.classList.toggle("is-active", filtersActive());
}

function clearFilters() {
  const names = genreNames();
  state.filters.genres = new Set(names);
  state.filters.genresKnown = new Set(names);
  state.filters.invert = false;
  state.filters.ratingMin = 0;
  state.filters.ratingMax = FILTER_RATING_MAX;
  apply();
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

/* --------------------------- suggestions --------------------------- */
const SUGGESTION_CLIENT_KEY = "moosic.client";
const SUGGESTION_AUTHOR_KEY = "moosic.author";

function suggestionClientId() {
  let id = "";
  try { id = localStorage.getItem(SUGGESTION_CLIENT_KEY) || ""; } catch (_) { /* ignore */ }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    const raw = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    id = String(raw).replace(/-/g, "").slice(0, 32);
    try { localStorage.setItem(SUGGESTION_CLIENT_KEY, id); } catch (_) { /* ignore */ }
  }
  return id;
}

function suggestionAuthor() {
  try { return localStorage.getItem(SUGGESTION_AUTHOR_KEY) || ""; } catch (_) { return ""; }
}

function rememberSuggestionAuthor(value) {
  try { localStorage.setItem(SUGGESTION_AUTHOR_KEY, value || ""); } catch (_) { /* ignore */ }
}

function suggestionWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], {
    month: "short", day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function suggestionReplyCount(node) {
  return (node.replies || []).reduce((n, r) => n + 1 + suggestionReplyCount(r), 0);
}

function renderSuggestionNode(node, depth = 0) {
  const card = document.createElement("article");
  card.className = "suggestion-card s-node" + (node.done ? " done" : "")
    + (depth ? " reply" : "");

  /* vote rail (Reddit-style) */
  const vote = document.createElement("div");
  vote.className = "s-vote";
  const up = document.createElement("button");
  up.type = "button";
  up.className = "s-vote-btn" + (node.my_vote === 1 ? " on up" : "");
  up.textContent = "▲";
  up.title = `${node.likes} like${node.likes === 1 ? "" : "s"}`;
  up.setAttribute("aria-label", "Like");
  up.onclick = () => voteSuggestion(node, node.my_vote === 1 ? 0 : 1);
  const score = document.createElement("span");
  score.className = "s-score";
  score.textContent = String(node.likes - node.dislikes);
  score.title = `${node.likes} like${node.likes === 1 ? "" : "s"} · `
    + `${node.dislikes} dislike${node.dislikes === 1 ? "" : "s"}`;
  const down = document.createElement("button");
  down.type = "button";
  down.className = "s-vote-btn" + (node.my_vote === -1 ? " on down" : "");
  down.textContent = "▼";
  down.title = `${node.dislikes} dislike${node.dislikes === 1 ? "" : "s"}`;
  down.setAttribute("aria-label", "Dislike");
  down.onclick = () => voteSuggestion(node, node.my_vote === -1 ? 0 : -1);
  vote.append(up, score, down);

  const main = document.createElement("div");
  main.className = "s-main";

  const top = document.createElement("div");
  top.className = "s-top";
  const badge = document.createElement("span");
  if (depth === 0) {
    const isBug = node.kind === "bug";
    badge.className = "s-badge " + (isBug ? "s-badge-bug" : "s-badge-suggestion");
    badge.textContent = isBug ? "Bug" : "Suggestion";
  } else {
    badge.className = "s-badge s-badge-reply";
    badge.textContent = "Reply";
  }
  const author = document.createElement("span");
  author.className = "s-author-name";
  author.textContent = node.author || "anonymous";
  const when = document.createElement("span");
  when.className = "s-when";
  when.textContent = suggestionWhen(node.created);
  top.append(badge, author, when);
  if (node.done) {
    const done = document.createElement("span");
    done.className = "s-done-tag";
    done.textContent = "finished";
    top.append(done);
  }

  const text = document.createElement("p");
  text.className = "s-text";
  text.textContent = node.text;

  const actions = document.createElement("div");
  actions.className = "s-actions";
  const replyBtn = document.createElement("button");
  replyBtn.type = "button";
  replyBtn.className = "s-link-btn";
  replyBtn.textContent = "Reply";
  replyBtn.onclick = () => {
    const existing = card.querySelector(".s-reply-form");
    if (existing) { existing.remove(); return; }
    card.appendChild(suggestionReplyForm(node, depth));
  };
  actions.appendChild(replyBtn);
  const nReplies = suggestionReplyCount(node);
  if (nReplies) {
    const count = document.createElement("span");
    count.className = "s-reply-count";
    count.textContent = `${nReplies} repl${nReplies === 1 ? "y" : "ies"}`;
    actions.appendChild(count);
  }
  if (depth === 0) {
    const finish = document.createElement("button");
    finish.type = "button";
    finish.className = "s-link-btn" + (node.done ? " reopen" : "");
    finish.textContent = node.done ? "Reopen thread" : "Mark finished";
    finish.onclick = () => toggleSuggestionDone(node);
    actions.appendChild(finish);
  }

  main.append(top, text, actions);

  if (node.replies && node.replies.length) {
    const replies = document.createElement("div");
    replies.className = "s-replies";
    for (const child of node.replies) replies.appendChild(renderSuggestionNode(child, depth + 1));
    main.appendChild(replies);
  }

  card.append(vote, main);
  return card;
}

function suggestionReplyForm(parent, depth) {
  const form = document.createElement("form");
  form.className = "s-reply-form";
  const textarea = document.createElement("textarea");
  textarea.rows = 2;
  textarea.maxLength = 600;
  textarea.required = true;
  textarea.placeholder = "Reply to this " + (depth ? "reply" : "thread") + "…";
  const row = document.createElement("div");
  row.className = "s-reply-row";
  const author = document.createElement("input");
  author.type = "text";
  author.maxLength = 60;
  author.placeholder = "your name (optional)";
  author.value = suggestionAuthor();
  author.autocomplete = "nickname";
  const send = document.createElement("button");
  send.type = "submit";
  send.className = "btn btn-primary";
  send.textContent = "Reply";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  cancel.onclick = () => form.remove();
  row.append(author, cancel, send);
  form.append(textarea, row);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    send.disabled = true;
    send.textContent = "Posting…";
    try {
      await api("/api/suggestions", {
        method: "POST",
        body: { text, author: author.value, parent_id: parent.id },
      });
      rememberSuggestionAuthor(author.value.trim());
      await reloadSuggestions();
      toast(parent.done ? "Reply posted — thread reopened" : "Reply posted");
      refreshStatus();
    } catch (err) {
      send.disabled = false;
      send.textContent = "Reply";
      toast(err.message, true);
    }
  };
  return form;
}

async function voteSuggestion(node, value) {
  try {
    const r = await api("/api/suggestions/" + encodeURIComponent(node.id) + "/vote", {
      method: "POST",
      body: { value, client_id: suggestionClientId() },
    });
    node.likes = r.likes;
    node.dislikes = r.dislikes;
    node.my_vote = r.my_vote;
    renderSuggestions();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderSuggestions() {
  const list = $("#suggestion-list");
  if (!state.suggestionsLoaded) {
    $("#suggestions-count").textContent = "Loading…";
    $("#suggestions-empty").hidden = true;
    list.replaceChildren();
    return;
  }
  const items = state.suggestions || [];
  const open = items.filter((s) => !s.done).length;
  const replies = items.reduce((n, s) => n + suggestionReplyCount(s), 0);
  $("#suggestions-count").textContent = items.length
    ? `${open} open · ${items.length - open} done · ${replies} repl${replies === 1 ? "y" : "ies"}`
    : "";
  $("#suggestions-empty").hidden = items.length !== 0;
  list.replaceChildren();
  for (const item of items) list.appendChild(renderSuggestionNode(item));
}

async function reloadSuggestions() {
  if (state.suggestionsLoading) return;
  state.suggestionsLoading = true;
  try {
    const data = await api("/api/suggestions?client_id="
      + encodeURIComponent(suggestionClientId()));
    state.suggestions = data.suggestions || [];
    state.suggestionsLoaded = true;
    renderSuggestions();
  } catch (e) {
    state.suggestionsLoaded = true;
    renderSuggestions();
    toast("Failed to load suggestions: " + e.message, true);
  } finally {
    state.suggestionsLoading = false;
  }
}

async function toggleSuggestionDone(node) {
  const done = !node.done;
  try {
    await api("/api/suggestions/" + encodeURIComponent(node.id),
              { method: "PATCH", body: { done } });
    await reloadSuggestions();
    refreshStatus();
    toast(done ? "Thread marked finished" : "Thread reopened");
  } catch (e) {
    toast(e.message, true);
  }
}

/* ----------------------------- play history ------------------------ */
// Unique ids in play order, used as the autoplay context when starting from a
// history row. The page itself keeps every play (including repeats), so this
// only dedupes the context — not what is shown.
function historyContextIds(entries) {
  const ids = [];
  const seen = new Set();
  for (const h of entries) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    ids.push(h.id);
  }
  return ids;
}

function renderHistory() {
  const list = $("#history-list");
  if (!list) return;
  list.replaceChildren();
  // Keep one row per play so playing a song twice shows twice (the old code
  // deduped by id and silently dropped the earlier play).
  const entries = state.history.filter((h) => songById(h.id));
  const contextIds = historyContextIds(entries);
  $("#history-sub").textContent = entries.length
    ? `${entries.length} play${entries.length === 1 ? "" : "s"} · newest first`
    : "Nothing played yet.";
  $("#history-empty").hidden = entries.length !== 0;
  $("#history-clear").disabled = entries.length === 0;
  for (const entry of entries) {
    const song = songById(entry.id);
    const actions = document.createElement("span");
    actions.className = "row-actions";
    const q = document.createElement("button");
    q.className = "btn";
    q.textContent = "＋ Queue";
    q.onclick = (e) => { e.stopPropagation(); enqueue(entry.id, false); };
    actions.appendChild(q);
    list.appendChild(resultRow({
      song,
      onPlay: () => play(entry.id, contextIds),
      action: actions,
    }));
  }
}

function clearHistory() {
  state.history = [];
  savePlayHistory();
  renderHistory();
  toast("History cleared");
}

function setView(type, value = "") {
  closeDrawer();
  state.viewType = type;
  state.viewValue = value;
  if (type !== "playlist") state.playlist = null;
  if (type === "suggestions") state.suggestionsLoaded = false;
  apply();
}

// Every top-level page. Each view switch must hide all of the others; doing this
// in one place prevents pages from stacking on top of each other (previously
// History -> Bugs left both visible, and History -> All songs did too).
const VIEW_IDS = [
  "library-view", "search-view", "albums-view", "suggestions-view",
  "history-view", "admin-panel",
];
function showView(id) {
  for (const viewId of VIEW_IDS) {
    const el = document.getElementById(viewId);
    if (el) el.hidden = viewId !== id;
  }
}

function applyInner() {
  if (state.viewType === "admin") {
    showView("admin-panel");
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.view === "admin"));
    loadQuota();
    return;
  }
  if (state.viewType === "search") {
    showView("search-view");
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
    renderSearchPage();
    return;
  }
  if (state.viewType === "history") {
    showView("history-view");
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.view === "history"));
    renderHistory();
    return;
  }
  if (state.viewType === "albums") {
    showView("albums-view");
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.view === "albums"));
    reloadAlbums().then(renderAlbums);
    return;
  }
  if (state.viewType === "suggestions") {
    showView("suggestions-view");
    renderGenres();
    renderPlaylists();
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.view === "suggestions"));
    renderSuggestions();
    if (!state.suggestionsLoaded) reloadSuggestions();
    return;
  }
  showView("library-view");
  // Library views default to rating order; playlists/albums keep their own order.
  if (state.sort === "default" && state.viewType !== "playlist" && state.viewType !== "album") {
    state.sort = "rating";
    $("#sort").value = "rating";
  }
  renderFilters();
  const q = state.query.trim().toLowerCase();
  let rows;
  if (state.viewType === "playlist") {
    rows = (state.playlist ? state.playlist.songs : []).slice();
  } else {
    rows = state.master.slice();
    if (state.viewType === "genre") rows = rows.filter((s) => s.genre === state.viewValue);
    else if (state.viewType === "album" && state.album) {
      rows = rows.filter((s) => (s.album || "") === state.album.album
        && (s.artist || "") === state.album.artist);
    }
  }
  if (q) {
    rows = rows.filter((s) => `${s.title} ${s.artist} ${s.genre}`.toLowerCase().includes(q));
  }
  const f = state.filters;
  rows = rows.filter((s) => {
    // Selection is an allow-list; "invert" turns it into a deny-list.
    const genre = s.genre || "Unsorted";
    if (f.genres.has(genre) === f.invert) return false;
    // Inclusive star range; unrated songs count as 0★.
    const stars = (state.ratings[s.id] || 0) * FILTER_RATING_MAX;
    if (stars < f.ratingMin - 1e-9 || stars > f.ratingMax + 1e-9) return false;
    return true;
  });
  const sorters = {
    rating: (a, b) => (state.ratings[b.id] || 0) - (state.ratings[a.id] || 0),
    title: (a, b) => a.title.localeCompare(b.title),
    artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
    genre: (a, b) => a.genre.localeCompare(b.genre) || a.artist.localeCompare(b.artist),
    duration: (a, b) => (a.duration || 0) - (b.duration || 0),
  };
  // "default" keeps playlist/album intrinsic order; any other sort applies.
  const sortKey = state.sort === "default" ? null : state.sort;
  if (sortKey && sorters[sortKey]) rows = rows.sort(sorters[sortKey]);
  state.filtered = rows;
  renderRows();
  renderHero();
  renderGenres();
  renderPlaylists();

  $("#view-count").textContent = `${rows.length} track${rows.length === 1 ? "" : "s"}`;
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("is-active",
      (b.dataset.view === "all" && state.viewType === "all")));
  $("#empty").hidden = rows.length !== 0;
}

function apply() {
  applyInner();
  syncQueueNav();
}

function renderHero() {
  let title, meta, extra = [];
  if (state.viewType === "playlist" && state.playlist) {
    title = state.playlist.name;
    const total = state.playlist.songs.length;
    meta = `${state.filtered.length} of ${total} track${total === 1 ? "" : "s"}`
      + (state.playlist.description ? ` · ${state.playlist.description}` : "");
    extra = [
      ["＋ Add songs", () => openAddSongsPicker(state.playlist)],
      ["💾 Save offline", () => saveOfflineList(state.filtered)],
      ["⬇ Export for Apple Music", () => exportScope("playlist", state.playlist.slug)],
      ["✎ Rename", () => editPlaylist(state.playlist)],
      ["🗑 Delete", () => deletePlaylist(state.playlist)],
    ];
  } else if (state.viewType === "genre") {
    title = state.viewValue;
    meta = `${state.filtered.length} track${state.filtered.length === 1 ? "" : "s"}`;
  } else if (state.viewType === "album" && state.album) {
    title = state.album.album;
    meta = `${state.album.artist} · ${state.filtered.length} track${state.filtered.length === 1 ? "" : "s"}`;
    extra = [
      ["＋ Playlist", () => albumToPlaylist()],
      ["💾 Save offline", () => saveOfflineList(state.filtered)],
      ["⬇ Export for Apple Music", () => exportScope("album", state.album.key)],
      ["⬇ Download missing", () => downloadAlbum()],
    ];
  } else {
    title = "All songs";
    meta = `${state.filtered.length} of ${state.master.length} tracks`
      + ` · ${Object.keys(state.genres).length} genres`;
  }

  const ids = state.filtered.map((s) => s.id);
  const actions = [];
  if (ids.length) {
    actions.push(
      ["▶ Play", () => play(ids[0], ids)],
      ["⤨ Shuffle", () => playOrder(shuffleArray(ids))],
      ["＋ Queue", () => enqueueList(ids, false)],
      ["⤨ Shuffle queue", () => enqueueList(shuffleArray(ids), false)],
    );
  }
  actions.push(...extra);

  $("#hero-title").textContent = title;
  $("#hero-meta").textContent = meta;
  renderHeroArt(state.filtered);
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
    row.dataset.songId = s.id;
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
    if (!s.missing && state.offline.has(s.id)) {
      const off = document.createElement("span");
      off.className = "offline-badge";
      off.textContent = "⬇";
      off.title = "Available offline";
      strong.append(" ", off);
    }
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
      if (e.target.closest("button, a, input")) return;
      play(s.id);
    };
    bindPlayGesture(row, activate);
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
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  }
}

function syncTimes() {
  document.querySelectorAll(".js-cur").forEach((el) => { el.textContent = fmtTime(audio.currentTime); });
  document.querySelectorAll(".js-end").forEach((el) => { el.textContent = fmtTime(audio.duration); });
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0;
  document.querySelectorAll(".js-seek").forEach((el) => { if (!el._dragging) el.value = pct; });
  if ("mediaSession" in navigator && isFinite(audio.duration) && audio.duration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(Math.max(audio.currentTime, 0), audio.duration),
      });
    } catch (_) { /* not supported / out of range */ }
  }
}

function updateMediaSession(song) {
  if (!("mediaSession" in navigator) || !song) return;
  const artwork = [];
  if (song.has_cover) {
    try {
      artwork.push({
        src: new URL(BASE + "api/cover/" + encodeURIComponent(song.id), location.origin).href,
        sizes: "512x512", type: "image/jpeg",
      });
    } catch (_) { /* ignore */ }
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || "",
    artist: song.artist || "",
    album: song.album || song.genre || "",
    artwork,
  });
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const handlers = {
    play: () => togglePlay(),
    pause: () => pausePlayback(),
    previoustrack: () => prevTrack(),
    nexttrack: () => nextTrack(),
    seekbackward: (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); },
    seekforward: (d) => {
      audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (d.seekOffset || 10));
    },
    seekto: (d) => { if (typeof d.seekTime === "number") audio.currentTime = d.seekTime; },
    stop: () => { pausePlayback(); audio.currentTime = 0; },
  };
  for (const [name, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(name, fn); } catch (_) { /* unsupported */ }
  }
}

function syncVolume() {
  document.querySelectorAll(".js-vol").forEach((el) => {
    const v = volumeToSlider(audio.volume);
    if (Number(el.value) !== v) el.value = v;
  });
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
  rebuildPlayerRating();
}

function recordPlayed(id) {
  // Record every play (repeats included) so History reflects what was played.
  const entry = { id, source: state.currentSource, autoPos: state.autoPos };
  state.history.unshift(entry);
  if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  savePlayHistory();
  if (state.viewType === "history") renderHistory();
}

/* Per-song loudness trim. A Web Audio gain node lets us boost quiet tracks
 * (audio.volume is capped at 1.0); the element's own volume slider still works
 * upstream of this node.
 *
 * iOS quirks this works around:
 *  - Routing the <audio> element through a MediaElementSource makes it play
 *    *only* through the AudioContext, so if iOS suspends the context (e.g. when
 *    the PWA is backgrounded) playback goes silent. We resume the context on
 *    play, visibility, focus and the first user gesture.
 *  - Pausing a MediaElementSource can replay a short (~0.25 s) buffered segment
 *    on Safari/iOS. Muting the gain node just before pausing hides it; the gain
 *    is restored on the next play. */
let audioGraphCtx = null;
let audioGraphGain = null;
let currentGainDb = 0;
function ensureAudioGraph() {
  if (audioGraphGain) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    audioGraphCtx = new Ctx();
    const source = audioGraphCtx.createMediaElementSource(audio);
    audioGraphGain = audioGraphCtx.createGain();
    source.connect(audioGraphGain);
    audioGraphGain.connect(audioGraphCtx.destination);
  } catch (_) {
    audioGraphCtx = null;
    audioGraphGain = null;
  }
}
function gainFactor(db) {
  const v = Number(db);
  return isFinite(v) ? Math.pow(10, v / 20) : 1;
}
function applySongGain(db) {
  const v = Number(db);
  currentGainDb = isFinite(v) ? v : 0;
  ensureAudioGraph();
  if (!audioGraphGain) return;
  audioGraphGain.gain.value = gainFactor(currentGainDb);
}
function resumeAudioGraph() {
  if (audioGraphCtx && audioGraphCtx.state !== "running") {
    audioGraphCtx.resume().catch(() => {});
  }
}
// Pause with the graph muted so iOS doesn't leak the tail buffer.
function pausePlayback() {
  if (audioGraphGain) audioGraphGain.gain.value = 0;
  audio.pause();
}
function startPlayback() {
  ensureAudioGraph();
  resumeAudioGraph();
  if (audioGraphGain) audioGraphGain.gain.value = gainFactor(currentGainDb);
  audio.play().catch(() => {});
}

function startAudio(id, { source = null, record = true, autoplay = true } = {}) {
  const song = songById(id);
  if (!song || song.missing) return;
  state.currentId = id;
  if (source) state.currentSource = source;
  applySongGain(song.gain_db);
  resumeAudioGraph();
  audio.src = streamUrl(song);
  if (autoplay) startPlayback();
  syncNow(song);
  document.querySelectorAll(".track").forEach((r) =>
    r.classList.toggle("is-playing", r.dataset.id === id));
  localStorage.setItem("moosic.last", id);
  updateMediaSession(song);
  if (record) recordPlayed(id);
  if (queuePanelOpen()) renderQueue();
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
  if (r === undefined || r === null) return 1.0;      // unrated = neutral
  // Strong contrast so higher ratings are clearly favoured, while keeping a
  // generous random band (a 0.4 song is still ~3x an unrated one, a 5★ ~8x).
  return 0.25 + 8.0 * r;                              // 0 -> 0.25, 1.0 -> 8.25
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

// Re-order the autoplay tail for the current shuffle mode, keeping the current
// track (and everything already played) where it is. The explicit queue is a
// separate list, so it is never re-ordered here.
function rebuildAuto() {
  if (!state.context.length) return;
  const head = state.autoPos >= 0 ? state.auto.slice(0, state.autoPos + 1) : [];
  const headSet = new Set(head);
  const played = new Set(state.history.map((h) => h.id));
  const queued = new Set(state.queue);
  const rest = state.context.filter(
    (id) => !played.has(id) && !headSet.has(id) && !queued.has(id));
  const ordered = state.shuffle === "smart" ? smartOrder(rest)
    : state.shuffle === "on" ? shuffleArray(rest) : rest;
  state.auto = head.concat(ordered);
  if (state.autoPos >= state.auto.length) state.autoPos = state.auto.length - 1;
}

function sameContext(ids) {
  if (ids.length !== state.context.length) return false;
  for (let i = 0; i < ids.length; i++) if (ids[i] !== state.context[i]) return false;
  return true;
}

// Play `id` now. If the requested view is the same as the current autoplay
// context, jump to the existing entry; otherwise start a fresh autoplay order
// from `contextIds` (the current view by default). The explicit queue survives
// a context change so user-queued songs are not lost.
function play(id, contextIds) {
  const song = songById(id);
  if (!song || song.missing) return;
  const ctx = (contextIds && contextIds.length)
    ? contextIds.slice()
    : (state.filtered.length ? state.filtered.map((s) => s.id) : [id]);

  const qi = state.queue.indexOf(id);
  if (qi >= 0 && sameContext(ctx)) {
    // Clicking a song that is waiting in the explicit queue consumes it.
    state.queue.splice(qi, 1);
    startAudio(id, { source: "explicit" });
    return;
  }
  if (qi >= 0) state.queue.splice(qi, 1); // don't play it twice
  if (sameContext(ctx)) {
    const ai = state.auto.indexOf(id);
    if (ai >= 0) {
      state.autoPos = ai;
      startAudio(id, { source: "auto" });
      return;
    }
  }

  state.context = ctx;
  state.auto = buildOrder(ctx, id);
  state.autoPos = Math.max(0, state.auto.indexOf(id));
  startAudio(id, { source: "auto" });
}

// Play an explicit ordered list (used by "Shuffle filtered" so the order is
// exactly what the user sees, regardless of the global shuffle mode).
function playOrder(ids) {
  const clean = ids.filter((id) => songById(id));
  if (!clean.length) return;
  const first = clean[0];
  const qi = state.queue.indexOf(first);
  if (qi >= 0) state.queue.splice(qi, 1);
  state.context = clean.slice();
  state.auto = clean.slice();
  state.autoPos = 0;
  startAudio(first, { source: "auto" });
}

function nextTrack() {
  clearStopAfter();
  if (state.queue.length) {
    startAudio(state.queue.shift(), { source: "explicit" });
    return;
  }
  if (!state.auto.length) { pausePlayback(); return; }
  if (state.autoPos + 1 < state.auto.length) {
    state.autoPos += 1;
    startAudio(state.auto[state.autoPos], { source: "auto" });
    return;
  }
  if (state.repeat === "all") {
    state.autoPos = 0;
    startAudio(state.auto[0], { source: "auto" });
    return;
  }
  pausePlayback();
}

function prevTrack() {
  clearStopAfter();
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.history.length > 1) {
    const current = state.history.shift();
    savePlayHistory();
    // Going back past a queued song puts it back at the front of the queue so
    // that "next" retraces exactly what was played.
    if (current.source === "explicit") state.queue.unshift(current.id);
    let prev = state.history[0];
    // Skip history entries whose song was deleted from the library.
    while (prev && !songById(prev.id)) {
      state.history.shift();
      prev = state.history[0];
    }
    savePlayHistory();
    if (!prev) { audio.currentTime = 0; return; }
    // Restore the autoplay position that was current when `prev` played, so
    // "next" walks forward through exactly the same sequence.
    if (prev.autoPos >= 0) state.autoPos = prev.autoPos;
    startAudio(prev.id, { source: prev.source, record: false });
    return;
  }
  if (state.repeat === "all" && state.auto.length) {
    state.autoPos = state.auto.length - 1;
    startAudio(state.auto[state.autoPos], { source: "auto" });
    return;
  }
  audio.currentTime = 0;
}

function enqueue(id, asNext) {
  if (!songById(id)) return;
  if (!state.currentId) { play(id); return; }
  const qi = state.queue.indexOf(id);
  if (qi >= 0) state.queue.splice(qi, 1);
  // Don't let an explicitly queued song also play again via autoplay.
  const ai = state.auto.indexOf(id);
  if (ai > state.autoPos) state.auto.splice(ai, 1);
  if (asNext) state.queue.unshift(id);
  else state.queue.push(id);
  toast(asNext ? "Playing next" : "Added to queue");
  if (queuePanelOpen()) renderQueue();
}

// Queue every song in a list (playlist, album, search result set). With nothing
// playing, start the list and queue the rest behind it.
function enqueueList(ids, asNext = false) {
  const clean = [];
  for (const id of ids) {
    if (songById(id) && !clean.includes(id)) clean.push(id);
  }
  if (!clean.length) return;
  if (!state.currentId) {
    play(clean[0], clean);
    state.queue = clean.slice(1);
    // Those songs are now explicit; keep them out of autoplay so they don't
    // play a second time when the queued run finishes.
    const queuedSet = new Set(state.queue);
    state.auto = state.auto.filter((id, i) => i <= state.autoPos || !queuedSet.has(id));
    if (queuePanelOpen()) renderQueue();
    toast(`Started ${clean.length} songs`);
    return;
  }
  const add = clean.filter((id) => !state.queue.includes(id));
  const addSet = new Set(add);
  state.auto = state.auto.filter((id, i) => i <= state.autoPos || !addSet.has(id));
  if (asNext) state.queue.unshift(...add);
  else state.queue.push(...add);
  toast(add.length
    ? `${asNext ? "Playing next" : "Queued"} ${add.length} song${add.length === 1 ? "" : "s"}`
    : "Already queued");
  if (queuePanelOpen()) renderQueue();
}

// Remove an item from the explicit queue (autoplay is unaffected).
function removeFromQueue(index) {
  if (index < 0 || index >= state.queue.length) return;
  state.queue.splice(index, 1);
  renderQueue();
}

function clearQueue() {
  const hadQueue = state.queue.length;
  state.queue = [];
  // "Clear queue" also stops the current autoplay run, but keeps the current
  // song playing. Use shuffle/play from a view to start a new autoplay run.
  state.auto = state.currentId && state.currentSource === "auto" ? [state.currentId] : [];
  state.autoPos = state.auto.length ? 0 : -1;
  state.context = state.auto.slice();
  renderQueue();
  toast(hadQueue ? "Queue cleared" : "Autoplay cleared");
}

function queueRow(song, { current = false, removeIndex = undefined, autoIndex = undefined } = {}) {
  const row = document.createElement("div");
  row.className = "queue-item" + (current ? " current" : "");
  row.dataset.songId = song.id;
  row.appendChild(artEl(song, "q-art"));
  const main = document.createElement("div");
  main.className = "q-main";
  const t = document.createElement("strong"); t.textContent = song.title;
  const a = document.createElement("span"); a.className = "muted"; a.textContent = song.artist || "";
  main.append(t, a);
  row.appendChild(main);
  if (current) {
    const b = document.createElement("span"); b.className = "badge best"; b.textContent = "Now playing";
    row.appendChild(b);
  }
  if (removeIndex !== undefined) {
    const rm = document.createElement("button");
    rm.className = "mini-btn";
    rm.textContent = "✕";
    rm.title = "Remove from queue";
    rm.onclick = (e) => { e.stopPropagation(); removeFromQueue(removeIndex); };
    row.appendChild(rm);
  }
  if (current) {
    // no click action on the current row
  } else if (removeIndex !== undefined) {
    bindPlayGesture(row, () => {
      const id = state.queue.splice(removeIndex, 1)[0];
      if (id) startAudio(id, { source: "explicit" });
    });
  } else if (autoIndex !== undefined) {
    bindPlayGesture(row, () => {
      state.autoPos = autoIndex;
      startAudio(song.id, { source: "auto" });
    });
  }
  return row;
}

function queueGroup(text) {
  const p = document.createElement("p");
  p.className = "queue-group";
  p.textContent = text;
  return p;
}

function renderQueue() {
  const list = $("#queue-list");
  if (!list) return;
  list.replaceChildren();
  const queued = state.queue.length;
  const upcoming = Math.max(0, state.auto.length - state.autoPos - 1);
  const current = state.currentId ? songById(state.currentId) : null;
  $("#queue-sub").textContent = current
    ? `${queued} queued · ${upcoming} up next in autoplay`
    : "Nothing queued.";

  if (!current && !queued) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Play something, or use “Play next” / “Add to queue” on a song.";
    list.appendChild(p);
    return;
  }
  if (current) list.appendChild(queueRow(current, { current: true }));

  if (queued) {
    list.appendChild(queueGroup("Queue"));
    state.queue.forEach((id, i) => {
      const s = songById(id);
      if (s) list.appendChild(queueRow(s, { removeIndex: i }));
    });
  }
  if (upcoming) {
    const label = state.shuffle === "smart" ? "Autoplay · smart shuffle"
      : state.shuffle === "on" ? "Autoplay · shuffle" : "Autoplay";
    list.appendChild(queueGroup(label));
    const start = state.autoPos + 1;
    const end = Math.min(state.auto.length, start + 10);
    for (let i = start; i < end; i++) {
      const s = songById(state.auto[i]);
      if (s) list.appendChild(queueRow(s, { autoIndex: i }));
    }
    if (end < state.auto.length) {
      const more = document.createElement("p");
      more.className = "hint queue-more";
      more.textContent = `… ${state.auto.length - end} more in autoplay`;
      list.appendChild(more);
    }
  }
  const curEl = list.querySelector(".queue-item.current");
  if (curEl) curEl.scrollIntoView({ block: "nearest" });
}

function queuePanelOpen() {
  const layout = document.querySelector(".layout");
  return !!layout && layout.classList.contains("queue-open");
}
function syncQueueNav() {
  const nav = document.querySelector('.nav-item[data-view="queue"]');
  if (nav) nav.classList.toggle("is-active", queuePanelOpen());
}
function setQueuePanel(open) {
  document.querySelector(".layout").classList.toggle("queue-open", open);
  syncQueueNav();
  if (open) renderQueue();
}
function toggleQueuePanel() { setQueuePanel(!queuePanelOpen()); }

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

// Searchable picker so adding songs to a playlist doesn't require scrolling the
// whole library. Click rows to select, then add them in one PATCH.
function openAddSongsPicker(pl) {
  if (!pl) return;
  const root = $("#modal-root");
  root.hidden = false;
  root.innerHTML = "";
  const box = document.createElement("div");
  box.className = "modal picker-modal";
  const h = document.createElement("h3");
  h.textContent = `Add songs to “${pl.name}”`;
  const search = document.createElement("input");
  search.type = "search";
  search.className = "picker-search";
  search.placeholder = "Search your library by title, artist or album…";
  search.autocomplete = "off";
  search.spellcheck = false;
  const list = document.createElement("div");
  list.className = "picker-list";
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn btn-primary";
  ok.textContent = "Add selected";
  ok.disabled = true;
  actions.append(cancel, ok);
  box.append(h, search, list, actions);
  root.appendChild(box);

  const existing = new Set(pl.songs.map((s) => s.id));
  const selected = new Map(); // id -> true, keeps selection order

  const render = () => {
    const q = normText(search.value.trim());
    const matches = state.master
      .filter((s) => !existing.has(s.id))
      .filter((s) => !q || normText(`${s.title} ${s.artist} ${s.album || ""}`).includes(q))
      .slice(0, 100);
    list.replaceChildren();
    if (!matches.length) {
      const p = document.createElement("p");
      p.className = "hint picker-empty";
      p.textContent = q ? "No matching songs." : "Every library song is already in this playlist.";
      list.appendChild(p);
    }
    for (const s of matches) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "picker-row" + (selected.has(s.id) ? " on" : "");
      row.dataset.songId = s.id;
      row.appendChild(artEl(s, "picker-art"));
      const info = document.createElement("span");
      info.className = "picker-info";
      const t = document.createElement("strong"); t.textContent = s.title;
      const a = document.createElement("span"); a.className = "muted";
      a.textContent = s.artist + (s.album ? " · " + s.album : "");
      info.append(t, a);
      const mark = document.createElement("span");
      mark.className = "picker-check";
      mark.textContent = selected.has(s.id) ? "✓" : "＋";
      row.append(info, mark);
      row.onclick = () => {
        if (selected.has(s.id)) selected.delete(s.id);
        else selected.set(s.id, true);
        row.classList.toggle("on", selected.has(s.id));
        mark.textContent = selected.has(s.id) ? "✓" : "＋";
        ok.disabled = selected.size === 0;
        ok.textContent = selected.size ? `Add ${selected.size}` : "Add selected";
      };
      list.appendChild(row);
    }
  };

  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    root.hidden = true;
    root.innerHTML = "";
  }
  cancel.onclick = close;
  root.onclick = (e) => { if (e.target === root) close(); };
  document.addEventListener("keydown", onKey);
  search.addEventListener("input", render);
  ok.onclick = async () => {
    if (!selected.size) return;
    ok.disabled = true;
    ok.textContent = "Adding…";
    try {
      const ids = pl.songs.map((s) => s.id).concat([...selected.keys()]);
      await api("/api/playlists/" + encodeURIComponent(pl.slug), { method: "PATCH", body: { songs: ids } });
      const n = selected.size;
      close();
      await openPlaylist(pl.slug);
      await reloadPlaylists();
      refreshStatus();
      toast(`Added ${n} song${n === 1 ? "" : "s"} to “${pl.name}”`);
    } catch (e) {
      ok.disabled = false;
      ok.textContent = "Add selected";
      toast(e.message, true);
    }
  };
  render();
  search.focus();
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
  if (song && song.id) row.dataset.songId = song.id;
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
    bindPlayGesture(row, (e) => { if (!e.target.closest("button, a, input")) onPlay(); });
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
  const wasCurrent = state.currentId === song.id;
  const wasOffline = state.offline.has(song.id);
  const resumeAt = wasCurrent ? audio.currentTime : 0;
  const wasPlaying = wasCurrent && !audio.paused;
  toast("Looking for a better match…");
  try {
    const r = await api("/api/songs/" + encodeURIComponent(song.id) + "/replace-match", { method: "POST" });
    state.quota = r.quota;
    renderQuota();
    await reloadLibrary();
    const s2 = songById(song.id);
    // A replacement swaps the file under the same song id, so cached audio and
    // cover bytes for that id are stale. Drop them before re-rendering/playing.
    await dropCachedUrls([
      streamUrl(song),
      new URL(coverUrl(song), location.origin).href,
    ]);
    apply();
    if (s2) {
      if (wasOffline) {
        setOffline(song.id, false);
        cacheTrack(s2).then((ok) => { if (ok) { setOffline(s2.id, true); apply(); } });
      }
      if (wasCurrent) {
        // The <audio> element keeps the old stream (and its duration) unless
        // we reload it after the server swapped the file.
        if (resumeAt > 0) {
          audio.addEventListener("loadedmetadata", () => {
            try { audio.currentTime = Math.min(resumeAt, audio.duration || resumeAt); } catch (_) {}
          }, { once: true });
        }
        startAudio(s2.id, { source: state.currentSource, record: false, autoplay: wasPlaying });
        syncNow(s2);
        updateMediaSession(s2);
      }
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
  state.sort = "default";
  $("#sort").value = "default";
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
  if (audio.paused) startPlayback(); else pausePlayback();
}
function syncShuffleUI() {
  document.querySelectorAll(".js-shuffle").forEach((el) => {
    el.classList.toggle("is-on", state.shuffle !== "off");
    el.classList.toggle("smart", state.shuffle === "smart");
    el.textContent = state.shuffle === "smart" ? "✨" : "⤨";
    el.title = state.shuffle === "smart" ? "Smart shuffle (rating-weighted)"
      : state.shuffle === "on" ? "Shuffle" : "Shuffle off";
  });
}
function toggleShuffle() {
  state.shuffle = state.shuffle === "off" ? "on"
    : state.shuffle === "on" ? "smart" : "off";
  syncShuffleUI();
  if (state.auto.length) rebuildAuto();
  if (queuePanelOpen()) renderQueue();
  toast(state.shuffle === "smart" ? "Smart shuffle on — favouring higher-rated songs"
    : state.shuffle === "on" ? "Shuffle on" : "Shuffle off");
}

function syncRepeatUI() {
  document.querySelectorAll(".js-repeat").forEach((el) => {
    el.classList.toggle("is-on", state.repeat !== "off");
    // Off, repeat-all and repeat-one each look different so a single click
    // always produces visible feedback.
    el.textContent = state.repeat === "one" ? "🔂" : state.repeat === "all" ? "🔁" : "↻";
    el.title = "Repeat: " + state.repeat;
    el.setAttribute("aria-label", "Repeat: " + state.repeat);
  });
  audio.loop = state.repeat === "one" && !state.stopAfter;
}
function toggleRepeat() {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  syncRepeatUI();
  toast("Repeat: " + state.repeat);
}

function syncStopAfterUI() {
  document.querySelectorAll(".js-stop-after").forEach((el) => {
    el.classList.toggle("is-on", state.stopAfter);
    el.title = state.stopAfter ? "Stop after this song (on)" : "Stop after this song";
    el.setAttribute("aria-pressed", state.stopAfter ? "true" : "false");
  });
}
function setStopAfter(on) {
  state.stopAfter = !!on;
  syncStopAfterUI();
  audio.loop = state.repeat === "one" && !state.stopAfter;
}
function clearStopAfter() { if (state.stopAfter) setStopAfter(false); }
function toggleStopAfter() {
  if (!state.stopAfter && !state.currentId) {
    toast("Play something first", true);
    return;
  }
  setStopAfter(!state.stopAfter);
  toast(state.stopAfter ? "Stopping after this song" : "Stop after this song cancelled");
}

document.querySelectorAll(".js-play").forEach((el) => { el.onclick = togglePlay; });
document.querySelectorAll(".js-next").forEach((el) => { el.onclick = nextTrack; });
document.querySelectorAll(".js-prev").forEach((el) => { el.onclick = prevTrack; });
document.querySelectorAll(".js-shuffle").forEach((el) => { el.onclick = toggleShuffle; });
document.querySelectorAll(".js-repeat").forEach((el) => { el.onclick = toggleRepeat; });
document.querySelectorAll(".js-stop-after").forEach((el) => { el.onclick = toggleStopAfter; });
syncShuffleUI();
syncRepeatUI();
syncStopAfterUI();

$("#new-playlist").onclick = newPlaylist;
$("#history-clear").onclick = clearHistory;
$("#queue-clear").onclick = clearQueue;
$("#queue-close").onclick = () => setQueuePanel(false);
$("#add-song").onclick = addSong;
$("#commit").onclick = doCommit;
$("#refresh-assets").onclick = doRefresh;
$("#export-library").onclick = () => exportScope("library");

audio.addEventListener("play", () => {
  ensureAudioGraph();
  resumeAudioGraph();
  // Undo the mute applied by pausePlayback().
  if (audioGraphGain) audioGraphGain.gain.value = gainFactor(currentGainDb);
  syncPlayIcon();
});
audio.addEventListener("pause", syncPlayIcon);
audio.addEventListener("loadedmetadata", syncTimes);
audio.addEventListener("timeupdate", syncTimes);
audio.addEventListener("ended", () => {
  if (state.stopAfter) {
    setStopAfter(false);
    pausePlayback();
    toast("Stopped after this song");
    return;
  }
  if (state.repeat !== "one") nextTrack();
});
audio.addEventListener("error", () => { if (state.currentId) toast("Could not play that track", true); });

// iOS suspends the AudioContext when the PWA is backgrounded or the tab is
// hidden; since the <audio> element is routed through it, a suspended context
// silences playback (the "backgrounding mutes the volume" bug). Resume whenever
// we return to the foreground and on the next user gesture (iOS needs a
// gesture to unlock audio).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeAudioGraph();
});
window.addEventListener("pageshow", resumeAudioGraph);
window.addEventListener("focus", resumeAudioGraph);
["pointerdown", "touchend", "keydown"].forEach((ev) =>
  document.addEventListener(ev, resumeAudioGraph, { passive: true }));

document.querySelectorAll(".js-seek").forEach((el) => {
  el.addEventListener("input", () => {
    el._dragging = true;
    if (audio.duration) audio.currentTime = (el.value / 1000) * audio.duration;
  });
  el.addEventListener("change", () => { el._dragging = false; });
});

// Human hearing is roughly logarithmic, so a linear slider feels top-heavy:
// most of the useful change is crammed into the first third. Square the slider
// position so equal movements are closer to equal perceived loudness changes.
const volumeGain = (slider) =>
  Math.pow(Math.max(0, Math.min(100, Number(slider) || 0)) / 100, 2);
const volumeToSlider = (gain) =>
  Math.round(Math.pow(Math.max(0, Math.min(1, Number(gain) || 0)), 1 / 2) * 100);
const savedVolRaw = Number(localStorage.getItem("moosic.volume") ?? "90");
const savedVol = isFinite(savedVolRaw) ? Math.max(0, Math.min(100, savedVolRaw)) : 90;
audio.volume = volumeGain(savedVol);
document.querySelectorAll(".js-vol").forEach((el) => {
  el.value = savedVol;
  el.addEventListener("input", () => {
    audio.volume = volumeGain(el.value);
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

function songMenuItems(song) {
  const items = [
    { type: "rating", song },
    { type: "volume", song },
    { label: "Play", fn: () => play(song.id) },
    { label: "Play next", fn: () => enqueue(song.id, true) },
    { label: "Add to queue", fn: () => enqueue(song.id, false) },
    { label: "Add to playlist", fn: () => addToPlaylist(song) },
    { label: "Download MP3", fn: () => downloadTrack(song) },
    {
      label: state.offline.has(song.id) ? "Remove offline copy" : "Save offline",
      fn: () => toggleOffline(song),
    },
    { label: "Edit details", fn: () => editSong(song) },
    { label: "Wrong match — replace", fn: () => replaceMatch(song) },
  ];
  if (song.id === state.currentId) {
    items.splice(4, 0, {
      label: state.stopAfter ? "Cancel stop after this song" : "Stop after this song",
      fn: () => toggleStopAfter(),
    });
  }
  if (state.viewType === "playlist") {
    items.push(
      { label: "Move up", fn: () => moveInPlaylist(song.id, -1) },
      { label: "Move down", fn: () => moveInPlaylist(song.id, 1) },
      { label: "Remove from playlist", danger: true, fn: () => removeFromPlaylist(song.id) },
    );
  }
  items.push({ label: "Delete from library", danger: true, fn: () => deleteSong(song) });
  return items;
}

function menuRating(song) {
  const row = document.createElement("div");
  row.className = "menu-rating";
  const label = document.createElement("span");
  label.textContent = "Rate";
  row.append(label, starWidget(song, false));
  return row;
}

const fmtDb = (db) => {
  const v = Number(db);
  if (db === null || db === undefined || !isFinite(v)) return "Auto";
  return (v > 0 ? "+" : "") + v.toFixed(1) + " dB";
};

async function saveSongGain(song, body, valueEl, sliderEl) {
  try {
    const r = await api(`/api/volume/${encodeURIComponent(song.id)}`,
                        { method: "PUT", body });
    song.gain_db = r.gain_db;
    if (sliderEl) sliderEl.value = String(r.gain_db ?? 0);
    if (valueEl) valueEl.textContent = fmtDb(r.gain_db);
    if (state.currentId === song.id) applySongGain(song.gain_db);
  } catch (err) {
    toast(err.message, true);
  }
}

function menuVolume(song) {
  const row = document.createElement("div");
  row.className = "menu-volume";
  const label = document.createElement("span");
  label.textContent = "Volume";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "-20";
  slider.max = "12";
  slider.step = "0.5";
  slider.value = String(isFinite(Number(song.gain_db)) ? Number(song.gain_db) : 0);
  slider.setAttribute("aria-label", "Per-song volume in decibels");
  const value = document.createElement("b");
  value.textContent = fmtDb(song.gain_db);
  const auto = document.createElement("button");
  auto.type = "button";
  auto.textContent = "Auto";
  auto.title = "Re-measure this track's loudness";
  slider.oninput = () => { value.textContent = fmtDb(Number(slider.value)); };
  slider.onchange = () => saveSongGain(song, { gain_db: Number(slider.value) }, value, slider);
  auto.onclick = async (e) => {
    e.stopPropagation();
    if (auto.disabled) return;
    auto.disabled = true;
    const prev = auto.textContent;
    auto.textContent = "…";
    try { await saveSongGain(song, { auto: true }, value, slider); }
    finally { auto.disabled = false; auto.textContent = prev; }
  };
  row.append(label, slider, value, auto);
  return row;
}

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
  for (const it of songMenuItems(song)) {
    if (it.type === "rating") { panel.appendChild(menuRating(it.song)); continue; }
    if (it.type === "volume") { panel.appendChild(menuVolume(it.song)); continue; }
    const b = document.createElement("button");
    b.className = "sheet-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.onclick = async () => { closeActionSheet(); await it.fn(); };
    panel.appendChild(b);
  }
  const cancel = document.createElement("button");
  cancel.className = "sheet-item cancel";
  cancel.textContent = "Cancel";
  cancel.onclick = closeActionSheet;
  panel.appendChild(cancel);
  $("#sheet-root").hidden = false;
}
$("#sheet-backdrop").onclick = closeActionSheet;

/* right-click song menu */
function closeContextMenu() {
  const m = $("#context-menu");
  m.hidden = true;
  m.replaceChildren();
}
function openContextMenu(song, x, y) {
  const menu = $("#context-menu");
  menu.replaceChildren();
  for (const it of songMenuItems(song)) {
    if (it.type === "rating") { menu.appendChild(menuRating(it.song)); continue; }
    if (it.type === "volume") { menu.appendChild(menuVolume(it.song)); continue; }
    const b = document.createElement("button");
    b.className = "sheet-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.onclick = async () => { closeContextMenu(); await it.fn(); };
    menu.appendChild(b);
  }
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
}

document.addEventListener("contextmenu", (e) => {
  const row = e.target.closest("[data-song-id]");
  if (row && row.dataset.songId) {
    const song = songById(row.dataset.songId);
    if (song) {
      e.preventDefault();
      closeActionSheet();
      openContextMenu(song, e.clientX, e.clientY);
      return;
    }
  }
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return; // keep native copy/paste in fields
  e.preventDefault();
  closeContextMenu();
});

document.querySelectorAll(".nav-item").forEach((b) =>
  b.onclick = () => {
    closeDrawer();
    if (b.dataset.view === "queue") { toggleQueuePanel(); return; }
    setView(b.dataset.view);
  });

if (suggestionAuthor()) $("#suggestion-author").value = suggestionAuthor();

$("#suggestion-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const textEl = $("#suggestion-text");
  const text = textEl.value.trim();
  if (!text) { toast("Write a bug or suggestion first", true); textEl.focus(); return; }
  const btn = $("#suggestion-submit");
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Posting…";
  try {
    await api("/api/suggestions", {
      method: "POST",
      body: {
        kind: $("#suggestion-kind").value,
        text,
        author: $("#suggestion-author").value,
      },
    });
    rememberSuggestionAuthor($("#suggestion-author").value.trim());
    state.suggestionsLoaded = false;
    textEl.value = "";
    await reloadSuggestions();
    refreshStatus();
    toast("Posted — thanks!");
    textEl.focus();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

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
  if (!e.target.closest("#context-menu")) closeContextMenu();
});
window.addEventListener("scroll", closeContextMenu, true);
window.addEventListener("resize", closeContextMenu);
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; apply(); });

// Rating is a dual-thumb range: keep min <= max by nudging the other handle,
// then update the rows at most once per animation frame while dragging.
let filterApplyRaf = 0;
function scheduleFilterApply() {
  if (filterApplyRaf) return;
  filterApplyRaf = requestAnimationFrame(() => { filterApplyRaf = 0; apply(); });
}
function onRatingRangeInput(which) {
  const minEl = $("#filter-rating-min");
  const maxEl = $("#filter-rating-max");
  let lo = Number(minEl.value);
  let hi = Number(maxEl.value);
  if (lo > hi) {
    if (which === "min") hi = lo;
    else lo = hi;
  }
  state.filters.ratingMin = lo;
  state.filters.ratingMax = hi;
  minEl.value = String(lo);
  maxEl.value = String(hi);
  syncFilterUI();
  scheduleFilterApply();
}
$("#filter-rating-min").addEventListener("input", () => onRatingRangeInput("min"));
$("#filter-rating-max").addEventListener("input", () => onRatingRangeInput("max"));
$("#filter-invert").addEventListener("click", () => {
  state.filters.invert = !state.filters.invert;
  apply();
});
$("#filter-genres-all").addEventListener("click", () => {
  state.filters.genres = new Set(genreNames());
  apply();
});
$("#filter-genres-none").addEventListener("click", () => {
  state.filters.genres = new Set();
  apply();
});
$("#filter-toggle").addEventListener("click", () => {
  const panel = $("#filter-panel");
  const open = panel.hidden;
  panel.hidden = !open;
  $("#filter-toggle").setAttribute("aria-expanded", String(open));
});
$("#filter-clear").addEventListener("click", clearFilters);
syncFilterUI();

document.addEventListener("keydown", (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); search.focus(); return; }
  if (e.key === "Escape") {
    closeContextMenu();
    const panel = $("#filter-panel");
    if (panel && !panel.hidden) {
      panel.hidden = true;
      $("#filter-toggle").setAttribute("aria-expanded", "false");
    }
  }
  if (typing) return;
  if (e.code === "Space") { e.preventDefault(); $("#play").click(); }
  else if (e.key === "ArrowRight") audio.currentTime += 5;
  else if (e.key === "ArrowLeft") audio.currentTime -= 5;
  else if (e.key === "n") nextTrack();
  else if (e.key === "p") prevTrack();
});

/* --------------------------- PWA / offline --------------------------- */
const swPending = new Map();
function onSwMessage(event) {
  const d = event.data || {};
  if ((d.type === "CACHED" || d.type === "UNCACHED") && d.reqId && swPending.has(d.reqId)) {
    swPending.get(d.reqId)(!!d.ok);
    swPending.delete(d.reqId);
  }
}
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register(BASE + "sw.js", { scope: BASE });
    navigator.serviceWorker.addEventListener("message", onSwMessage);
  } catch (e) {
    console.warn("service worker:", e);
  }
}
function streamUrl(song) {
  return new URL(BASE + "api/stream/" + encodeURIComponent(song.id), location.origin).href;
}
// Ask the service worker to evict cached bytes for URLs whose backing file
// changed (match replacement, retag). Resolves even if no SW is controlling
// the page, so callers can await it unconditionally.
function dropCachedUrls(urls) {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
    return Promise.resolve();
  }
  const target = navigator.serviceWorker.controller;
  const reqId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  return new Promise((resolve) => {
    const timer = setTimeout(() => { swPending.delete(reqId); resolve(); }, 3000);
    swPending.set(reqId, () => { clearTimeout(timer); resolve(); });
    target.postMessage({ type: "UNCACHE_URLS", urls, reqId });
  });
}
async function cacheTrack(song) {
  if (!("serviceWorker" in navigator)) return false;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const target = navigator.serviceWorker.controller || (reg && reg.active);
  if (!target) return false;
  const reqId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  return new Promise((resolve) => {
    const timer = setTimeout(() => { swPending.delete(reqId); resolve(false); }, 90000);
    swPending.set(reqId, (ok) => { clearTimeout(timer); resolve(ok); });
    target.postMessage({ type: "CACHE_TRACK", url: streamUrl(song), id: song.id, reqId });
  });
}
function setOffline(id, on) {
  if (on) state.offline.add(id); else state.offline.delete(id);
  localStorage.setItem("moosic.offline", JSON.stringify([...state.offline]));
}
async function toggleOffline(song) {
  if (state.offline.has(song.id)) {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    const target = navigator.serviceWorker.controller || (reg && reg.active);
    if (target) target.postMessage({ type: "UNCACHE_TRACK", url: streamUrl(song) });
    setOffline(song.id, false);
    toast(`Removed “${song.title}” from offline`);
    apply();
    return;
  }
  const ok = await cacheTrack(song);
  if (ok) {
    setOffline(song.id, true);
    toast(`Saved “${song.title}” for offline`);
    apply();
  } else {
    toast("Couldn't cache offline — reload once online, then try again", true);
  }
}
function downloadTrack(song) {
  const a = document.createElement("a");
  a.href = BASE + "api/download/" + encodeURIComponent(song.id);
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Downloading “${song.title}”…`);
}
async function saveOfflineList(songs) {
  if (!songs.length) return;
  if (songs.length > 40
      && !window.confirm(`Save ${songs.length} tracks for offline? This can use a lot of storage.`)) return;
  let done = 0;
  for (const s of songs) {
    const ok = await cacheTrack(s);
    if (ok) { setOffline(s.id, true); done += 1; }
  }
  apply();
  toast(`Saved ${done}/${songs.length} tracks offline`);
}
function exportScope(scope, id) {
  const params = new URLSearchParams({ scope });
  if (id) params.set("id", id);
  const a = document.createElement("a");
  a.href = BASE + "api/export?" + params.toString();
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast("Preparing export… unzip it on a Mac, then Music → File → Add to Library");
}
function showInfo(title, lines) {
  const root = $("#modal-root");
  root.hidden = false;
  root.innerHTML = "";
  const box = document.createElement("div");
  box.className = "modal";
  const h = document.createElement("h3");
  h.textContent = title;
  const body = document.createElement("div");
  body.className = "info-body";
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    body.appendChild(p);
  }
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const close = document.createElement("button");
  close.className = "btn btn-primary";
  close.textContent = "Close";
  const dismiss = () => { root.hidden = true; root.innerHTML = ""; };
  close.onclick = dismiss;
  root.onclick = (e) => { if (e.target === root) dismiss(); };
  actions.appendChild(close);
  box.append(h, body, actions);
  root.appendChild(box);
}
function setupInstallBanner() {
  const standalone = window.navigator.standalone === true
    || window.matchMedia("(display-mode: standalone)").matches;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS && !standalone && localStorage.getItem("moosic.installDismissed") !== "1") {
    $("#install-banner").hidden = false;
  }
  $("#install-dismiss").onclick = () => {
    localStorage.setItem("moosic.installDismissed", "1");
    $("#install-banner").hidden = true;
  };
  $("#ios-help").onclick = () => showInfo("Listen on iPhone / Apple Music", [
    "Add to Home Screen: open this site in Safari → Share → “Add to Home Screen”. It runs full-screen and keeps your playlists and ratings.",
    "Listen offline: use “Save offline” on a song, album or playlist (or the ⋮ menu). Cached tracks play without a connection.",
    "Apple Music: Apple Music can't import files from Safari. Tap “Export for Apple Music” on an album/playlist, then on a Mac unzip it and use Music → File → Add to Library. With an Apple Music subscription and Sync Library enabled, the tracks appear on your iPhone.",
    "Apple Music streaming tracks are DRM-protected and can't be downloaded into Moosic — only your own files are in scope.",
  ]);
}

/* ------------------------------- boot ------------------------------- */
(async function boot() {
  try {
    await reloadLibrary();
    await reloadPlaylists();
  } catch (e) { toast("Failed to load library: " + e.message, true); }
  registerServiceWorker();
  setupMediaSession();
  setupInstallBanner();
  const last = localStorage.getItem("moosic.last");
  if (last && state.index.has(last)) play(last);
  refreshStatus();
  setInterval(refreshStatus, 15000);
})();
