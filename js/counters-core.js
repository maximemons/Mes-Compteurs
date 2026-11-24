// Mes compteurs : calculs de durée et caps (commun à l'appli et au service worker).
// Script classique : il expose globalThis.MCCounters, chargé par import dans la page
// et par importScripts() dans sw.js.

(function (g) {
  const DAY = 864e5;
  const HOUR = 36e5;
  const GRACE = 36 * HOUR; // un cap franchi depuis moins de 36 h peut encore être notifié

  const nf = new Intl.NumberFormat("fr-FR");
  const fmtInt = n => nf.format(n);

  /* ------------------------------------------------ Dates (calendrier local) */

  function addDays(t, n) {
    const d = new Date(t);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  // Ajoute n mois en restant sur le même jour (31 janv. + 1 mois → 28/29 févr.)
  function addMonths(t, n) {
    const d = new Date(t);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d.getTime();
  }

  // Jours pleins écoulés (tient compte des changements d'heure)
  function fullDays(start, now) {
    if (now <= start) return 0;
    let n = Math.floor((now - start) / DAY);
    while (n > 0 && addDays(start, n) > now) n--;
    while (addDays(start, n + 1) <= now) n++;
    return n;
  }

  function fullMonths(start, now) {
    if (now <= start) return 0;
    const a = new Date(start), b = new Date(now);
    let n = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    while (n > 0 && addMonths(start, n) > now) n--;
    while (addMonths(start, n + 1) <= now) n++;
    return Math.max(0, n);
  }

  const fullYears = (start, now) => Math.floor(fullMonths(start, now) / 12);

  function totals(start, now) {
    const days = fullDays(start, now);
    return {
      hours: now > start ? Math.floor((now - start) / HOUR) : 0,
      days,
      weeks: Math.floor(days / 7),
      months: fullMonths(start, now),
      years: fullYears(start, now)
    };
  }

  // Décomposition : 3 ans, 19 semaines, 2 jours (seulement avec les unités choisies)
  const DESC = ["years", "months", "weeks", "days", "hours"];
  function breakdown(start, now, units) {
    const order = DESC.filter(u => units.includes(u));
    const out = [];
    let cur = start;
    for (const u of order) {
      let v = 0;
      if (now > cur) {
        if (u === "years") { v = fullYears(cur, now); cur = addMonths(cur, v * 12); }
        else if (u === "months") { v = fullMonths(cur, now); cur = addMonths(cur, v); }
        else if (u === "weeks") { v = Math.floor(fullDays(cur, now) / 7); cur = addDays(cur, v * 7); }
        else if (u === "days") { v = fullDays(cur, now); cur = addDays(cur, v); }
        else { v = Math.floor((now - cur) / HOUR); cur += v * HOUR; }
      }
      out.push([u, v]);
    }
    return out;
  }

  /* ------------------------------------------------ Caps */

  const DAY_STEPS = [7, 50, 100, 200, 300, 500, 1000, 1500];
  const MONTH_STEPS = [1, 3, 6];

  // Tous les caps d'un compteur jusqu'à « until », triés dans le temps
  function milestones(start, until) {
    const out = [];
    const push = (key, at, label, n, kind) => { if (at <= until) out.push({ key, at, label, n, kind }); };
    for (const n of DAY_STEPS) push("d" + n, addDays(start, n), fmtInt(n) + " jours", n, "d");
    for (let n = 2000; addDays(start, n) <= until; n += 1000) push("d" + n, addDays(start, n), fmtInt(n) + " jours", n, "d");
    for (const n of MONTH_STEPS) push("m" + n, addMonths(start, n), n + " mois", n, "m");
    for (let y = 1; addMonths(start, 12 * y) <= until; y++) push("y" + y, addMonths(start, 12 * y), y === 1 ? "1 an" : y + " ans", y, "y");
    return out.sort((a, b) => a.at - b.at);
  }

  const between = (start, from, to) => milestones(start, to).filter(m => m.at > from);

  /* ------------------------------------------------ Décomptes (jusqu'à une date) */

  const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const isCountdown = c => !!c && c.mode === "countdown";

  // Prochaine échéance d'un décompte. Un décompte annuel garde sa date toute la journée
  // du jour J, puis passe à l'année suivante.
  function countdownTarget(c, now) {
    const base = c.targetAt;
    if (!c.repeat) return base;
    let k = Math.max(0, new Date(now).getFullYear() - new Date(base).getFullYear() - 1);
    let t = addMonths(base, 12 * k);
    while (addDays(startOfDay(t), 1) <= now) t = addMonths(base, 12 * ++k);
    return t;
  }

  // Étapes d'un décompte : J-100, J-30, J-7, J-1 (au début du jour) puis le jour J
  const CD_STEPS = [100, 30, 7, 1];
  function countdownSteps(c, from, to) {
    const targets = [];
    if (!c.repeat) targets.push(c.targetAt);
    else {
      let k = Math.max(0, new Date(from).getFullYear() - new Date(c.targetAt).getFullYear() - 1);
      for (; k < 400; k++) {
        const t = addMonths(c.targetAt, 12 * k);
        if (addDays(startOfDay(t), -(CD_STEPS[0] + 1)) > to) break;
        targets.push(t);
      }
    }
    const out = [];
    for (const t of targets) {
      for (const n of CD_STEPS) out.push({ key: `t${t}:j${n}`, at: addDays(startOfDay(t), -n), label: `J-${n}`, n, kind: "cd", target: t });
      out.push({ key: `t${t}:j0`, at: t, label: "Jour J", n: 0, kind: "cd", target: t });
    }
    return out.filter(m => m.at > from && m.at <= to).sort((a, b) => a.at - b.at);
  }

  // Prochains caps (compteur) ou prochaines étapes (décompte)
  function upcomingFor(c, now, count = 1) {
    if (isCountdown(c)) return countdownSteps(c, now, now + (count + 1) * 370 * DAY).slice(0, count);
    return upcoming(c.startAt, now, count);
  }

  function upcoming(start, now, count = 1) {
    const from = Math.max(start, now);
    return milestones(start, from + (count + 2) * 370 * DAY).filter(m => m.at > now).slice(0, count);
  }

  function previous(start, now) {
    const past = milestones(start, now);
    return past.length ? past[past.length - 1] : null;
  }

  // Caps à notifier : franchis depuis moins de GRACE et pas encore vus sur cet appareil
  function dueMilestones(list, now, seen) {
    const due = [];
    for (const c of list || []) {
      if (!c || c.notify === false) continue;
      let steps;
      if (isCountdown(c)) {
        if (typeof c.targetAt !== "number") continue;
        // rien d'antérieur à la création du décompte (startAt = création)
        steps = countdownSteps(c, Math.max(c.startAt || 0, now - GRACE), now);
      } else {
        if (!(c.startAt <= now)) continue;
        steps = between(c.startAt, Math.max(c.startAt, now - GRACE), now);
      }
      const fresh = steps
        .map(m => ({ counter: c, milestone: m, seenKey: `${c.id}:${c.startAt}:${m.key}` }))
        .filter(d => !seen.has(d.seenKey));
      // Décompte : seule l'étape la plus récente s'affiche (pas « J-1 » et « Jour J » d'un coup) ;
      // les autres sont marquées vues sans notification.
      if (isCountdown(c)) fresh.forEach((d, i) => { if (i < fresh.length - 1) d.silent = true; });
      due.push(...fresh);
    }
    return due;
  }

  function notificationFor({ counter, milestone, seenKey }) {
    if (milestone.kind === "cd") {
      const n = milestone.n;
      return {
        title: n === 0 ? `Jour J : ${counter.name}` : `${milestone.label} : ${counter.name}`,
        options: {
          body: n === 0 ? `C’est aujourd’hui : « ${counter.name} » !` : `Plus que ${n} ${n > 1 ? "jours" : "jour"} avant « ${counter.name} ».`,
          tag: seenKey,
          icon: "icons/icon-192.png",
          badge: "icons/icon-192.png",
          data: { url: `./#/c/${counter.id}` }
        }
      };
    }
    return {
      title: `Nouveau cap : ${milestone.label}`,
      options: {
        body: `« ${counter.name} » vient de passer ${milestone.label}.`,
        tag: seenKey,
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        data: { url: `./#/c/${counter.id}` }
      }
    };
  }

  /* ------------------------------------------------ Petit stockage IndexedDB (page et SW) */

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("mes-compteurs", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function kvGet(key) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const req = db.transaction("kv").objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function kvSet(key, value) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  g.MCCounters = {
    DAY, HOUR, GRACE, fmtInt,
    addDays, addMonths, fullDays, fullMonths, fullYears, totals, breakdown,
    milestones, between, upcoming, previous, dueMilestones, notificationFor,
    startOfDay, isCountdown, countdownTarget, countdownSteps, upcomingFor,
    kvGet, kvSet
  };
})(globalThis);
