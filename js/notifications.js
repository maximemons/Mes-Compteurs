// Notifications des grands caps (100 jours, 1 an, 1 000 jours…).
// Un navigateur ne peut pas réveiller une page fermée à heure fixe : deux mécanismes se relaient.
//  1. Appli ouverte (ou en arrière-plan) : minuteur calé sur le prochain cap + vérification au retour.
//  2. Appli installée sur Chrome/Android : synchronisation périodique du service worker (sw.js).
// Un cap n'est notifié qu'une fois par appareil (mémoire dans IndexedDB, partagée avec sw.js).

import "./counters-core.js";

const C = globalThis.MCCounters;
const PREF_KEY = "mc:notifications";
const MAX_DELAY = 6 * C.HOUR;

let snapshot = [];
let timer = null;
let regPromise = null;

export const notifSupported = () => "Notification" in window && "serviceWorker" in navigator;

// "unsupported" | "denied" | "on" | "off"
export function notifStatus() {
  if (!notifSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted" && localStorage.getItem(PREF_KEY) === "on") return "on";
  return "off";
}

function registration() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!regPromise) {
    regPromise = navigator.serviceWorker.register("./sw.js")
      .then(() => navigator.serviceWorker.ready)
      .catch(err => { console.warn("Service worker indisponible", err); return null; });
  }
  return regPromise;
}

async function registerPeriodicSync() {
  const reg = await registration();
  if (!reg || !("periodicSync" in reg)) return;
  try {
    const perm = await navigator.permissions.query({ name: "periodic-background-sync" });
    if (perm.state === "granted") await reg.periodicSync.register("mc-caps", { minInterval: 6 * C.HOUR });
  } catch (err) {
    // Non pris en charge (navigateur, appli non installée) : la vérification à l'ouverture suffit.
  }
}

async function unregisterPeriodicSync() {
  const reg = await registration();
  try { if (reg && "periodicSync" in reg) await reg.periodicSync.unregister("mc-caps"); } catch { /* rien */ }
}

async function show(title, options) {
  const reg = await registration();
  if (reg?.showNotification) return reg.showNotification(title, options);
  return new Notification(title, options);
}

export async function enableNotifications() {
  if (!notifSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return notifStatus();
  localStorage.setItem(PREF_KEY, "on");
  // Les caps déjà franchis depuis plus de 36 h ne sont pas notifiés : pas d'avalanche à l'activation.
  await registerPeriodicSync();
  await checkNow();
  schedule();
  return notifStatus();
}

export async function disableNotifications() {
  localStorage.setItem(PREF_KEY, "off");
  clearTimeout(timer);
  await unregisterPeriodicSync();
  return notifStatus();
}

export async function testNotification() {
  await show("Nouveau cap : 100 jours", {
    body: "Voilà à quoi ressemblera la notification d’un grand cap.",
    tag: "mc-test",
    icon: "icons/icon-192.png",
    data: { url: "./#/caps" }
  });
}

export async function checkNow() {
  if (notifStatus() !== "on" || !snapshot.length) return;
  let seen;
  try { seen = new Set((await C.kvGet("seen")) || []); } catch { seen = new Set(); }
  const due = C.dueMilestones(snapshot, Date.now(), seen);
  if (!due.length) return;
  for (const d of due) {
    seen.add(d.seenKey);
    if (d.silent) continue;
    const n = C.notificationFor(d);
    try { await show(n.title, n.options); } catch (err) { console.warn(err); }
  }
  try { await C.kvSet("seen", [...seen].slice(-1000)); } catch { /* rien */ }
}

function schedule() {
  clearTimeout(timer);
  if (notifStatus() !== "on") return;
  const now = Date.now();
  let next = Infinity;
  for (const c of snapshot) {
    if (c.notify === false) continue;
    const m = C.upcomingFor(c, now, 1)[0];
    if (m && m.at < next) next = m.at;
  }
  const delay = Math.min(Math.max(next - now + 1000, 1000), MAX_DELAY);
  timer = setTimeout(async () => { await checkNow(); schedule(); }, delay);
}

// Appelée à chaque changement des compteurs : mémorise la liste pour la page et le service worker
export async function syncCounters(list) {
  snapshot = list;
  try { await C.kvSet("snapshot", list); } catch { /* rien */ }
  if (notifStatus() === "on") {
    registration();
    await checkNow();
  }
  schedule();
}

export function stopNotificationsForLogout() {
  clearTimeout(timer);
  snapshot = [];
  return C.kvSet("snapshot", []).catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { checkNow(); schedule(); }
});
