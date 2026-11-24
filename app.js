import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { ANIMALS } from "./animals.js";

/* =========================================================
   Firebase
   ========================================================= */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
let db;
try {
  // Keeps a copy on the device, so it also works offline and syncs later.
  db = initializeFirestore(fbApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (e) {
  db = getFirestore(fbApp);
}

/* =========================================================
   State & helpers
   ========================================================= */
const state = {
  user: null,
  activities: new Map(),   // id -> {id, name, color, defaultMinutes, createdAt}
  sessions: new Map(),     // id -> {id, activityId, date: 'YYYY-MM-DD', minutes, createdAt}
  byDate: new Map(),       // 'YYYY-MM-DD' -> [session, ...]
  view: loadView(),
  cursor: new Date()
};
let unsubs = [];
const flying = new Set();   // session ids hidden while a ghost flies to them
const landing = new Set();  // session ids playing the landing bounce

const $ = (s) => document.querySelector(s);
const col = (name) => collection(db, "users", state.user.uid, name);
const docRef = (name, id) => doc(db, "users", state.user.uid, name, id);
const newId = (name) => doc(col(name)).id;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const narrow = () => window.innerWidth <= 480;
const vibrate = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* ignore */ } };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const strip = ({ id, ...rest }) => rest;

/* =========================================================
   Dates & formatting
   ========================================================= */
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Calendar week number (ISO 8601, as used in Finland).
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

function fmtMinutes(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
// Compact version for tight spots, e.g. "45m", "2h", "2h30".
function fmtShort(m) {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h${pad(r)}` : `${h}h`;
}

/* =========================================================
   Colours
   ========================================================= */
function hexToHsl(hex) {
  const n = parseInt((hex || "#9aa0a6").slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

// Longer session = deeper, more saturated shade of the activity's colour.
// 15 min very light · 30 min medium-light · 1 h medium · 2 h deep · 3 h+ deepest
function shade(baseHex, minutes) {
  const { h, s } = hexToHsl(baseHex);
  const t = Math.pow(Math.min(Math.max(minutes, 5), 180) / 180, 0.75);
  const light = 86 - 50 * t;
  const sat = Math.max(20, s * (0.55 + 0.45 * t));
  return `hsl(${h.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
}

// Picks a colour whose hue is far from the other activities' colours.
function autoColor(excludeId = null, current = null) {
  const used = [...state.activities.values()]
    .filter((a) => a.id !== excludeId && a.color)
    .map((a) => hexToHsl(a.color).h);
  const currentHue = current ? hexToHsl(current).h : null;
  const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const candidates = [];
  for (let h = 0; h < 360; h += 15) {
    const score = used.length ? Math.min(...used.map((u) => hueDist(u, h))) : 180;
    candidates.push({ h, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  let top = candidates.slice(0, 5).filter((c) => currentHue === null || hueDist(c.h, currentHue) > 10);
  if (!top.length) top = candidates.slice(0, 5);
  const pick = top[Math.floor(Math.random() * top.length)];
  return hslToHex(pick.h, 88, 74);   // soft pastel, like the sketch
}

/* =========================================================
   Auth
   ========================================================= */
getRedirectResult(auth).catch((e) => showSigninError(e));

onAuthStateChanged(auth, (user) => {
  $("#loading").classList.add("hidden");
  unsubs.forEach((u) => u());
  unsubs = [];
  state.user = user;
  state.activities = new Map();
  state.sessions = new Map();
  state.byDate = new Map();
  history.undo = [];
  history.redo = [];
  closePopover();
  closeDrawer();

  if (!user) {
    $("#app").classList.add("hidden");
    $("#signin").classList.remove("hidden");
    return;
  }
  $("#signin").classList.add("hidden");
  $("#app").classList.remove("hidden");
  setAvatar(user);
  subscribe();
  render();
});

$("#whyBtn").addEventListener("click", () => $("#whyDialog").showModal());
$("#whyDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });   // tap outside closes

$("#signinBtn").addEventListener("click", async () => {
  $("#signinError").textContent = "";
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      showSigninError(e);
    }
  }
});

function showSigninError(e) {
  $("#signinError").textContent = e.code === "auth/unauthorized-domain"
    ? "This web address isn't on Firebase's list of authorised domains yet."
    : `Sign-in failed (${e.code || e.message}).`;
}

function setAvatar(user) {
  const btn = $("#userBtn");
  if (user.photoURL) {
    btn.style.backgroundImage = `url("${user.photoURL}")`;
    btn.textContent = "";
  } else {
    btn.style.backgroundImage = "";
    btn.textContent = (user.displayName || user.email || "?").charAt(0).toUpperCase();
  }
}

/* =========================================================
   Live data
   ========================================================= */
function subscribe() {
  unsubs.push(onSnapshot(col("activities"), (snap) => {
    state.activities = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    renderLists();
    renderCalendar();
    renderPopover();
  }, onDbError));

  unsubs.push(onSnapshot(col("sessions"), (snap) => {
    state.sessions = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    indexSessions();
    renderLists();
    renderCalendar();
    renderPopover();
  }, onDbError));
}

function indexSessions() {
  const m = new Map();
  for (const s of state.sessions.values()) {
    if (!m.has(s.date)) m.set(s.date, []);
    m.get(s.date).push(s);
  }
  for (const arr of m.values()) arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  state.byDate = m;
}

function onDbError(err) {
  console.error(err);
  toast(err && err.code === "permission-denied"
    ? "Can't reach your data. Check the Firestore rules (see README)."
    : "Couldn't save. Check your connection.");
}

/* =========================================================
   Writing data + undo / redo (last 5 steps)
   ========================================================= */
const history = { undo: [], redo: [] };
const LIMIT = 5;

const put = (name, id, data) => setDoc(docRef(name, id), data).catch(onDbError);
const patch = (name, id, data) => updateDoc(docRef(name, id), data).catch(onDbError);
const del = (name, id) => deleteDoc(docRef(name, id)).catch(onDbError);
function batchWrite(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    for (const o of ops.slice(i, i + 400)) {
      if (o.set) b.set(docRef(o.name, o.id), o.data);
      else b.delete(docRef(o.name, o.id));
    }
    b.commit().catch(onDbError);
  }
}
const actName = (id) => state.activities.get(id)?.name || "activity";
const sessionsOf = (activityId) => [...state.sessions.values()].filter((s) => s.activityId === activityId);

function record(action) {
  history.undo.push(action);
  if (history.undo.length > LIMIT) history.undo.shift();
  history.redo = [];
}
function undo() {
  const a = history.undo.pop();
  if (!a) return toast("Nothing to undo");
  a.undo();
  history.redo.push(a);
  toast(`Undo: ${a.label}`);
}
function redo() {
  const a = history.redo.pop();
  if (!a) return toast("Nothing to redo");
  a.redo();
  history.undo.push(a);
  if (history.undo.length > LIMIT) history.undo.shift();
  toast(`Redo: ${a.label}`);
}

function createSession(activityId, date, minutes) {
  const id = newId("sessions");
  const data = { activityId, date, minutes, createdAt: Date.now() };
  put("sessions", id, data);
  record({
    label: `added ${actName(activityId)}`,
    undo: () => del("sessions", id),
    redo: () => put("sessions", id, data)
  });
  return id;
}

function moveSession(id, date) {
  const s = state.sessions.get(id);
  if (!s || s.date === date) return false;
  const from = s.date;
  patch("sessions", id, { date });
  record({
    label: `moved ${actName(s.activityId)}`,
    undo: () => patch("sessions", id, { date: from }),
    redo: () => patch("sessions", id, { date })
  });
  return true;
}

function removeSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  const data = strip(s);
  del("sessions", id);
  record({
    label: `deleted ${actName(s.activityId)}`,
    undo: () => put("sessions", id, data),
    redo: () => del("sessions", id)
  });
}

function setMinutes(id, m) {
  const s = state.sessions.get(id);
  if (!s || !Number.isFinite(m)) return;
  m = Math.min(1440, Math.max(5, Math.round(m)));
  if (m === s.minutes) return;
  const name = actName(s.activityId);
  patch("sessions", id, { minutes: m });
  // Quick repeated +/- taps on the same session count as one step.
  const last = history.undo[history.undo.length - 1];
  if (last && last.kind === "minutes" && last.id === id && Date.now() - last.t < 2000) {
    last.after = m;
    last.t = Date.now();
    last.label = `${name} ${fmtMinutes(m)}`;
    history.redo = [];
    return;
  }
  record({
    kind: "minutes", id, before: s.minutes, after: m, t: Date.now(),
    label: `${name} ${fmtMinutes(m)}`,
    undo() { patch("sessions", id, { minutes: this.before }); },
    redo() { patch("sessions", id, { minutes: this.after }); }
  });
}

function createActivity(data) {
  const id = newId("activities");
  put("activities", id, data);
  let saved = [];
  record({
    label: `new activity ${data.name}`,
    undo: () => {
      saved = sessionsOf(id).map((s) => ({ id: s.id, data: strip(s) }));
      batchWrite(saved.map((s) => ({ name: "sessions", id: s.id })));
      del("activities", id);
    },
    redo: () => {
      put("activities", id, data);
      batchWrite(saved.map((s) => ({ set: true, name: "sessions", id: s.id, data: s.data })));
    }
  });
}

function updateActivity(id, after) {
  const a = state.activities.get(id);
  if (!a) return;
  const before = { name: a.name, color: a.color, defaultMinutes: a.defaultMinutes };
  patch("activities", id, after);
  record({
    label: `edited ${after.name}`,
    undo: () => patch("activities", id, before),
    redo: () => patch("activities", id, after)
  });
}

function deleteActivity(id) {
  const a = state.activities.get(id);
  if (!a) return;
  const data = strip(a);
  const saved = sessionsOf(id).map((s) => ({ id: s.id, data: strip(s) }));
  const remove = () => {
    del("activities", id);
    batchWrite(saved.map((s) => ({ name: "sessions", id: s.id })));
  };
  remove();
  record({
    label: `deleted ${a.name}`,
    undo: () => {
      put("activities", id, data);
      batchWrite(saved.map((s) => ({ set: true, name: "sessions", id: s.id, data: s.data })));
    },
    redo: remove
  });
}

/* =========================================================
   Rendering
   ========================================================= */
function render() {
  document.querySelectorAll(".view-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  renderLists();
  renderCalendar();
}

function sortedActivities() {
  return [...state.activities.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function currentRange() {
  if (state.view === "week") {
    const s = startOfWeek(state.cursor);
    return [dateKey(s), dateKey(addDays(s, 6))];
  }
  const y = state.cursor.getFullYear(), m = state.cursor.getMonth();
  return [dateKey(new Date(y, m, 1)), dateKey(new Date(y, m + 1, 0))];
}

function totalsInRange() {
  const [from, to] = currentRange();
  const totals = new Map();
  for (const s of state.sessions.values()) {
    if (s.date >= from && s.date <= to) totals.set(s.activityId, (totals.get(s.activityId) || 0) + (s.minutes || 0));
  }
  return totals;
}

function renderLists() {
  renderDots();
  renderDrawerList();
}

function renderDots() {
  const box = $("#dots");
  const scroll = box.scrollLeft;
  box.innerHTML = "";
  for (const a of sortedActivities()) {
    const d = el("button", "dot");
    d.dataset.drag = "activity";
    d.dataset.id = a.id;
    d.style.background = a.color;
    d.setAttribute("aria-label", a.name);
    box.append(d);
  }
  const add = el("button", "dot add-dot");
  add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  add.id = "addDot";
  add.setAttribute("aria-label", "New activity");
  box.append(add);
  box.scrollLeft = scroll;
  updateDotArrows();
}

function updateDotArrows() {
  const d = $("#dots");
  const overflow = d.scrollWidth > d.clientWidth + 2;
  $("#dotsBar").classList.toggle("overflow", overflow);
  $("#dotsPrev").disabled = d.scrollLeft <= 2;
  $("#dotsNext").disabled = d.scrollLeft + d.clientWidth >= d.scrollWidth - 2;
}

$("#dots").addEventListener("scroll", updateDotArrows, { passive: true });
$("#dotsPrev").addEventListener("click", () => $("#dots").scrollBy({ left: -$("#dots").clientWidth * 0.8 }));
$("#dotsNext").addEventListener("click", () => $("#dots").scrollBy({ left: $("#dots").clientWidth * 0.8 }));
$("#dots").addEventListener("click", (e) => { if (e.target.closest("#addDot")) openActivityDialog(null); });

function renderDrawerList() {
  renderGallery();
  const list = $("#activityList");
  list.innerHTML = "";
  const acts = sortedActivities();
  if (!acts.length) {
    list.append(el("li", "empty", "No activities yet. Add your first one!"));
    return;
  }
  const totals = totalsInRange();
  const period = state.view === "week" ? "this week" : "this month";
  for (const a of acts) {
    const li = el("li", "activity");
    li.dataset.drag = "activity";
    li.dataset.id = a.id;
    const sw = el("span", "swatch");
    sw.style.background = a.color;
    const total = totals.get(a.id) || 0;
    li.append(sw, el("span", "act-name", a.name),
      el("span", "act-meta", `${fmtMinutes(a.defaultMinutes || 30)} · ${total ? fmtMinutes(total) : "0 min"} ${period}`));
    list.append(li);
  }
}

function makeBlock(s) {
  const a = state.activities.get(s.activityId);
  if (!a) return null;
  const b = el("div", "block");
  b.dataset.drag = "session";
  b.dataset.id = s.id;
  b.style.background = shade(a.color, s.minutes);
  b.setAttribute("role", "button");
  b.setAttribute("aria-label", `${a.name}, ${fmtMinutes(s.minutes)}`);
  if (flying.has(s.id)) b.classList.add("flying");
  if (landing.has(s.id)) b.classList.add("land");
  if (drag && drag.started && drag.kind === "session" && drag.id === s.id) b.classList.add("picked");
  return b;
}

function renderCalendar() {
  if (!state.user) return;
  if (state.view === "week") renderWeek();
  else renderMonth();
  markSelectedDay();
}

function calendarShell(rows, headCells) {
  const wrap = el("div", "cal");
  wrap.style.setProperty("--rows", rows);
  const head = el("div", "cal-head");
  head.append(el("div", "wk-lbl", "Week"), ...headCells);
  const body = el("div", "cal-body");
  const wknos = el("div", "wknos");
  const box = el("div", "box");
  body.append(wknos, box);
  wrap.append(head, body);
  return { wrap, wknos, box };
}

function renderMonth() {
  const y = state.cursor.getFullYear(), m = state.cursor.getMonth();
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  const lead = (first.getDay() + 6) % 7;
  const weeks = Math.ceil((lead + last.getDate()) / 7);
  const gridStart = startOfWeek(first);
  const today = dateKey(new Date());

  $("#title").textContent = first.toLocaleDateString("en-GB", { month: narrow() ? "short" : "long", year: "numeric" });

  // No room for the animal after the last day? Add one extra row for it,
  // as tall as the others; the calendar then scrolls a little.
  const total = weeks * 7;
  const trail = total - (lead + last.getDate());
  const extraRow = trail < 2;
  const { wrap, wknos, box } = calendarShell(weeks + (extraRow ? 1 : 0), WEEKDAYS.map((w) => el("div", "wd", w)));
  for (let r = 0; r < weeks; r++) wknos.append(el("div", "wkno", isoWeek(addDays(gridStart, r * 7))));
  if (extraRow) wknos.append(el("div", "wkno"));

  // Grid lines: solid next to real days, dashed between empty cells,
  // and none inside the animal's corner so it has open space.
  const inMonth = (i) => i >= lead && i < lead + last.getDate();
  const inFish = (i) => trail >= 2 && i >= total - trail;
  const lineKind = (a, b) => (inMonth(a) || inMonth(b)) ? "solid" : (inFish(a) && inFish(b)) ? "" : "dash";

  for (let i = 0; i < total; i++) {
    const d = addDays(gridStart, i);
    const cell = el("div", "day");
    if (i % 7 < 6) { const k = lineKind(i, i + 1); if (k) cell.classList.add("br-" + k); }
    if (i + 7 < total) { const k = lineKind(i, i + 7); if (k) cell.classList.add("bb-" + k); }
    else if (extraRow) cell.classList.add("bb-solid");   // line above the animal row
    if (inFish(i)) continue;   // the animal sits here instead
    if (d.getMonth() !== m) {
      cell.classList.add("out");   // other month: empty, no date
      box.append(cell);
      continue;
    }
    const key = dateKey(d);
    cell.dataset.date = key;
    if (key === today) cell.classList.add("today");
    const num = el("div", "day-num");
    num.append(el("span", "", d.getDate()));
    const blocks = el("div", "blocks");
    for (const s of state.byDate.get(key) || []) {
      const b = makeBlock(s);
      if (b) blocks.append(b);
    }
    cell.append(num, blocks);
    box.append(cell);
  }
  addFish(box, trail, weeks, extraRow, y, m);
  const cal = $("#calendar");
  const keepScroll = cal.dataset.month === `${y}-${m}` ? cal.scrollTop : 0;
  cal.dataset.month = `${y}-${m}`;
  const cellScroll = saveCellScroll();
  cal.replaceChildren(wrap);
  sizeRows(wrap, weeks);
  cal.scrollTop = keepScroll;
  restoreCellScroll(cellScroll);
}

/* ---------- busy days scroll inside their cell ---------- */
function saveCellScroll() {
  const m = new Map();
  document.querySelectorAll("#calendar [data-date] .blocks").forEach((b) => {
    if (b.scrollTop) m.set(b.parentElement.dataset.date, b.scrollTop);
  });
  return m;
}
function restoreCellScroll(m) {
  document.querySelectorAll("#calendar [data-date] .blocks").forEach((b) => {
    const t = m.get(b.parentElement.dataset.date);
    if (t) b.scrollTop = t;
    updateFade(b);
  });
}
// Fade the top/bottom edge when there are hidden circles that way.
function updateFade(b) {
  const max = b.scrollHeight - b.clientHeight;
  b.classList.toggle("more-above", max > 1 && b.scrollTop > 1);
  b.classList.toggle("more-below", max > 1 && b.scrollTop < max - 1);
}
$("#calendar").addEventListener("scroll", (e) => {
  if (e.target.classList && e.target.classList.contains("blocks")) updateFade(e.target);
}, true);

// Base row height: the month's weeks fill the screen. A row with lots of
// circles grows taller than this, and the calendar then scrolls.
function sizeRows(wrap, rowsOnScreen, reserve = 0) {
  const cal = $("#calendar");
  const head = wrap.querySelector(".cal-head");
  const padBottom = parseFloat(getComputedStyle(cal).paddingBottom) || 0;
  const avail = cal.clientHeight - padBottom - (head ? head.offsetHeight : 30) - 4 - reserve;   // 4 = box outline
  wrap.style.setProperty("--rowh", `${Math.max(56, Math.floor(avail / rowsOnScreen))}px`);
}

/* =========================================================
   Month animals: grey dots that fill with colour, one per session.
   Each month has its own animal (see animals.js).
   ========================================================= */
const animalSeen = new Map();   // 'YYYY-MM' -> coloured dots last time, for the pop animation
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthSessions(y, m) {
  const from = dateKey(new Date(y, m, 1)), to = dateKey(new Date(y, m + 1, 0));
  return [...state.sessions.values()]
    .filter((s) => s.date >= from && s.date <= to && state.activities.has(s.activityId))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
}

// Draws month m's animal coloured with that month's sessions.
function animalSvg(y, m, { popFrom = Infinity, wiggle = false, align = "xMidYMid" } = {}) {
  const animal = ANIMALS[m];
  const sessions = monthSessions(y, m);
  const count = sessions.length;
  const baseN = animal.base.length;
  const points = [...animal.base, ...animal.extra];
  const total = Math.min(points.length, Math.max(baseN, count));

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${animal.width.toFixed(1)} 60`);
  svg.setAttribute("preserveAspectRatio", `${align} meet`);
  svg.setAttribute("class", "fish" + (wiggle ? " wiggle" : "") + (count >= baseN ? " full" : ""));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${animal.name}: ${count} of ${baseN} dots coloured`);
  for (let i = 0; i < total; i++) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", points[i][0].toFixed(1));
    c.setAttribute("cy", points[i][1].toFixed(1));
    c.setAttribute("r", i < baseN ? 2.7 : 2.2);
    if (i < count) {
      const s = sessions[i];
      c.setAttribute("fill", shade(state.activities.get(s.activityId).color, s.minutes));
      if (i >= popFrom) c.setAttribute("class", "pop");
    } else {
      c.setAttribute("class", "grey");
    }
    svg.append(c);
  }
  return { svg, count, baseN, sessions };
}

// The month's animal, with new dots popping in and a wiggle when it gets full.
function liveAnimal(y, m, align) {
  const key = `${y}-${pad(m + 1)}`;
  const count = monthSessions(y, m).length;
  const baseN = ANIMALS[m].base.length;
  const prev = animalSeen.get(key);
  animalSeen.set(key, count);
  const popFrom = prev !== undefined && count > prev ? prev : Infinity;
  const wiggle = prev !== undefined && prev < baseN && count >= baseN;
  return animalSvg(y, m, { popFrom, wiggle, align }).svg;
}

function addFish(box, trail, rows, extraRow, y, m) {
  const svg = liveAnimal(y, m, "xMaxYMid");   // hug the right edge

  const holder = el("div");
  holder.append(svg);
  if (!extraRow) {
    // Fits into the empty cells after the month's last day.
    holder.className = "fish-in";
    holder.style.gridRow = String(rows);
    holder.style.gridColumn = `${8 - trail} / span ${trail}`;
    box.append(holder);
  } else {
    // Its own row at the bottom of the calendar, inside the outline.
    holder.className = "animal-row";
    box.append(holder);
  }
}

/* ---------- Gallery: this month's animal and every month since you started ---------- */
let galleryOpen = false;

function galleryMonths() {
  const now = new Date();
  let first = new Date(now.getFullYear(), now.getMonth(), 1);
  for (const s of state.sessions.values()) {
    const d = parseKey(s.date);
    if (d < first) first = new Date(d.getFullYear(), d.getMonth(), 1);
  }
  for (const a of state.activities.values()) {
    if (a.createdAt) { const d = new Date(a.createdAt); if (d < first) first = new Date(d.getFullYear(), d.getMonth(), 1); }
  }
  const months = [];
  for (let d = new Date(now.getFullYear(), now.getMonth(), 1); d >= first; d = new Date(d.getFullYear(), d.getMonth() - 1, 1)) {
    months.push([d.getFullYear(), d.getMonth()]);
  }
  return months;   // newest first
}

function renderGallery() {
  const grid = $("#galleryGrid");
  if (!galleryOpen || !state.user) { grid.innerHTML = ""; return; }
  grid.innerHTML = "";
  for (const [y, m] of galleryMonths()) {
    const card = el("button", "gallery-card");
    card.type = "button";
    card.dataset.y = y;
    card.dataset.m = m;
    const { svg } = animalSvg(y, m);
    card.append(svg, el("span", "gallery-title", `${MONTH_NAMES[m]} ${y}`));
    grid.append(card);
  }
}

/* ---------- Sidebar sections that fold open/closed (remembered on this device) ---------- */
function setupFold(toggleSel, bodySel, storeKey, openByDefault) {
  const btn = $(toggleSel), body = $(bodySel);
  let open = openByDefault;
  try { const v = localStorage.getItem(storeKey); if (v !== null) open = v === "1"; } catch { /* ignore */ }
  const apply = () => {
    btn.setAttribute("aria-expanded", String(open));
    body.classList.toggle("hidden", !open);
  };
  apply();
  btn.addEventListener("click", () => {
    open = !open;
    apply();
    try { localStorage.setItem(storeKey, open ? "1" : "0"); } catch { /* ignore */ }
  });
}
setupFold("#activitiesToggle", "#activitiesBody", "ct-fold-activities", true);
setupFold("#backupToggle", "#backupBody", "ct-fold-backup", false);

$("#galleryToggle").addEventListener("click", () => {
  galleryOpen = !galleryOpen;
  $("#galleryToggle").setAttribute("aria-expanded", String(galleryOpen));
  $("#galleryGrid").classList.toggle("hidden", !galleryOpen);
  renderGallery();
});

$("#galleryGrid").addEventListener("click", (e) => {
  const card = e.target.closest(".gallery-card");
  if (!card) return;
  openPopover({ type: "month", y: Number(card.dataset.y), m: Number(card.dataset.m) }, card, "side");
});

function renderWeek() {
  const start = startOfWeek(state.cursor);
  const end = addDays(start, 6);
  const today = dateKey(new Date());

  // Title: "Week 48 · Nov 2026", "Week 49 · Nov – Dec 2026", "Week 53 · Dec 2026 – Jan 2027"
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  const mon = (d) => d.toLocaleDateString("en-GB", { month: "short" });
  const months = sameMonth ? `${mon(end)} ${end.getFullYear()}`
    : sameYear ? `${mon(start)} – ${mon(end)} ${end.getFullYear()}`
    : `${mon(start)} ${start.getFullYear()} – ${mon(end)} ${end.getFullYear()}`;
  $("#title").textContent = `Week ${isoWeek(start)} · ${months}`;

  const heads = [];
  const cols = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const key = dateKey(d);
    const list = state.byDate.get(key) || [];
    const total = list.reduce((sum, s) => sum + (state.activities.has(s.activityId) ? (s.minutes || 0) : 0), 0);

    const h = el("div", "wd wd-week");
    if (key === today) h.classList.add("today");
    h.dataset.date = key;
    h.append(el("div", "", WEEKDAYS[i]), el("div", "wd-date", d.getDate()), el("div", "wd-total", total ? fmtShort(total) : ""));
    heads.push(h);

    // Mon–Fri run the full height; Sat and Sun stop above the animal's corner.
    const c = el("div", "wcol" + (i < 6 ? " br-solid" : "") + (i >= 5 ? " bb-solid wcol-short" : "") + (key === today ? " today" : ""));
    c.dataset.date = key;
    const blocks = el("div", "blocks");
    for (const s of list) {
      const bl = makeBlock(s);
      if (bl) blocks.append(bl);
    }
    c.append(blocks);
    cols.push(c);
  }
  const { wrap, wknos, box } = calendarShell(1, heads);
  wrap.classList.add("week");
  wknos.append(el("div", "wkno", isoWeek(start)), el("div", "wkno"));
  box.append(...cols);

  // Animal in the bottom-right corner under Sat–Sun: this month's, or both if the week crosses a month.
  const strip = el("div", "week-animals");
  strip.append(liveAnimal(start.getFullYear(), start.getMonth(), "xMidYMid"));
  if (!sameMonth) strip.append(liveAnimal(end.getFullYear(), end.getMonth(), "xMidYMid"));
  box.append(strip);

  const cellScroll = saveCellScroll();
  $("#calendar").replaceChildren(wrap);
  sizeRows(wrap, 1);
  restoreCellScroll(cellScroll);
}

/* =========================================================
   Navigation
   ========================================================= */
function loadView() {
  try { return localStorage.getItem("ct-view") === "week" ? "week" : "month"; } catch { return "month"; }
}
function saveView() {
  try { localStorage.setItem("ct-view", state.view); } catch { /* ignore */ }
}

$("#prevBtn").addEventListener("click", () => step(-1));
$("#nextBtn").addEventListener("click", () => step(1));
$("#todayBtn").addEventListener("click", () => {
  const now = new Date();
  const already = state.view === "week"
    ? dateKey(startOfWeek(state.cursor)) === dateKey(startOfWeek(now))
    : state.cursor.getFullYear() === now.getFullYear() && state.cursor.getMonth() === now.getMonth();
  state.cursor = now;
  closePopover();
  render();
  const box = document.querySelector("#calendar .day.today, #calendar .wcol.today");
  if (!box) return;
  const blue = "#4a7fd6";
  const pulse = [
    { boxShadow: `inset 0 0 0 2px ${blue}`, backgroundColor: "rgba(74,127,214,0)" },
    { boxShadow: `inset 0 0 0 5px ${blue}`, backgroundColor: "rgba(74,127,214,.14)" },
    { boxShadow: `inset 0 0 0 2px ${blue}`, backgroundColor: "rgba(74,127,214,0)" }
  ];
  // Already on today: a quick double pulse ("you're already here").
  // Coming back from another month: one pulse so the eye finds it.
  box.animate(pulse, { duration: already ? 380 : 560, iterations: already ? 2 : 1, easing: "ease-out" });
  if (already) vibrate(6);
});
document.querySelectorAll(".view-toggle button").forEach((b) =>
  b.addEventListener("click", () => { state.view = b.dataset.view; saveView(); closePopover(); render(); })
);

function step(dir) {
  const c = state.cursor;
  state.cursor = state.view === "week" ? addDays(c, 7 * dir) : new Date(c.getFullYear(), c.getMonth() + dir, 1);
  closePopover();
  render();
}

/* ---------- side menu ---------- */
function openDrawer() {
  closePopover();
  renderGallery();
  $("#drawer").classList.add("open");
  $("#scrim").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#scrim").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
}
$("#menuBtn").addEventListener("click", openDrawer);
$("#drawerClose").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
$("#addActivityBtn").addEventListener("click", () => { closeDrawer(); openActivityDialog(null); });

/* =========================================================
   Juicy drag & drop
   - Mouse: press and move.
   - Touch: press and hold briefly, then move (quick swipes still scroll).
   - Flick a square fast and let go: it flies away and is deleted.
   ========================================================= */
let drag = null;
const G = 34;            // ghost size in px
const HOLD_MS = 200;     // touch hold before pick-up
const SLOP = 10;         // touch movement allowed during the hold
const THRESH = 6;        // mouse movement before a drag starts
const FLICK_SPEED = 1.1; // px per ms
const FLICK_DIST = 40;   // px from start

document.addEventListener("pointerdown", (e) => {
  if (pop && !e.target.closest("#popover") && !e.target.closest("[data-drag]") && !e.target.closest("#userBtn") && !e.target.closest(".gallery-card")) closePopover();
  const src = e.target.closest("[data-drag]");
  if (!src || drag) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (multi && multi.max >= 2) return;

  drag = {
    kind: src.dataset.drag, id: src.dataset.id, el: src,
    fromDot: src.classList.contains("dot"), fromDrawer: !!src.closest("#drawer"),
    x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, pointerId: e.pointerId,
    touch: e.pointerType === "touch", started: false, timer: null, raf: 0,
    samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }], target: null
  };
  if (drag.touch) {
    drag.timer = setTimeout(() => { if (drag && !drag.started) beginDrag(); }, HOLD_MS);
  }
});

window.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
  while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > 120) drag.samples.shift();
  if (!drag.started) {
    const dist = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
    if (drag.touch) { if (dist > SLOP) cancelDrag(); return; }
    if (dist < THRESH) return;
    beginDrag();
  }
  updateTarget();
});

window.addEventListener("pointerup", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.started && multi && multi.max >= 2) { cancelDrag(); return; }
  if (drag.started) release(e.timeStamp);
  else { const d = drag; cancelDrag(); handleTap(d); }
});

window.addEventListener("pointercancel", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (drag.started) springBack(takeDrag());
  else cancelDrag();
});

document.addEventListener("contextmenu", (e) => { if (e.target.closest("[data-drag]")) e.preventDefault(); });

function dragBaseColor() {
  if (drag.kind === "activity") return state.activities.get(drag.id)?.color || "#9aa0a6";
  const s = state.sessions.get(drag.id);
  return state.activities.get(s?.activityId)?.color || "#9aa0a6";
}
function dragColor() {
  if (drag.kind === "activity") {
    const a = state.activities.get(drag.id);
    return a ? shade(a.color, a.defaultMinutes || 30) : "#ccc";
  }
  const s = state.sessions.get(drag.id);
  const a = s && state.activities.get(s.activityId);
  return a ? shade(a.color, s.minutes) : "#ccc";
}

const ghostTransform = (d) => `translate(${d.gx}px, ${d.gy}px) rotate(${d.rot}deg) scale(${d.scale})`;

function beginDrag() {
  drag.started = true;
  clearTimeout(drag.timer);
  closePopover();
  if (drag.fromDrawer) closeDrawer();
  vibrate(10);

  const r = drag.el.getBoundingClientRect();
  const g = el("div", "ghost");
  g.style.width = g.style.height = G + "px";
  g.style.background = dragColor();
  document.body.append(g);
  drag.ghost = g;
  drag.gx = r.left + r.width / 2 - G / 2;
  drag.gy = r.top + r.height / 2 - G / 2;
  drag.scale = Math.max(r.width, 8) / G;
  drag.rot = 0;
  g.style.transform = ghostTransform(drag);
  void g.offsetWidth;          // apply the start state before animating
  g.classList.add("lifted");   // lifts with a big soft shadow

  document.body.classList.add("dragging");
  document.body.style.setProperty("--drag-color", dragBaseColor());
  if (drag.kind === "session") drag.el.classList.add("picked");
  if (drag.fromDot) drag.el.animate(
    [{ transform: "scale(1)" }, { transform: "scale(1.35)" }, { transform: "scale(.9)" }, { transform: "scale(1)" }],
    { duration: 380, easing: "ease-out" }
  );
  updateTarget();
  drag.raf = requestAnimationFrame(tick);
}

// Ghost follows the pointer with a little lag, tilts with movement and wobbles.
function tick() {
  if (!drag || !drag.started) return;
  const tx = drag.x - G / 2;
  const ty = drag.y - G / 2 - (drag.touch ? 46 : 0);   // above the finger so it stays visible
  const dx = tx - drag.gx;
  drag.gx += dx * 0.35;
  drag.gy += (ty - drag.gy) * 0.35;
  const targetRot = Math.max(-28, Math.min(28, dx * 0.9));
  drag.rot += (targetRot - drag.rot) * 0.22;
  drag.scale += ((drag.target ? 1.22 : 1.12) - drag.scale) * 0.2;
  const cal = $("#calendar");
  const cr = cal.getBoundingClientRect();
  if (cal.scrollHeight > cal.clientHeight) {
    if (drag.y > cr.bottom - 48) { cal.scrollTop += 9; updateTarget(); }
    else if (drag.y < cr.top + 48 && drag.y > cr.top - 80) { cal.scrollTop -= 9; updateTarget(); }
  }
  drag.ghost.style.transform = ghostTransform(drag);
  drag.raf = requestAnimationFrame(tick);
}

function updateTarget() {
  const under = document.elementFromPoint(drag.x, drag.y);
  const target = under ? under.closest("#calendar [data-date]") : null;
  if (target !== drag.target) {
    if (drag.target) drag.target.classList.remove("drop-target");
    if (target) { target.classList.add("drop-target"); vibrate(4); }
    drag.target = target;
  }
}

// Removes drag state but keeps the ghost, for the closing animation.
function takeDrag() {
  const d = drag;
  drag = null;
  clearTimeout(d.timer);
  cancelAnimationFrame(d.raf);
  if (d.target) d.target.classList.remove("drop-target");
  document.body.classList.remove("dragging");
  return d;
}

// Cancels a drag that never started (or an Escape), with no animation.
function cancelDrag() {
  if (!drag) return;
  const d = takeDrag();
  if (d.ghost) d.ghost.remove();
  if (d.el) d.el.classList.remove("picked");
}

function velocity(d, releaseTime) {
  const s = d.samples;
  const last = s[s.length - 1];
  const dist = Math.hypot(d.x - d.x0, d.y - d.y0);
  if (s.length < 2 || releaseTime - last.t > 100) return { speed: 0, vx: 0, vy: 0, dist };
  let first = s[0];
  for (const p of s) { if (last.t - p.t <= 100) { first = p; break; } }
  const dt = Math.max(1, last.t - first.t);
  const vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
  return { speed: Math.hypot(vx, vy), vx, vy, dist };
}

function release(releaseTime) {
  const d = takeDrag();
  const v = velocity(d, releaseTime);

  // Flick to delete
  if (d.kind === "session" && v.speed > FLICK_SPEED && v.dist > FLICK_DIST) {
    const name = actName(state.sessions.get(d.id)?.activityId);
    flickAway(d, v);
    removeSession(d.id);
    toast(`Deleted ${name}`);
    vibrate([8, 30, 8]);
    return;
  }

  if (d.target) {
    const date = d.target.dataset.date;
    let id;
    if (d.kind === "activity") {
      const a = state.activities.get(d.id);
      if (!a) return springBack(d);
      id = createSession(d.id, date, a.defaultMinutes || 30);
    } else {
      id = d.id;
      moveSession(id, date);
    }
    flying.add(id);
    flyToBlock(d, id, date);
  } else {
    springBack(d);
  }
}

// Ghost dives into the block's spot, then the block lands with a squash & bounce.
async function flyToBlock(d, id, date) {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    const e = document.querySelector(`.block[data-id="${id}"]`);
    if (e && e.closest("[data-date]")?.dataset.date === date) target = e;
    else await nextFrame();
  }
  if (!target) {
    flying.delete(id);
    d.ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150 }).onfinish = () => d.ghost.remove();
    return;
  }
  target.classList.add("flying");
  target.classList.remove("picked");
  const cell = target.parentElement;
  if (cell && cell.scrollHeight > cell.clientHeight) {
    const top = target.offsetTop - cell.offsetTop;
    if (top < cell.scrollTop || top + target.offsetHeight > cell.scrollTop + cell.clientHeight) {
      cell.scrollTop = top + target.offsetHeight - cell.clientHeight + 4;
      updateFade(cell);
    }
  }
  const r = target.getBoundingClientRect();
  const s = r.width / G;
  const end = `translate(${r.left + r.width / 2 - G / 2}px, ${r.top + r.height / 2 - G / 2}px) rotate(0deg) scale(${s})`;
  const anim = d.ghost.animate([{ transform: ghostTransform(d) }, { transform: end }],
    { duration: 210, easing: "cubic-bezier(.55,0,.85,.35)", fill: "forwards" });
  anim.onfinish = () => {
    d.ghost.remove();
    flying.delete(id);
    landing.add(id);
    const e = document.querySelector(`.block[data-id="${id}"]`);
    if (e) { e.classList.remove("flying", "picked"); e.classList.add("land"); }
    vibrate(8);
    setTimeout(() => {
      landing.delete(id);
      const e2 = document.querySelector(`.block[data-id="${id}"]`);
      if (e2) e2.classList.remove("land");
    }, 470);
  };
}

// Missed: spring back to where it came from.
function springBack(d) {
  let src = null;
  if (d.kind === "session") src = document.querySelector(`.block[data-id="${d.id}"]`);
  else if (d.fromDot) src = document.querySelector(`.dot[data-id="${d.id}"]`);
  const r = src && src.getBoundingClientRect();
  if (!r || !r.width) {
    d.ghost.animate([{ opacity: 1, transform: ghostTransform(d) }, { opacity: 0, transform: ghostTransform({ ...d, scale: 0.3 }) }],
      { duration: 220, fill: "forwards" }).onfinish = () => d.ghost.remove();
    if (src) src.classList.remove("picked");
    return;
  }
  const end = `translate(${r.left + r.width / 2 - G / 2}px, ${r.top + r.height / 2 - G / 2}px) rotate(0deg) scale(${r.width / G})`;
  const frames = [{ transform: ghostTransform(d) }, { transform: end }];
  d.ghost.classList.remove("lifted");
  d.ghost.animate(frames, { duration: 380, easing: "cubic-bezier(.34,1.56,.64,1)", fill: "forwards" }).onfinish = () => {
    d.ghost.remove();
    const s2 = d.kind === "session" ? document.querySelector(`.block[data-id="${d.id}"]`) : null;
    if (s2) s2.classList.remove("picked");
  };
}

// Flicked: spins off in the throw direction and fades, with a little puff.
function flickAway(d, v) {
  const dist = 360 * Math.min(2.2, Math.max(1, v.speed));
  const tx = d.gx + (v.vx / v.speed) * dist;
  const ty = d.gy + (v.vy / v.speed) * dist;
  const spin = d.rot + (v.vx >= 0 ? 1 : -1) * 600;
  d.ghost.animate([
    { transform: ghostTransform(d), opacity: 1 },
    { transform: `translate(${tx}px, ${ty}px) rotate(${spin}deg) scale(.35)`, opacity: 0 }
  ], { duration: 480, easing: "cubic-bezier(.2,.6,.35,1)", fill: "forwards" }).onfinish = () => d.ghost.remove();
  puff(d.x, d.y - (d.touch ? 46 : 0), d.ghost.style.background);
}

function puff(x, y, color) {
  for (let i = 0; i < 8; i++) {
    const p = el("div", "puff");
    p.style.background = color;
    document.body.append(p);
    const ang = (Math.PI * 2 * i) / 8 + Math.random() * 0.5;
    const r = 26 + Math.random() * 22;
    p.animate([
      { transform: `translate(${x - 4}px, ${y - 4}px) scale(1)`, opacity: 0.9 },
      { transform: `translate(${x - 4 + Math.cos(ang) * r}px, ${y - 4 + Math.sin(ang) * r}px) scale(.2)`, opacity: 0 }
    ], { duration: 420 + Math.random() * 120, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" }).onfinish = () => p.remove();
  }
}

function handleTap(d) {
  if (d.kind === "session") openSessionPopover(d.id, d.el);
  else if (d.fromDot) openActivityInfo(d.id, d.el);
  else { closeDrawer(); openActivityDialog(d.id); }
}

/* =========================================================
   Undo / redo gestures: 2-finger tap = undo, 3-finger tap = redo
   ========================================================= */
// Tracks fingers with pointer events (these arrive reliably on every phone).
// Runs in the capture phase, so it sees each finger before the drag code does.
let multi = null;
const fingers = new Map();   // pointerId -> start {x, y}

window.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch") return;
  if (fingers.size === 0) multi = { max: 0, t0: e.timeStamp, moved: false, dragged: false };
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  multi.max = Math.max(multi.max, fingers.size);
  if (fingers.size >= 2 && drag && !drag.started) cancelDrag();
}, true);

window.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "touch" || !multi) return;
  const s = fingers.get(e.pointerId);
  if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 18) multi.moved = true;
  if (drag && drag.started) multi.dragged = true;
}, true);

function fingerUp(e, cancelled) {
  if (e.pointerType !== "touch" || !fingers.has(e.pointerId)) return;
  fingers.delete(e.pointerId);
  if (fingers.size > 0 || !multi) return;
  const m = multi;
  // Let the drag code see this last finger first, then reset.
  setTimeout(() => { if (multi === m) multi = null; }, 0);
  if (cancelled || m.moved || m.dragged || e.timeStamp - m.t0 > 400) return;
  if (document.querySelector("dialog[open]")) return;
  if (m.max === 2) undo();
  else if (m.max === 3) redo();
}
window.addEventListener("pointerup", (e) => fingerUp(e, false), true);
window.addEventListener("pointercancel", (e) => fingerUp(e, true), true);

// No page scrolling while dragging on a phone.
document.addEventListener("touchmove", (e) => { if (drag && drag.started) e.preventDefault(); }, { passive: false });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (drag) { drag.started ? springBack(takeDrag()) : cancelDrag(); }
    closePopover();
    closeDrawer();
    return;
  }
  const typing = e.target.closest("input, textarea, [contenteditable]") || document.querySelector("dialog[open]");
  if (typing || !(e.ctrlKey || e.metaKey) || !state.user) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
});

/* =========================================================
   Bubbles: session details, activity info, account
   ========================================================= */
let pop = null;   // {type: 'session' | 'activity' | 'user', id?}
const popEl = $("#popover");

const SESSION_HTML = `
  <div class="pop-head">
    <span class="pop-dot"></span>
    <strong class="pop-name"></strong>
    <button class="icon-btn" data-act="close" aria-label="Close">×</button>
  </div>
  <div class="pop-dur">
    <button class="icon-btn" data-step="-15" aria-label="15 minutes less">−</button>
    <input type="number" min="5" max="1440" step="5" aria-label="Minutes">
    <span>min</span>
    <button class="icon-btn" data-step="15" aria-label="15 minutes more">+</button>
  </div>
  <div class="pop-pretty"></div>
  <div class="pop-actions"><button class="btn danger small" data-act="delete">Delete</button></div>`;

const ACTIVITY_HTML = `
  <div class="pop-head">
    <span class="pop-dot round"></span>
    <strong class="pop-name"></strong>
    <button class="icon-btn" data-act="close" aria-label="Close">×</button>
  </div>
  <div class="pop-line"></div>
  <div class="pop-line muted"></div>
  <div class="pop-actions"><button class="btn small" data-act="edit">Edit</button></div>`;

function openPopover(p, anchor, mode) {
  pop = p;
  popEl.dataset.built = "";
  renderPopover();
  positionPopover(anchor, mode);
}
const openSessionPopover = (id, anchor) => openPopover({ type: "session", id }, anchor, "side");
const openActivityInfo = (id, anchor) => openPopover({ type: "activity", id }, anchor, "below");
const openUserPopover = () => openPopover({ type: "user" }, $("#userBtn"), "below-right");

function closePopover() {
  pop = null;
  popEl.dataset.built = "";
  popEl.classList.add("hidden");
  popEl.innerHTML = "";
  markSelectedDay();
}

function renderPopover() {
  if (!pop) return;
  if (pop.type === "session") {
    const s = state.sessions.get(pop.id);
    const a = s && state.activities.get(s.activityId);
    if (!s || !a) return closePopover();
    if (popEl.dataset.built !== "s:" + pop.id) { popEl.innerHTML = SESSION_HTML; popEl.dataset.built = "s:" + pop.id; }
    popEl.querySelector(".pop-dot").style.background = shade(a.color, s.minutes);
    popEl.querySelector(".pop-name").textContent = a.name;
    const inp = popEl.querySelector("input");
    if (document.activeElement !== inp) inp.value = s.minutes;
    popEl.querySelector(".pop-pretty").textContent = fmtMinutes(s.minutes);
  } else if (pop.type === "activity") {
    const a = state.activities.get(pop.id);
    if (!a) return closePopover();
    if (popEl.dataset.built !== "a:" + pop.id) { popEl.innerHTML = ACTIVITY_HTML; popEl.dataset.built = "a:" + pop.id; }
    popEl.querySelector(".pop-dot").style.background = a.color;
    popEl.querySelector(".pop-name").textContent = a.name;
    const lines = popEl.querySelectorAll(".pop-line");
    lines[0].textContent = `Default session: ${fmtMinutes(a.defaultMinutes || 30)}`;
    const total = totalsInRange().get(a.id) || 0;
    lines[1].textContent = `${state.view === "week" ? "This week" : "This month"}: ${fmtMinutes(total)}`;
  } else if (pop.type === "month") {
    const { y, m } = pop;
    const key = "m:" + y + "-" + m;
    const { count, baseN, sessions } = animalSvg(y, m);
    const minutes = sessions.reduce((t, s) => t + (s.minutes || 0), 0);
    const byAct = new Map();
    for (const s of sessions) byAct.set(s.activityId, (byAct.get(s.activityId) || 0) + (s.minutes || 0));
    const top = [...byAct.entries()].sort((p, q) => q[1] - p[1])[0];
    if (popEl.dataset.built !== key) {
      popEl.innerHTML = `
        <div class="pop-head">
          <strong class="pop-name"></strong>
          <button class="icon-btn" data-act="close" aria-label="Close">×</button>
        </div>
        <div class="stat-row"><span>Dots coloured</span><b class="st-dots"></b></div>
        <div class="stat-row"><span>Total time</span><b class="st-time"></b></div>
        <div class="stat-row"><span>Top activity</span><b class="st-top"></b></div>
        <div class="pop-actions"><button class="btn small" data-act="gotomonth">Go to month</button></div>`;
      popEl.dataset.built = key;
    }
    popEl.querySelector(".pop-name").textContent = `${MONTH_NAMES[m]} ${y}`;
    popEl.querySelector(".st-dots").textContent = `${count} / ${baseN}`;
    popEl.querySelector(".st-time").textContent = minutes ? fmtMinutes(minutes) : "–";
    const topEl = popEl.querySelector(".st-top");
    topEl.textContent = "";
    if (top) {
      const a = state.activities.get(top[0]);
      const dot = el("span", "st-dot");
      dot.style.background = a.color;
      topEl.append(dot, `${a.name} · ${fmtMinutes(top[1])}`);
    } else {
      topEl.textContent = "–";
    }
  } else if (pop.type === "user") {
    if (popEl.dataset.built !== "user") {
      popEl.innerHTML = `<p class="pop-email"></p><button class="btn" data-act="signout">Sign out</button>` +
        `<button class="why-link pop-privacy" data-act="privacy">Privacy &amp; sign-in info</button>`;
      popEl.querySelector(".pop-email").textContent = state.user?.email || "";
      popEl.dataset.built = "user";
    }
  }
  popEl.classList.remove("hidden");
  markSelectedDay();
}

// While a session's popup is open, ring that day's date in blue.
function markSelectedDay() {
  document.querySelectorAll(".sel-day").forEach((e) => e.classList.remove("sel-day"));
  if (!pop || pop.type !== "session") return;
  const s = state.sessions.get(pop.id);
  if (!s) return;
  document.querySelectorAll(`#calendar .day[data-date="${s.date}"], #calendar .wd-week[data-date="${s.date}"]`)
    .forEach((e) => e.classList.add("sel-day"));
}

function positionPopover(anchor, mode) {
  if (!pop) return;
  if (narrow() && mode === "side") {
    popEl.classList.add("sheet");
    popEl.style.left = popEl.style.top = "";
    return;
  }
  popEl.classList.remove("sheet");
  const r = anchor.getBoundingClientRect();
  const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
  let left, top;
  if (mode === "below-right") { left = r.right - pw; top = r.bottom + 8; }
  else if (mode === "below") { left = r.left + r.width / 2 - pw / 2; top = r.bottom + 10; }
  else {
    left = r.right + 10;
    if (left + pw > window.innerWidth - 8) left = r.left - pw - 10;
    top = r.top - 10;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
  popEl.style.left = left + "px";
  popEl.style.top = top + "px";
}

popEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || !pop) return;
  if (btn.dataset.act === "close") return closePopover();
  if (btn.dataset.act === "signout") { closePopover(); return signOut(auth); }
  if (btn.dataset.act === "privacy") { closePopover(); return $("#whyDialog").showModal(); }
  if (btn.dataset.act === "edit") { const id = pop.id; closePopover(); return openActivityDialog(id); }
  if (btn.dataset.act === "gotomonth") {
    const { y, m } = pop;
    closePopover();
    closeDrawer();
    state.view = "month";
    saveView();
    state.cursor = new Date(y, m, 1);
    return render();
  }
  if (pop.type !== "session") return;
  const s = state.sessions.get(pop.id);
  if (!s) return;
  if (btn.dataset.step) setMinutes(s.id, (s.minutes || 0) + Number(btn.dataset.step));
  if (btn.dataset.act === "delete") {
    closePopover();
    removeSession(s.id);
    toast(`Deleted ${actName(s.activityId)}`);
  }
});

popEl.addEventListener("change", (e) => {
  if (e.target.matches("input") && pop && pop.type === "session") setMinutes(pop.id, Number(e.target.value));
});

$("#userBtn").addEventListener("click", () => (pop && pop.type === "user" ? closePopover() : openUserPopover()));

let resizeTimer = null;
window.addEventListener("resize", () => {
  if (pop) closePopover();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.user) { renderCalendar(); updateDotArrows(); } }, 150);
});

/* =========================================================
   Add / edit activity dialog
   ========================================================= */
const dlg = $("#activityDialog");
let editingId = null;
let deleteArmed = false;

function openActivityDialog(id) {
  editingId = id || null;
  deleteArmed = false;
  const a = id ? state.activities.get(id) : null;
  $("#dialogTitle").textContent = a ? "Edit activity" : "New activity";
  $("#actName").value = a ? a.name : "";
  $("#actMinutes").value = a ? a.defaultMinutes || 30 : 30;
  $("#actColor").value = a ? a.color : autoColor();
  const delBtn = $("#deleteActivityBtn");
  delBtn.classList.toggle("hidden", !a);
  delBtn.textContent = "Delete";
  updatePreview();
  dlg.showModal();
  if (window.matchMedia("(hover: hover)").matches) setTimeout(() => $("#actName").focus(), 0);
}

// The shade circles double as quick buttons for the default length.
function updatePreview() {
  const color = $("#actColor").value;
  const current = Math.round(Number($("#actMinutes").value));
  const box = $("#colorPreview");
  box.innerHTML = "";
  for (const [m, label] of [[15, "15 min"], [30, "30 min"], [60, "1 h"], [120, "2 h"], [180, "3 h"]]) {
    const b = el("button", m === current ? "sel" : "");
    b.type = "button";
    b.dataset.min = m;
    b.setAttribute("aria-label", `Set default length to ${label}`);
    const i = el("i");
    i.style.background = shade(color, m);
    b.append(i, label);
    box.append(b);
  }
}

$("#colorPreview").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-min]");
  if (!b) return;
  $("#actMinutes").value = b.dataset.min;
  updatePreview();
  const i = $(`#colorPreview button[data-min="${b.dataset.min}"] i`);
  if (i) i.animate([{ transform: "scale(1)" }, { transform: "scale(1.35)" }, { transform: "scale(1.12)" }], { duration: 260, easing: "ease-out" });
});
$("#actMinutes").addEventListener("input", updatePreview);
$("#actColor").addEventListener("input", updatePreview);
$("#autoColorBtn").addEventListener("click", () => {
  $("#actColor").value = autoColor(editingId, $("#actColor").value);
  updatePreview();
});
$("#cancelBtn").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

$("#activityForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#actName").value.trim();
  if (!name) return;
  let minutes = Math.round(Number($("#actMinutes").value));
  if (!Number.isFinite(minutes) || minutes < 5) minutes = 30;
  minutes = Math.min(600, minutes);
  const color = $("#actColor").value;
  dlg.close();
  if (editingId) updateActivity(editingId, { name, defaultMinutes: minutes, color });
  else createActivity({ name, defaultMinutes: minutes, color, createdAt: Date.now() });
});

$("#deleteActivityBtn").addEventListener("click", () => {
  const n = sessionsOf(editingId).length;
  if (!deleteArmed) {
    deleteArmed = true;
    $("#deleteActivityBtn").textContent = n ? `Also delete ${n} session${n === 1 ? "" : "s"}?` : "Really delete?";
    return;
  }
  const name = actName(editingId);
  dlg.close();
  deleteActivity(editingId);
  toast(`Deleted ${name}`);
});

/* =========================================================
   Installable app
   ========================================================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

const isInstalled = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// Installed on an iPhone/iPad: the page runs under the status bar, so give it more room at the top.
if (isIOS && isInstalled()) document.documentElement.classList.add("ios-app");

let installPrompt = null;
// Android / Chrome / Edge: offer a real "Install app" button.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("#installBox").classList.remove("hidden");
  $("#installBtn").classList.remove("hidden");
});
$("#installBtn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $("#installBox").classList.add("hidden");
});
window.addEventListener("appinstalled", () => {
  $("#installBox").classList.add("hidden");
  toast("ColorTracker installed");
});
// iPhone / iPad: Safari has no install button, so show how to do it.
if (isIOS && !isInstalled()) {
  $("#installBox").classList.remove("hidden");
  $("#iosHint").classList.remove("hidden");
}

/* =========================================================
   Backup: download, restore, CSV
   ========================================================= */
const today = () => dateKey(new Date());

function saveFile(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  // iPhone: the share sheet lets you save to Files / iCloud
  if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function needUser() {
  if (state.user) return true;
  toast("Sign in first.");
  return false;
}

$("#backupBtn").addEventListener("click", () => {
  if (!needUser()) return;
  const data = {
    app: "ColorTracker",
    version: 1,
    exportedAt: new Date().toISOString(),
    activities: [...state.activities.values()],
    sessions: [...state.sessions.values()]
  };
  saveFile(`colortracker-backup-${today()}.json`, JSON.stringify(data, null, 1), "application/json");
  toast(`Backup saved: ${data.activities.length} activities, ${data.sessions.length} sessions.`);
});

$("#csvBtn").addEventListener("click", () => {
  if (!needUser()) return;
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Date", "Week", "Activity", "Minutes", "Colour"].map(q).join(";")];
  const list = [...state.sessions.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
  for (const s of list) {
    const act = state.activities.get(s.activityId);
    rows.push([s.date, isoWeek(parseKey(s.date)), act ? act.name : "(deleted)", s.minutes, act ? act.color : ""].map(q).join(";"));
  }
  // semicolons + BOM so Excel (also Finnish Excel) splits columns and keeps ä/ö
  saveFile(`colortracker-sessions-${today()}.csv`, "﻿" + rows.join("\r\n"), "text/csv");
  toast(`Exported ${list.length} sessions.`);
});

/* --- restore --- */
const restoreDlg = $("#restoreDialog");
let pendingRestore = null;

$("#restoreBtn").addEventListener("click", () => {
  if (!needUser()) return;
  $("#restoreFile").value = "";
  $("#restoreFile").click();
});

const isId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const num = (v, lo, hi, dflt) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : dflt);

function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error("That file isn't a ColorTracker backup."); }
  if (!raw || raw.app !== "ColorTracker" || !Array.isArray(raw.activities) || !Array.isArray(raw.sessions)) {
    throw new Error("That file isn't a ColorTracker backup.");
  }
  const activities = [];
  for (const a of raw.activities) {
    if (!a || !isId(a.id) || typeof a.name !== "string" || !a.name.trim()) continue;
    activities.push({ id: a.id, data: {
      name: a.name.trim().slice(0, 40),
      color: isHex(a.color) ? a.color : autoColor(),
      defaultMinutes: num(a.defaultMinutes, 5, 600, 30),
      createdAt: num(a.createdAt, 0, 9e15, Date.now())
    }});
  }
  const known = new Set(activities.map((a) => a.id));
  const sessions = [];
  for (const x of raw.sessions) {
    if (!x || !isId(x.id) || !known.has(x.activityId) || !isDate(x.date)) continue;
    sessions.push({ id: x.id, data: {
      activityId: x.activityId, date: x.date,
      minutes: num(x.minutes, 1, 1440, 30),
      createdAt: num(x.createdAt, 0, 9e15, Date.now())
    }});
  }
  return { activities, sessions, exportedAt: raw.exportedAt };
}

$("#restoreFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    pendingRestore = parseBackup(await f.text());
  } catch (err) {
    toast(err.message);
    return;
  }
  const when = pendingRestore.exportedAt ? new Date(pendingRestore.exportedAt) : null;
  $("#restoreInfo").textContent =
    `${pendingRestore.activities.length} activities, ${pendingRestore.sessions.length} sessions` +
    (when && !isNaN(when) ? ` · saved ${when.toLocaleDateString()}` : "");
  restoreDlg.querySelector('input[value="merge"]').checked = true;
  closeDrawer();
  restoreDlg.showModal();
});

$("#restoreCancel").addEventListener("click", () => { pendingRestore = null; restoreDlg.close(); });

$("#restoreGo").addEventListener("click", () => {
  if (!pendingRestore || !state.user) return;
  const mode = restoreDlg.querySelector('input[name="restoreMode"]:checked').value;
  if (mode === "replace" && !confirm("Delete all your current activities and sessions and replace them with the backup?")) return;
  const ops = [];
  if (mode === "replace") {
    const keepA = new Set(pendingRestore.activities.map((a) => a.id));
    const keepS = new Set(pendingRestore.sessions.map((s) => s.id));
    for (const id of state.sessions.keys()) if (!keepS.has(id)) ops.push({ name: "sessions", id });
    for (const id of state.activities.keys()) if (!keepA.has(id)) ops.push({ name: "activities", id });
  }
  for (const a of pendingRestore.activities) ops.push({ set: true, name: "activities", id: a.id, data: a.data });
  for (const s of pendingRestore.sessions) ops.push({ set: true, name: "sessions", id: s.id, data: s.data });
  batchWrite(ops);
  history.undo = []; history.redo = [];   // a restore can't be undone step by step
  toast(`Restored ${pendingRestore.activities.length} activities and ${pendingRestore.sessions.length} sessions.`);
  pendingRestore = null;
  restoreDlg.close();
});

/* =========================================================
   Toast
   ========================================================= */
let toastTimer = null;
function toast(message) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.remove("hidden");
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}
