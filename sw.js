// Offline helper for ColorTracker.
// - Your own files: always try the internet first (so updates show up), fall back to the saved copy offline.
// - Firebase code and fonts: saved once, then loaded from the device.
// - Your data and sign-in are NOT touched here; Firebase handles those itself.

const VERSION = "24";   // app version: same number as ?v= in index.html and app.js
const CACHE = `colortracker-v${VERSION}`;
const SHELL = [
  "./",
  "./index.html",
  `./style.css?v=${VERSION}`,
  `./app.js?v=${VERSION}`,
  `./firebase-config.js?v=${VERSION}`,
  `./animals.js?v=${VERSION}`,
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else if (
    (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com"
  ) {
    event.respondWith(cacheFirst(req));
  }
  // Everything else (Firestore, sign-in) goes straight to the internet.
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: "no-cache" });   // ask the server, don't reuse a stale browser copy
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") {
      const page = await cache.match("./index.html");
      if (page) return page;
    }
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
