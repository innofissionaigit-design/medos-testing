/*
 * Service worker of the patient app (docs/patient-app.md). It does one thing: when the phone is offline and the patient opens the app, show a plain "you are offline"
 * page instead of the browser's error. It never stores or serves anything else: no pages, no data and no API answers, so a patient's records are never kept on the
 * phone by this app and are never shown from a stale copy. Everything it keeps is the offline page and the icon.
 */
const CACHE = "medos-patient-offline-v1";
const OFFLINE = "/patient/offline.html";
const KEEP = [OFFLINE, "/patient/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(KEEP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith("medos-patient-") && n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only a page the patient is opening, and only when the network fails. Everything else goes straight to the network, untouched.
  if (req.mode !== "navigate" || req.method !== "GET") return;
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE).then((r) => r ?? new Response("You are offline.", { status: 503, headers: { "content-type": "text/plain" } }))));
});
