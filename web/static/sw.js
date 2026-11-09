/* Moosic service worker — app shell + offline audio cache (Range-aware).
 *
 * - App shell / static assets: cached (stale-while-revalidate).
 * - Covers: cache-first (immutable).
 * - Audio: explicit "save offline" caches the full MP3; playback Range
 *   requests are served as 206 slices from that cache. Opportunistic caching
 *   only happens for full (non-Range) audio fetches. Capped at MAX_AUDIO.
 */
const VERSION = "v4-meme-icons-squircle";
const SHELL = `moosic-shell-${VERSION}`;
const STATIC_CACHE = `moosic-static-${VERSION}`;
const AUDIO = `moosic-audio-${VERSION}`;
const COVERS = `moosic-covers-${VERSION}`;
const MAX_AUDIO = 60;

const scopeURL = new URL(self.registration.scope);
const abs = (p) => new URL(p, scopeURL).href;
const SHELL_URLS = [
  "./", "manifest.webmanifest", "apple-touch-icon.png", "favicon.svg",
  "favicon.gif", "favicon-32.png",
  "static/icon-192.png", "static/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(SHELL_URLS.map(async (p) => {
      try {
        const r = await fetch(abs(p), { cache: "reload" });
        if (r.ok) await cache.put(abs(p), r);
      } catch (_) { /* offline install: best effort */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, STATIC_CACHE, AUDIO, COVERS]);
    // Cache Storage is origin-scoped (other Funnel apps share it); only clean
    // up this app's old caches.
    for (const key of await caches.keys()) {
      if (key.startsWith("moosic-") && !keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const isAudio = (u) => u.pathname.includes("/api/stream/");
const isCover = (u) => u.pathname.includes("/api/cover/");
const isStatic = (u) => u.pathname.includes("/static/")
  || /\/(favicon|manifest|apple-touch|icon-\d+)/.test(u.pathname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== scopeURL.origin) return;

  if (req.mode === "navigate") { event.respondWith(networkFirst(req)); return; }
  if (isAudio(url)) { event.respondWith(audioHandler(req)); return; }
  if (isCover(url)) { event.respondWith(cacheFirst(req, COVERS)); return; }
  if (isStatic(url)) { event.respondWith(staleWhileRevalidate(req, STATIC_CACHE)); return; }
});

async function networkFirst(req) {
  try {
    const resp = await fetch(req);
    const cache = await caches.open(SHELL);
    if (resp.ok) cache.put(abs("./"), resp.clone());
    return resp;
  } catch (_) {
    const hit = await caches.match(abs("./"));
    return hit || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok) cache.put(req, resp.clone());
  return resp;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((resp) => { if (resp.ok) cache.put(req, resp.clone()); return resp; })
    .catch(() => null);
  return hit || (await network) || new Response("", { status: 504 });
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(header);
  if (!m) return null;
  let start = m[1] === "" ? null : parseInt(m[1], 10);
  let end = m[2] === "" ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  else if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

async function audioHandler(req) {
  const cache = await caches.open(AUDIO);
  const cachedResp = await cache.match(req.url);
  const rangeHeader = req.headers.get("range");

  if (cachedResp) {
    const buf = await cachedResp.arrayBuffer();
    const total = buf.byteLength;
    const headers = {
      "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "no-store",
    };
    const range = parseRange(rangeHeader, total);
    if (!range) {
      return new Response(buf, { status: 200, headers: { ...headers, "Content-Length": String(total) } });
    }
    if (range.invalid) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    const slice = buf.slice(range.start, range.end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
        "Content-Length": String(slice.byteLength),
      },
    });
  }

  // Not cached. Range requests are streamed straight from the network (partial
  // responses can't be stored); a full fetch is cached opportunistically.
  if (rangeHeader) return fetch(req);
  const resp = await fetch(req);
  if (resp.ok) {
    cache.put(req.url, resp.clone());
    trim(AUDIO, MAX_AUDIO);
  }
  return resp;
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const reply = (msg) => { try { event.source && event.source.postMessage(msg); } catch (_) {} };

  if (data.type === "CACHE_TRACK") {
    event.waitUntil((async () => {
      try {
        const resp = await fetch(data.url);
        const ok = resp.ok && resp.status === 200;
        if (ok) {
          const cache = await caches.open(AUDIO);
          await cache.put(data.url, resp.clone());
          await trim(AUDIO, MAX_AUDIO);
        }
        reply({ type: "CACHED", id: data.id, reqId: data.reqId, ok });
      } catch (_) {
        reply({ type: "CACHED", id: data.id, reqId: data.reqId, ok: false });
      }
    })());
  } else if (data.type === "UNCACHE_TRACK") {
    event.waitUntil(caches.open(AUDIO).then((c) => c.delete(data.url)));
  } else if (data.type === "UNCACHE_URLS") {
    // Evict both audio and cover bytes for URLs whose file changed under the
    // same song id (a wrong-match replacement keeps the id but swaps the MP3
    // and thumbnail). Reply so the page can await the eviction before it
    // reloads the <audio> element / re-renders covers.
    event.waitUntil((async () => {
      const urls = Array.isArray(data.urls) ? data.urls : [];
      for (const name of [AUDIO, COVERS]) {
        const cache = await caches.open(name);
        for (const url of urls) await cache.delete(url);
      }
      reply({ type: "UNCACHED", reqId: data.reqId, ok: true });
    })());
  } else if (data.type === "IS_CACHED") {
    event.waitUntil((async () => {
      const hit = await caches.match(data.url);
      reply({ type: "IS_CACHED", id: data.id, cached: !!hit });
    })());
  } else if (data.type === "CLEAR_AUDIO") {
    event.waitUntil(caches.delete(AUDIO));
  }
});
