// Focus pro telefon: Google kalendář + Google Tasks ve stylu desktopového Focusu.
// Mluví přímo s Google API (žádný vlastní server); přihlášení přes Google Identity Services.
// ?demo = ukázková data bez přihlášení (kontrola vzhledu).
"use strict";

const CFG = window.FOCUS_CONFIG || {};
const DEMO = new URLSearchParams(location.search).has("demo");
const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/tasks";
const CAL_API = "https://www.googleapis.com/calendar/v3";
const TASK_API = "https://tasks.googleapis.com/tasks/v1";
const EVENT_COLORS = { 1: "#7986CB", 2: "#33B679", 3: "#8E24AA", 4: "#E67C73", 5: "#F6BF26", 6: "#F4511E", 7: "#039BE5", 8: "#616161", 9: "#3F51B5", 10: "#0B8043", 11: "#D50000" };
const DAYS = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
const MONTHS = ["ledna", "února", "března", "dubna", "května", "června", "července", "srpna", "září", "října", "listopadu", "prosince"];

// ---------- pomocné ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const sod = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const hm = d => d.getHours() + ":" + pad(d.getMinutes());
const monday = d => addDays(sod(d), -((d.getDay() + 6) % 7));
const dayLabel = d => DAYS[d.getDay()].replace(/^./, c => c.toUpperCase());
const dateLong = d => d.getDate() + ". " + MONTHS[d.getMonth()];
function isoLocal(d) {
  const off = -d.getTimezoneOffset(), s = off >= 0 ? "+" : "-", a = Math.abs(off);
  return ymd(d) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":00" + s + pad(Math.floor(a / 60)) + ":" + pad(a % 60);
}
function parseYmd(s) { const p = (s || "").slice(0, 10).split("-").map(Number); return p.length === 3 && p[0] ? new Date(p[0], p[1] - 1, p[2]) : null; }
function tint(hex, amt) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const dark = document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const base = dark ? [28, 28, 31] : [255, 255, 255], a = dark ? 0.78 : amt;
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
  view: "today", day: sod(new Date()), week: monday(new Date()),
  token: null, tokenExp: 0, needAuth: false,
  calendars: store.get("cals", []), events: store.get("events", []), eventsRange: store.get("eventsRange", null),
  lists: store.get("lists", []), tasks: store.get("tasks", []), listFilter: store.get("listFilter", "all"),
  loading: 0, loadedAt: 0, error: null
};
S.events.forEach(revive);
S.tasks.forEach(t => { t.due = t.due ? new Date(t.due) : null; });

function revive(e) { e.start = new Date(e.start); e.end = new Date(e.end); }
function selectedCals() {
  const sel = store.get("calSel", null);
  return S.calendars.filter(c => sel ? sel.includes(c.id) : (c.visible || c.primary));
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
  const out = []; let page = "";
  do {
    const j = await api("GET", CAL_API + "/users/me/calendarList?maxResults=250" + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
    (j.items || []).forEach(c => { if (!c.deleted) out.push({ id: c.id, name: c.summaryOverride || c.summary, color: (c.backgroundColor || "#7C5CD6").toUpperCase(), role: c.accessRole, primary: !!c.primary, visible: !!c.selected && !c.hidden }); });
    page = j.nextPageToken || "";
  } while (page);
  out.sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name, "cs"));
  S.calendars = out; store.set("cals", out);
  const p = out.find(c => c.primary); if (p) store.set("email", p.id);
}

function rangeFor() {
  const from = addDays(monday(S.view === "week" ? S.week : S.day), 0), to = addDays(from, 7);
  return { from, to };
}

async function loadEvents() {
  const { from, to } = rangeFor(), all = [];
  await Promise.all(selectedCals().map(async cal => {
    let page = "";
    do {
      const j = await api("GET", CAL_API + "/calendars/" + encodeURIComponent(cal.id) + "/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=" +
        encodeURIComponent(from.toISOString()) + "&timeMax=" + encodeURIComponent(to.toISOString()) + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
      (j.items || []).forEach(e => { const n = normEvent(e, cal); if (n) all.push(n); });
      page = j.nextPageToken || "";
    } while (page);
  }));
  all.sort((a, b) => a.start - b.start);
  S.events = all; S.eventsRange = { from: +from, to: +to };
  store.set("events", all); store.set("eventsRange", S.eventsRange);
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
    id: e.id, calId: cal.id, title: e.summary || "(bez názvu)", loc: e.location || "", start, end, allDay,
    color: EVENT_COLORS[e.colorId] || cal.color, free: e.transparency === "transparent", link: e.htmlLink || "",
    lock: !writable ? "Kalendář „" + cal.name + "“ je jen pro čtení." : e.recurringEventId ? "Opakovaná událost – uprav ji v Google Kalendáři." : others ? "Schůzka s dalšími lidmi – uprav ji v Google Kalendáři." : ""
  };
}

async function loadTasks() {
  const lj = await api("GET", TASK_API + "/users/@me/lists?maxResults=100");
  const lists = (lj.items || []).map(l => ({ id: l.id, name: l.title }));
  const tasks = [], since = sod(addDays(new Date(), -1));
  await Promise.all(lists.map(async l => {
    let page = "";
    do {
      const j = await api("GET", TASK_API + "/lists/" + encodeURIComponent(l.id) + "/tasks?maxResults=100&showCompleted=true&showHidden=true" + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
      (j.items || []).forEach(t => {
        if (t.deleted || !(t.title || "").trim()) return;
        const done = t.status === "completed", completed = t.completed ? new Date(t.completed) : null;
        if (done && (!completed || completed < since)) return;   // hotové jen z dneška a včerejška
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

// ---------- vykreslení ----------
const SHORT = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];
const icon = (id, cls) => `<svg class="${cls || ""}"><use href="#i-${id}"/></svg>`;

function topHtml() {
  if (!signedIn()) return "";
  const refresh = `<button class="icon-btn${S.loading ? " spin" : ""}" data-act="refresh" aria-label="Obnovit">${icon("refresh")}</button>`;
  if (S.view === "today") {
    const d = S.day, today = sod(new Date()), isToday = sameDay(d, today), w = monday(d);
    let strip = `<div class="strip"><button class="strip-nav" data-act="day" data-n="-7" aria-label="Předchozí týden">${icon("left")}</button>`;
    for (let i = 0; i < 7; i++) {
      const x = addDays(w, i), busy = eventsOn(x).length + tasksDue(x, false).length;
      strip += `<button class="sd${sameDay(x, d) ? " on" : ""}${sameDay(x, today) ? " is-today" : ""}" data-act="pick" data-d="${+x}"><span>${SHORT[x.getDay()]}</span><b>${x.getDate()}</b><i${busy ? "" : ' class="no"'}></i></button>`;
    }
    strip += `<button class="strip-nav" data-act="day" data-n="7" aria-label="Další týden">${icon("right")}</button></div>`;
    return `<div class="hdr"><div class="hdr-title">${dayLabel(d)}<small>${dateLong(d)}${d.getFullYear() !== today.getFullYear() ? " " + d.getFullYear() : ""}${isToday ? " · dnes" : ""}</small></div>
      ${isToday ? "" : `<button class="today-pill" data-act="today">Dnes</button>`}${refresh}</div>` + strip;
  }
  if (S.view === "week") {
    const w = S.week, end = addDays(w, 6), thisWeek = sameDay(w, monday(new Date()));
    return `<div class="hdr"><button class="icon-btn" data-act="week" data-n="-7" aria-label="Předchozí">${icon("left")}</button>
      <div class="hdr-title center">${thisWeek ? "Tento týden" : "Týden"}<small>${w.getDate()}. ${w.getMonth() !== end.getMonth() ? (w.getMonth() + 1) + ". " : ""}– ${end.getDate()}. ${end.getMonth() + 1}.</small></div>
      <button class="icon-btn" data-act="week" data-n="7" aria-label="Další">${icon("right")}</button></div>
      ${thisWeek ? "" : `<div class="hdr-sub"><button class="today-pill" data-act="thisweek">Zpět na tento týden</button></div>`}`;
  }
  if (S.view === "tasks") {
    const open = S.tasks.filter(t => !t.done).length;
    return `<div class="hdr"><div class="hdr-title">Úkoly<small>${open} ${plural(open, "otevřený", "otevřené", "otevřených")}</small></div>${refresh}</div>`;
  }
  return `<div class="hdr"><div class="hdr-title">Nastavení<small>Focus pro telefon</small></div></div>`;
}

function render() {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.view === S.view));
  $("#top").innerHTML = topHtml();
  const v = $("#view");
  if (!signedIn()) { $("#fab").hidden = true; $("#tabs").hidden = true; v.innerHTML = signinHtml(); return; }
  $("#tabs").hidden = false;
  $("#fab").hidden = S.view === "settings";
  let html = "";
  if (S.needAuth) html += `<div class="banner">Přihlášení ke Googlu vypršelo.<button data-act="reauth">Obnovit</button></div>`;
  if (S.error) html += `<div class="banner">${esc(S.error)}<button data-act="refresh">Zkusit znovu</button></div>`;
  html += S.view === "today" ? todayHtml() : S.view === "week" ? weekHtml() : S.view === "tasks" ? tasksHtml() : settingsHtml();
  v.innerHTML = html;
  if (S.view === "today" && !render.scrolled && sameDay(S.day, new Date())) {
    render.scrolled = true;
    const now = $(".now"); if (now) setTimeout(() => window.scrollTo({ top: Math.max(0, now.getBoundingClientRect().top + window.scrollY - 220) }), 30);
  }
}

function signinHtml() {
  const noId = !DEMO && !CFG.clientId;
  return `<div class="signin"><span class="logo"><i></i></span><h1>Focus</h1>
    <p>Kalendář a úkoly z tvého Google účtu na jednom místě – stejně jako ve Focusu na PC.</p>
    ${noId ? `<p class="muted">Chybí Client ID v souboru config.js.</p>` : `<button class="btn primary" data-act="signin">Přihlásit se Googlem</button>`}
    <p class="muted" style="font-size:12px">Data zůstávají v Googlu, appka je jen čte a upravuje.</p></div>`;
}

function eventsOn(day) {
  const a = sod(day), b = addDays(a, 1);
  return S.events.filter(e => e.start < b && e.end > a);
}
function tasksDue(day, includeLate) {
  const d = sod(day);
  return S.tasks.filter(t => !t.done && t.due && (sameDay(t.due, d) || (includeLate && t.due < d)))
    .sort((x, y) => x.due - y.due);
}

function todayHtml() {
  const d = S.day, isToday = sameDay(d, new Date());
  const evs = eventsOn(d), allDay = evs.filter(e => e.allDay), timed = evs.filter(e => !e.allDay);
  let html = "";

  // úkoly na den (dnes i zpožděné); štítek termínu jen u zpožděných – „dnes“ je tu jasné
  const due = tasksDue(d, isToday);
  html += `<div class="card"><div class="card-head"><span class="card-title">Úkoly</span><span class="muted" style="font-size:13px">${due.length || ""}</span></div>`;
  html += due.length ? due.map(t => taskRow(t, sameDay(t.due, d))).join("") : `<div class="empty">${isToday ? "Na dnes nic – užij si to." : "Žádné úkoly s termínem."}</div>`;
  html += `</div>`;

  // kalendář
  html += `<div class="card"><div class="card-head"><span class="card-title">Kalendář</span><span class="muted" style="font-size:13px">${evs.length ? evs.length + " " + plural(evs.length, "událost", "události", "událostí") : ""}</span></div>`;
  if (allDay.length) html += `<div class="allday">${allDay.map(e => `<span class="chip-ev" style="--ev:${e.color};--ev-bg:${tint(e.color, .82)}" data-ev="${esc(e.calId)}|${esc(e.id)}">${esc(e.title)}</span>`).join("")}</div>`;
  html += timelineHtml(d, timed, isToday) + `</div>`;
  return html;
}

function timelineHtml(d, evs, isToday) {
  let startH = 7, endH = 22;
  evs.forEach(e => { startH = Math.min(startH, e.start < d ? 0 : e.start.getHours()); endH = Math.max(endH, e.end >= addDays(d, 1) ? 24 : Math.ceil(e.end.getHours() + e.end.getMinutes() / 60)); });
  if (isToday) { const h = new Date().getHours(); startH = Math.min(startH, h); endH = Math.max(endH, h + 1); }
  endH = Math.min(24, endH);
  const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour")) || 56;
  let html = `<div class="timeline" style="height:${(endH - startH) * H + 10}px;padding-top:10px">`;
  for (let h = startH; h < endH; h++) html += `<div class="hour" data-act="newat" data-h="${h}"><span>${h}:00</span></div>`;
  // rozložení překrývajících se událostí do sloupců
  const items = evs.map(e => ({ e, s: Math.max(+e.start, +d), t: Math.min(+e.end, +addDays(d, 1)) })).sort((a, b) => a.s - b.s || b.t - a.t);
  let cluster = [], clusterEnd = 0;
  const flush = () => { const cols = Math.max(...cluster.map(c => c.col)) + 1; cluster.forEach(c => c.cols = cols); cluster = []; };
  items.forEach(it => {
    if (cluster.length && it.s >= clusterEnd) flush();
    const used = cluster.filter(c => c.t > it.s).map(c => c.col);
    let col = 0; while (used.includes(col)) col++;
    it.col = col; cluster.push(it); clusterEnd = Math.max(clusterEnd, it.t);
  });
  if (cluster.length) flush();
  const base = +d + startH * 3600000;
  items.forEach(it => {
    const top = 10 + (it.s - base) / 3600000 * H, h = Math.max(22, (it.t - it.s) / 3600000 * H - 2), e = it.e;
    const left = `calc(60px + (100% - 72px) * ${it.col / it.cols})`, width = `calc((100% - 72px) / ${it.cols} - 4px)`;
    html += `<div class="ev${e.free ? " free" : ""}" style="top:${top}px;height:${h}px;left:${left};width:${width};--ev:${e.color};--ev-bg:${tint(e.color, .84)}" data-ev="${esc(e.calId)}|${esc(e.id)}">
      <b>${esc(e.title)}</b>${h > 34 ? `<small>${hm(e.start)} – ${hm(e.end)}${e.loc ? " · " + esc(e.loc) : ""}</small>` : ""}</div>`;
  });
  if (isToday) { const now = new Date(); html += `<div class="now" style="top:${10 + (now - base) / 3600000 * H}px"></div>`; }
  return html + `</div>`;
}

function weekHtml() {
  const w = S.week;
  let html = `<div class="card">`;
  for (let i = 0; i < 7; i++) {
    const d = addDays(w, i), evs = eventsOn(d), due = tasksDue(d, false), isT = sameDay(d, new Date());
    html += `<div class="week-day"><div class="week-head${isT ? " today" : ""}" data-act="openday" data-d="${+d}">${dayLabel(d)} <span class="muted">${d.getDate()}. ${d.getMonth() + 1}.</span></div>`;
    if (!evs.length && !due.length) html += `<div class="agenda"><span class="t"></span><span class="s muted" style="font-size:13px">Volno</span></div>`;
    evs.forEach(e => {
      html += `<div class="agenda" data-ev="${esc(e.calId)}|${esc(e.id)}" style="--ev:${e.color}"><span class="t">${e.allDay ? "celý den" : hm(e.start)}</span><span class="dot"></span><span class="s">${esc(e.title)}</span><span class="c">${esc(calById(e.calId).name)}</span></div>`;
    });
    due.forEach(t => { html += `<div class="agenda" data-task="${esc(t.id)}"><span class="t">úkol</span><span class="dot" style="background:transparent;border:2px solid var(--faint)"></span><span class="s">${esc(t.title)}</span></div>`; });
    html += `</div>`;
  }
  return html + `</div>`;
}

function dueChip(t) {
  if (!t.due) return "";
  const today = sod(new Date()), diff = Math.round((t.due - today) / 86400000);
  const cls = diff < 0 ? "late" : diff === 0 ? "today" : "";
  const txt = diff === 0 ? "dnes" : diff === 1 ? "zítra" : diff === -1 ? "včera" : diff > 1 && diff < 7 ? DAYS[t.due.getDay()] : t.due.getDate() + ". " + (t.due.getMonth() + 1) + ".";
  return `<span class="due ${cls}">${txt}</span>`;
}
function taskRow(t, hideDue) {
  const list = S.lists.find(l => l.id === t.listId);
  const meta = S.view === "tasks" ? (S.listFilter === "all" && list ? list.name : "") : (list && S.lists.length > 1 ? list.name : "");
  return `<div class="task${t.done ? " done" : ""}" data-task="${esc(t.id)}">
    <button class="check" data-act="toggle" data-id="${esc(t.id)}" aria-label="Hotovo">✓</button>
    <div class="tb"><div class="ts">${esc(t.title)}</div>${meta ? `<div class="tm">${esc(meta)}</div>` : ""}</div>${t.done || hideDue ? "" : dueChip(t)}</div>`;
}

function tasksHtml() {
  const f = S.listFilter, inList = t => f === "all" || t.listId === f;
  const open = S.tasks.filter(t => !t.done && inList(t)).sort((a, b) => (a.due ? +a.due : 9e15) - (b.due ? +b.due : 9e15) || a.title.localeCompare(b.title, "cs"));
  const done = S.tasks.filter(t => t.done && inList(t));
  let html = `<div class="lists"><button class="pill${f === "all" ? " on" : ""}" data-act="list" data-id="all">Vše<span class="n">${S.tasks.filter(t => !t.done).length}</span></button>`;
  S.lists.forEach(l => { html += `<button class="pill${f === l.id ? " on" : ""}" data-act="list" data-id="${esc(l.id)}">${esc(l.name)}<span class="n">${S.tasks.filter(t => !t.done && t.listId === l.id).length}</span></button>`; });
  html += `</div><form class="add-row" data-act="quickadd"><span>+</span><input id="quick" placeholder="Přidat úkol${f !== "all" ? " do " + esc((S.lists.find(l => l.id === f) || {}).name || "") : ""}…" autocomplete="off" enterkeyhint="done"></form>`;
  html += `<div class="card">` + (open.length ? open.map(taskRow).join("") : `<div class="empty">Všechno hotovo ✓</div>`) + `</div>`;
  if (done.length) html += `<div class="caption">Hotové dnes · ${done.length}</div><div class="card">${done.map(taskRow).join("")}</div>`;
  return html;
}

function settingsHtml() {
  const sel = selectedCals().map(c => c.id), theme = store.get("theme", "auto");
  let html = `<div class="caption">Účet</div><div class="card"><div class="row"><div class="grow"><div>${esc(store.get("email", DEMO ? "ukazka@gmail.com" : "Google účet"))}</div>
    <div class="sub">${S.loadedAt ? "Synchronizováno v " + hm(new Date(S.loadedAt)) : "Načítám…"}</div></div>
    <button class="btn secondary" data-act="signout" style="height:36px;padding:0 12px;font-size:13px">Odhlásit</button></div></div>`;
  html += `<div class="caption">Zobrazované kalendáře</div><div class="card">`;
  S.calendars.forEach(c => {
    html += `<div class="row" data-act="togglecal" data-id="${esc(c.id)}"><span class="cdot" style="background:${c.color}"></span><div class="grow">${esc(c.name)}${c.role === "owner" || c.role === "writer" ? "" : `<div class="sub">jen pro čtení</div>`}</div><span class="sw${sel.includes(c.id) ? " on" : ""}"></span></div>`;
  });
  html += `</div><div class="caption">Nové události zakládat do</div><div class="chips" style="padding:0 4px">`;
  const target = defaultCal();
  writableCals().forEach(c => { html += `<button class="chip${c.id === target ? " on" : ""}" data-act="caltarget" data-id="${esc(c.id)}"><span class="cdot" style="background:${c.color}"></span>${esc(c.name)}</button>`; });
  html += `</div><div class="caption">Vzhled</div><div class="chips" style="padding:0 4px">`;
  [["auto", "Podle telefonu"], ["light", "Světlý"], ["dark", "Tmavý"]].forEach(([k, n]) => { html += `<button class="chip${theme === k ? " on" : ""}" data-act="theme" data-id="${k}">${n}</button>`; });
  html += `</div><p class="muted" style="font-size:12px;padding:8px 6px">Focus pro telefon · kalendář a úkoly z Googlu. Na PC je stejné v desktopovém Focusu.</p>`;
  return html;
}
function plural(n, a, b, c) { return n === 1 ? a : n >= 2 && n <= 4 ? b : c; }

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
  const start = ev ? ev.start : presetStart || nextSlot(), mins = ev ? Math.round((ev.end - ev.start) / 60000) : 60;
  const ro = ev && ev.lock;
  let cal = ev ? ev.calId : defaultCal();
  openSheet(`<h2>${ev ? (ro ? esc(ev.title) : "Upravit událost") : "Nová událost"}</h2>
    <div class="hint">${ev ? esc(calById(ev.calId).name) + (ev.loc ? " · " + esc(ev.loc) : "") : "Google kalendář"}</div>
    ${ro ? `<div class="lock">🔒 ${esc(ev.lock)}</div>` : ""}
    <form id="evf">
      ${ro ? "" : calChips(cal, "cal")}
      <div class="group"><div class="field"><label>Název</label><input name="title" value="${ev ? esc(ev.title) : ""}" placeholder="Např. Večeře" ${ro ? "disabled" : ""} required></div></div>
      <div class="group">
        <div class="field"><label>Datum</label><input type="date" name="date" value="${ymd(start)}" ${ro ? "disabled" : ""}></div>
        ${ev && ev.allDay ? "" : `<div class="field"><label>Začátek</label><input type="time" name="time" value="${pad(start.getHours())}:${pad(start.getMinutes())}" step="300" ${ro ? "disabled" : ""}></div>
        <div class="field"><label>Délka</label><select name="mins" ${ro ? "disabled" : ""}>${[15, 30, 45, 60, 90, 120, 180, 240].concat([mins]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map(m => `<option value="${m}"${m === mins ? " selected" : ""}>${m < 60 ? m + " min" : (m / 60).toString().replace(".", ",") + " h"}</option>`).join("")}</select></div>`}
      </div>
      <div class="err" id="everr"></div>
      <div class="actions">
        ${ev && !ro ? `<button type="button" class="btn danger" data-sheet="delete">Smazat</button>` : ""}
        ${ev && ev.link ? `<a class="btn secondary" style="display:grid;place-items:center;text-decoration:none;color:inherit" href="${esc(ev.link)}" target="_blank" rel="noopener">Google</a>` : ""}
        ${ro ? "" : `<button class="btn primary">${ev ? "Uložit" : "Založit"}</button>`}
      </div>
    </form>`, sheet => {
    sheet.querySelectorAll("[data-cal]").forEach(b => b.onclick = () => { cal = b.dataset.cal; sheet.querySelectorAll("[data-cal]").forEach(x => x.classList.toggle("on", x === b)); });
    const del = sheet.querySelector('[data-sheet="delete"]');
    if (del) del.onclick = async () => {
      if (!confirm("Smazat „" + ev.title + "“?")) return;
      try { await api("DELETE", CAL_API + "/calendars/" + encodeURIComponent(ev.calId) + "/events/" + encodeURIComponent(ev.id)); S.events = S.events.filter(x => x !== ev); closeSheet(); render(); toast("Událost smazána"); }
      catch (e) { sheet.querySelector("#everr").textContent = e.message; }
    };
    sheet.querySelector("#evf").onsubmit = async ev2 => {
      ev2.preventDefault(); if (ro) return;
      const f = new FormData(ev2.target), d = parseYmd(f.get("date"));
      let s, e;
      if (ev && ev.allDay) { s = d; e = addDays(d, Math.max(1, Math.round((ev.end - ev.start) / 86400000))); }
      else { const [h, m] = (f.get("time") || "9:00").split(":").map(Number); s = new Date(d); s.setHours(h, m, 0, 0); e = new Date(+s + Number(f.get("mins")) * 60000); }
      const body = { summary: f.get("title").trim(), start: ev && ev.allDay ? { date: ymd(s) } : { dateTime: isoLocal(s) }, end: ev && ev.allDay ? { date: ymd(e) } : { dateTime: isoLocal(e) } };
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
function nextSlot() { const d = new Date(S.view === "today" ? S.day : new Date()), n = new Date(); if (sameDay(d, n)) d.setHours(n.getHours() + 1, 0, 0, 0); else d.setHours(9, 0, 0, 0); return d; }

function taskSheet(t) {
  let listId = t ? t.listId : (S.listFilter !== "all" ? S.listFilter : (S.lists[0] || {}).id);
  const today = sod(new Date());
  openSheet(`<h2>${t ? "Upravit úkol" : "Nový úkol"}</h2><div class="hint">Google úkoly${t ? " · " + esc((S.lists.find(l => l.id === t.listId) || {}).name || "") : ""}</div>
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
        else { if (!body.due) delete body.due; const r = await api("POST", TASK_API + "/lists/" + encodeURIComponent(listId) + "/tasks", body); S.tasks.push({ id: r.id, listId, title, notes: "", due: dueS ? parseYmd(dueS) : null, done: false }); }
        store.set("tasks", S.tasks); closeSheet(); render(); toast(t ? "Uloženo" : "Úkol přidán");
      } catch (e2) { sheet.querySelector("#terr").textContent = e2.message === "auth" ? "Přihlášení vypršelo – obnov ho nahoře." : e2.message; }
    };
  });
}

async function toggleTask(id) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  t.done = !t.done; t.completed = t.done ? new Date() : null; render();
  try { await api("PATCH", TASK_API + "/lists/" + encodeURIComponent(t.listId) + "/tasks/" + encodeURIComponent(t.id), t.done ? { status: "completed" } : { status: "needsAction", completed: null }); store.set("tasks", S.tasks); if (t.done) toast("Hotovo ✓"); }
  catch (e) { t.done = !t.done; render(); if (e.message !== "auth") toast(e.message); }
}

// ---------- události ----------
document.addEventListener("click", async e => {
  const a = e.target.closest("[data-act]"), evEl = e.target.closest("[data-ev]"), taskEl = e.target.closest("[data-task]");
  if (a) {
    const act = a.dataset.act;
    if (act === "toggle") { e.stopPropagation(); return toggleTask(a.dataset.id); }
    if (act === "signin") {
      try { await signIn(true); store.set("everSigned", true); render(); await refresh(true); }
      catch (err) { toast(err.message); }
      return;
    }
    if (act === "reauth") { try { await signIn(false); render(); await refresh(); } catch (err) { toast(err.message); } return; }
    if (act === "refresh") return refresh(true);
    if (act === "day") { S.day = addDays(S.day, +a.dataset.n); return dayChanged(); }
    if (act === "today") { S.day = sod(new Date()); render.scrolled = false; return dayChanged(); }
    if (act === "pick") { S.day = new Date(+a.dataset.d); render.scrolled = !sameDay(S.day, new Date()); return dayChanged(); }
    if (act === "week") { S.week = addDays(S.week, +a.dataset.n); return dayChanged(); }
    if (act === "thisweek") { S.week = monday(new Date()); return dayChanged(); }
    if (act === "openday") { S.day = new Date(+a.dataset.d); S.view = "today"; render.scrolled = true; window.scrollTo({ top: 0 }); return dayChanged(); }
    if (act === "list") { S.listFilter = a.dataset.id; store.set("listFilter", S.listFilter); return render(); }
    if (act === "newat") { const d = new Date(S.day); d.setHours(+a.dataset.h, 0, 0, 0); return eventSheet(null, d); }
    if (act === "togglecal") {
      const ids = selectedCals().map(c => c.id), id = a.dataset.id;
      store.set("calSel", ids.includes(id) ? ids.filter(x => x !== id) : ids.concat(id)); render(); return refresh();
    }
    if (act === "caltarget") { store.set("calTarget", a.dataset.id); return render(); }
    if (act === "theme") { store.set("theme", a.dataset.id); applyTheme(); return render(); }
    if (act === "signout") {
      if (!DEMO && window.google && S.token) google.accounts.oauth2.revoke(S.token, () => { });
      ["token", "everSigned", "cals", "events", "tasks", "lists", "calSel", "calTarget"].forEach(k => store.set(k, null));
      S.token = null; S.calendars = []; S.events = []; S.tasks = []; S.lists = []; return render();
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
  const tmp = { id: "tmp" + Date.now(), listId, title, notes: "", due: null, done: false }; S.tasks.push(tmp); render(); $("#quick").focus();
  try { const r = await api("POST", TASK_API + "/lists/" + encodeURIComponent(listId) + "/tasks", { title }); tmp.id = r.id; store.set("tasks", S.tasks); }
  catch (err) { S.tasks = S.tasks.filter(x => x !== tmp); render(); toast(err.message === "auth" ? "Přihlášení vypršelo" : err.message); }
});
$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  S.view = b.dataset.view; render.scrolled = S.view !== "today"; window.scrollTo({ top: 0 });
  if (S.view === "week") S.week = monday(S.day);
  dayChanged();
});
$("#fab").addEventListener("click", () => S.view === "tasks" ? taskSheet(null) : eventSheet(null));
// přetažení prstem doleva / doprava = další / předchozí den (týden)
let touch = null;
$("#view").addEventListener("touchstart", e => { if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; }, { passive: true });
$("#view").addEventListener("touchend", e => {
  if (!touch || (S.view !== "today" && S.view !== "week")) return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y, fast = Date.now() - touch.t < 600;
  touch = null;
  if (!fast || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  const dir = dx < 0 ? 1 : -1;
  if (S.view === "today") S.day = addDays(S.day, dir); else S.week = addDays(S.week, 7 * dir);
  dayChanged();
}, { passive: true });
$("#sheet-backdrop").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

function dayChanged() {
  const r = S.eventsRange, { from } = rangeFor();
  render();
  if (!r || +from !== r.from) refresh();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - S.loadedAt > 5 * 60000) refresh(); });
setInterval(() => { if (S.view === "today" && !document.hidden && !$("#sheet").classList.contains("open")) render(); }, 60000);   // posun čáry „teď“

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
    { id: "tuo", name: "TUO – přednášky", color: "#FFAD46", role: "reader", visible: true }
  ],
  init() {
    const d = sod(new Date()), at = (day, h, m) => { const x = addDays(d, day); x.setHours(h, m, 0, 0); return x; };
    let n = 0;
    const ev = (cal, title, s, mins, extra) => Object.assign({ id: "e" + (++n), calId: cal, title, loc: "", start: s, end: new Date(+s + mins * 60000), allDay: false, color: calById(cal).color, free: false, link: "", lock: cal === "tuo" ? "Kalendář „TUO – přednášky“ je jen pro čtení." : "" }, extra || {});
    S.calendars = this.cals;
    S.events = [
      ev("ondra@gmail.com", "Ranní běh", at(0, 7, 0), 45),
      ev("tuo", "Finanční trhy – přednáška", at(0, 9, 45), 90, { loc: "A-312" }),
      ev("doktori", "Zubař", at(0, 11, 15), 45, { loc: "Vinohradská 12" }),
      ev("ondra@gmail.com", "Oběd s Áďou", at(0, 12, 30), 60, { color: "#E67C73" }),
      ev("ostatni", "Nákup na víkend", at(0, 17, 0), 45),
      ev("ondra@gmail.com", "Večeře s rodiči", at(0, 18, 30), 90),
      ev("ostatni", "Narozeniny Andrejky", d, 1440, { allDay: true, end: addDays(d, 1) }),
      ev("ondra@gmail.com", "Volejbal", at(1, 19, 0), 120),
      ev("tuo", "Pojišťovnictví – cvičení", at(2, 10, 45), 90),
      ev("ostatni", "Servis auta", at(3, 8, 0), 60)
    ];
    S.lists = [{ id: "osobni", name: "Osobní" }, { id: "moje", name: "Moje úkoly" }];
    const t = (id, list, title, due, done) => ({ id, listId: list, title, notes: "", due: due === null ? null : addDays(d, due), done: !!done, completed: done ? new Date() : null });
    S.tasks = [
      t("t1", "osobni", "Zavolat doktorce", 0), t("t2", "osobni", "Pneumatiky", -2), t("t3", "osobni", "Ukončit REVOLUT", 3),
      t("t4", "osobni", "Volejbalový míč pro rodiče", null), t("t5", "moje", "Bakalářka – zadání práce", 1), t("t6", "osobni", "T-Mobile s babičkou", null), t("t7", "moje", "NJ úkol 223/3", 0, true)
    ];
    S.loadedAt = Date.now();
  },
  async api(method) { if (method !== "GET") await new Promise(r => setTimeout(r, 150)); return { id: "d" + Date.now() }; }
};

// ---------- start ----------
// přímý odkaz na obrazovku (#week, #tasks, #settings) a vynucený vzhled (?theme=dark) – zkratky a náhledy
const startView = location.hash.slice(1);
if (["today", "week", "tasks", "settings"].includes(startView)) { S.view = startView; render.scrolled = startView !== "today"; }
applyTheme();
const forced = new URLSearchParams(location.search).get("theme");
if (forced === "dark" || forced === "light") { document.documentElement.dataset.theme = forced; syncBars(); }
if (DEMO) { store.set = () => { }; Demo.init(); }
render();
if (!DEMO && signedIn()) { if (S.token) refresh(); else S.needAuth = true, render(); }
if ("serviceWorker" in navigator && !DEMO && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => { });
