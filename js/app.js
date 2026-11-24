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
  "car", "plane", "dog", "cat", "book", "star"
];

const COLORS = ["#1D6B57", "#3B4BDB", "#D2433D", "#C98A0B", "#8340D6", "#0B8FAE", "#D9577F", "#4B5568"];

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

function fmtSince(t, now = Date.now()) {
  if (t > now) return `démarre le ${fmtDate(t)}`;
  const d = dayDiff(t, now);
  if (d === 0) return `depuis aujourd’hui, ${fmtTime(t)}`;
  if (d === 1) return `depuis hier, ${fmtTime(t)}`;
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

function toLocalInput(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* =========================================================
   Valeurs d'un compteur
   ========================================================= */

const unitsOf = c => {
  const list = (c.units || []).filter(u => UNITS[u]);
  return list.length ? list : ["days"];
};

function unitValues(c, now = Date.now()) {
  const units = unitsOf(c);
  if (c.display === "breakdown") {
    const vals = C.breakdown(c.startAt, now, units).map(([u, v]) => ({ u, v }));
    const first = vals.findIndex(x => x.v > 0);
    return first === -1 ? vals.slice(-1) : vals.slice(first);
  }
  const t = C.totals(c.startAt, now);
  return UNIT_ASC.filter(u => units.includes(u)).map(u => ({ u, v: t[u] }));
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
  return c.display === "breakdown" ? vals.join(", ") : vals.join(" · ");
}

// Ce qui dépasse les jours pleins : heures, minutes, secondes
function tickerText(c, now = Date.now()) {
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
    if (c.startAt > now) continue;
    const m = C.upcoming(c.startAt, now, 1)[0];
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
      const t = TEMPLATES[+btn.dataset.template];
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
  const prev = c.startAt <= now ? C.previous(c.startAt, now) : null;
  const recent = prev && now - prev.at < RECENT_CAP;
  return `
    <article class="counter-card" data-id="${esc(c.id)}" style="--c:${esc(c.color || COLORS[0])}" tabindex="0" aria-label="${esc(c.name)} : ${esc(unitsText(c, now))}">
      <span class="counter-badge"><i class="fa-solid fa-${esc(c.icon || "hourglass-half")}"></i></span>
      <div class="counter-main">
        <div class="counter-top">
          <strong class="counter-name">${esc(c.name)}</strong>
          ${recent ? `<span class="cap-pill"><i class="fa-solid fa-trophy"></i>${esc(prev.label)}</span>` : ""}
        </div>
        ${unitsHtml(c, now)}
        <span class="counter-since">${esc(fmtSince(c.startAt, now))}</span>
      </div>
      ${c.resettable !== false ? `<button type="button" class="icon-btn counter-reset" data-reset aria-label="Remettre « ${esc(c.name)} » à zéro" title="Remettre à zéro"><i class="fa-solid fa-rotate-left"></i></button>` : "<span></span>"}
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

  const started = c.startAt <= now;
  const next = started ? C.upcoming(c.startAt, now, 1)[0] : null;
  const prev = started ? C.previous(c.startAt, now) : null;
  const prevAt = prev ? prev.at : c.startAt;
  const pct = next ? Math.min(100, Math.max(0, (now - prevAt) / (next.at - prevAt) * 100)) : 0;
  const passed = started ? C.milestones(c.startAt, now).reverse() : [];

  $("#view").innerHTML = `
    <section class="hero" style="--c:${esc(c.color || COLORS[0])}">
      <span class="counter-badge counter-badge--lg"><i class="fa-solid fa-${esc(c.icon || "hourglass-half")}"></i></span>
      ${unitsHtml(c, now, "units--hero")}
      <p class="ticker" data-ticker="${esc(c.id)}">${esc(tickerText(c, now))}</p>
      <p class="hero-since">${esc(started ? `Depuis le ${fmtDateTime(c.startAt)}` : `Démarre le ${fmtDateTime(c.startAt)}`)}</p>
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

    ${historyHtml(c, now)}`;

  const view = $("#view");
  $("[data-reset]", view)?.addEventListener("click", () => resetCounter(c));
  $("[data-enable-history]", view)?.addEventListener("click", () => {
    persist(updateDoc(userDoc("counters", c.id), { history: true }), "Historique activé");
  });
  $$("[data-del-period]", view).forEach(btn => btn.addEventListener("click", () => deletePeriod(c, +btn.dataset.delPeriod)));
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
  const upd = { startAt: at, lastResetAt: at };
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
    detail: "Le compteur et son historique disparaissent définitivement.",
    confirmLabel: "Supprimer", danger: true
  });
  if (!ok) return;
  entry.close(() => {
    if (parseRoute().id === c.id) location.replace("#/");
    persist(deleteDoc(userDoc("counters", c.id)), "Compteur supprimé");
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
    startAt: Date.now(), units: ["days"], display: "totals",
    resettable: true, history: false, notify: true,
    ...preset
  };
  const units = unitsOf(base);
  const catId = categoryById(base.categoryId)?.id || "";

  const body = `
    <form class="form" novalidate>
      <label class="field">
        <span class="field-label">Nom</span>
        <input name="name" value="${esc(base.name)}" maxlength="60" placeholder="${base.icon === "baby" ? "Ex. Naissance de Léa" : "Ex. Sans alcool"}" autocomplete="off" required>
      </label>

      <label class="field">
        <span class="field-label">Point de départ</span>
        <input name="startAt" type="datetime-local" value="${toLocalInput(base.startAt)}" required>
        <span class="hint">Une date passée fonctionne aussi, comme une naissance.</span>
      </label>

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

      <div class="switch-list">
        ${switchRow("resettable", "Remise à zéro", "Un bouton pour repartir de zéro, avec confirmation.", base.resettable !== false)}
        ${switchRow("history", "Historique des séries", "Garde chaque série arrêtée et affiche ton record.", !!base.history)}
        ${switchRow("notify", "Notifier les grands caps", "100 jours, 1 an, 1 000 jours…", base.notify !== false)}
      </div>

      <p class="field-error hidden" data-error role="alert"></p>

      ${counter ? `<button type="button" class="btn btn-danger-ghost btn-block danger-zone" data-delete><i class="fa-solid fa-trash-can"></i> Supprimer ce compteur</button>` : ""}
    </form>`;

  const footer = `<button type="button" class="btn btn-primary btn-block" data-save>${counter ? "Enregistrer" : "Créer le compteur"}</button>`;

  let initial = "";
  const serialize = form => JSON.stringify([...new FormData(form).entries()]);

  openSheet({
    title: counter ? "Modifier le compteur" : "Nouveau compteur",
    body, footer,
    isDirty: () => serialize($("form", sheetStack[sheetStack.length - 1].el)) !== initial,
    onMount(el, entry) {
      const form = $("form", el);
      initial = serialize(form);

      const readUnits = () => $$("input[name=units]:checked", form).map(i => i.value);
      const updatePreview = () => {
        const start = new Date(form.elements.startAt.value).getTime();
        const us = readUnits();
        const prev = $("[data-preview]", form);
        if (!us.length) { prev.textContent = "Choisis au moins une unité."; return; }
        if (Number.isNaN(start)) { prev.textContent = "Indique un point de départ."; return; }
        const now = Date.now();
        const sample = start <= now ? start : now - (1234 * C.DAY + 5 * C.HOUR);
        prev.textContent = `${start <= now ? "Aujourd’hui" : "Par exemple"} : ${unitsText({ startAt: sample, units: us, display: form.elements.display.value }, now)}`;
      };
      form.addEventListener("input", updatePreview);
      form.addEventListener("change", updatePreview);
      updatePreview();

      form.elements.category.addEventListener("change", () => {
        const isNew = form.elements.category.value === "__new";
        $("[data-newcat]", form).classList.toggle("hidden", !isNew);
        if (isNew) form.elements.newCategory.focus();
      });

      $("[data-delete]", form)?.addEventListener("click", () => deleteCounter(counter, entry));
      form.addEventListener("submit", e => { e.preventDefault(); save(); });
      $("[data-save]", el).addEventListener("click", save);
      if (!counter) setTimeout(() => form.elements.name.focus(), 260);

      function fail(msg, input) {
        const err = $("[data-error]", form);
        err.textContent = msg;
        err.classList.remove("hidden");
        $$("[aria-invalid]", form).forEach(i => i.removeAttribute("aria-invalid"));
        if (input) { input.setAttribute("aria-invalid", "true"); input.focus(); }
      }

      function save() {
        const name = form.elements.name.value.trim();
        const startAt = new Date(form.elements.startAt.value).getTime();
        const us = readUnits();
        if (!name) return fail("Donne un nom au compteur.", form.elements.name);
        if (Number.isNaN(startAt)) return fail("Indique un point de départ valide.", form.elements.startAt);
        if (!us.length) return fail("Choisis au moins une unité d’affichage.");

        const batch = writeBatch(db);
        let categoryId = form.elements.category.value || null;
        if (categoryId === "__new") {
          const catName = form.elements.newCategory.value.trim();
          if (!catName) return fail("Donne un nom à la nouvelle catégorie.", form.elements.newCategory);
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
          startAt,
          units: UNIT_ASC.filter(u => us.includes(u)),
          display: form.elements.display.value === "breakdown" ? "breakdown" : "totals",
          icon: form.elements.icon.value || "hourglass-half",
          color: form.elements.color.value || COLORS[0],
          categoryId,
          resettable: form.elements.resettable.checked,
          history: form.elements.history.checked,
          notify: form.elements.notify.checked
        };

        if (counter) {
          if ((categoryById(counter.categoryId)?.id || null) !== categoryId) data.order = nextOrder(categoryId);
          batch.update(userDoc("counters", counter.id), data);
        } else {
          batch.set(userDoc("counters", newId()), {
            ...data,
            order: nextOrder(categoryId),
            periods: [],
            createdAt: serverTimestamp()
          });
        }
        entry.close(() => persist(batch.commit(), counter ? "Compteur enregistré" : "Compteur créé"));
      }
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
    for (const m of C.upcoming(c.startAt, now, 4)) items.push({ c, m });
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
    <p class="lead">Les prochains grands caps de tes compteurs : 100 jours, 6 mois, 1 an, 1 000 jours…</p>
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
        <p class="muted">Tes compteurs sont liés à ton compte et visibles par toi seul.</p>
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
      .filter(c => typeof c.startAt === "number");
    state.ready.counters = true;
    scheduleRender();
    syncCounters(state.counters.map(c => ({ id: c.id, name: c.name, startAt: c.startAt, notify: c.notify !== false })));
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
    state.categories = [];
    state.counters = [];
    showScreen("login");
  }
});
