// Focus pro telefon: Přehled (odpracováno, splněno), Úkoly (Google Tasks) a Kalendář (den / týden / měsíc).
// Mluví přímo s Google API (žádný vlastní server); přihlášení přes Google Identity Services.
// Odpracovaný čas zapisuje Focus na PC do Google kalendáře „Focus · naměřeno“ – odtud ho čte Přehled
// a vrstva „Naměřeno“ v Kalendáři. ?demo = ukázková data bez přihlášení (kontrola vzhledu).
"use strict";

const CFG = window.FOCUS_CONFIG || {};
const DEMO = new URLSearchParams(location.search).has("demo");
const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/tasks";
const CAL_API = "https://www.googleapis.com/calendar/v3";
const TASK_API = "https://tasks.googleapis.com/tasks/v1";
const TRACKED_NAME = "Focus · naměřeno", WORK_NAME = "Focus · firemní";
const EVENT_COLORS = { 1: "#7986CB", 2: "#33B679", 3: "#8E24AA", 4: "#E67C73", 5: "#F6BF26", 6: "#F4511E", 7: "#039BE5", 8: "#616161", 9: "#3F51B5", 10: "#0B8043", 11: "#D50000" };
const DAYS = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
const SHORT = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];
const MONTHS = ["ledna", "února", "března", "dubna", "května", "června", "července", "srpna", "září", "října", "listopadu", "prosince"];
const MONTHS1 = ["Leden", "Únor", "Březen", "Duben", "Květen", "Červen", "Červenec", "Srpen", "Září", "Říjen", "Listopad", "Prosinec"];

// ---------- pomocné ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const sod = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const hm = d => d.getHours() + ":" + pad(d.getMinutes());
const monday = d => addDays(sod(d), -((d.getDay() + 6) % 7));
const dayLabel = d => DAYS[d.getDay()].replace(/^./, c => c.toUpperCase());
const dateLong = d => d.getDate() + ". " + MONTHS[d.getMonth()];
const dur = ms => { const m = Math.round(ms / 60000); return Math.floor(m / 60) + ":" + pad(m % 60); };
const icon = (id, cls) => `<svg class="${cls || ""}"><use href="#i-${id}"/></svg>`;
function plural(n, a, b, c) { return n === 1 ? a : n >= 2 && n <= 4 ? b : c; }
function isoLocal(d) {
  const off = -d.getTimezoneOffset(), s = off >= 0 ? "+" : "-", a = Math.abs(off);
  return ymd(d) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":00" + s + pad(Math.floor(a / 60)) + ":" + pad(a % 60);
}
function parseYmd(s) { const p = (s || "").slice(0, 10).split("-").map(Number); return p.length === 3 && p[0] ? new Date(p[0], p[1] - 1, p[2]) : null; }
function isDark() { const t = document.documentElement.dataset.theme; return t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches); }
function tint(hex, amt) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const dark = isDark(), base = dark ? [28, 28, 31] : [255, 255, 255], a = dark ? 0.78 : amt;
  const m = (v, t) => Math.round(v + (t - v) * a);
  return "rgb(" + m(r, base[0]) + "," + m(g, base[1]) + "," + m(b, base[2]) + ")";
}
const store = {
  get(k, def) { try { const v = localStorage.getItem("focus:" + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem("focus:" + k, JSON.stringify(v)); } catch (e) { } }
};
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------- stav ----------
const S = {
  view: "overview", calMode: store.get("calMode", "day"), day: sod(new Date()), month: addMonths(new Date(), 0),
  token: null, tokenExp: 0, needAuth: false,
  calendars: store.get("cals", []), trackedId: store.get("trackedId", null),
  events: store.get("events", []), tracked: store.get("tracked", []), eventsRange: store.get("eventsRange", null),
  lists: store.get("lists", []), tasks: store.get("tasks", []), listFilter: store.get("listFilter", "all"),
  showTracked: store.get("showTracked", true), projRange: "week",
  loading: 0, loadedAt: 0, error: null
};
S.events.forEach(revive); S.tracked.forEach(revive);
S.tasks.forEach(t => { t.due = t.due ? new Date(t.due) : null; t.completed = t.completed ? new Date(t.completed) : null; });
function revive(e) { e.start = new Date(e.start); e.end = new Date(e.end); }

function selectedCals() {
  const sel = store.get("calSel", null), workHidden = store.get("workHidden", false);
  return S.calendars.filter(c => c.mirror ? !workHidden : sel ? sel.includes(c.id) : (c.visible || c.primary));
}
function writableCals() { return S.calendars.filter(c => c.role === "owner" || c.role === "writer"); }
function defaultCal() {
  const w = writableCals(), t = store.get("calTarget", null);
  return (w.find(c => c.id === t) || w.find(c => c.primary) || w[0] || {}).id;
}
function calById(id) { return S.calendars.find(c => c.id === id) || { id, name: "", color: "#7C5CD6" }; }

// ---------- přihlášení ----------
let tokenClient = null, pendingAuth = null;
function initAuth() {
  if (DEMO || tokenClient || !window.google || !google.accounts || !google.accounts.oauth2) return !!tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.clientId, scope: SCOPES, hint: store.get("email", undefined),
    callback: r => {
      const p = pendingAuth; pendingAuth = null;
      if (r.error) { if (p) p.reject(new Error(r.error_description || r.error)); return; }
      if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPES.split(" "))) { if (p) p.reject(new Error("Je potřeba povolit kalendář i úkoly.")); return; }
      S.token = r.access_token; S.tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
      store.set("token", { t: S.token, e: S.tokenExp }); S.needAuth = false;
      if (p) p.resolve(S.token);
    },
    error_callback: e => { const p = pendingAuth; pendingAuth = null; if (p) p.reject(new Error(e && e.type === "popup_closed" ? "Přihlášení zavřeno." : "Přihlášení se nepovedlo.")); }
  });
  return true;
}
function signIn(consent) {
  return new Promise((resolve, reject) => {
    if (!initAuth()) { reject(new Error("Google přihlášení se ještě načítá, zkus to za chvilku.")); return; }
    pendingAuth = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: consent ? "consent" : "" });
  });
}
(function restoreToken() { const t = store.get("token", null); if (t && t.e > Date.now()) { S.token = t.t; S.tokenExp = t.e; } })();
const signedIn = () => DEMO || (store.get("everSigned", false) && (S.token || S.calendars.length));

async function api(method, url, body) {
  if (DEMO) return Demo.api(method, url, body);
  if (!S.token || Date.now() > S.tokenExp) { S.needAuth = true; render(); throw new Error("auth"); }
  const r = await fetch(url, { method, headers: Object.assign({ Authorization: "Bearer " + S.token }, body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { S.token = null; S.needAuth = true; render(); throw new Error("auth"); }
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ("Google " + r.status));
  return j;
}

// ---------- načítání ----------
async function loadCalendars() {
  const out = []; let page = "", tracked = null;
  do {
    const j = await api("GET", CAL_API + "/users/me/calendarList?maxResults=250" + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
    (j.items || []).forEach(c => {
      if (c.deleted) return;
      const name = c.summaryOverride || c.summary;
      if (name === TRACKED_NAME) { tracked = c.id; return; }   // naměřený čas z PC – samostatně
      if (name === WORK_NAME) {   // firemní schůzky zrcadlené z Outlooku – jen ke čtení, vždy zapnuté
        out.push({ id: c.id, name: "Firemní", color: "#3F51B5", role: "reader", mirror: true, visible: true });
        return;
      }
      out.push({ id: c.id, name, color: (c.backgroundColor || "#7C5CD6").toUpperCase(), role: c.accessRole, primary: !!c.primary, visible: !!c.selected && !c.hidden });
    });
    page = j.nextPageToken || "";
  } while (page);
  out.sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name, "cs"));
  S.calendars = out; S.trackedId = tracked;
  store.set("cals", out); store.set("trackedId", tracked);
  const p = out.find(c => c.primary); if (p) store.set("email", p.id);
}

// Načítané období: týden kolem vybraného dne + celý viditelný měsíc (a vždy tento týden kvůli Přehledu).
function loadRange() {
  let from = monday(S.day), to = addDays(from, 7);
  if (S.view === "calendar" && S.calMode === "month") { from = monday(S.month); to = addDays(from, 42); }
  const w = monday(new Date());
  if (w < from) from = w;
  if (addDays(w, 7) > to) to = addDays(w, 7);
  return { from, to };
}

async function fetchEvents(calId, from, to, each) {
  let page = "";
  do {
    const j = await api("GET", CAL_API + "/calendars/" + encodeURIComponent(calId) + "/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=" +
      encodeURIComponent(from.toISOString()) + "&timeMax=" + encodeURIComponent(to.toISOString()) + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
    (j.items || []).forEach(each);
    page = j.nextPageToken || "";
  } while (page);
}

async function loadEvents() {
  const { from, to } = loadRange(), all = [], tracked = [];
  const jobs = selectedCals().map(cal => fetchEvents(cal.id, from, to, e => { const n = normEvent(e, cal); if (n) all.push(n); }));
  if (S.trackedId) jobs.push(fetchEvents(S.trackedId, from, to, e => {
    if (e.status === "cancelled" || !e.start || !e.start.dateTime) return;
    tracked.push({ id: e.id, title: e.summary || "Práce", project: e.description || "", start: new Date(e.start.dateTime), end: new Date(e.end.dateTime), color: EVENT_COLORS[e.colorId] || "#7C5CD6" });
  }));
  await Promise.all(jobs);
  all.sort((a, b) => a.start - b.start); tracked.sort((a, b) => a.start - b.start);
  S.events = all; S.tracked = tracked; S.eventsRange = { from: +from, to: +to };
  store.set("events", all); store.set("tracked", tracked); store.set("eventsRange", S.eventsRange);
}

function normEvent(e, cal) {
  if (e.status === "cancelled") return null;
  const me = (e.attendees || []).find(a => a.self);
  if (me && me.responseStatus === "declined") return null;
  const allDay = !!(e.start && e.start.date);
  const start = allDay ? parseYmd(e.start.date) : new Date(e.start.dateTime), end = allDay ? parseYmd(e.end.date) : new Date(e.end.dateTime);
  const others = (e.attendees || []).some(a => !a.self) || (e.organizer && !e.organizer.self);
  const writable = cal.role === "owner" || cal.role === "writer";
  return {
    id: e.id, calId: cal.id, title: e.summary || "(bez názvu)", loc: e.location || "", desc: e.description || "", start, end, allDay,
    color: EVENT_COLORS[e.colorId] || cal.color, free: e.transparency === "transparent", link: e.htmlLink || "",
    lock: cal.mirror ? "Firemní schůzka z Outlooku – změny dělej v Outlooku." : !writable ? "Kalendář „" + cal.name + "“ je jen pro čtení." : e.recurringEventId ? "Opakovaná událost – uprav ji v Google Kalendáři." : others ? "Schůzka s dalšími lidmi – uprav ji v Google Kalendáři." : ""
  };
}

async function loadTasks() {
  const lj = await api("GET", TASK_API + "/users/@me/lists?maxResults=100");
  const lists = (lj.items || []).map(l => ({ id: l.id, name: l.title }));
  const tasks = [], since = sod(addDays(new Date(), -14));   // hotové za 14 dní – pro Přehled a seznam „Hotové“
  await Promise.all(lists.map(async l => {
    let page = "";
    do {
      const j = await api("GET", TASK_API + "/lists/" + encodeURIComponent(l.id) + "/tasks?maxResults=100&showCompleted=true&showHidden=true" + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
      (j.items || []).forEach(t => {
        if (t.deleted || !(t.title || "").trim()) return;
        const done = t.status === "completed", completed = t.completed ? new Date(t.completed) : null;
        if (done && (!completed || completed < since)) return;
        tasks.push({ id: t.id, listId: l.id, title: t.title, notes: t.notes || "", due: t.due ? parseYmd(t.due) : null, done, completed });
      });
      page = j.nextPageToken || "";
    } while (page);
  }));
  S.lists = lists; S.tasks = tasks;
  store.set("lists", lists); store.set("tasks", tasks);
}

async function refresh(full) {
  if (!signedIn() || S.loading) return;
  S.loading++; S.error = null; render();
  try {
    if (full || !S.calendars.length) await loadCalendars();
    await Promise.all([loadEvents(), loadTasks()]);
    S.loadedAt = Date.now();
  } catch (e) { if (e.message !== "auth") S.error = e.message; }
  S.loading--; render();
}

// ---------- data pro obrazovky ----------
function eventsOn(day) { const a = sod(day), b = addDays(a, 1); return S.events.filter(e => e.start < b && e.end > a); }
function trackedOn(day) { const a = sod(day), b = addDays(a, 1); return S.tracked.filter(e => e.start < b && e.end > a); }
function workedMs(day) {
  const a = +sod(day), b = a + 86400000, now = Date.now();
  return trackedOn(day).reduce((s, e) => s + Math.max(0, Math.min(+e.end, b, now) - Math.max(+e.start, a)), 0);
}
function doneOn(day) { return S.tasks.filter(t => t.done && t.completed && sameDay(t.completed, day)); }
function tasksDue(day, includeLate) {
  const d = sod(day);
  return S.tasks.filter(t => !t.done && t.due && (sameDay(t.due, d) || (includeLate && t.due < d))).sort((x, y) => x.due - y.due);
}

// ---------- vykreslení ----------
function topHtml() {
  if (!signedIn()) return "";
  const today = sod(new Date());
  const refresh = `<button class="icon-btn${S.loading ? " spin" : ""}" data-act="refresh" aria-label="Obnovit">${icon("refresh")}</button>`;
  const gear = `<button class="icon-btn" data-act="settings" aria-label="Nastavení">${icon("settings")}</button>`;
  if (S.view === "settings") return `<div class="hdr"><button class="icon-btn" data-act="back" aria-label="Zpět">${icon("left")}</button><div class="hdr-title">Nastavení<small>Focus pro telefon</small></div></div>`;
  if (S.view === "overview") return `<div class="hdr"><div class="hdr-title">Přehled<small>${dayLabel(today)} ${dateLong(today)}</small></div>${refresh}${gear}</div>`;
  if (S.view === "tasks") {
    const open = S.tasks.filter(t => !t.done).length;
    return `<div class="hdr"><div class="hdr-title">Úkoly<small>${open} ${plural(open, "otevřený", "otevřené", "otevřených")}</small></div>${refresh}${gear}</div>`;
  }
  // kalendář
  const m = S.calMode, d = S.day;
  let title, sub;
  if (m === "day") { title = dayLabel(d); sub = dateLong(d) + (d.getFullYear() !== today.getFullYear() ? " " + d.getFullYear() : "") + (sameDay(d, today) ? " · dnes" : ""); }
  else if (m === "week") { const w = monday(d), e = addDays(w, 6); title = sameDay(w, monday(today)) ? "Tento týden" : "Týden"; sub = w.getDate() + ". " + (w.getMonth() + 1) + ". – " + e.getDate() + ". " + (e.getMonth() + 1) + "."; }
  else { title = MONTHS1[S.month.getMonth()]; sub = String(S.month.getFullYear()); }
  const isCurrent = m === "day" ? sameDay(d, today) : m === "week" ? sameDay(monday(d), monday(today)) : (S.month.getMonth() === today.getMonth() && S.month.getFullYear() === today.getFullYear());
  let html = `<div class="hdr"><div class="hdr-title">${title}<small>${sub}</small></div>${isCurrent ? "" : `<button class="today-pill" data-act="today">Dnes</button>`}
      <button class="icon-btn" data-act="prev" aria-label="Předchozí">${icon("left")}</button><button class="icon-btn" data-act="next" aria-label="Další">${icon("right")}</button>${gear}</div>
    <div class="seg-row"><div class="seg">${[["day", "Den"], ["week", "Týden"], ["month", "Měsíc"]].map(([k, n]) => `<button class="${m === k ? "on" : ""}" data-act="calmode" data-id="${k}">${n}</button>`).join("")}</div>
    ${S.trackedId ? `<button class="layer${S.showTracked ? " on" : ""}" data-act="layer" style="margin-left:auto">${icon("today")}Naměřeno</button>` : ""}</div>`;
  if (m === "day") {
    const w = monday(d);
    html += `<div class="strip">`;
    for (let i = 0; i < 7; i++) {
      const x = addDays(w, i), busy = eventsOn(x).length + tasksDue(x, false).length;
      html += `<button class="sd${sameDay(x, d) ? " on" : ""}${sameDay(x, today) ? " is-today" : ""}" data-act="pick" data-d="${+x}"><span>${SHORT[x.getDay()]}</span><b>${x.getDate()}</b><i${busy ? "" : ' class="no"'}></i></button>`;
    }
    html += `</div>`;
  }
  return html;
}

function render() {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.view === S.view));
  const top = $("#top"); if (top) top.innerHTML = topHtml();
  const v = $("#view");
  if (!signedIn()) { $("#fab").hidden = true; $("#tabs").hidden = true; v.innerHTML = signinHtml(); return; }
  $("#tabs").hidden = false;
  $("#fab").hidden = S.view === "settings" || S.view === "overview";
  let html = "";
  if (S.needAuth) html += `<div class="banner">Přihlášení ke Googlu vypršelo.<button data-act="reauth">Obnovit</button></div>`;
  if (S.error) html += `<div class="banner">${esc(S.error)}<button data-act="refresh">Zkusit znovu</button></div>`;
  html += S.view === "overview" ? overviewHtml() : S.view === "tasks" ? tasksHtml() : S.view === "calendar" ? calendarHtml() : settingsHtml();
  v.innerHTML = html;
  if (S.view === "calendar" && S.calMode === "day" && !render.scrolled && sameDay(S.day, new Date())) {
    render.scrolled = true;
    const now = $(".now"); if (now) setTimeout(() => window.scrollTo({ top: Math.max(0, now.getBoundingClientRect().top + window.scrollY - 260) }), 30);
  }
}

function signinHtml() {
  const noId = !DEMO && !CFG.clientId;
  return `<div class="signin"><span class="logo"><i></i></span><h1>Focus</h1>
    <p>Kalendář a úkoly z tvého Google účtu na jednom místě – stejně jako ve Focusu na PC.</p>
    ${noId ? `<p class="muted">Chybí Client ID v souboru config.js.</p>` : `<button class="btn primary" data-act="signin">Přihlásit se Googlem</button>`}
    <p class="muted" style="font-size:12px">Data zůstávají v Googlu, appka je jen čte a upravuje.</p></div>`;
}

// ----- Přehled -----
function overviewHtml() {
  const today = sod(new Date()), now = new Date();
  const worked = workedMs(today), done = doneOn(today).length, left = tasksDue(today, true).length;
  const next = S.events.filter(e => !e.allDay && e.end > now && sameDay(e.start, today)).sort((a, b) => a.start - b.start)[0];
  let html = `<div class="card"><div class="stats">
      <div class="stat"><span>Odpracováno</span><b>${S.trackedId ? dur(worked) : "–"}</b><small>${S.trackedId ? "h dnes" : "čeká na PC"}</small></div>
      <div class="stat"><span>Splněno</span><b>${done}</b><small>${plural(done, "úkol", "úkoly", "úkolů")} dnes</small></div>
      <div class="stat"><span>Zbývá</span><b>${left}</b><small>na dnes</small></div></div>`;
  if (next) {
    const mins = Math.round((next.start - now) / 60000);
    html += `<div class="next" data-ev="${esc(next.calId)}|${esc(next.id)}" style="--ev:${next.color}"><span class="dot"></span><div class="grow"><b>${esc(next.title)}</b><small>${hm(next.start)} – ${hm(next.end)}${next.loc ? " · " + esc(next.loc) : ""}</small></div>
      <span class="due ${mins <= 15 ? "today" : ""}">${mins <= 0 ? "probíhá" : mins < 60 ? "za " + mins + " min" : "v " + hm(next.start)}</span></div>`;
  } else html += `<div class="next muted" style="font-size:13px">Dnes už nic v kalendáři.</div>`;
  html += `</div>`;

  // týden: hodiny po dnech + splněné úkoly
  const w = monday(today), days = [...Array(7)].map((_, i) => addDays(w, i));
  const hours = days.map(workedMs), dones = days.map(d => doneOn(d).length), max = Math.max(4 * 3600000, ...hours);
  const totalH = hours.reduce((a, b) => a + b, 0), totalD = dones.reduce((a, b) => a + b, 0);
  html += `<div class="card"><div class="card-head"><span class="card-title">Tento týden</span><span class="muted" style="font-size:13px">${S.trackedId ? dur(totalH) + " h · " : ""}${totalD} ${plural(totalD, "úkol", "úkoly", "úkolů")}</span></div><div class="bars">`;
  days.forEach((d, i) => {
    const h = hours[i], isT = sameDay(d, today), future = d > today;
    html += `<button class="bar-col${isT ? " today" : ""}" data-act="openday" data-d="${+d}"><em>${h ? dur(h) : ""}</em><div class="bar-track"><div class="bar" style="height:${Math.round(h / max * 100)}%"></div></div>
      <span>${SHORT[d.getDay()]}</span><small>${future ? "" : dones[i] ? "✓ " + dones[i] : "·"}</small></button>`;
  });
  html += `</div></div>`;

  // projekty
  if (S.trackedId) {
    const from = S.projRange === "day" ? today : w, to = addDays(S.projRange === "day" ? today : w, S.projRange === "day" ? 1 : 7);
    const per = {};
    S.tracked.forEach(e => {
      const ms = Math.max(0, Math.min(+e.end, +to, Date.now()) - Math.max(+e.start, +from)); if (!ms) return;
      const k = e.project || e.title; per[k] = per[k] || { ms: 0, color: e.color }; per[k].ms += ms;
    });
    const rows = Object.entries(per).sort((a, b) => b[1].ms - a[1].ms), top = rows.length ? rows[0][1].ms : 1;
    html += `<div class="card"><div class="card-head"><span class="card-title">Čas po projektech</span><div class="seg mini">${[["day", "Dnes"], ["week", "Týden"]].map(([k, n]) => `<button class="${S.projRange === k ? "on" : ""}" data-act="projrange" data-id="${k}">${n}</button>`).join("")}</div></div>`;
    html += rows.length ? rows.map(([name, r]) => `<div class="proj"><div class="proj-top"><span class="cdot" style="background:${r.color}"></span><span class="grow">${esc(name)}</span><b>${dur(r.ms)}</b></div><div class="proj-track"><div style="width:${Math.max(3, Math.round(r.ms / top * 100))}%;background:${r.color}"></div></div></div>`).join("")
      : `<div class="empty">${S.projRange === "day" ? "Dnes zatím nic naměřeno." : "Tento týden zatím nic naměřeno."}</div>`;
    html += `</div>`;
  } else {
    html += `<div class="card"><div class="empty">Odpracovaný čas se tu ukáže, až ho Focus na PC začne zapisovat do Google kalendáře „${TRACKED_NAME}“ (Nastavení → Google kalendář → Povolit nová oprávnění).</div></div>`;
  }
  return html;
}

// ----- Úkoly -----
function dueChip(t) {
  if (!t.due) return "";
  const today = sod(new Date()), diff = Math.round((t.due - today) / 86400000);
  const cls = diff < 0 ? "late" : diff === 0 ? "today" : "";
  const txt = diff === 0 ? "dnes" : diff === 1 ? "zítra" : diff === -1 ? "včera" : diff > 1 && diff < 7 ? DAYS[t.due.getDay()] : t.due.getDate() + ". " + (t.due.getMonth() + 1) + ".";
  return `<span class="due ${cls}">${txt}</span>`;
}
function doneWhen(t) {
  if (!t.completed) return "splněno";
  const today = sod(new Date()), d = sod(t.completed), diff = Math.round((today - d) / 86400000);
  return "splněno " + (diff === 0 ? "dnes " + hm(t.completed) : diff === 1 ? "včera " + hm(t.completed) : t.completed.getDate() + ". " + (t.completed.getMonth() + 1) + ".");
}
function taskRow(t, opts) {
  opts = opts || {};
  const list = S.lists.find(l => l.id === t.listId);
  const parts = [];
  if (t.done) parts.push(doneWhen(t));
  if (opts.showList && list) parts.push(list.name);
  if (t.done && t.due) parts.push("termín " + t.due.getDate() + ". " + (t.due.getMonth() + 1) + ".");
  return `<div class="task${t.done ? " done" : ""}" data-task="${esc(t.id)}">
    <button class="check" data-act="toggle" data-id="${esc(t.id)}" aria-label="Hotovo">✓</button>
    <div class="tb"><div class="ts">${esc(t.title)}</div>${parts.length ? `<div class="tm">${esc(parts.join(" · "))}</div>` : ""}</div>${t.done || opts.hideDue ? "" : dueChip(t)}</div>`;
}

function tasksHtml() {
  const f = S.listFilter, inList = t => f === "all" || t.listId === f;
  const open = S.tasks.filter(t => !t.done && inList(t)).sort((a, b) => (a.due ? +a.due : 9e15) - (b.due ? +b.due : 9e15) || a.title.localeCompare(b.title, "cs"));
  const done = S.tasks.filter(t => t.done && inList(t)).sort((a, b) => (b.completed || 0) - (a.completed || 0));
  const showList = f === "all" && S.lists.length > 1;
  let html = `<div class="lists"><button class="pill${f === "all" ? " on" : ""}" data-act="list" data-id="all">Vše<span class="n">${S.tasks.filter(t => !t.done).length}</span></button>`;
  S.lists.forEach(l => { html += `<button class="pill${f === l.id ? " on" : ""}" data-act="list" data-id="${esc(l.id)}">${esc(l.name)}<span class="n">${S.tasks.filter(t => !t.done && t.listId === l.id).length}</span></button>`; });
  html += `</div><form class="add-row" data-act="quickadd"><span>+</span><input id="quick" placeholder="Přidat úkol${f !== "all" ? " do " + esc((S.lists.find(l => l.id === f) || {}).name || "") : ""}…" autocomplete="off" enterkeyhint="done"></form>`;
  // otevřené po skupinách: po termínu, dnes, nadcházející, bez termínu
  const today = sod(new Date()), groups = [["Po termínu", t => t.due && t.due < today], ["Dnes", t => t.due && sameDay(t.due, today)], ["Nadcházející", t => t.due && t.due > today], ["Bez termínu", t => !t.due]];
  let any = false;
  groups.forEach(([name, fn]) => {
    const items = open.filter(fn); if (!items.length) return; any = true;
    html += `<div class="caption">${name} · ${items.length}</div><div class="card">${items.map(t => taskRow(t, { showList, hideDue: name === "Dnes" })).join("")}</div>`;
  });
  if (!any) html += `<div class="card"><div class="empty">Všechno hotovo ✓</div></div>`;
  if (done.length) html += `<div class="caption">Hotové za 14 dní · ${done.length}</div><div class="card">${done.slice(0, store.get("doneAll", false) ? 999 : 8).map(t => taskRow(t, { showList })).join("")}
    ${done.length > 8 && !store.get("doneAll", false) ? `<button class="more" data-act="doneall">Zobrazit všech ${done.length}</button>` : ""}</div>`;
  return html;
}

// ----- Kalendář -----
function calendarHtml() { return S.calMode === "day" ? dayHtml() : S.calMode === "week" ? weekHtml() : monthHtml(); }

function dayHtml() {
  const d = S.day, isToday = sameDay(d, new Date());
  const evs = eventsOn(d), allDay = evs.filter(e => e.allDay), timed = evs.filter(e => !e.allDay);
  const tr = S.showTracked && S.trackedId ? trackedOn(d) : null;
  let html = `<div class="card">`;
  if (allDay.length) html += `<div class="allday" style="padding-top:12px">${allDay.map(e => `<span class="chip-ev" style="--ev:${e.color};--ev-bg:${tint(e.color, .82)}" data-ev="${esc(e.calId)}|${esc(e.id)}">${esc(e.title)}</span>`).join("")}</div>`;
  if (tr) html += `<div class="lanes"><span>Kalendář</span><span>Naměřeno${tr.length ? " · " + dur(workedMs(d)) : ""}</span></div>`;
  const due = tasksDue(d, isToday);
  html += timelineHtml(d, timed, isToday, tr) + `</div>`;
  if (due.length) html += `<div class="caption">Úkoly ${isToday ? "na dnes" : "s termínem"} · ${due.length}</div><div class="card">${due.map(t => taskRow(t, { hideDue: sameDay(t.due, d) })).join("")}</div>`;
  return html;
}

function layoutCols(items) {
  let cluster = [], end = 0;
  const flush = () => { const cols = Math.max(...cluster.map(c => c.col)) + 1; cluster.forEach(c => c.cols = cols); cluster = []; };
  items.forEach(it => {
    if (cluster.length && it.s >= end) flush();
    const used = cluster.filter(c => c.t > it.s).map(c => c.col);
    let col = 0; while (used.includes(col)) col++;
    it.col = col; cluster.push(it); end = Math.max(end, it.t);
  });
  if (cluster.length) flush();
  return items;
}

function timelineHtml(d, evs, isToday, tracked) {
  let startH = 7, endH = 22;
  const all = evs.concat(tracked || []);
  all.forEach(e => { startH = Math.min(startH, e.start < d ? 0 : e.start.getHours()); endH = Math.max(endH, e.end >= addDays(d, 1) ? 24 : Math.ceil(e.end.getHours() + e.end.getMinutes() / 60)); });
  if (isToday) { const h = new Date().getHours(); startH = Math.min(startH, h); endH = Math.max(endH, h + 1); }
  endH = Math.min(24, endH);
  const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour")) || 56;
  const base = +d + startH * 3600000, dayEnd = +addDays(d, 1);
  // pruhy: bez vrstvy celá šířka pro kalendář; s vrstvou 60 % kalendář, 40 % naměřeno
  const L = tracked ? "(100% - 72px) * 0.6" : "(100% - 72px)", T0 = "(60px + (100% - 72px) * 0.6 + 4px)", TW = "((100% - 72px) * 0.4 - 4px)";
  let html = `<div class="timeline" style="height:${(endH - startH) * H + 10}px;padding-top:10px">`;
  for (let h = startH; h < endH; h++) html += `<div class="hour" data-act="newat" data-h="${h}"><span>${h}:00</span></div>`;
  const items = layoutCols(evs.map(e => ({ e, s: Math.max(+e.start, +d), t: Math.min(+e.end, dayEnd) })).sort((a, b) => a.s - b.s || b.t - a.t));
  items.forEach(it => {
    const top = 10 + (it.s - base) / 3600000 * H, h = Math.max(22, (it.t - it.s) / 3600000 * H - 2), e = it.e;
    html += `<div class="ev${e.free ? " free" : ""}" style="top:${top}px;height:${h}px;left:calc(60px + ${L} * ${it.col / it.cols});width:calc(${L} / ${it.cols} - 4px);--ev:${e.color};--ev-bg:${tint(e.color, .84)}" data-ev="${esc(e.calId)}|${esc(e.id)}">
      <b>${esc(e.title)}</b>${h > 34 ? `<small>${hm(e.start)} – ${hm(e.end)}${e.loc ? " · " + esc(e.loc) : ""}</small>` : ""}</div>`;
  });
  if (tracked) {
    let lastBottom = -1;
    tracked.forEach(e => {
      const s = Math.max(+e.start, +d), t = Math.min(+e.end, dayEnd, Date.now());
      if (t - s < 60000) return;
      let top = 10 + (s - base) / 3600000 * H, h = Math.max(18, (t - s) / 3600000 * H - 2);
      if (top < lastBottom + 2) { h = Math.max(18, h - (lastBottom + 2 - top)); top = lastBottom + 2; }
      lastBottom = top + h;
      html += `<div class="ev tracked" style="top:${top}px;height:${h}px;left:calc${T0};width:calc${TW};--ev:${e.color};--ev-bg:${tint(e.color, .88)}" title="${esc(e.title)} ${hm(e.start)}–${hm(e.end)}">
        <b>${esc(e.title)}</b>${h > 32 ? `<small>${dur(t - s)}${e.project && e.project !== e.title ? " · " + esc(e.project) : ""}</small>` : ""}</div>`;
    });
  }
  if (isToday) html += `<div class="now" style="top:${10 + (Date.now() - base) / 3600000 * H}px"></div>`;
  return html + `</div>`;
}

function weekHtml() {
  const w = monday(S.day);
  let html = `<div class="card">`;
  for (let i = 0; i < 7; i++) {
    const d = addDays(w, i), evs = eventsOn(d), due = tasksDue(d, false), isT = sameDay(d, new Date());
    const worked = S.showTracked && S.trackedId ? workedMs(d) : 0;
    html += `<div class="week-day"><div class="week-head${isT ? " today" : ""}" data-act="openday" data-d="${+d}">${dayLabel(d)} <span class="muted">${d.getDate()}. ${d.getMonth() + 1}.</span>${worked ? `<span class="worked">${dur(worked)} h</span>` : ""}</div>`;
    if (!evs.length && !due.length) html += `<div class="agenda"><span class="t"></span><span class="s muted" style="font-size:13px">Volno</span></div>`;
    evs.forEach(e => { html += `<div class="agenda" data-ev="${esc(e.calId)}|${esc(e.id)}" style="--ev:${e.color}"><span class="t">${e.allDay ? "celý den" : hm(e.start)}</span><span class="dot"></span><span class="s">${esc(e.title)}</span><span class="c">${esc(calById(e.calId).name)}</span></div>`; });
    due.forEach(t => { html += `<div class="agenda" data-task="${esc(t.id)}"><span class="t">úkol</span><span class="dot ring"></span><span class="s">${esc(t.title)}</span></div>`; });
    html += `</div>`;
  }
  return html + `</div>`;
}

function monthHtml() {
  const m = S.month, start = monday(m), today = sod(new Date());
  let html = `<div class="card month"><div class="mgrid head">${["Po", "Út", "St", "Čt", "Pá", "So", "Ne"].map(x => `<span>${x}</span>`).join("")}</div><div class="mgrid">`;
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i), evs = eventsOn(d), out = d.getMonth() !== m.getMonth();
    const worked = S.showTracked && S.trackedId && !out ? workedMs(d) : 0, due = tasksDue(d, false).length;
    html += `<button class="mcell${out ? " out" : ""}${sameDay(d, today) ? " is-today" : ""}" data-act="openday" data-d="${+d}"><b>${d.getDate()}</b>
      <div class="mev">${evs.slice(0, 3).map(e => `<i style="background:${e.color}"></i>`).join("")}${evs.length > 3 ? `<em>+${evs.length - 3}</em>` : ""}</div>
      ${worked ? `<small>${dur(worked)}</small>` : due ? `<small class="mdue">${due} ✓</small>` : ""}</button>`;
  }
  html += `</div></div>`;
  // seznam událostí vybraného měsíce (nadcházející)
  const upcoming = S.events.filter(e => e.start.getMonth() === m.getMonth() && e.start.getFullYear() === m.getFullYear() && e.end >= today).slice(0, 12);
  if (upcoming.length) html += `<div class="caption">Nadcházející · ${MONTHS1[m.getMonth()].toLowerCase()}</div><div class="card">${upcoming.map(e => `<div class="agenda" data-ev="${esc(e.calId)}|${esc(e.id)}" style="--ev:${e.color}"><span class="t">${e.start.getDate()}. ${e.start.getMonth() + 1}.</span><span class="dot"></span><span class="s">${esc(e.title)}</span><span class="c">${e.allDay ? "celý den" : hm(e.start)}</span></div>`).join("")}</div>`;
  return html;
}

// ----- Nastavení -----
function settingsHtml() {
  const sel = selectedCals().map(c => c.id), theme = store.get("theme", "auto");
  let html = `<div class="caption">Účet</div><div class="card"><div class="row"><div class="grow"><div>${esc(store.get("email", DEMO ? "ukazka@gmail.com" : "Google účet"))}</div>
    <div class="sub">${S.loadedAt ? "Synchronizováno v " + hm(new Date(S.loadedAt)) : "Načítám…"}</div></div>
    <button class="btn secondary" data-act="signout" style="height:36px;padding:0 12px;font-size:13px">Odhlásit</button></div></div>`;
  html += `<div class="caption">Odpracovaný čas</div><div class="card"><div class="row"><div class="grow">${S.trackedId ? "Čte se z kalendáře „" + TRACKED_NAME + "“" : "Zatím nenalezeno"}
    <div class="sub">${S.trackedId ? "Zapisuje ho Focus na PC." : "Na PC: Nastavení → Google kalendář → Povolit nová oprávnění."}</div></div></div></div>`;
  html += `<div class="caption">Zobrazované kalendáře</div><div class="card">`;
  S.calendars.forEach(c => {
    html += `<div class="row" data-act="togglecal" data-id="${esc(c.id)}"><span class="cdot" style="background:${c.color}"></span><div class="grow">${esc(c.name)}${c.mirror ? `<div class="sub">z Outlooku přes Focus na PC · jen pro čtení</div>` : c.role === "owner" || c.role === "writer" ? "" : `<div class="sub">jen pro čtení</div>`}</div><span class="sw${sel.includes(c.id) ? " on" : ""}"></span></div>`;
  });
  html += `</div><div class="caption">Nové události zakládat do</div><div class="chips" style="padding:0 4px">`;
  const target = defaultCal();
  writableCals().forEach(c => { html += `<button class="chip${c.id === target ? " on" : ""}" data-act="caltarget" data-id="${esc(c.id)}"><span class="cdot" style="background:${c.color}"></span>${esc(c.name)}</button>`; });
  html += `</div><div class="caption">Vzhled</div><div class="chips" style="padding:0 4px">`;
  [["auto", "Podle telefonu"], ["light", "Světlý"], ["dark", "Tmavý"]].forEach(([k, n]) => { html += `<button class="chip${theme === k ? " on" : ""}" data-act="theme" data-id="${k}">${n}</button>`; });
  html += `</div><p class="muted" style="font-size:12px;padding:8px 6px">Focus pro telefon · kalendář a úkoly z Googlu. Na PC je stejné v desktopovém Focusu.</p>`;
  return html;
}

// ---------- spodní panely ----------
function openSheet(html, onMount) {
  $("#sheet").innerHTML = `<div class="grab"></div>` + html;
  $("#sheet-backdrop").classList.add("open"); $("#sheet").classList.add("open");
  if (onMount) onMount($("#sheet"));
}
function closeSheet() { $("#sheet").classList.remove("open"); $("#sheet-backdrop").classList.remove("open"); }

function calChips(selected, attr) {
  return `<div class="chips">` + writableCals().map(c => `<button type="button" class="chip${c.id === selected ? " on" : ""}" data-${attr}="${esc(c.id)}"><span class="cdot" style="background:${c.color}"></span>${esc(c.name)}</button>`).join("") + `</div>`;
}

function eventSheet(ev, presetStart) {
  const start = ev ? ev.start : presetStart || nextSlot();
  const end = ev ? (ev.allDay ? addDays(ev.end, -1) : ev.end) : new Date(+start + 3600000);   // celodenní: konec včetně
  const ro = ev && ev.lock, dis = ro ? "disabled" : "";
  let cal = ev ? ev.calId : defaultCal(), allDay = !!(ev && ev.allDay);
  const tm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
  openSheet(`<h2>${ev ? (ro ? esc(ev.title) : "Upravit událost") : "Nová událost"}</h2>
    <div class="hint">${ev ? esc(calById(ev.calId).name) : "Google kalendář"}</div>
    ${ro ? `<div class="lock">🔒 ${esc(ev.lock)}</div>` : ""}
    <form id="evf">
      ${ro ? "" : calChips(cal, "cal")}
      <div class="group"><div class="field"><label>Název</label><input name="title" value="${ev ? esc(ev.title) : ""}" placeholder="Např. Večeře" ${dis} required></div>
        <div class="field"><label>Místo</label><input name="loc" value="${ev ? esc(ev.loc) : ""}" placeholder="nepovinné" ${dis}></div></div>
      <div class="group">
        <div class="field" data-allday><label>Celý den</label><span class="grow"></span><span class="sw${allDay ? " on" : ""}" id="sw-allday"></span></div>
        <div class="field"><label>Začátek</label><input type="date" name="sdate" value="${ymd(start)}" ${dis}><input type="time" name="stime" class="tm" value="${tm(start)}" step="300" ${dis}></div>
        <div class="field"><label>Konec</label><input type="date" name="edate" value="${ymd(end)}" ${dis}><input type="time" name="etime" class="tm" value="${tm(end)}" step="300" ${dis}></div>
      </div>
      ${ro ? "" : `<div class="chips" id="lens">${[["30 min", 30], ["1 h", 60], ["2 h", 120], ["4 h", 240], ["8 h", 480]].map(([n, m]) => `<button type="button" class="chip" data-len="${m}">${n}</button>`).join("")}</div>`}
      <div class="group"><div class="field note"><label>Poznámka</label><textarea name="desc" rows="2" placeholder="nepovinné" ${dis}>${ev ? esc(ev.desc || "") : ""}</textarea></div></div>
      <div class="err" id="everr"></div>
      <div class="actions">
        ${ev && !ro ? `<button type="button" class="btn danger" data-sheet="delete">Smazat</button>` : ""}
        ${ev && ev.link ? `<a class="btn secondary" style="display:grid;place-items:center;text-decoration:none;color:inherit" href="${esc(ev.link)}" target="_blank" rel="noopener">Google</a>` : ""}
        ${ro ? "" : `<button class="btn primary">${ev ? "Uložit" : "Založit"}</button>`}
      </div>
    </form>`, sheet => {
    sheet.querySelectorAll("[data-cal]").forEach(b => b.onclick = () => { cal = b.dataset.cal; sheet.querySelectorAll("[data-cal]").forEach(x => x.classList.toggle("on", x === b)); });
    const q = n => sheet.querySelector(`[name="${n}"]`);
    const at = (dn, tn) => { const d = parseYmd(q(dn).value) || sod(new Date()), [h, m] = (q(tn).value || "9:00").split(":").map(Number); d.setHours(h || 0, m || 0, 0, 0); return d; };
    const setEnd = d => { q("edate").value = ymd(d); q("etime").value = tm(d); };
    const syncAllDay = () => { sheet.querySelectorAll(".tm").forEach(x => x.style.display = allDay ? "none" : ""); const l = sheet.querySelector("#lens"); if (l) l.style.display = allDay ? "none" : ""; };
    syncAllDay();
    if (!ro) {
      sheet.querySelector("[data-allday]").onclick = () => { allDay = !allDay; sheet.querySelector("#sw-allday").classList.toggle("on", allDay); syncAllDay(); };
      // posun začátku posune i konec (zachová délku)
      let lenMs = Math.max(0, at("edate", "etime") - at("sdate", "stime"));
      ["sdate", "stime"].forEach(n => q(n).addEventListener("change", () => setEnd(new Date(+at("sdate", "stime") + lenMs))));
      ["edate", "etime"].forEach(n => q(n).addEventListener("change", () => { lenMs = Math.max(0, at("edate", "etime") - at("sdate", "stime")); }));
      sheet.querySelectorAll("[data-len]").forEach(b => b.onclick = () => { lenMs = +b.dataset.len * 60000; setEnd(new Date(+at("sdate", "stime") + lenMs)); });
    }
    const del = sheet.querySelector('[data-sheet="delete"]');
    if (del) del.onclick = async () => {
      if (!confirm("Smazat „" + ev.title + "“?")) return;
      try { await api("DELETE", CAL_API + "/calendars/" + encodeURIComponent(ev.calId) + "/events/" + encodeURIComponent(ev.id)); S.events = S.events.filter(x => x !== ev); closeSheet(); render(); toast("Událost smazána"); }
      catch (e) { sheet.querySelector("#everr").textContent = e.message; }
    };
    sheet.querySelector("#evf").onsubmit = async ev2 => {
      ev2.preventDefault(); if (ro) return;
      const f = new FormData(ev2.target);
      let s, e;
      if (allDay) { s = parseYmd(f.get("sdate")); e = addDays(parseYmd(f.get("edate")) || s, 1); }   // Google: konec celodenní je výlučný
      else { s = at("sdate", "stime"); e = at("edate", "etime"); }
      if (!s || e <= s) { sheet.querySelector("#everr").textContent = "Konec musí být po začátku."; return; }
      const body = {
        summary: f.get("title").trim(), location: f.get("loc").trim(), description: f.get("desc").trim(),
        // při přepnutí celodenní ↔ časová je potřeba druhou podobu výslovně vynulovat
        start: allDay ? { date: ymd(s), dateTime: null } : { dateTime: isoLocal(s), date: null },
        end: allDay ? { date: ymd(e), dateTime: null } : { dateTime: isoLocal(e), date: null }
      };
      if (!ev) { ["start", "end"].forEach(k => { const o = body[k]; Object.keys(o).forEach(x => o[x] === null && delete o[x]); }); }
      try {
        if (!ev) await api("POST", CAL_API + "/calendars/" + encodeURIComponent(cal) + "/events", body);
        else {
          let c = ev.calId;
          if (cal !== c) { await api("POST", CAL_API + "/calendars/" + encodeURIComponent(c) + "/events/" + encodeURIComponent(ev.id) + "/move?destination=" + encodeURIComponent(cal)); c = cal; }
          await api("PATCH", CAL_API + "/calendars/" + encodeURIComponent(c) + "/events/" + encodeURIComponent(ev.id), body);
        }
        if (!ev) store.set("calTarget", cal);
        closeSheet(); toast(ev ? "Uloženo" : "Událost založena"); S.day = sod(s); await refresh();
      } catch (e2) { sheet.querySelector("#everr").textContent = e2.message === "auth" ? "Přihlášení vypršelo – obnov ho nahoře." : e2.message; }
    };
  });
}
function nextSlot() { const d = new Date(S.view === "calendar" ? S.day : new Date()), n = new Date(); if (sameDay(d, n)) d.setHours(n.getHours() + 1, 0, 0, 0); else d.setHours(9, 0, 0, 0); return d; }

function taskSheet(t) {
  let listId = t ? t.listId : (S.listFilter !== "all" ? S.listFilter : (S.lists[0] || {}).id);
  const today = sod(new Date());
  openSheet(`<h2>${t ? "Upravit úkol" : "Nový úkol"}</h2><div class="hint">Google úkoly${t ? " · " + esc((S.lists.find(l => l.id === t.listId) || {}).name || "") : ""}${t && t.done ? " · " + esc(doneWhen(t)) : ""}</div>
    <form id="tf">
      ${t ? "" : `<div class="chips">${S.lists.map(l => `<button type="button" class="chip${l.id === listId ? " on" : ""}" data-list="${esc(l.id)}">${esc(l.name)}</button>`).join("")}</div>`}
      <div class="group"><div class="field"><label>Název</label><input name="title" value="${t ? esc(t.title) : ""}" placeholder="Co je potřeba udělat" required></div>
        <div class="field"><label>Termín</label><input type="date" name="due" value="${t && t.due ? ymd(t.due) : ""}"></div></div>
      <div class="chips">${[["Dnes", 0], ["Zítra", 1], ["Příští týden", 7 - ((today.getDay() + 6) % 7)], ["Bez termínu", null]].map(([n, d]) => `<button type="button" class="chip" data-due="${d === null ? "" : ymd(addDays(today, d))}">${n}</button>`).join("")}</div>
      ${t && t.notes ? `<div class="hint" style="white-space:pre-wrap">${esc(t.notes)}</div>` : ""}
      <div class="err" id="terr"></div>
      <div class="actions">${t ? `<button type="button" class="btn danger" data-sheet="delete">Smazat</button>` : ""}<button class="btn primary">${t ? "Uložit" : "Přidat"}</button></div>
    </form>`, sheet => {
    sheet.querySelectorAll("[data-list]").forEach(b => b.onclick = () => { listId = b.dataset.list; sheet.querySelectorAll("[data-list]").forEach(x => x.classList.toggle("on", x === b)); });
    sheet.querySelectorAll("[data-due]").forEach(b => b.onclick = () => { sheet.querySelector('[name="due"]').value = b.dataset.due; });
    const del = sheet.querySelector('[data-sheet="delete"]');
    if (del) del.onclick = async () => {
      if (!confirm("Smazat úkol „" + t.title + "“?")) return;
      try { await api("DELETE", TASK_API + "/lists/" + encodeURIComponent(t.listId) + "/tasks/" + encodeURIComponent(t.id)); S.tasks = S.tasks.filter(x => x !== t); store.set("tasks", S.tasks); closeSheet(); render(); toast("Úkol smazán"); }
      catch (e) { sheet.querySelector("#terr").textContent = e.message; }
    };
    sheet.querySelector("#tf").onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target), title = f.get("title").trim(), dueS = f.get("due");
      const body = { title, due: dueS ? dueS + "T00:00:00.000Z" : null };
      try {
        if (t) { await api("PATCH", TASK_API + "/lists/" + encodeURIComponent(t.listId) + "/tasks/" + encodeURIComponent(t.id), body); t.title = title; t.due = dueS ? parseYmd(dueS) : null; }
        else { if (!body.due) delete body.due; const r = await api("POST", TASK_API + "/lists/" + encodeURIComponent(listId) + "/tasks", body); S.tasks.push({ id: r.id, listId, title, notes: "", due: dueS ? parseYmd(dueS) : null, done: false, completed: null }); }
        store.set("tasks", S.tasks); closeSheet(); render(); toast(t ? "Uloženo" : "Úkol přidán");
      } catch (e2) { sheet.querySelector("#terr").textContent = e2.message === "auth" ? "Přihlášení vypršelo – obnov ho nahoře." : e2.message; }
    };
  });
}

async function toggleTask(id) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  t.done = !t.done; t.completed = t.done ? new Date() : null; render();
  try { await api("PATCH", TASK_API + "/lists/" + encodeURIComponent(t.listId) + "/tasks/" + encodeURIComponent(t.id), t.done ? { status: "completed" } : { status: "needsAction", completed: null }); store.set("tasks", S.tasks); if (t.done) toast("Hotovo ✓"); }
  catch (e) { t.done = !t.done; t.completed = null; render(); if (e.message !== "auth") toast(e.message); }
}

// ---------- ovládání ----------
function shift(dir) {
  if (S.calMode === "day") S.day = addDays(S.day, dir);
  else if (S.calMode === "week") S.day = addDays(S.day, 7 * dir);
  else S.month = addMonths(S.month, dir);
  rangeChanged();
}
function rangeChanged() {
  const r = S.eventsRange, { from, to } = loadRange();
  render();
  if (!r || +from < r.from || +to > r.to) refresh();
}

document.addEventListener("click", async e => {
  const a = e.target.closest("[data-act]"), evEl = e.target.closest("[data-ev]"), taskEl = e.target.closest("[data-task]");
  if (a) {
    const act = a.dataset.act, id = a.dataset.id;
    if (act === "toggle") { e.stopPropagation(); return toggleTask(id); }
    if (act === "signin") { try { await signIn(true); store.set("everSigned", true); render(); await refresh(true); } catch (err) { toast(err.message); } return; }
    if (act === "reauth") { try { await signIn(false); render(); await refresh(); } catch (err) { toast(err.message); } return; }
    if (act === "refresh") return refresh(true);
    if (act === "settings") { S.prevView = S.view; S.view = "settings"; window.scrollTo({ top: 0 }); return render(); }
    if (act === "back") { S.view = S.prevView || "overview"; return render(); }
    if (act === "calmode") { S.calMode = id; store.set("calMode", id); if (id === "month") S.month = addMonths(S.day, 0); render.scrolled = id !== "day"; window.scrollTo({ top: 0 }); return rangeChanged(); }
    if (act === "layer") { S.showTracked = !S.showTracked; store.set("showTracked", S.showTracked); return render(); }
    if (act === "prev") return shift(-1);
    if (act === "next") return shift(1);
    if (act === "today") { S.day = sod(new Date()); S.month = addMonths(new Date(), 0); render.scrolled = false; return rangeChanged(); }
    if (act === "pick") { S.day = new Date(+a.dataset.d); render.scrolled = !sameDay(S.day, new Date()); return rangeChanged(); }
    if (act === "openday") { S.day = new Date(+a.dataset.d); S.view = "calendar"; S.calMode = "day"; store.set("calMode", "day"); render.scrolled = !sameDay(S.day, new Date()); window.scrollTo({ top: 0 }); return rangeChanged(); }
    if (act === "projrange") { S.projRange = id; return render(); }
    if (act === "doneall") { store.set("doneAll", true); return render(); }
    if (act === "list") { S.listFilter = id; store.set("listFilter", id); return render(); }
    if (act === "newat") { const d = new Date(S.day); d.setHours(+a.dataset.h, 0, 0, 0); return eventSheet(null, d); }
    if (act === "togglecal") {
      const c = S.calendars.find(x => x.id === id);
      if (c && c.mirror) store.set("workHidden", !store.get("workHidden", false));
      else { const ids = selectedCals().filter(x => !x.mirror).map(x => x.id); store.set("calSel", ids.includes(id) ? ids.filter(x => x !== id) : ids.concat(id)); }
      render(); return refresh();
    }
    if (act === "caltarget") { store.set("calTarget", id); return render(); }
    if (act === "theme") { store.set("theme", id); applyTheme(); return render(); }
    if (act === "signout") {
      if (!DEMO && window.google && S.token) google.accounts.oauth2.revoke(S.token, () => { });
      ["token", "everSigned", "cals", "events", "tracked", "tasks", "lists", "calSel", "calTarget", "trackedId"].forEach(k => store.set(k, null));
      S.token = null; S.calendars = []; S.events = []; S.tracked = []; S.tasks = []; S.lists = []; S.trackedId = null; S.view = "overview"; return render();
    }
  }
  if (evEl) { const [cal, id] = evEl.dataset.ev.split("|"); const ev = S.events.find(x => x.calId === cal && x.id === id); if (ev) eventSheet(ev); return; }
  if (taskEl) { const t = S.tasks.find(x => x.id === taskEl.dataset.task); if (t) taskSheet(t); }
});
document.addEventListener("submit", async e => {
  if (!e.target.matches('[data-act="quickadd"]')) return;
  e.preventDefault();
  const inp = $("#quick"), title = inp.value.trim(); if (!title) return;
  const listId = S.listFilter !== "all" ? S.listFilter : (S.lists[0] || {}).id; if (!listId) return;
  inp.value = "";
  const tmp = { id: "tmp" + Date.now(), listId, title, notes: "", due: null, done: false, completed: null }; S.tasks.push(tmp); render(); $("#quick").focus();
  try { const r = await api("POST", TASK_API + "/lists/" + encodeURIComponent(listId) + "/tasks", { title }); tmp.id = r.id; store.set("tasks", S.tasks); }
  catch (err) { S.tasks = S.tasks.filter(x => x !== tmp); render(); toast(err.message === "auth" ? "Přihlášení vypršelo" : err.message); }
});
$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  S.view = b.dataset.view; render.scrolled = !(S.view === "calendar" && S.calMode === "day"); window.scrollTo({ top: 0 });
  rangeChanged();
});
$("#fab").addEventListener("click", () => S.view === "tasks" ? taskSheet(null) : eventSheet(null));
$("#sheet-backdrop").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

// přetažení prstem doleva / doprava v Kalendáři = další / předchozí den, týden nebo měsíc
let touch = null;
$("#view").addEventListener("touchstart", e => { if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; }, { passive: true });
$("#view").addEventListener("touchend", e => {
  if (!touch || S.view !== "calendar") return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y, fast = Date.now() - touch.t < 600;
  touch = null;
  if (!fast || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  shift(dx < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - S.loadedAt > 5 * 60000) refresh(); });
setInterval(() => { if (!document.hidden && !$("#sheet").classList.contains("open") && (S.view === "overview" || S.view === "calendar")) render(); }, 60000);

function applyTheme() {
  const t = store.get("theme", "auto");
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  syncBars();
}
// Stavová i spodní systémová lišta Androidu mají barvu podle theme-color – musí sedět s pozadím appky.
function syncBars() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#111113";
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", bg);
  document.documentElement.style.background = bg;
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { syncBars(); render(); });

// ---------- ukázková data (?demo) ----------
const Demo = {
  cals: [
    { id: "ondra@gmail.com", name: "Ondra", color: "#9FC6E7", role: "owner", primary: true, visible: true },
    { id: "ostatni", name: "Ostatní", color: "#F691B2", role: "owner", visible: true },
    { id: "doktori", name: "Doktoři a prohlídky", color: "#42D692", role: "owner", visible: true },
    { id: "tuo", name: "TUO – přednášky", color: "#FFAD46", role: "reader", visible: true },
    { id: "work", name: "Firemní", color: "#3F51B5", role: "reader", mirror: true, visible: true }
  ],
  init() {
    const d = sod(new Date()), at = (day, h, m) => { const x = addDays(d, day); x.setHours(h, m, 0, 0); return x; };
    let n = 0;
    const ev = (cal, title, s, mins, extra) => Object.assign({ id: "e" + (++n), calId: cal, title, loc: "", start: s, end: new Date(+s + mins * 60000), allDay: false, color: calById(cal).color, free: false, link: "", lock: cal === "tuo" ? "Kalendář „TUO – přednášky“ je jen pro čtení." : "" }, extra || {});
    S.calendars = this.cals; S.trackedId = "tracked";
    S.events = [
      ev("ondra@gmail.com", "Ranní běh", at(0, 7, 0), 45), ev("tuo", "Finanční trhy – přednáška", at(0, 9, 45), 90, { loc: "A-312" }),
      ev("doktori", "Zubař", at(0, 11, 15), 45, { loc: "Vinohradská 12" }), ev("ondra@gmail.com", "Oběd s Áďou", at(0, 12, 30), 60, { color: "#E67C73" }),
      ev("ostatni", "Nákup na víkend", at(0, 17, 0), 45), ev("ondra@gmail.com", "Večeře s rodiči", at(0, 18, 30), 90),
      ev("ostatni", "Narozeniny Andrejky", d, 1440, { allDay: true, end: addDays(d, 1) }), ev("ondra@gmail.com", "Volejbal", at(1, 19, 0), 120),
      ev("tuo", "Pojišťovnictví – cvičení", at(2, 10, 45), 90),
      ev("work", "Porada vedení", at(0, 14, 0), 60, { loc: "Zasedačka 2", lock: "Firemní schůzka z Outlooku – změny dělej v Outlooku." }),
      ev("work", "Call s účetní", at(1, 9, 30), 30, { loc: "Teams", lock: "Firemní schůzka z Outlooku – změny dělej v Outlooku." }), ev("ostatni", "Servis auta", at(3, 8, 0), 60), ev("doktori", "Kontrola", at(9, 8, 30), 30)
    ];
    const tr = (day, h, m, mins, title, project, color) => ({ id: "w" + (++n), title, project, start: at(day, h, m), end: new Date(+at(day, h, m) + mins * 60000), color });
    const wk = -((d.getDay() + 6) % 7);
    S.tracked = [];
    for (let i = wk; i <= 0; i++) {
      S.tracked.push(tr(i, 8, 10, 95, "Monthly payment run", "DVG Finance", "#8E24AA"), tr(i, 10, 0, 70, "Ai development", "Vibe Coding", "#039BE5"));
      if (i % 2) S.tracked.push(tr(i, 13, 0, 50, "Bakalářka", "School", "#0B8043"));
    }
    S.lists = [{ id: "osobni", name: "Osobní" }, { id: "moje", name: "Moje úkoly" }];
    const t = (id, list, title, due, doneDaysAgo) => ({ id, listId: list, title, notes: "", due: due === null ? null : addDays(d, due), done: doneDaysAgo != null, completed: doneDaysAgo != null ? new Date(+at(-doneDaysAgo, 15, 20)) : null });
    S.tasks = [
      t("t1", "osobni", "Zavolat doktorce", 0), t("t2", "osobni", "Pneumatiky", -2), t("t3", "osobni", "Ukončit REVOLUT", 3),
      t("t4", "osobni", "Volejbalový míč pro rodiče", null), t("t5", "moje", "Bakalářka – zadání práce", 1), t("t6", "osobni", "T-Mobile s babičkou", null),
      t("t7", "moje", "NJ úkol 223/3", 0, 0), t("t8", "osobni", "Objednat vitamíny", null, 0), t("t9", "osobni", "Zaplatit nájem", -1, 1), t("t10", "moje", "Prezentace TIS", -3, 3)
    ];
    S.loadedAt = Date.now();
  },
  async api(method) { if (method !== "GET") await new Promise(r => setTimeout(r, 150)); return { id: "d" + Date.now() }; }
};

// ---------- start ----------
// přímý odkaz na obrazovku (#overview, #tasks, #calendar, #week, #month) a vynucený vzhled (?theme=dark)
const startView = location.hash.slice(1);
if (["overview", "tasks", "calendar", "settings"].includes(startView)) S.view = startView;
if (["week", "month", "day"].includes(startView)) { S.view = "calendar"; S.calMode = startView; }
render.scrolled = !(S.view === "calendar" && S.calMode === "day");
applyTheme();
const forced = new URLSearchParams(location.search).get("theme");
if (forced === "dark" || forced === "light") { document.documentElement.dataset.theme = forced; syncBars(); }
if (DEMO) { store.set = () => { }; Demo.init(); }
render();
if (!DEMO && signedIn()) { if (S.token) refresh(); else { S.needAuth = true; render(); } }
if ("serviceWorker" in navigator && !DEMO && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => { });
