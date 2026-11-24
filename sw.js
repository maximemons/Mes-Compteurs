// Service worker de Mes compteurs : notifications des grands caps.
// La page lui laisse la liste des compteurs dans IndexedDB ; lors d'une synchronisation
// périodique (Chrome, appli installée), il vérifie seul si un cap vient d'être franchi.

importScripts("./js/counters-core.js");

const C = self.MCCounters;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

async function checkMilestones() {
  const list = (await C.kvGet("snapshot").catch(() => null)) || [];
  if (!list.length) return;
  const seen = new Set((await C.kvGet("seen").catch(() => null)) || []);
  const due = C.dueMilestones(list, Date.now(), seen);
  if (!due.length) return;
  for (const d of due) {
    seen.add(d.seenKey);
    if (d.silent) continue;
    const n = C.notificationFor(d);
    await self.registration.showNotification(n.title, n.options);
  }
  await C.kvSet("seen", [...seen].slice(-1000));
}

self.addEventListener("periodicsync", e => {
  if (e.tag === "mc-caps") e.waitUntil(checkMilestones());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./#/", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if ("navigate" in w) return w.navigate(url);
        return;
      }
    }
    return self.clients.openWindow(url);
  })());
});
