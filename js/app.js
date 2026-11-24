import { auth, db, googleProvider } from "./firebase-config.js";
import "./counters-core.js";
import {
  notifStatus, enableNotifications, disableNotifications, testNotification,
  syncCounters, stopNotificationsForLogout
} from "./notifications.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  collection,
  doc,
  onSnapshot,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

const C = globalThis.MCCounters;

/* =========================================================
   Constantes
   ========================================================= */

const UNITS = {
  hours:  { label: "Heures",   one: "heure",   many: "heures" },
  days:   { label: "Jours",    one: "jour",    many: "jours" },
  weeks:  { label: "Semaines", one: "semaine", many: "semaines" },
  months: { label: "Mois",     one: "mois",    many: "mois" },
  years:  { label: "Années",   one: "an",      many: "ans" }
};
const UNIT_ASC = ["hours", "days", "weeks", "months", "years"];

const ICONS = [
  "hourglass-half", "wine-glass-empty", "ban-smoking", "baby", "heart", "ring",
  "cake-candles", "person-running", "dumbbell", "leaf", "seedling", "mug-hot",
  "cookie-bite", "mobile-screen", "gamepad", "bed", "house", "briefcase",
  "car", "plane", "dog", "cat", "book", "star",
  "tree", "gift", "champagne-glasses", "umbrella-beach", "ghost", "flag"
];

const COLORS = ["#1D6B57", "#3B4BDB", "#D2433D", "#C98A0B", "#8340D6", "#0B8FAE", "#D9577F", "#4B5568"];

// Prochaine occurrence d'une date annuelle (mois 0-11), à minuit ; le jour même compte encore
function nextAnnual(month, day, now = Date.now()) {
  const y = new Date(now).getFullYear();
  const t = new Date(y, month, day).getTime();
  return C.addDays(t, 1) <= now ? new Date(y + 1, month, day).getTime() : t;
}

// Raccourcis proposés dans l'éditeur en mode décompte
const QUICK_DATES = [
  { name: "Noël", month: 11, day: 25, icon: "tree" },
  { name: "Nouvel an", month: 0, day: 1, icon: "champagne-glasses" },
  { name: "Saint-Valentin", month: 1, day: 14, icon: "heart" },
  { name: "14 Juillet", month: 6, day: 14, icon: "flag" },
  { name: "Halloween", month: 9, day: 31, icon: "ghost" }
];

const TEMPLATES = [
  {
    title: "Sans alcool", text: "En jours et en semaines, remise à zéro si tu craques",
    data: { name: "Sans alcool", icon: "wine-glass-empty", color: "#1D6B57", units: ["days", "weeks"], display: "totals", resettable: true }
  },
  {
    title: "Sans cigarette", text: "En jours, semaines et mois",
    data: { name: "Sans cigarette", icon: "ban-smoking", color: "#0B8FAE", units: ["days", "weeks", "months"], display: "totals", resettable: true }
  },
  {
    title: "Depuis une naissance", text: "En jours, semaines et années à la fois",
    data: { name: "", icon: "baby", color: "#D9577F", units: ["days", "weeks", "years"], display: "totals", resettable: false }
  },
  {
    title: "Jusqu’à Noël", text: "Un décompte en jours, relancé chaque année",
    get data() {
      return { name: "Noël", icon: "tree", color: "#D2433D", mode: "countdown", targetAt: nextAnnual(11, 25), repeat: true, allDay: true, units: ["days"], display: "totals" };
    }
  }
];

const RECENT_CAP = 7 * C.DAY; // un cap franchi depuis moins de 7 jours est signalé sur la carte

/* =========================================================
   État et outils
   ========================================================= */

const state = {
  user: null,
  categories: [],
  counters: [],
  ready: { categories: false, counters: false },
  unsub: []
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const fmtInt = C.fmtInt;
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many) => (Math.abs(n) < 2 ? one : many);

const userCol = name => collection(db, "users", state.user.uid, name);
const userDoc = (name, id) => doc(db, "users", state.user.uid, name, id);

// Photos d'un compteur : métadonnées + miniature dans « photos », image complète dans « photoFiles »
// (chargée seulement à l'affichage, pour garder la galerie légère).
const photosCol = cid => collection(db, "users", state.user.uid, "counters", cid, "photos");
const photoDoc = (cid, pid) => doc(db, "users", state.user.uid, "counters", cid, "photos", pid);
const photoFilesCol = cid => collection(db, "users", state.user.uid, "counters", cid, "photoFiles");
const photoFileDoc = (cid, pid) => doc(db, "users", state.user.uid, "counters", cid, "photoFiles", pid);

const counterById = id => state.counters.find(c => c.id === id);
const categoryById = id => state.categories.find(c => c.id === id) || null;
const countersIn = catId => state.counters
  .filter(c => (categoryById(c.categoryId)?.id || null) === catId)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const nextOrder = catId => countersIn(catId).reduce((m, c) => Math.max(m, (c.order ?? 0) + 1), 0);

// Les écritures Firestore se résolvent à la synchronisation serveur : on ne les attend pas
// pour garder une interface réactive hors ligne, mais on signale les erreurs.
function persist(promise, okMsg) {
  if (okMsg) toast(okMsg);
  return promise.catch(err => {
    console.error(err);
    toast(errorMessage(err), true);
  });
}

function errorMessage(err) {
  const code = err?.code || "";
  if (code.includes("permission-denied")) return "Accès refusé. Vérifie les règles Firestore du projet.";
  if (code.includes("resource-exhausted")) return "Quota Firebase atteint. Réessaie plus tard.";
  return "L’enregistrement a échoué. Réessaie.";
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), isError ? 4200 : 2200);
}

/* =========================================================
   Dates et durées
   ========================================================= */

const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayDiff = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / C.DAY);

const fmtDate = (t, opts = { day: "numeric", month: "long", year: "numeric" }) => new Date(t).toLocaleDateString("fr-FR", opts);
const fmtTime = t => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtDateTime = t => `${fmtDate(t, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} à ${fmtTime(t)}`;

const fmtDay = t => fmtDate(t, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function fmtSince(t, now = Date.now(), allDay = false) {
  if (t > now) return `démarre le ${fmtDate(t)}`;
  const d = dayDiff(t, now);
  if (d === 0) return allDay ? "depuis aujourd’hui" : `depuis aujourd’hui, ${fmtTime(t)}`;
  if (d === 1) return allDay ? "depuis hier" : `depuis hier, ${fmtTime(t)}`;
  return `depuis le ${fmtDate(t)}`;
}

function fmtIn(at, now = Date.now()) {
  const d = dayDiff(now, at);
  if (d <= 0) {
    const h = Math.max(0, Math.round((at - now) / C.HOUR));
    return h <= 1 ? "dans moins d’une heure" : `dans ${h} h`;
  }
  if (d === 1) return "demain";
  if (d < 100) return `dans ${d} jours`;
  const m = C.fullMonths(now, at);
  return m < 24 ? `dans ${m} mois` : `dans ${Math.floor(m / 12)} ans`;
}

// Durée d'une série (début → fin), en toutes lettres
function fmtSpan(start, end, short = false) {
  const days = C.fullDays(start, end);
  if (days >= 1) return short ? `${fmtInt(days)} j` : `${fmtInt(days)} ${plural(days, "jour", "jours")}`;
  const h = Math.floor((end - start) / C.HOUR);
  if (h >= 1) return short ? `${h} h` : `${h} ${plural(h, "heure", "heures")}`;
  const m = Math.max(0, Math.floor((end - start) / 60000));
  return short ? `${m} min` : `${m} ${plural(m, "minute", "minutes")}`;
}

const pad2 = n => String(n).padStart(2, "0");

function toLocalDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toLocalInput(t) {
  const d = new Date(t);
  return `${toLocalDay(t)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* =========================================================
   Valeurs d'un compteur
   ========================================================= */

const unitsOf = c => {
  const list = (c.units || []).filter(u => UNITS[u]);
  return list.length ? list : ["days"];
};

const isCd = c => C.isCountdown(c);

// Intervalle mesuré : départ → maintenant (compteur) ou maintenant → date visée (décompte).
// À la journée, on compte depuis minuit : le 24 novembre, Noël est à J-31, donc 31 jours.
function span(c, now = Date.now()) {
  if (isCd(c)) {
    const target = C.countdownTarget(c, now);
    const from = c.allDay ? C.startOfDay(now) : now;
    return { from, to: Math.max(from, target) };
  }
  return { from: c.startAt, to: now };
}

function unitValues(c, now = Date.now()) {
  const units = unitsOf(c);
  const { from, to } = span(c, now);
  if (c.display === "breakdown") {
    const vals = C.breakdown(from, to, units).map(([u, v]) => ({ u, v }));
    const first = vals.findIndex(x => x.v > 0);
    return first === -1 ? vals.slice(-1) : vals.slice(first);
  }
  const t = C.totals(from, to);
  return UNIT_ASC.filter(u => units.includes(u)).map(u => ({ u, v: t[u] }));
}

// État d'un décompte : jours restants (J-n), jour J, ou passé
function cdState(c, now = Date.now()) {
  const target = C.countdownTarget(c, now);
  const d = dayDiff(now, target);
  return { target, d, today: d === 0, past: d < 0 };
}

// Ligne sous les valeurs d'une carte
function whenLine(c, now = Date.now()) {
  if (!isCd(c)) return fmtSince(c.startAt, now, c.allDay);
  const { target, d, today, past } = cdState(c, now);
  if (past) return `Passé le ${fmtDate(target)}`;
  const time = c.allDay ? "" : ` à ${fmtTime(target)}`;
  const yearly = c.repeat ? " · chaque année" : "";
  if (today) return `Jour J, aujourd’hui${time}${yearly}`;
  const date = fmtDate(target, d > 300 ? undefined : { day: "numeric", month: "long" });
  return `J-${fmtInt(d)} · le ${date}${time}${yearly}`;
}

const unitLabel = (u, v) => plural(v, UNITS[u].one, UNITS[u].many);

function unitsInner(c, now = Date.now()) {
  return unitValues(c, now).map(({ u, v }) =>
    `<span class="unit"><strong>${fmtInt(v)}</strong><small>${unitLabel(u, v)}</small></span>`
  ).join("");
}

const unitsHtml = (c, now, cls = "") =>
  `<div class="units ${cls}" data-units="${esc(c.id)}">${unitsInner(c, now)}</div>`;

function unitsText(c, now = Date.now()) {
  const vals = unitValues(c, now).map(({ u, v }) => `${fmtInt(v)} ${unitLabel(u, v)}`);
  const txt = c.display === "breakdown" ? vals.join(", ") : vals.join(" · ");
  return isCd(c) ? `encore ${txt}` : txt;
}

// Ce qui dépasse les jours pleins : heures, minutes, secondes
function tickerText(c, now = Date.now()) {
  if (isCd(c)) {
    const t = C.countdownTarget(c, now);
    if (now >= t) return dayDiff(t, now) === 0 ? "C’est l’heure !" : "";
    const days = C.fullDays(now, t);
    let rest = Math.floor((t - C.addDays(now, days)) / 1000);
    const h = Math.floor(rest / 3600); rest -= h * 3600;
    const m = Math.floor(rest / 60); const s = rest - m * 60;
    return `et ${h} h ${pad2(m)} min ${pad2(s)} s`;
  }
  if (c.startAt > now) return `Démarre ${fmtIn(c.startAt, now)}`;
  const days = C.fullDays(c.startAt, now);
  let rest = Math.floor((now - C.addDays(c.startAt, days)) / 1000);
  const h = Math.floor(rest / 3600); rest -= h * 3600;
  const m = Math.floor(rest / 60); const s = rest - m * 60;
  return `+ ${h} h ${pad2(m)} min ${pad2(s)} s`;
}

/* =========================================================
   Boîte de confirmation
   (remplace confirm(), bloqué ou ignoré dans certaines applis installées)
   ========================================================= */

function confirmDialog(message, { detail = "", confirmLabel = "Confirmer", danger = false } = {}) {
  return new Promise(resolve => {
    const wrap = document.createElement("div");
    wrap.className = "dialog-backdrop";
    wrap.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-msg">
        <p id="dialog-msg" class="dialog-msg">${esc(message)}</p>
        ${detail ? `<p class="dialog-detail">${esc(detail)}</p>` : ""}
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" data-no>Annuler</button>
          <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-yes>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-open"));
    const done = value => {
      document.removeEventListener("keydown", onKey, true);
      wrap.classList.remove("is-open");
      setTimeout(() => wrap.remove(), 180);
      resolve(value);
    };
    const onKey = e => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); done(false); }
    };
    document.addEventListener("keydown", onKey, true);
    wrap.addEventListener("click", e => { if (e.target === wrap) done(false); });
    $("[data-no]", wrap).addEventListener("click", () => done(false));
    $("[data-yes]", wrap).addEventListener("click", () => done(true));
    $("[data-no]", wrap).focus();
  });
}

/* =========================================================
   Panneaux (bottom sheets) avec gestion du bouton retour
   ========================================================= */

const sheetStack = [];

function openSheet({ title, body, footer = "", onMount, isDirty }) {
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip"></div>
      <header class="sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Fermer"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <div class="sheet-body">${body}</div>
      ${footer ? `<footer class="sheet-foot">${footer}</footer>` : ""}
    </div>`;
  $("#sheet-root").appendChild(backdrop);
  document.body.classList.add("no-scroll");

  const entry = { backdrop, isDirty, force: false, after: null };
  sheetStack.push(entry);
  history.pushState({ mcSheet: sheetStack.length }, "");

  const requestClose = () => history.back();
  backdrop.addEventListener("click", e => { if (e.target === backdrop) requestClose(); });
  $("[data-close]", backdrop).addEventListener("click", requestClose);

  requestAnimationFrame(() => backdrop.classList.add("is-open"));
  const sheetEl = $(".sheet", backdrop);
  entry.el = sheetEl;
  entry.close = after => { entry.force = true; entry.after = after || null; history.back(); };
  onMount?.(sheetEl, entry);
  return entry;
}

function destroySheet(entry) {
  const i = sheetStack.indexOf(entry);
  if (i >= 0) sheetStack.splice(i, 1);
  entry.backdrop.classList.remove("is-open");
  setTimeout(() => entry.backdrop.remove(), 220);
  if (!sheetStack.length) document.body.classList.remove("no-scroll");
  if (entry.after) setTimeout(entry.after, 0);
}

window.addEventListener("popstate", () => {
  const top = sheetStack[sheetStack.length - 1];
  if (!top) return;
  if (!top.force && top.isDirty && top.isDirty()) {
    history.pushState({ mcSheet: sheetStack.length }, "");
    confirmDialog("Fermer sans enregistrer les modifications ?", { confirmLabel: "Fermer", danger: true })
      .then(ok => { if (ok) top.close(); });
    return;
  }
  destroySheet(top);
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && sheetStack.length && !document.querySelector(".dialog-backdrop")) history.back();
});

/* =========================================================
   En-tête, bouton flottant, navigation
   ========================================================= */

function setHeader({ title, kicker = "", back = null, actions = [] }) {
  $("#topbar-title").textContent = title;
  $("#topbar-kicker").textContent = kicker;
  $("#topbar-kicker").classList.toggle("hidden", !kicker);
  const backBtn = $("#btn-back");
  backBtn.classList.toggle("hidden", !back);
  $("#btn-home").classList.toggle("hidden", !!back);
  backBtn.onclick = back ? () => goBack(back) : null;
  document.title = title === "Mes compteurs" ? "Mes compteurs" : `${title} · Mes compteurs`;

  const wrap = $("#topbar-actions");
  wrap.innerHTML = actions.map((a, i) =>
    `<button type="button" class="icon-btn" data-action-idx="${i}" aria-label="${esc(a.label)}" title="${esc(a.label)}"><i class="fa-solid ${a.icon}"></i></button>`
  ).join("");
  $$("[data-action-idx]", wrap).forEach(btn => {
    btn.addEventListener("click", () => actions[+btn.dataset.actionIdx].onClick());
  });
}

function setFab(config) {
  const fab = $("#fab");
  if (!config) { fab.classList.add("hidden"); fab.onclick = null; return; }
  fab.innerHTML = `<i class="fa-solid ${config.icon}" aria-hidden="true"></i><span>${esc(config.label)}</span>`;
  fab.onclick = config.onClick;
  fab.classList.remove("hidden");
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "c" && parts[1]) return { page: "counter", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "caps") return { page: "caps" };
  return { page: "home" };
}

function setActiveTab(page) {
  $$(".tabbar a").forEach(a => a.classList.toggle("is-active", a.dataset.tab === page));
}

const navStack = [location.hash || "#/"];
window.addEventListener("hashchange", () => {
  const h = location.hash || "#/";
  if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else navStack.push(h);
  scheduleRender();
});

function goBack(target) {
  if (navStack.length > 1) history.back();
  else location.hash = target;
}

let pendingRender = false;
function scheduleRender() {
  if (pendingRender) return;
  pendingRender = true;
  requestAnimationFrame(() => { pendingRender = false; render(); });
}

let lastRouteKey = "";
let renderDeferred = false;

function render() {
  if (!state.user) return;
  if (drag.active) { renderDeferred = true; return; }
  const route = parseRoute();
  watchPhotos(route.page === "counter" ? route.id : null);
  setActiveTab(route.page === "caps" ? "caps" : "home");
  if (!state.ready.categories || !state.ready.counters) return renderLoading();

  const key = location.hash || "#/";
  const sameRoute = key === lastRouteKey;
  lastRouteKey = key;
  const y = window.scrollY;

  if (route.page === "counter") {
    const c = counterById(route.id);
    if (!c) { location.replace("#/"); return; }
    renderCounter(c);
  } else if (route.page === "caps") {
    renderCaps();
  } else {
    renderHome();
  }
  window.scrollTo(0, sameRoute ? y : 0);
}

function renderLoading() {
  setHeader({ title: "Mes compteurs" });
  setFab(null);
  $("#view").innerHTML = `<div class="loading"><div class="brand-mark brand-mark--lg"><span></span><span></span><span></span><span></span></div></div>`;
}

/* =========================================================
   Accueil : compteurs par catégorie
   ========================================================= */

function nextCapOverall(now = Date.now()) {
  let best = null;
  for (const c of state.counters) {
    if (!isCd(c) && c.startAt > now) continue;
    const m = C.upcomingFor(c, now, 1)[0];
    if (m && (!best || m.at < best.m.at)) best = { c, m };
  }
  return best;
}

function renderHome() {
  setHeader({
    title: "Mes compteurs",
    actions: [{ icon: "fa-layer-group", label: "Catégories", onClick: openCategories }]
  });
  setFab({ icon: "fa-plus", label: "Nouveau compteur", onClick: () => openCounterEditor() });
  const view = $("#view");
  const now = Date.now();

  if (!state.counters.length) {
    view.innerHTML = `
      <p class="today-date">${esc(capitalize(fmtDate(now, { weekday: "long", day: "numeric", month: "long" })))}</p>
      <h2 class="display">Premier compteur</h2>
      <p class="lead">Choisis un point de départ. Tu pourras tout changer ensuite : nom, date, unités, catégorie.</p>
      <div class="template-list">
        ${TEMPLATES.map((t, i) => `
          <button type="button" class="template-card" data-template="${i}" style="--c:${t.data.color}">
            <span class="counter-badge"><i class="fa-solid fa-${t.data.icon}"></i></span>
            <span class="template-text"><strong>${esc(t.title)}</strong><span>${esc(t.text)}</span></span>
            <i class="fa-solid fa-chevron-right chevron"></i>
          </button>`).join("")}
        <button type="button" class="template-card" data-template="blank">
          <span class="counter-badge" style="--c:var(--ink)"><i class="fa-solid fa-plus"></i></span>
          <span class="template-text"><strong>Compteur vide</strong><span>Tout régler toi-même</span></span>
          <i class="fa-solid fa-chevron-right chevron"></i>
        </button>
      </div>`;
    $$("[data-template]", view).forEach(btn => btn.addEventListener("click", () => {
      const t = TEMPLATES[btn.dataset.template];
      openCounterEditor(null, t ? t.data : {});
    }));
    return;
  }

  const next = nextCapOverall(now);
  const groups = [
    ...state.categories.map(cat => ({ cat, items: countersIn(cat.id) })),
    { cat: null, items: countersIn(null) }
  ];

  view.innerHTML = `
    <p class="today-date">Aujourd’hui</p>
    <h2 class="display">${esc(capitalize(fmtDate(now, { weekday: "long", day: "numeric", month: "long" })))}</h2>
    ${next ? `<p class="next-up">Prochain cap : <strong>${esc(next.m.label)}</strong> pour « ${esc(next.c.name)} », ${esc(fmtIn(next.m.at, now))}.</p>` : ""}
    ${groups.map(g => sectionHtml(g.cat, g.items, now)).join("")}
    <p class="drag-hint">${matchMedia("(pointer: coarse)").matches ? "Maintiens un compteur appuyé pour le changer de catégorie." : "Fais glisser un compteur pour le changer de catégorie."}</p>`;

  bindCards(view);
}

function sectionHtml(cat, items, now) {
  const id = cat?.id || "";
  return `
    <section class="cat ${cat ? "" : "cat--uncat"}" style="--cat:${cat ? esc(cat.color) : "var(--muted)"}">
      <header class="cat-head">
        <span class="cat-dot"></span>
        <h3>${esc(cat ? cat.name : "Sans catégorie")}</h3>
        <span class="cat-count">${items.length}</span>
      </header>
      <div class="cat-list" data-cat="${esc(id)}">
        ${items.map(c => cardHtml(c, now)).join("")}
        <div class="cat-empty">Glisse un compteur ici</div>
      </div>
    </section>`;
}

function cardHtml(c, now) {
  const cd = isCd(c);
  const prev = !cd && c.startAt <= now ? C.previous(c.startAt, now) : null;
  const recent = prev && now - prev.at < RECENT_CAP;
  const jourJ = cd && cdState(c, now).today;
  return `
    <article class="counter-card" data-id="${esc(c.id)}" style="--c:${esc(c.color || COLORS[0])}" tabindex="0" aria-label="${esc(c.name)} : ${esc(unitsText(c, now))}">
      ${badgeHtml(c)}
      <div class="counter-main">
        <div class="counter-top">
          <strong class="counter-name">${esc(c.name)}</strong>
          ${recent ? `<span class="cap-pill"><i class="fa-solid fa-trophy"></i>${esc(prev.label)}</span>` : ""}
          ${jourJ ? `<span class="cap-pill"><i class="fa-solid fa-star"></i>Jour J</span>` : ""}
        </div>
        ${unitsHtml(c, now)}
        <span class="counter-since">${esc(whenLine(c, now))}</span>
      </div>
      ${!cd && c.resettable !== false ? `<button type="button" class="icon-btn counter-reset" data-reset aria-label="Remettre « ${esc(c.name)} » à zéro" title="Remettre à zéro"><i class="fa-solid fa-rotate-left"></i></button>` : "<span></span>"}
    </article>`;
}

function bindCards(root) {
  $$(".counter-card", root).forEach(card => {
    const id = card.dataset.id;
    card.addEventListener("pointerdown", onCardPointerDown);
    card.addEventListener("contextmenu", e => e.preventDefault());
    card.addEventListener("click", e => {
      if (e.target.closest("[data-reset]")) return;
      if (Date.now() < suppressClickUntil) return;
      location.hash = `#/c/${encodeURIComponent(id)}`;
    });
    card.addEventListener("keydown", e => {
      if (e.target !== card) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); location.hash = `#/c/${encodeURIComponent(id)}`; }
    });
    $("[data-reset]", card)?.addEventListener("click", e => {
      e.stopPropagation();
      const c = counterById(id);
      if (c) resetCounter(c);
    });
  });
}

/* =========================================================
   Glisser-déposer (souris : on glisse ; tactile : appui long puis on glisse)
   ========================================================= */

const LONG_PRESS = 380;
const drag = { active: false, pending: null };
let suppressClickUntil = 0;

// Pendant un déplacement tactile, on bloque le défilement natif de la page
document.addEventListener("touchmove", e => { if (drag.active) e.preventDefault(); }, { passive: false });

function onCardPointerDown(e) {
  if (e.button !== 0 || drag.active) return;
  if (e.target.closest("[data-reset]")) return;
  const card = e.currentTarget;
  const p = { card, id: card.dataset.id, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, type: e.pointerType, timer: null };
  drag.pending = p;
  if (p.type !== "mouse") {
    card.classList.add("is-pressing");
    p.timer = setTimeout(() => { if (drag.pending === p) startDrag(p); }, LONG_PRESS);
  }
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", onDragUp);
  document.addEventListener("pointercancel", onDragCancel);
}

function removeDragListeners() {
  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", onDragUp);
  document.removeEventListener("pointercancel", onDragCancel);
}

function cancelPending() {
  const p = drag.pending;
  if (!p) return;
  clearTimeout(p.timer);
  p.card.classList.remove("is-pressing");
  drag.pending = null;
}

function onDragMove(e) {
  if (drag.active) {
    drag.x = e.clientX; drag.y = e.clientY;
    positionGhost();
    updateDropTarget();
    return;
  }
  const p = drag.pending;
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  const dist = Math.hypot(p.x - p.x0, p.y - p.y0);
  if (p.type === "mouse") { if (dist > 6) startDrag(p); }
  else if (dist > 10) { cancelPending(); removeDragListeners(); }
}

function onDragUp() {
  if (drag.active) dropCard();
  else cancelPending();
  removeDragListeners();
}

function onDragCancel() {
  if (drag.active) endDrag();
  else cancelPending();
  removeDragListeners();
}

function startDrag(p) {
  clearTimeout(p.timer);
  drag.pending = null;
  const card = p.card;
  card.classList.remove("is-pressing");
  const r = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("counter-ghost");
  ghost.removeAttribute("data-id");
  ghost.style.width = `${r.width}px`;
  document.body.appendChild(ghost);
  card.classList.add("is-placeholder");
  Object.assign(drag, {
    active: true, card, id: p.id, ghost,
    dx: p.x - r.left, dy: p.y - r.top, x: p.x, y: p.y,
    fromCat: card.closest(".cat-list")?.dataset.cat || ""
  });
  document.body.classList.add("is-dragging");
  navigator.vibrate?.(12);
  positionGhost();
  updateDropTarget();
  drag.raf = requestAnimationFrame(autoScroll);
}

function positionGhost() {
  drag.ghost.style.left = `${drag.x - drag.dx}px`;
  drag.ghost.style.top = `${drag.y - drag.dy}px`;
}

function updateDropTarget() {
  const el = document.elementFromPoint(drag.x, drag.y);
  const list = el?.closest(".cat-list") || el?.closest(".cat")?.querySelector(".cat-list");
  if (!list) return;
  $$(".cat-list.is-target").forEach(l => { if (l !== list) l.classList.remove("is-target"); });
  list.classList.add("is-target");

  let before = null;
  for (const c of $$(".counter-card", list)) {
    if (c === drag.card) continue;
    const r = c.getBoundingClientRect();
    if (drag.y < r.top + r.height / 2) { before = c; break; }
  }
  const anchor = before || $(".cat-empty", list);
  if (drag.card.nextElementSibling !== anchor || drag.card.parentElement !== list) list.insertBefore(drag.card, anchor);
}

function autoScroll() {
  if (!drag.active) return;
  const top = 140, bottom = window.innerHeight - 150;
  let v = 0;
  if (drag.y < top) v = -(top - drag.y) / 5;
  else if (drag.y > bottom) v = (drag.y - bottom) / 5;
  if (v) {
    window.scrollBy(0, Math.max(-20, Math.min(20, v)));
    updateDropTarget();
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

function dropCard() {
  const list = drag.card.closest(".cat-list");
  const catId = list?.dataset.cat || null;
  const ids = list ? $$(".counter-card", list).map(c => c.dataset.id) : [];
  const moved = (drag.fromCat || null) !== catId;

  const batch = writeBatch(db);
  let changes = 0;
  ids.forEach((id, i) => {
    const c = counterById(id);
    if (!c) return;
    const upd = {};
    if ((categoryById(c.categoryId)?.id || null) !== catId) upd.categoryId = catId;
    if (c.order !== i) upd.order = i;
    if (Object.keys(upd).length) {
      Object.assign(c, upd); // affichage immédiat, sans attendre Firestore
      batch.update(userDoc("counters", id), upd);
      changes++;
    }
  });
  const name = catId ? categoryById(catId)?.name : "Sans catégorie";
  endDrag();
  if (changes) persist(batch.commit(), moved ? `Déplacé dans « ${name} »` : null);
}

function endDrag() {
  cancelAnimationFrame(drag.raf);
  drag.ghost?.remove();
  drag.card?.classList.remove("is-placeholder");
  $$(".cat-list.is-target").forEach(l => l.classList.remove("is-target"));
  document.body.classList.remove("is-dragging");
  Object.assign(drag, { active: false, card: null, ghost: null });
  suppressClickUntil = Date.now() + 400;
  renderDeferred = false;
  render();
}

/* =========================================================
   Page d'un compteur
   ========================================================= */

function renderCounter(c) {
  const now = Date.now();
  const cat = categoryById(c.categoryId);
  setHeader({
    title: c.name,
    kicker: cat ? cat.name : "Sans catégorie",
    back: "#/",
    actions: [{ icon: "fa-pen", label: "Modifier", onClick: () => openCounterEditor(c) }]
  });
  setFab(null);
  if (isCd(c)) return renderCountdown(c, now);
  const started = c.startAt <= now;
  const next = started ? C.upcoming(c.startAt, now, 1)[0] : null;
  const prev = started ? C.previous(c.startAt, now) : null;
  const prevAt = prev ? prev.at : c.startAt;
  const pct = next ? Math.min(100, Math.max(0, (now - prevAt) / (next.at - prevAt) * 100)) : 0;
  const passed = started ? C.milestones(c.startAt, now).reverse() : [];

  $("#view").innerHTML = `
    <section class="hero" style="--c:${esc(c.color || COLORS[0])}">
      ${coverHtml(c)}
      <span class="counter-badge counter-badge--lg"><i class="fa-solid fa-${esc(c.icon || "hourglass-half")}"></i></span>
      ${unitsHtml(c, now, "units--hero")}
      ${c.allDay ? "" : `<p class="ticker" data-ticker="${esc(c.id)}">${esc(tickerText(c, now))}</p>`}
      <p class="hero-since">${esc(`${started ? "Depuis" : "Démarre"} le ${c.allDay ? fmtDay(c.startAt) : fmtDateTime(c.startAt)}`)}</p>
    </section>

    ${next ? `
    <section class="card next-cap">
      <div class="next-cap-head">
        <strong>Prochain cap : ${esc(next.label)}</strong>
        <span class="muted">${esc(fmtIn(next.at, now))}, le ${esc(fmtDate(next.at))}</span>
      </div>
      <div class="bar bar--cap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Avancement vers ${esc(next.label)}"><span style="width:${pct.toFixed(1)}%"></span></div>
    </section>` : ""}

    ${c.resettable !== false ? `
    <div class="reset-zone">
      <button type="button" class="btn btn-danger-ghost btn-block" data-reset><i class="fa-solid fa-rotate-left"></i> Remettre à zéro</button>
    </div>` : ""}

    ${passed.length ? `
    <section class="block">
      <h3 class="block-title">Caps franchis</h3>
      <div class="chips">
        ${passed.slice(0, 8).map(m => `<span class="chip" title="${esc(fmtDate(m.at))}"><i class="fa-solid fa-trophy"></i>${esc(m.label)}</span>`).join("")}
        ${passed.length > 8 ? `<span class="chip">et ${passed.length - 8} de plus</span>` : ""}
      </div>
    </section>` : ""}

    ${photosHtml(c)}

    ${historyHtml(c, now)}`;

  const view = $("#view");
  bindPhotos(view, c);
  $("[data-reset]", view)?.addEventListener("click", () => resetCounter(c));
  $("[data-enable-history]", view)?.addEventListener("click", () => {
    persist(updateDoc(userDoc("counters", c.id), { history: true }), "Historique activé");
  });
  $$("[data-del-period]", view).forEach(btn => btn.addEventListener("click", () => deletePeriod(c, +btn.dataset.delPeriod)));
}

function renderCountdown(c, now) {
  const { target, d, today, past } = cdState(c, now);
  // Repère du « chemin parcouru » : l'occurrence précédente (annuel) ou la création du décompte
  const ref = c.repeat ? C.addMonths(target, -12) : Math.min(c.startAt || now, target);
  const pct = target > ref ? Math.min(100, Math.max(0, (now - ref) / (target - ref) * 100)) : 100;
  const next = C.upcomingFor(c, now, 1)[0];
  const showNext = next && next.n !== 0 && next.target === target;

  $("#view").innerHTML = `
    <section class="hero" style="--c:${esc(c.color || COLORS[0])}">
      ${coverHtml(c)}
      <span class="counter-badge counter-badge--lg"><i class="fa-solid fa-${esc(c.icon || "hourglass-half")}"></i></span>
      ${today || past ? `<p class="cd-done">${today ? "C’est aujourd’hui !" : "C’est passé."}</p>` : `
      <p class="cd-label">Encore</p>
      ${unitsHtml(c, now, "units--hero")}`}
      ${c.allDay || past ? "" : `<p class="ticker" data-ticker="${esc(c.id)}">${esc(tickerText(c, now))}</p>`}
      <p class="hero-since">${esc(`${past ? "C’était le" : "Jusqu’au"} ${c.allDay ? fmtDay(target) : fmtDateTime(target)}${c.repeat ? " · chaque année" : ""}`)}</p>
    </section>
    ${past ? `
    <section class="card next-cap">
      <p class="muted">Ce décompte est terminé. Choisis une nouvelle date, ou active « Chaque année » pour qu’il reparte tout seul.</p>
      <button type="button" class="btn btn-ghost btn-small" data-edit style="align-self:flex-start"><i class="fa-solid fa-pen"></i> Modifier la date</button>
    </section>` : `
    <section class="card next-cap" style="--c:${esc(c.color || COLORS[0])}">
      <div class="next-cap-head">
        <strong>${today ? "Jour J" : `J-${fmtInt(d)}`}</strong>
        <span class="muted">${Math.floor(pct)} % du chemin parcouru</span>
      </div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Chemin parcouru jusqu’au jour J"><span style="width:${pct.toFixed(1)}%"></span></div>
      ${showNext ? `<p class="muted">Prochaine étape : <strong>${esc(next.label)}</strong>, ${esc(fmtIn(next.at, now))}.</p>` : ""}
    </section>`}

    ${photosHtml(c)}`;

  $("[data-edit]", $("#view"))?.addEventListener("click", () => openCounterEditor(c));
  bindPhotos($("#view"), c);
}

function historyHtml(c, now) {
  if (!c.history) {
    return `
      <section class="block">
        <h3 class="block-title">Historique</h3>
        <div class="card">
          <p class="muted">Désactivé pour ce compteur. Active-le pour garder chaque série arrêtée par une remise à zéro et voir ton record.</p>
          <button type="button" class="btn btn-ghost btn-small" data-enable-history style="margin-top:12px"><i class="fa-solid fa-clock-rotate-left"></i> Activer l’historique</button>
        </div>
      </section>`;
  }
  const periods = (c.periods || []).map((p, i) => ({ ...p, i, len: p.end - p.start }));
  const curLen = Math.max(0, now - c.startAt);
  const pastBest = periods.reduce((m, p) => Math.max(m, p.len), 0);
  const best = Math.max(curLen, pastBest);
  const recordStart = curLen >= pastBest ? c.startAt : periods.find(p => p.len === pastBest).start;
  const recordEnd = recordStart + best;

  let note;
  if (!periods.length) note = `<p class="record-note">Aucune remise à zéro pour l’instant. Chaque série arrêtée apparaîtra ici.</p>`;
  else if (curLen >= pastBest) note = `<p class="record-note"><strong>Tu es sur ton record.</strong> La série en cours dépasse toutes les précédentes.</p>`;
  else note = `
    <p class="record-note">Encore <strong>${esc(fmtSpan(now, now + (pastBest - curLen)))}</strong> pour égaler ton record.</p>
    <div class="bar" style="margin-top:8px" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(curLen / pastBest * 100)}" aria-label="Avancement vers le record"><span style="width:${(curLen / pastBest * 100).toFixed(1)}%"></span></div>`;

  const sorted = [...periods].sort((a, b) => b.end - a.end);
  return `
    <section class="block" style="--c:${esc(c.color || COLORS[0])}">
      <h3 class="block-title">Historique</h3>
      <div class="stats">
        <div class="stat"><strong>${esc(fmtSpan(c.startAt, Math.max(now, c.startAt), true))}</strong><span>Série en cours</span></div>
        <div class="stat"><strong>${esc(fmtSpan(recordStart, recordEnd, true))}</strong><span>Record</span></div>
        <div class="stat"><strong>${periods.length}</strong><span>${plural(periods.length, "Remise à 0", "Remises à 0")}</span></div>
      </div>
      ${note}
      ${sorted.length ? `
      <ul class="period-list">
        ${sorted.map(p => `
          <li class="period ${p.len === pastBest && pastBest > curLen ? "period--record" : ""}">
            <div>
              <div class="period-len">${esc(fmtSpan(p.start, p.end))}</div>
              <div class="period-dates">${esc(fmtDate(p.start, { day: "numeric", month: "short", year: "numeric" }))} → ${esc(fmtDate(p.end, { day: "numeric", month: "short", year: "numeric" }))}</div>
            </div>
            <button type="button" class="icon-btn" data-del-period="${p.i}" aria-label="Supprimer cette série"><i class="fa-solid fa-trash-can"></i></button>
            <div class="bar"><span style="width:${best ? (p.len / best * 100).toFixed(1) : 0}%"></span></div>
          </li>`).join("")}
      </ul>` : ""}
    </section>`;
}

/* =========================================================
   Photos : illustration (miniature sur la carte) et suivi daté
   ========================================================= */

const MAX_DATA = 900000;  // taille max d'une image en base64 (un document Firestore fait 1 Mo au plus)
const FULL_SIDE = 1600;   // grand côté de l'image enregistrée
const THUMB_SIDE = 320;   // miniature carrée
const fullCache = new Map(); // photoId → image complète (data URL ou lien)

const photos = { cid: null, list: [], ready: false, unsub: null };

// Écoute les photos du compteur affiché (et seulement celui-là)
function watchPhotos(cid) {
  if (photos.cid === cid) return;
  photos.unsub?.();
  Object.assign(photos, { cid, list: [], ready: false, unsub: null });
  if (!cid || !state.user) return;
  photos.unsub = onSnapshot(photosCol(cid), snap => {
    if (photos.cid !== cid) return;
    photos.list = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => typeof p.takenAt === "number");
    photos.ready = true;
    scheduleRender();
  }, err => {
    console.error(err);
    photos.ready = true;
    toast(errorMessage(err), true);
  });
}

const createdMs = p => p.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
const sortedPhotos = () => [...photos.list].sort((a, b) => (b.takenAt - a.takenAt) || (createdMs(b) - createdMs(a)));
const photoById = id => photos.list.find(p => p.id === id) || null;
const photoSrc = p => p.kind === "link" ? p.url : (fullCache.get(p.id) || p.thumb);
const safeLink = u => /^https?:\/\//i.test(String(u || ""));

// Une image qui ne charge pas (lien mort) : on bascule sur l'affichage de secours
document.addEventListener("error", e => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.hasAttribute("data-fallback")) img.closest("[data-thumb]")?.classList.add("is-broken");
}, true);

// Date choisie → instant : aujourd'hui = maintenant (ordre des photos du jour), sinon midi
function dayToTime(day) {
  if (day === toLocalDay(Date.now())) return Date.now();
  return new Date(`${day}T12:00`).getTime();
}

/* ------------------------------------------------ Préparation des images */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}

function toJpeg(img, w, h, quality, crop) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // fond blanc pour les PNG transparents
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const [sx, sy, sw, sh] = crop || [0, 0, img.naturalWidth, img.naturalHeight];
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

// Réduit la photo (grand côté 1 600 px, JPEG) jusqu'à tenir dans un document Firestore,
// et prépare une miniature carrée.
async function processImage(file) {
  const { img, url } = await loadImage(file);
  try {
    const W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error("empty");
    let side = FULL_SIDE, q = 0.82, data = "";
    for (let i = 0; i < 10; i++) {
      const s = Math.min(1, side / Math.max(W, H));
      data = toJpeg(img, W * s, H * s, q);
      if (data.length <= MAX_DATA) break;
      if (q > 0.62) q -= 0.1; else side = Math.round(side * 0.8);
    }
    if (data.length > MAX_DATA) throw new Error("too-big");
    const sq = Math.min(W, H);
    const thumb = toJpeg(img, Math.min(THUMB_SIDE, sq), Math.min(THUMB_SIDE, sq), 0.72, [(W - sq) / 2, (H - sq) / 2, sq, sq]);
    const s = Math.min(1, side / Math.max(W, H));
    return { data, thumb, w: Math.round(W * s), h: Math.round(H * s) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Vérifie qu'un lien mène bien à une image affichable
function probeImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ""; resolve(false); }, 10000);
    img.referrerPolicy = "no-referrer";
    img.onload = () => { clearTimeout(timer); resolve(true); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = url;
  });
}

/* ------------------------------------------------ Sélecteur : appareil photo, galerie ou lien */

function mountPhotoPicker(box, { current = null, allowRemove = false, onChange = () => {} } = {}) {
  let pending = null;   // { kind: "file", data, thumb, w, h, fileDate } | { kind: "link", url }
  let removed = false;
  let mode = "idle";    // idle | link | busy
  let error = "";
  const touch = matchMedia("(pointer: coarse)").matches;

  const shown = () => pending ? (pending.thumb || pending.url) : (!removed && current?.src ? current.src : null);

  function draw() {
    const src = shown();
    const canRemove = allowRemove && !!src;
    box.innerHTML = `
      <div class="pp">
        ${src ? `
        <div class="pp-preview" data-thumb>
          <img src="${esc(src)}" alt="Aperçu" referrerpolicy="no-referrer" data-fallback>
          <span class="pp-broken"><i class="fa-solid fa-image"></i></span>
        </div>` : ""}
        ${mode === "busy" ? `<p class="muted pp-busy"><i class="fa-solid fa-spinner fa-spin"></i> Préparation de la photo…</p>`
        : mode === "link" ? `
        <div class="pp-link">
          <input type="url" inputmode="url" placeholder="https://…/photo.jpg" aria-label="Lien de l’image" data-pp-url autocomplete="off">
          <div class="pp-actions">
            <button type="button" class="btn btn-primary btn-small" data-pp-ok>Utiliser ce lien</button>
            <button type="button" class="btn btn-ghost btn-small" data-pp-cancel>Annuler</button>
          </div>
        </div>` : `
        <div class="pp-actions">
          ${touch ? `<button type="button" class="btn btn-ghost btn-small" data-pp-camera><i class="fa-solid fa-camera"></i> Prendre une photo</button>` : ""}
          <button type="button" class="btn btn-ghost btn-small" data-pp-file><i class="fa-solid fa-image"></i> ${touch ? "Galerie" : (src ? "Changer d’image" : "Choisir une image")}</button>
          <button type="button" class="btn btn-ghost btn-small" data-pp-link><i class="fa-solid fa-link"></i> Lien</button>
          ${canRemove ? `<button type="button" class="btn btn-danger-ghost btn-small" data-pp-remove><i class="fa-solid fa-xmark"></i> Retirer</button>` : ""}
        </div>`}
        <p class="field-error ${error ? "" : "hidden"}" role="alert">${esc(error)}</p>
        <input type="file" accept="image/*" capture="environment" hidden data-pp-in-camera>
        <input type="file" accept="image/*" hidden data-pp-in-file>
      </div>`;
    if (mode === "link") setTimeout(() => $("[data-pp-url]", box)?.focus(), 0);
  }

  async function takeFile(input) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.type && !file.type.startsWith("image/")) { error = "Ce fichier n’est pas une image."; draw(); return; }
    mode = "busy"; error = ""; draw();
    try {
      const r = await processImage(file);
      pending = { kind: "file", ...r, fileDate: file.lastModified || null };
      removed = false;
    } catch (err) {
      console.error(err);
      error = err.message === "too-big"
        ? "Cette image est trop lourde, même réduite. Essaie une autre photo."
        : "Impossible de lire cette image. Essaie une photo JPEG ou PNG.";
    }
    mode = "idle"; draw(); onChange(pending);
  }

  async function takeLink() {
    const raw = $("[data-pp-url]", box)?.value.trim() || "";
    let url;
    try { url = new URL(raw); } catch { url = null; }
    if (!url || !/^https?:$/.test(url.protocol) || raw.length > 2000) {
      error = "Colle un lien complet qui commence par https://"; draw(); return;
    }
    mode = "busy"; error = ""; draw();
    const ok = await probeImage(url.href);
    if (ok) { pending = { kind: "link", url: url.href }; removed = false; mode = "idle"; }
    else { error = "Ce lien n’affiche pas d’image. Il doit mener directement au fichier (.jpg, .png, .webp…)."; mode = "link"; }
    draw();
    if (mode === "link") $("[data-pp-url]", box).value = raw;
    onChange(pending);
  }

  box.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || mode === "busy") return;
    if (b.matches("[data-pp-camera]")) $("[data-pp-in-camera]", box).click();
    else if (b.matches("[data-pp-file]")) $("[data-pp-in-file]", box).click();
    else if (b.matches("[data-pp-link]")) { mode = "link"; error = ""; draw(); }
    else if (b.matches("[data-pp-cancel]")) { mode = "idle"; error = ""; draw(); }
    else if (b.matches("[data-pp-ok]")) takeLink();
    else if (b.matches("[data-pp-remove]")) { pending = null; removed = !!current; error = ""; draw(); onChange(null); }
  });
  box.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.matches("[data-pp-url]")) { e.preventDefault(); takeLink(); }
  });
  box.addEventListener("change", e => {
    if (e.target.matches("input[type=file]")) takeFile(e.target);
  });
  draw();

  return {
    get pending() { return pending; },
    get removed() { return removed && !pending; },
    get busy() { return mode === "busy"; },
    get dirty() { return !!pending || removed; }
  };
}

/* ------------------------------------------------ Écritures */

// Ajoute une photo au lot d'écritures ; renvoie la référence d'illustration correspondante
function addPhotoToBatch(batch, cid, pending, { takenAt, caption = "" }) {
  const pid = newId();
  const meta = { kind: pending.kind, takenAt, caption, createdAt: serverTimestamp() };
  if (pending.kind === "file") {
    Object.assign(meta, { thumb: pending.thumb, w: pending.w, h: pending.h });
    batch.set(photoFileDoc(cid, pid), { data: pending.data });
    fullCache.set(pid, pending.data);
  } else {
    meta.url = pending.url;
  }
  batch.set(photoDoc(cid, pid), meta);
  return coverRef({ id: pid, ...meta });
}

const coverRef = p => ({ photoId: p.id, kind: p.kind, src: p.kind === "link" ? p.url : p.thumb });

async function photoFull(cid, p) {
  if (p.kind === "link") return p.url;
  if (fullCache.has(p.id)) return fullCache.get(p.id);
  const snap = await getDoc(photoFileDoc(cid, p.id));
  const data = snap.exists() ? snap.data().data : null;
  if (data) fullCache.set(p.id, data);
  return data;
}

// Firestore ne supprime pas les sous-collections avec le document parent
async function deleteCounterPhotos(cid) {
  const jobs = [];
  for (const col of [photosCol(cid), photoFilesCol(cid)]) {
    const snap = await getDocs(col);
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach(d => b.delete(d.ref));
      jobs.push(b.commit());
    }
  }
  await Promise.all(jobs);
}

/* ------------------------------------------------ Affichage */

// Pastille de la carte : la miniature d'illustration, sinon l'icône
function badgeHtml(c) {
  const icon = `<i class="fa-solid fa-${esc(c.icon || "hourglass-half")}"></i>`;
  if (!c.cover?.src) return `<span class="counter-badge">${icon}</span>`;
  return `
    <span class="counter-badge counter-thumb" data-thumb>
      ${icon}
      <img src="${esc(c.cover.src)}" alt="" loading="lazy" referrerpolicy="no-referrer" draggable="false" data-fallback>
      <span class="thumb-dot">${icon}</span>
    </span>`;
}

function coverHtml(c) {
  if (!c.cover?.src) return "";
  const src = fullCache.get(c.cover.photoId) || c.cover.src;
  return `
    <button type="button" class="hero-cover" data-thumb data-open-cover aria-label="Voir la photo d’illustration">
      <img src="${esc(src)}" alt="" referrerpolicy="no-referrer" data-fallback data-cover-img>
      <span class="pp-broken"><i class="fa-solid fa-image"></i> Image introuvable</span>
    </button>`;
}

function photosHtml(c) {
  const mine = photos.cid === c.id;
  const list = mine ? sortedPhotos() : [];
  const loading = mine && !photos.ready;
  const tiles = list.map(p => {
    const isCover = c.cover?.photoId === p.id;
    const date = fmtDate(p.takenAt, { day: "numeric", month: "short", year: "numeric" });
    return `
      <li>
        <button type="button" class="photo-tile" data-photo="${esc(p.id)}" data-thumb aria-label="Photo du ${esc(fmtDate(p.takenAt))}${p.caption ? ` : ${esc(p.caption)}` : ""}">
          <img src="${esc(p.kind === "link" ? p.url : p.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback>
          <span class="pp-broken"><i class="fa-solid fa-image"></i></span>
          ${isCover ? `<span class="photo-star" title="Photo d’illustration"><i class="fa-solid fa-star"></i></span>` : ""}
          ${p.kind === "link" ? `<span class="photo-kind" title="Photo en lien"><i class="fa-solid fa-link"></i></span>` : ""}
          <span class="photo-date">${esc(date)}</span>
        </button>
      </li>`;
  }).join("");
  return `
    <section class="block" style="--c:${esc(c.color || COLORS[0])}">
      <div class="block-head">
        <h3 class="block-title">Photos${list.length ? ` <span class="cat-count">${list.length}</span>` : ""}</h3>
        <button type="button" class="btn btn-ghost btn-small" data-add-photo><i class="fa-solid fa-plus"></i> Ajouter une photo</button>
      </div>
      ${loading ? `<p class="muted">Chargement des photos…</p>`
      : list.length ? `<ul class="photo-grid">${tiles}</ul>`
      : `<div class="card"><p class="muted">Aucune photo pour l’instant. Ajoute une photo d’illustration, ou des photos de suivi datées pour voir l’évolution au fil du temps.</p></div>`}
    </section>`;
}

function bindPhotos(view, c) {
  $("[data-add-photo]", view)?.addEventListener("click", () => openPhotoAdder(c));
  $$("[data-photo]", view).forEach(btn => btn.addEventListener("click", () => {
    const p = photoById(btn.dataset.photo);
    if (p) openPhotoViewer(c, p);
  }));
  $("[data-open-cover]", view)?.addEventListener("click", () => {
    const p = photoById(c.cover?.photoId);
    if (p) openPhotoViewer(c, p);
    else if (!photos.ready) toast("Photos en cours de chargement…");
    else toast("Cette photo ne fait plus partie de la galerie.");
  });
  // Image complète de l'illustration, à la place de la miniature
  const cover = c.cover;
  if (cover?.kind === "file" && !fullCache.has(cover.photoId)) {
    photoFull(c.id, { id: cover.photoId, kind: "file" }).then(src => {
      const img = $("[data-cover-img]", view);
      if (src && img && img.isConnected && counterById(c.id)?.cover?.photoId === cover.photoId) img.src = src;
    }).catch(err => console.error(err));
  }
}

/* ------------------------------------------------ Ajouter une photo */

function openPhotoAdder(c) {
  const today = toLocalDay(Date.now());
  let picker = null;
  openSheet({
    title: "Ajouter une photo",
    body: `
      <div class="form">
        <div class="field">
          <span class="field-label">Photo</span>
          <div data-picker></div>
        </div>
        <label class="field">
          <span class="field-label">Date</span>
          <input type="date" name="day" value="${today}" max="${today}">
          <span class="hint" data-day-hint>Aujourd’hui par défaut. Choisis une date passée pour une photo plus ancienne.</span>
        </label>
        <label class="field">
          <span class="field-label">Légende (facultatif)</span>
          <input name="caption" maxlength="140" placeholder="Ex. Premier footing" autocomplete="off">
        </label>
        <div class="switch-list">
          ${switchRow("cover", "Photo d’illustration", "En miniature sur la carte et en tête de la page du compteur.", !c.cover)}
        </div>
        <p class="field-error hidden" data-error role="alert"></p>
      </div>`,
    footer: `<button type="button" class="btn btn-primary btn-block" data-save>Ajouter la photo</button>`,
    isDirty: () => !!picker?.pending,
    onMount(el, entry) {
      const day = $("[name=day]", el);
      const caption = $("[name=caption]", el);
      const hint = $("[data-day-hint]", el);
      const defaultHint = hint.textContent;

      picker = mountPhotoPicker($("[data-picker]", el), {
        onChange(p) {
          // Photo de la galerie plus ancienne : on propose sa date
          const fd = p?.kind === "file" ? p.fileDate : null;
          if (fd && toLocalDay(fd) !== day.value && fd <= Date.now()) {
            hint.innerHTML = `${esc(defaultHint)} <button type="button" class="inline-link" data-use-file-date>Utiliser la date du fichier (${esc(fmtDate(fd))})</button>`;
            $("[data-use-file-date]", hint).addEventListener("click", () => { day.value = toLocalDay(fd); hint.textContent = defaultHint; });
          } else {
            hint.textContent = defaultHint;
          }
        }
      });

      $("[data-save]", el).addEventListener("click", () => {
        const err = $("[data-error]", el);
        const fail = msg => { err.textContent = msg; err.classList.remove("hidden"); };
        if (picker.busy) return fail("La photo est en cours de préparation, patiente un instant.");
        if (!picker.pending) return fail("Prends une photo, choisis-en une ou colle un lien.");
        if (!day.value) return fail("Indique la date de la photo.");
        if (day.value > toLocalDay(Date.now())) return fail("La date ne peut pas être dans le futur.");

        const batch = writeBatch(db);
        const ref = addPhotoToBatch(batch, c.id, picker.pending, { takenAt: dayToTime(day.value), caption: caption.value.trim() });
        if ($("[name=cover]", el).checked) batch.update(userDoc("counters", c.id), { cover: ref });
        entry.close(() => persist(batch.commit(), "Photo ajoutée"));
      });
    }
  });
}

/* ------------------------------------------------ Voir, modifier, supprimer une photo */

function openPhotoViewer(c, p) {
  const today = toLocalDay(Date.now());
  const isCover = c.cover?.photoId === p.id;
  const dayN = !isCd(c) && p.takenAt >= c.startAt ? C.fullDays(c.startAt, p.takenAt) + 1 : null;
  const initialDay = toLocalDay(p.takenAt);
  const initialCaption = p.caption || "";

  openSheet({
    title: capitalize(fmtDate(p.takenAt)),
    body: `
      <figure class="photo-full" data-thumb>
        <img src="${esc(photoSrc(p))}" alt="${esc(p.caption || "")}" referrerpolicy="no-referrer" data-fallback data-full>
        <span class="pp-broken"><i class="fa-solid fa-image"></i> Image introuvable${p.kind === "link" ? " : le lien ne répond plus" : ""}</span>
      </figure>
      <p class="photo-meta">
        ${esc(capitalize(fmtDay(p.takenAt)))}${dayN ? `, jour ${esc(fmtInt(dayN))} du compteur` : ""}
        ${p.kind === "link" && safeLink(p.url) ? `<br><a class="inline-link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> Ouvrir le lien d’origine</a>` : ""}
      </p>
      <div class="form">
        <label class="field">
          <span class="field-label">Date</span>
          <input type="date" name="day" value="${initialDay}" max="${today}">
        </label>
        <label class="field">
          <span class="field-label">Légende</span>
          <input name="caption" maxlength="140" value="${esc(initialCaption)}" placeholder="Facultatif" autocomplete="off">
        </label>
        <div class="switch-list">
          ${switchRow("cover", "Photo d’illustration", "En miniature sur la carte et en tête de la page du compteur.", isCover)}
        </div>
        <p class="field-error hidden" data-error role="alert"></p>
      </div>`,
    footer: `
      <div class="foot-actions">
        <button type="button" class="btn btn-danger-ghost" data-del><i class="fa-solid fa-trash-can"></i> Supprimer</button>
        <button type="button" class="btn btn-primary" data-save>Enregistrer</button>
      </div>`,
    isDirty: () => {
      const el = sheetStack[sheetStack.length - 1]?.el;
      if (!el) return false;
      return $("[name=day]", el).value !== initialDay
        || $("[name=caption]", el).value !== initialCaption
        || $("[name=cover]", el).checked !== isCover;
    },
    onMount(el, entry) {
      if (p.kind === "file" && !fullCache.has(p.id)) {
        photoFull(c.id, p).then(src => {
          const img = $("[data-full]", el);
          if (src && img?.isConnected) img.src = src;
        }).catch(err => console.error(err));
      }

      $("[data-save]", el).addEventListener("click", () => {
        const day = $("[name=day]", el).value;
        const caption = $("[name=caption]", el).value.trim();
        const cover = $("[name=cover]", el).checked;
        const err = $("[data-error]", el);
        if (!day) { err.textContent = "Indique la date de la photo."; err.classList.remove("hidden"); return; }
        if (day > toLocalDay(Date.now())) { err.textContent = "La date ne peut pas être dans le futur."; err.classList.remove("hidden"); return; }

        const batch = writeBatch(db);
        const upd = {};
        if (day !== initialDay) upd.takenAt = dayToTime(day);
        if (caption !== initialCaption) upd.caption = caption;
        if (Object.keys(upd).length) batch.update(photoDoc(c.id, p.id), upd);
        if (cover && !isCover) batch.update(userDoc("counters", c.id), { cover: coverRef(p) });
        if (!cover && isCover) batch.update(userDoc("counters", c.id), { cover: null });
        const changed = Object.keys(upd).length || cover !== isCover;
        entry.close(() => { if (changed) persist(batch.commit(), "Photo enregistrée"); });
      });

      $("[data-del]", el).addEventListener("click", async () => {
        const ok = await confirmDialog("Supprimer cette photo ?", {
          detail: `Photo du ${fmtDate(p.takenAt)}.${isCover ? " C’est la photo d’illustration : la carte retrouvera son icône." : ""}`,
          confirmLabel: "Supprimer", danger: true
        });
        if (!ok) return;
        const batch = writeBatch(db);
        batch.delete(photoDoc(c.id, p.id));
        if (p.kind === "file") batch.delete(photoFileDoc(c.id, p.id));
        if (counterById(c.id)?.cover?.photoId === p.id) batch.update(userDoc("counters", c.id), { cover: null });
        fullCache.delete(p.id);
        entry.close(() => persist(batch.commit(), "Photo supprimée"));
      });
    }
  });
}

/* =========================================================
   Actions sur un compteur
   ========================================================= */

async function resetCounter(c) {
  const now = Date.now();
  const running = c.startAt < now ? fmtSpan(c.startAt, now) : null;
  const ok = await confirmDialog(`Remettre « ${c.name} » à zéro ?`, {
    detail: `${running ? `La série en cours (${running}) s’arrête et le` : "Le"} compteur repart de maintenant.${c.history ? " La série sera gardée dans l’historique." : " Elle ne sera pas conservée."}`,
    confirmLabel: "Remettre à zéro",
    danger: true
  });
  if (!ok) return;
  const at = Date.now();
  const upd = { startAt: c.allDay ? C.startOfDay(at) : at, lastResetAt: at };
  if (c.history && c.startAt < at) upd.periods = [...(c.periods || []), { start: c.startAt, end: at }];
  Object.assign(c, upd);
  scheduleRender();
  persist(updateDoc(userDoc("counters", c.id), upd), "Compteur remis à zéro");
}

async function deletePeriod(c, index) {
  const p = (c.periods || [])[index];
  if (!p) return;
  const ok = await confirmDialog("Supprimer cette série de l’historique ?", {
    detail: `${fmtSpan(p.start, p.end)}, du ${fmtDate(p.start)} au ${fmtDate(p.end)}.`,
    confirmLabel: "Supprimer", danger: true
  });
  if (!ok) return;
  const periods = (c.periods || []).filter((_, i) => i !== index);
  persist(updateDoc(userDoc("counters", c.id), { periods }), "Série supprimée");
}

async function deleteCounter(c, entry) {
  const ok = await confirmDialog(`Supprimer « ${c.name} » ?`, {
    detail: "Le compteur, son historique et ses photos disparaissent définitivement.",
    confirmLabel: "Supprimer", danger: true
  });
  if (!ok) return;
  entry.close(() => {
    if (parseRoute().id === c.id) location.replace("#/");
    persist(Promise.all([deleteDoc(userDoc("counters", c.id)), deleteCounterPhotos(c.id)]), "Compteur supprimé");
  });
}

/* =========================================================
   Éditeur de compteur
   ========================================================= */

function switchRow(name, title, text, checked) {
  return `
    <label class="switch-row">
      <span class="switch-text"><strong>${esc(title)}</strong><span>${esc(text)}</span></span>
      <span class="switch"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}><span></span></span>
    </label>`;
}

function openCounterEditor(counter = null, preset = {}) {
  const base = counter || {
    name: "", icon: "hourglass-half", color: COLORS[0], categoryId: null,
    mode: "since", startAt: C.startOfDay(Date.now()), allDay: true, repeat: false,
    units: ["days"], display: "totals",
    resettable: true, history: false, notify: true,
    ...preset
  };
  const cdBase = isCd(base);
  // Les anciens compteurs (sans allDay) restent à l'heure près
  const allDay = !!base.allDay;
  const when = cdBase ? (base.targetAt ?? nextAnnual(11, 25)) : base.startAt;
  const units = unitsOf(base);
  const catId = categoryById(base.categoryId)?.id || "";
  const body = `
    <form class="form" novalidate>
      <fieldset class="field">
        <legend class="field-label">Type</legend>
        <div class="seg">
          <label><input type="radio" name="mode" value="since" ${cdBase ? "" : "checked"}><span>Depuis une date</span></label>
          <label><input type="radio" name="mode" value="countdown" ${cdBase ? "checked" : ""}><span>Jusqu’à une date</span></label>
        </div>
      </fieldset>

      <label class="field">
        <span class="field-label">Nom</span>
        <input name="name" value="${esc(base.name)}" maxlength="60" placeholder="${base.icon === "baby" ? "Ex. Naissance de Léa" : "Ex. Sans alcool"}" autocomplete="off" required>
      </label>

      <div class="field">
        <span class="field-label" data-when-label>${cdBase ? "Date visée" : "Point de départ"}</span>
        <div class="quick-dates ${cdBase ? "" : "hidden"}" data-quick>
          ${QUICK_DATES.map((q, i) => `<button type="button" class="quick-date" data-quick-i="${i}"><i class="fa-solid fa-${q.icon}"></i>${esc(q.name)}</button>`).join("")}
        </div>
        <input name="day" type="date" value="${toLocalDay(when)}" aria-label="Jour" class="${allDay ? "" : "hidden"}">
        <input name="datetime" type="datetime-local" value="${toLocalInput(when)}" aria-label="Jour et heure" class="${allDay ? "hidden" : ""}">
        <span class="hint" data-when-hint>${cdBase ? "Le décompte se fait en jours jusqu’à cette date." : "Une date passée fonctionne aussi, comme une naissance."}</span>
      </div>

      <div class="switch-list">
        ${switchRow("timed", "Heure précise", "Sinon, on compte à la journée.", !allDay)}
        <div data-only-cd class="${cdBase ? "" : "hidden"}">
          ${switchRow("repeat", "Chaque année", "Une fois le jour J passé, le décompte repart pour l’année suivante.", !!base.repeat)}
        </div>
      </div>

      <fieldset class="field">
        <legend class="field-label">Afficher en</legend>
        <div class="unit-chips">
          ${UNIT_ASC.map(u => `
            <label class="unit-chip"><input type="checkbox" name="units" value="${u}" ${units.includes(u) ? "checked" : ""}><span>${UNITS[u].label}</span></label>`).join("")}
        </div>
      </fieldset>

      <fieldset class="field">
        <legend class="field-label">Présentation</legend>
        <div class="seg">
          <label><input type="radio" name="display" value="totals" ${base.display !== "breakdown" ? "checked" : ""}><span>Chaque total</span></label>
          <label><input type="radio" name="display" value="breakdown" ${base.display === "breakdown" ? "checked" : ""}><span>Décomposé</span></label>
        </div>
        <p class="preview" data-preview aria-live="polite"></p>
      </fieldset>

      <label class="field">
        <span class="field-label">Catégorie</span>
        <select name="category">
          <option value="">Sans catégorie</option>
          ${state.categories.map(cat => `<option value="${esc(cat.id)}" ${cat.id === catId ? "selected" : ""}>${esc(cat.name)}</option>`).join("")}
          <option value="__new">Nouvelle catégorie…</option>
        </select>
      </label>
      <label class="field hidden" data-newcat>
        <span class="field-label">Nom de la nouvelle catégorie</span>
        <input name="newCategory" maxlength="40" placeholder="Ex. Santé" autocomplete="off">
      </label>

      <fieldset class="field">
        <legend class="field-label">Icône</legend>
        <div class="icon-grid">
          ${ICONS.map(ic => `
            <label class="icon-choice" title="${ic}"><input type="radio" name="icon" value="${ic}" ${ic === base.icon ? "checked" : ""}><span><i class="fa-solid fa-${ic}"></i></span></label>`).join("")}
        </div>
      </fieldset>

      <fieldset class="field">
        <legend class="field-label">Couleur</legend>
        <div class="color-row">
          ${COLORS.map(col => `
            <label class="color-choice"><input type="radio" name="color" value="${col}" ${col === base.color ? "checked" : ""} aria-label="Couleur ${col}"><span style="--sw:${col}"></span></label>`).join("")}
        </div>
      </fieldset>

      <div class="field">
        <span class="field-label">Photo d’illustration</span>
        <div data-cover-picker></div>
        <span class="hint">Affichée en miniature sur la carte. Elle rejoint aussi les photos du compteur, à la date du jour.</span>
      </div>

      <div class="switch-list">
        <div data-only-since class="${cdBase ? "hidden" : ""}">
          ${switchRow("resettable", "Remise à zéro", "Un bouton pour repartir de zéro, avec confirmation.", base.resettable !== false)}
          ${switchRow("history", "Historique des séries", "Garde chaque série arrêtée et affiche ton record.", !!base.history)}
        </div>
        ${switchRow("notify", "Notifier les étapes", cdBase ? "J-30, J-7, J-1 et le jour J." : "100 jours, 1 an, 1 000 jours…", base.notify !== false)}
      </div>

      <p class="field-error hidden" data-error role="alert"></p>
      ${counter ? `<button type="button" class="btn btn-danger-ghost btn-block danger-zone" data-delete><i class="fa-solid fa-trash-can"></i> Supprimer ${cdBase ? "ce décompte" : "ce compteur"}</button>` : ""}
    </form>`;

  const footer = `<button type="button" class="btn btn-primary btn-block" data-save>${counter ? "Enregistrer" : "Créer"}</button>`;
  let initial = "";
  let picker = null;
  const serialize = form => JSON.stringify([...new FormData(form).entries()]);

  openSheet({
    title: counter ? (cdBase ? "Modifier le décompte" : "Modifier le compteur") : "Nouveau compteur",
    body, footer,
    isDirty: () => serialize($("form", sheetStack[sheetStack.length - 1].el)) !== initial || !!picker?.dirty,
    onMount(el, entry) {
      const form = $("form", el);
      const f = form.elements;
      initial = serialize(form);
      picker = mountPhotoPicker($("[data-cover-picker]", form), { current: counter?.cover || null, allowRemove: true });

      const readUnits = () => $$("input[name=units]:checked", form).map(i => i.value);
      const mode = () => f.mode.value === "countdown" ? "countdown" : "since";
      // Jour seul → minuit, heure locale
      const readWhen = () => f.timed.checked
        ? new Date(f.datetime.value).getTime()
        : (f.day.value ? new Date(`${f.day.value}T00:00`).getTime() : NaN);

      const syncMode = () => {
        const cd = mode() === "countdown";
        $("[data-when-label]", form).textContent = cd ? "Date visée" : "Point de départ";
        $("[data-when-hint]", form).textContent = cd
          ? "Le décompte se fait en jours jusqu’à cette date."
          : "Une date passée fonctionne aussi, comme une naissance.";
        $("[data-quick]", form).classList.toggle("hidden", !cd);
        $("[data-only-cd]", form).classList.toggle("hidden", !cd);
        $("[data-only-since]", form).classList.toggle("hidden", cd);
        $("input[name=notify]", form).closest(".switch-row").querySelector(".switch-text span").textContent =
          cd ? "J-30, J-7, J-1 et le jour J." : "100 jours, 1 an, 1 000 jours…";
        f.name.placeholder = cd ? "Ex. Vacances d’été" : "Ex. Sans alcool";
      };

      const syncTimed = () => {
        const timed = f.timed.checked;
        if (timed && f.day.value) {
          // Compteur démarré aujourd'hui : l'heure actuelle ; sinon minuit
          const isToday = f.day.value === toLocalDay(Date.now());
          const hhmm = isToday && mode() === "since" ? toLocalInput(Date.now()).slice(11) : "00:00";
          f.datetime.value = `${f.day.value}T${hhmm}`;
        } else if (!timed && f.datetime.value) {
          f.day.value = f.datetime.value.slice(0, 10);
        }
        f.day.classList.toggle("hidden", timed);
        f.datetime.classList.toggle("hidden", !timed);
      };

      const updatePreview = () => {
        const t = readWhen();
        const us = readUnits();
        const prev = $("[data-preview]", form);
        if (!us.length) { prev.textContent = "Choisis au moins une unité."; return; }
        if (Number.isNaN(t)) { prev.textContent = "Indique une date."; return; }
        const now = Date.now();
        const sample = { units: us, display: f.display.value, allDay: !f.timed.checked };
        if (mode() === "countdown") {
          const c = { ...sample, mode: "countdown", targetAt: t, repeat: f.repeat.checked };
          const st = cdState(c, now);
          if (st.past) { prev.textContent = "Cette date est passée : choisis une date à venir ou active « Chaque année »."; return; }
          prev.textContent = st.today ? "C’est aujourd’hui : jour J !" : `Aujourd’hui : J-${fmtInt(st.d)}, ${unitsText(c, now)}`;
          return;
        }
        const start = t <= now ? t : now - (1234 * C.DAY + 5 * C.HOUR);
        prev.textContent = `${t <= now ? "Aujourd’hui" : "Par exemple"} : ${unitsText({ ...sample, startAt: start }, now)}`;
      };

      form.addEventListener("input", updatePreview);
      form.addEventListener("change", e => {
        if (e.target.name === "mode") syncMode();
        if (e.target.name === "timed") syncTimed();
        updatePreview();
      });
      updatePreview();

      // Raccourcis : Noël, Nouvel an…
      $$("[data-quick-i]", form).forEach(btn => btn.addEventListener("click", () => {
        const q = QUICK_DATES[+btn.dataset.quickI];
        const t = nextAnnual(q.month, q.day);
        f.day.value = toLocalDay(t);
        f.datetime.value = toLocalInput(t);
        const name = f.name.value.trim();
        if (!name || QUICK_DATES.some(x => x.name === name)) f.name.value = q.name;
        f.repeat.checked = true;
        const ic = $(`input[name=icon][value="${q.icon}"]`, form);
        if (ic) ic.checked = true;
        updatePreview();
      }));

      f.category.addEventListener("change", () => {
        const isNew = f.category.value === "__new";
        $("[data-newcat]", form).classList.toggle("hidden", !isNew);
        if (isNew) f.newCategory.focus();
      });

      $("[data-delete]", form)?.addEventListener("click", () => deleteCounter(counter, entry));
      form.addEventListener("submit", e => { e.preventDefault(); save(); });
      $("[data-save]", el).addEventListener("click", save);
      if (!counter) setTimeout(() => f.name.focus(), 260);

      function fail(msg, input) {
        const err = $("[data-error]", form);
        err.textContent = msg;
        err.classList.remove("hidden");
        $$("[aria-invalid]", form).forEach(i => i.removeAttribute("aria-invalid"));
        if (input) { input.setAttribute("aria-invalid", "true"); input.focus(); }
      }

      function save() {
        const name = f.name.value.trim();
        const t = readWhen();
        const us = readUnits();
        const cd = mode() === "countdown";
        const timed = f.timed.checked;
        if (!name) return fail(cd ? "Donne un nom au décompte." : "Donne un nom au compteur.", f.name);
        if (Number.isNaN(t)) return fail("Indique une date valide.", timed ? f.datetime : f.day);
        if (!us.length) return fail("Choisis au moins une unité d’affichage.");

        if (picker.busy) return fail("La photo est en cours de préparation, patiente un instant.");

        const batch = writeBatch(db);
        const counterId = counter ? counter.id : newId();
        let categoryId = f.category.value || null;
        if (categoryId === "__new") {
          const catName = f.newCategory.value.trim();
          if (!catName) return fail("Donne un nom à la nouvelle catégorie.", f.newCategory);
          categoryId = newId();
          batch.set(userDoc("categories", categoryId), {
            name: catName,
            color: COLORS[state.categories.length % COLORS.length],
            order: state.categories.reduce((m, c) => Math.max(m, (c.order ?? 0) + 1), 0),
            createdAt: serverTimestamp()
          });
        }

        const data = {
          name,
          mode: cd ? "countdown" : "since",
          allDay: !timed,
          repeat: cd && f.repeat.checked,
          units: UNIT_ASC.filter(u => us.includes(u)),
          display: f.display.value === "breakdown" ? "breakdown" : "totals",
          icon: f.icon.value || "hourglass-half",
          color: f.color.value || COLORS[0],
          categoryId,
          resettable: f.resettable.checked,
          history: f.history.checked,
          notify: f.notify.checked
        };
        if (cd) {
          data.targetAt = t;
          // Pour un décompte, startAt = sa création (repère du « chemin parcouru » et des notifications)
          data.startAt = counter && isCd(counter) ? counter.startAt : Date.now();
        } else {
          data.startAt = t;
        }

        if (picker.pending) data.cover = addPhotoToBatch(batch, counterId, picker.pending, { takenAt: Date.now() });
        else if (picker.removed) data.cover = null;

        if (counter) {
          if ((categoryById(counter.categoryId)?.id || null) !== categoryId) data.order = nextOrder(categoryId);
          batch.update(userDoc("counters", counter.id), data);
        } else {
          batch.set(userDoc("counters", counterId), {
            ...data,
            order: nextOrder(categoryId),
            periods: [],
            createdAt: serverTimestamp()
          });
        }
        const what = cd ? "Décompte" : "Compteur";
        entry.close(() => persist(batch.commit(), counter ? `${what} enregistré` : `${what} créé`));
      }

      syncMode();
    }
  });
}

/* =========================================================
   Catégories
   ========================================================= */

function openCategories() {
  let rows = state.categories.map(c => ({ id: c.id, name: c.name, color: c.color || COLORS[0], isNew: false }));
  const removed = [];
  const initial = JSON.stringify(rows);

  const rowsHtml = () => rows.length
    ? rows.map((r, i) => `
      <div class="cat-row" data-row="${i}">
        <button type="button" class="cat-color" style="--sw:${esc(r.color)}" data-color aria-label="Changer la couleur" title="Changer la couleur"></button>
        <input value="${esc(r.name)}" maxlength="40" placeholder="Nom de la catégorie" aria-label="Nom de la catégorie" data-name>
        <div class="cat-row-tools">
          <button type="button" class="icon-btn" data-up aria-label="Monter" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" class="icon-btn" data-down aria-label="Descendre" ${i === rows.length - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
          <button type="button" class="icon-btn icon-btn--danger" data-remove aria-label="Supprimer"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`).join("")
    : `<p class="muted">Aucune catégorie. Les compteurs sont rangés dans « Sans catégorie ».</p>`;

  openSheet({
    title: "Catégories",
    body: `
      <p class="muted">Pour ranger un compteur, fais-le glisser d’une catégorie à l’autre sur l’accueil, ou choisis sa catégorie dans ses réglages.</p>
      <div class="cat-rows" data-rows>${rowsHtml()}</div>
      <button type="button" class="btn btn-ghost btn-small" data-add style="align-self:flex-start"><i class="fa-solid fa-plus"></i> Ajouter une catégorie</button>
      <p class="field-error hidden" data-error role="alert"></p>`,
    footer: `<button type="button" class="btn btn-primary btn-block" data-save>Enregistrer</button>`,
    isDirty: () => { readInputs(); return JSON.stringify(rows) !== initial || removed.length > 0; },
    onMount(el, entry) {
      const wrap = $("[data-rows]", el);
      const redraw = () => { wrap.innerHTML = rowsHtml(); };

      wrap.addEventListener("click", async e => {
        const rowEl = e.target.closest("[data-row]");
        if (!rowEl) return;
        readInputs();
        const i = +rowEl.dataset.row;
        if (e.target.closest("[data-color]")) {
          rows[i].color = COLORS[(COLORS.indexOf(rows[i].color) + 1) % COLORS.length];
        } else if (e.target.closest("[data-up]") && i > 0) {
          [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
        } else if (e.target.closest("[data-down]") && i < rows.length - 1) {
          [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
        } else if (e.target.closest("[data-remove]")) {
          const n = rows[i].isNew ? 0 : countersIn(rows[i].id).length;
          if (n) {
            const ok = await confirmDialog(`Supprimer « ${rows[i].name || "cette catégorie"} » ?`, {
              detail: `${n} ${plural(n, "compteur passera", "compteurs passeront")} dans « Sans catégorie ». Aucun compteur n’est supprimé.`,
              confirmLabel: "Supprimer", danger: true
            });
            if (!ok) return;
          }
          if (!rows[i].isNew) removed.push(rows[i].id);
          rows.splice(i, 1);
        } else return;
        redraw();
      });

      $("[data-add]", el).addEventListener("click", () => {
        readInputs();
        rows.push({ id: newId(), name: "", color: COLORS[rows.length % COLORS.length], isNew: true });
        redraw();
        $$("[data-name]", wrap).pop()?.focus();
      });

      $("[data-save]", el).addEventListener("click", () => {
        readInputs();
        const err = $("[data-error]", el);
        if (rows.some(r => !r.name.trim())) {
          err.textContent = "Chaque catégorie a besoin d’un nom.";
          err.classList.remove("hidden");
          return;
        }
        const batch = writeBatch(db);
        rows.forEach((r, order) => {
          const data = { name: r.name.trim(), color: r.color, order };
          if (r.isNew) batch.set(userDoc("categories", r.id), { ...data, createdAt: serverTimestamp() });
          else batch.update(userDoc("categories", r.id), data);
        });
        let base = nextOrder(null);
        removed.forEach(id => {
          batch.delete(userDoc("categories", id));
          countersIn(id).forEach(c => batch.update(userDoc("counters", c.id), { categoryId: null, order: base++ }));
        });
        entry.close(() => persist(batch.commit(), "Catégories enregistrées"));
      });
    }
  });

  function readInputs() {
    const sheet = sheetStack[sheetStack.length - 1]?.el;
    if (!sheet) return;
    $$("[data-row]", sheet).forEach(rowEl => {
      const r = rows[+rowEl.dataset.row];
      if (r) r.name = $("[data-name]", rowEl).value;
    });
  }
}

/* =========================================================
   Prochains caps
   ========================================================= */

function renderCaps() {
  setHeader({ title: "Prochains caps" });
  setFab(null);
  const now = Date.now();
  const items = [];
  for (const c of state.counters) {
    for (const m of C.upcomingFor(c, now, 4)) items.push({ c, m });
  }
  items.sort((a, b) => a.m.at - b.m.at);
  const list = items.slice(0, 30);

  let lastMonth = "";
  const rows = list.map(({ c, m }) => {
    const month = capitalize(fmtDate(m.at, { month: "long", year: "numeric" }));
    const head = month !== lastMonth ? `<li class="caps-month">${esc(month)}</li>` : "";
    lastMonth = month;
    return `${head}
      <li class="caps-item" style="--c:${esc(c.color || COLORS[0])}">
        <a href="#/c/${encodeURIComponent(c.id)}">
          <span class="caps-date"><strong>${new Date(m.at).getDate()}</strong><span>${esc(fmtDate(m.at, { month: "short" }))}</span></span>
          <span class="caps-text"><strong>${esc(m.label)}</strong><span>${esc(c.name)}</span></span>
          <span class="caps-when">${esc(fmtIn(m.at, now))}</span>
        </a>
      </li>`;
  }).join("");

  $("#view").innerHTML = `
    <h2 class="display">À venir</h2>
    <p class="lead">Les prochains grands caps de tes compteurs (100 jours, 6 mois, 1 an…) et les étapes de tes décomptes (J-30, J-7, jour J).</p>
    ${notifBlockHtml()}
    ${list.length ? `<ul class="caps-list">${rows}</ul>` : `<p class="block muted">Crée un compteur pour voir arriver ses caps.</p>`}`;
  bindNotifBlock($("#view"));
}

/* =========================================================
   Bloc notifications (page Caps et Mon compte)
   ========================================================= */

function notifBlockHtml() {
  const st = notifStatus();
  const texts = {
    unsupported: "Ce navigateur ne gère pas les notifications. Sur iPhone, ajoute d’abord l’appli à l’écran d’accueil (iOS 16.4 ou plus).",
    denied: "Les notifications sont bloquées pour ce site. Autorise-les dans les réglages du navigateur, puis reviens ici.",
    off: "Reçois une notification sur cet appareil quand un compteur passe un grand cap.",
    on: "Activées sur cet appareil. Elles arrivent quand l’appli est ouverte ou en arrière-plan ; installée sur Android, elle vérifie aussi de temps en temps une fois fermée."
  };
  return `
    <div class="card notif-card" data-notif>
      <div class="notif-card-head">
        <i class="fa-solid ${st === "on" ? "fa-bell" : "fa-bell-slash"}"></i>
        <strong>Notifications ${st === "on" ? "activées" : "désactivées"}</strong>
      </div>
      <p class="muted">${esc(texts[st])}</p>
      <div class="notif-actions">
        ${st === "off" ? `<button type="button" class="btn btn-primary btn-small" data-notif-on><i class="fa-solid fa-bell"></i> Activer les notifications</button>` : ""}
        ${st === "on" ? `
          <button type="button" class="btn btn-ghost btn-small" data-notif-test>Tester</button>
          <button type="button" class="btn btn-ghost btn-small" data-notif-off>Désactiver</button>` : ""}
      </div>
    </div>`;
}

function bindNotifBlock(root) {
  const block = $("[data-notif]", root);
  if (!block) return;
  const refresh = () => { block.outerHTML = notifBlockHtml(); bindNotifBlock(root); };
  $("[data-notif-on]", block)?.addEventListener("click", async e => {
    e.currentTarget.disabled = true;
    const st = await enableNotifications();
    toast(st === "on" ? "Notifications activées" : "Notifications non autorisées", st !== "on");
    refresh();
  });
  $("[data-notif-off]", block)?.addEventListener("click", async () => {
    await disableNotifications();
    toast("Notifications désactivées");
    refresh();
  });
  $("[data-notif-test]", block)?.addEventListener("click", () => testNotification().catch(err => {
    console.error(err);
    toast("La notification de test n’a pas pu s’afficher.", true);
  }));
}

/* =========================================================
   Mon compte
   ========================================================= */

function openAccount() {
  const u = state.user;
  openSheet({
    title: "Mon compte",
    body: `
      <div class="account">
        ${u.photoURL ? `<img class="account-avatar" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : `<span class="account-avatar account-avatar--empty"><i class="fa-solid fa-user"></i></span>`}
        <p class="account-name">${esc(u.displayName || "Connecté avec Google")}</p>
        <p class="muted">Tes compteurs et leurs photos sont liés à ton compte et visibles par toi seul.</p>
      </div>
      ${notifBlockHtml()}`,
    footer: `<button type="button" class="btn btn-ghost btn-block" data-logout><i class="fa-solid fa-right-from-bracket"></i> Se déconnecter</button>`,
    onMount(el, entry) {
      bindNotifBlock(el);
      $("[data-logout]", el).addEventListener("click", async e => {
        e.currentTarget.disabled = true;
        await stopNotificationsForLogout();
        entry.close(() => signOut(auth));
      });
    }
  });
}

/* =========================================================
   Mise à jour en direct
   ========================================================= */

let tickCount = 0;
let lastDay = startOfDay(Date.now());

setInterval(() => {
  if (!state.user || drag.active) return;
  const now = Date.now();
  if (startOfDay(now) !== lastDay) { lastDay = startOfDay(now); scheduleRender(); return; }
  $$("[data-ticker]").forEach(el => {
    const c = counterById(el.dataset.ticker);
    if (c) el.textContent = tickerText(c, now);
  });
  if (++tickCount % 15 === 0) {
    $$("[data-units]").forEach(el => {
      const c = counterById(el.dataset.units);
      if (!c) return;
      const html = unitsInner(c, now);
      if (el.innerHTML !== html) el.innerHTML = html;
    });
  }
}, 1000);

/* =========================================================
   Authentification et données
   ========================================================= */

function authErrorMessage(err) {
  switch (err?.code) {
    case "auth/unauthorized-domain":
      return "Ce domaine n’est pas autorisé. Ajoute-le dans Firebase : Authentication, Paramètres, Domaines autorisés.";
    case "auth/operation-not-allowed":
      return "La connexion Google n’est pas activée dans la console Firebase (Authentication, Méthodes de connexion).";
    case "auth/network-request-failed":
      return "Pas de connexion réseau. Vérifie ta connexion puis réessaie.";
    default:
      return "La connexion a échoué. Réessaie.";
  }
}

function showLoginError(err) {
  const el = $("#login-error");
  el.textContent = authErrorMessage(err);
  el.classList.remove("hidden");
}

async function login() {
  $("#login-error").classList.add("hidden");
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(err.code)) {
      return signInWithRedirect(auth, googleProvider);
    }
    if (["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(err.code)) return;
    console.error(err);
    showLoginError(err);
  }
}

function startListeners() {
  stopListeners();
  state.ready = { categories: false, counters: false };
  const onError = err => {
    console.error(err);
    toast(errorMessage(err), true);
  };
  state.unsub.push(onSnapshot(userCol("categories"), snap => {
    state.categories = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    state.ready.categories = true;
    scheduleRender();
  }, onError));
  state.unsub.push(onSnapshot(userCol("counters"), snap => {
    state.counters = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(c => typeof c.startAt === "number" && (!C.isCountdown(c) || typeof c.targetAt === "number"));
    state.ready.counters = true;
    scheduleRender();
    syncCounters(state.counters.map(c => ({
      id: c.id, name: c.name, startAt: c.startAt, notify: c.notify !== false,
      mode: c.mode || "since", targetAt: c.targetAt ?? null, repeat: !!c.repeat
    })));
  }, onError));
}

function stopListeners() {
  state.unsub.forEach(fn => fn());
  state.unsub = [];
}

function showScreen(name) {
  $("#splash").classList.add("hidden");
  $("#login-screen").classList.toggle("hidden", name !== "login");
  $("#app").classList.toggle("hidden", name !== "app");
}

/* =========================================================
   Démarrage
   ========================================================= */

$("#btn-login").addEventListener("click", login);
$("#btn-account").addEventListener("click", openAccount);

getRedirectResult(auth).catch(err => { console.error(err); showLoginError(err); });

onAuthStateChanged(auth, user => {
  state.user = user;
  if (user) {
    const avatar = $("#user-avatar");
    if (user.photoURL) {
      avatar.src = user.photoURL;
      $("#btn-account").classList.add("has-photo");
    } else {
      $("#btn-account").classList.remove("has-photo");
    }
    showScreen("app");
    renderLoading();
    startListeners();
  } else {
    stopListeners();
    watchPhotos(null);
    fullCache.clear();
    state.categories = [];
    state.counters = [];
    showScreen("login");
  }
});
