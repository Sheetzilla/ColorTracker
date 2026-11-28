import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, EmailAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, signInAnonymously, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, linkWithCredential, linkWithPopup, linkWithRedirect, signInWithCredential,
  deleteUser, reauthenticateWithCredential, reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, deleteField,
  query, where, getDocs
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js?v=42";   // ?v= = app version, same as in index.html / sw.js
import { ANIMALS } from "./animals.js?v=42";

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
// Reads a length the way people write it: "90", "1:30", "2h", "1h 30", "1.5h", "45 min". Returns minutes or null.
function parseDuration(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(",", ".");
  if (!t) return null;
  let m = null, r;
  if (/^\d+$/.test(t)) m = Number(t);
  else if ((r = t.match(/^(\d+):([0-5]?\d)$/))) m = Number(r[1]) * 60 + Number(r[2]);
  else if ((r = t.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m|min|mins|minutes?)?)?$/)) && (r[1] || r[2])) {
    m = Math.round(Number(r[1] || 0) * 60 + Number(r[2] || 0));
  }
  return Number.isFinite(m) && m > 0 ? m : null;
}
// How a length is written back into a box: "45" or "1:30".
const boxDuration = (m) => (m < 60 ? String(m) : `${Math.floor(m / 60)}:${pad(m % 60)}`);
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
  const t = Math.pow(Math.min(Math.max(minutes, 5), 120) / 120, 0.75);   // 2 h and longer = darkest
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
getRedirectResult(auth).catch((e) => handleGoogleError(e));

onAuthStateChanged(auth, (user) => {
  $("#loading").classList.add("hidden");
  unsubs.forEach((u) => u());
  unsubs = [];
  resetSessionLoading();
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
    showSignin(false);
    return;
  }
  hideSignin();
  $("#app").classList.remove("hidden");
  setAvatar(user);
  showOfflineInfo();
  if (!navigator.onLine) toast(OFFLINE_MSG, 0);
  subscribe();
  render();
});

$("#whyBtn").addEventListener("click", () => $("#whyDialog").showModal());

// Privacy popup: our own always-visible scroll bar (phones hide theirs), shown only when the text doesn't fit.
(() => {
  const page = $("#whyDialog .bw-page"), bar = $("#whyDialog .bw-sb"), thumb = bar.firstElementChild;
  const update = () => {
    const extra = page.scrollHeight - page.clientHeight;
    bar.classList.toggle("hidden", extra <= 1);
    if (extra <= 1) return;
    const track = bar.clientHeight;
    const h = Math.max(28, track * page.clientHeight / page.scrollHeight);
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translateY(${(track - h) * page.scrollTop / extra}px)`;
  };
  page.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(page);   // also runs when the popup opens
})();
$("#whyDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });   // tap outside closes

/* ---------- Sign-in screen ---------- */
// "closed" = first page (just the buttons), "signup" = create an account, "login" = an account that already exists.
let authMode = "closed";
const isGuest = () => !!(state.user && state.user.isAnonymous);

function setAuthMode(mode) {
  authMode = mode;
  const login = mode === "login", open = mode !== "closed";
  const fields = $("#emailFields");
  fields.classList.toggle("open", open);
  fields.inert = !open;
  $("#emailBtn").textContent = login ? "Log in" : "Create account";
  $("#loginOpenBtn").classList.toggle("hidden", open);
  $("#passInput").autocomplete = login ? "current-password" : "new-password";
  $("#passInput").placeholder = login ? "Password" : "Password (at least 6 characters)";
  $("#forgotBtn").classList.toggle("hidden", !login);
  $("#modeRow").classList.toggle("hidden", !open);
  $("#modeText").textContent = login ? "New here?" : "Already have an account?";
  $("#modeBtn").textContent = login ? "Create account" : "Log in";
  signinMsg("");
  if (open) setTimeout(() => $("#emailInput").focus({ preventScroll: true }), 50);
}

// overApp = a guest opened it from the account button: the app stays behind it and × goes back.
function showSignin(overApp) {
  setAuthMode("closed");
  $("#passInput").value = "";
  $("#signin").classList.toggle("over-app", overApp);
  $("#signinClose").classList.toggle("hidden", !overApp);
  $("#guestBtn").classList.toggle("hidden", overApp);
  $("#signin").classList.remove("hidden");
}
function hideSignin() {
  $("#signin").classList.add("hidden");
  signinMsg("");
}

function signinMsg(text, ok = false) {
  const p = $("#signinError");
  p.textContent = text;
  p.classList.toggle("ok", ok);
}

function authErrorText(e) {
  switch (e.code) {
    case "auth/invalid-email": return "That email address doesn't look right.";
    case "auth/missing-email": return "Write your email address first.";
    case "auth/missing-password":
    case "auth/weak-password": return "The password needs at least 6 characters.";
    case "auth/email-already-in-use": return "That email already has an account.";
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found": return "Wrong email or password.";
    case "auth/too-many-requests": return "Too many tries. Wait a moment and try again.";
    case "auth/network-request-failed": return "No internet connection.";
    case "auth/operation-not-allowed":
    case "auth/admin-restricted-operation": return "This sign-in method isn't turned on in Firebase yet.";
    case "auth/unauthorized-domain": return "This web address isn't on Firebase's list of authorised domains yet.";
    default: return `Sign-in failed (${e.code || e.message}).`;
  }
}
const showSigninError = (e) => signinMsg(authErrorText(e));

// Opens a dialog and resolves with the button's value ("ok" / "cancel").
function ask(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = "cancel";
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

// A guest just got a real account: same user id, so all their data stays and now syncs.
function afterUpgrade() {
  state.user = auth.currentUser;
  setAvatar(state.user);
  hideSignin();
  closePopover();
  toast("Account ready! Your data is kept and now syncs.");
}

$("#modeBtn").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
$("#loginOpenBtn").addEventListener("click", () => setAuthMode("login"));
$("#signinClose").addEventListener("click", () => { if (state.user) hideSignin(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isGuest() && !$("#signin").classList.contains("hidden") && !document.querySelector("dialog[open]")) hideSignin();
});

$("#emailForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  signinMsg("");
  if (authMode === "closed") return setAuthMode("signup");   // first tap only opens the fields
  const email = $("#emailInput").value.trim();
  const pass = $("#passInput").value;
  if (!email) return signinMsg("Write your email address first.");
  if (!pass) return signinMsg(authMode === "signup" ? "Choose a password (at least 6 characters)." : "Write your password.");
  const btn = $("#emailBtn");
  btn.disabled = true;
  try {
    if (authMode === "signup") {
      if (isGuest()) {
        await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email, pass));
        afterUpgrade();
      } else {
        await createUserWithEmailAndPassword(auth, email, pass);
      }
    } else {
      if (isGuest() && await ask($("#mergeDialog")) !== "ok") return;
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (err) {
    showSigninError(err);
  } finally {
    btn.disabled = false;
  }
});

$("#forgotBtn").addEventListener("click", async () => {
  const email = $("#emailInput").value.trim();
  if (!email) return signinMsg("Write your email address above, then tap Forgot password again.");
  try {
    await sendPasswordResetEmail(auth, email);
    signinMsg("If that email has an account, a reset link is on its way. Check your spam folder too.", true);
  } catch (err) {
    showSigninError(err);
  }
});

$("#guestBtn").addEventListener("click", async () => {
  signinMsg("");
  let warned = false;
  try { warned = localStorage.getItem("ct-guest-warned") === "1"; } catch { /* ignore */ }
  if (!warned) {
    if (await ask($("#guestDialog")) !== "ok") return;
    try { localStorage.setItem("ct-guest-warned", "1"); } catch { /* ignore */ }
  }
  try {
    await signInAnonymously(auth);
  } catch (err) {
    showSigninError(err);
  }
});

$("#mergeBackupBtn").addEventListener("click", () => $("#backupBtn").click());

$("#signinBtn").addEventListener("click", async () => {
  signinMsg("");
  const provider = new GoogleAuthProvider();
  const guest = isGuest();
  try {
    if (guest) {
      await linkWithPopup(auth.currentUser, provider);
      afterUpgrade();
    } else {
      await signInWithPopup(auth, provider);
    }
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      if (guest) await linkWithRedirect(auth.currentUser, provider);
      else await signInWithRedirect(auth, provider);
    } else {
      handleGoogleError(e);
    }
  }
});

// That Google account already exists: ask before leaving the guest data behind, then log in to it.
async function handleGoogleError(e) {
  if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
  if (e.code === "auth/credential-already-in-use") {
    const cred = GoogleAuthProvider.credentialFromError(e);
    if (!cred) return showSigninError(e);
    if (await ask($("#mergeDialog")) !== "ok") return;
    try { await signInWithCredential(auth, cred); } catch (err) { showSigninError(err); }
    return;
  }
  showSigninError(e);
}

/* ---------- Danger Zone: delete the user and all their data ---------- */
const hasProvider = (u, id) => u.providerData.some((p) => p.providerId === id);
const dangerDlg = $("#dangerDialog");

function openDanger() {
  const u = auth.currentUser;
  if (!u) return;
  $("#dangerPassRow").classList.toggle("hidden", !hasProvider(u, "password"));
  $("#dangerPass").value = "";
  $("#dangerError").textContent = "";
  $("#dangerGo").disabled = false;
  $("#dangerGo").textContent = "Delete everything";
  dangerDlg.showModal();
}

// Deletes every document under users/{uid}, in batches (Firestore allows 500 per batch).
async function deleteAllData(uid) {
  for (const name of ["activities", "sessions", "settings"]) {
    const snap = await getDocs(collection(db, "users", uid, name));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

// Only a real tap/click on "Delete everything" may delete. Cancel just closes, and Enter does nothing.
$("#dangerCancel").addEventListener("click", () => dangerDlg.close());
$("#dangerPass").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
$("#dangerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.submitter !== $("#dangerGo")) return;
  const err = $("#dangerError"), go = $("#dangerGo");
  err.textContent = "";
  const u = auth.currentUser;
  if (!u) return dangerDlg.close();
  if (!navigator.onLine) { err.textContent = "You're offline. Connect to the internet to delete your data."; return; }
  const usesPassword = hasProvider(u, "password");
  const pass = $("#dangerPass").value;
  if (usesPassword && !pass) { err.textContent = "Type your password first."; return; }
  go.disabled = true;
  go.textContent = "Deleting…";
  try {
    // 1. Make sure it's really them (Firebase asks for a fresh sign-in before deleting a user).
    if (usesPassword) await reauthenticateWithCredential(u, EmailAuthProvider.credential(userEmail(u), pass));
    else if (hasProvider(u, "google.com")) await reauthenticateWithPopup(u, new GoogleAuthProvider());
    // 2. Stop live updates, then delete the data and this device's offline note.
    unsubs.forEach((un) => un());
    unsubs = [];
    await deleteAllData(u.uid);
    try { localStorage.removeItem(`ct-offline-saved-${u.uid}`); } catch { /* ignore */ }
    // 3. Delete the user itself: the app goes back to the first page.
    await deleteUser(u);
    dangerDlg.close();
    toast("Your user and all your data were deleted.");
  } catch (e2) {
    if (e2.code === "auth/popup-closed-by-user" || e2.code === "auth/cancelled-popup-request") err.textContent = "Deleting was cancelled.";
    else if (e2.code === "permission-denied") err.textContent = "The database didn't allow deleting. Check the Firestore rules.";
    else err.textContent = authErrorText(e2).replace("Sign-in failed", "Deleting failed");
    if (state.user && !unsubs.length) subscribe();   // stopped halfway: show what's still there
  } finally {
    go.disabled = false;
    go.textContent = "Delete everything";
  }
});
dangerDlg.addEventListener("click", (e) => { if (e.target === e.currentTarget) dangerDlg.close(); });

// Firebase auto clean-up deletes guest accounts 30 days after they were created.
function guestDaysLeft() {
  const created = Date.parse(state.user?.metadata?.creationTime || "");
  if (!created) return null;
  return Math.ceil((created + 30 * 864e5 - Date.now()) / 864e5);
}

// Profile details can sit on the linked provider when a guest upgraded.
const userEmail = (u) => u.email || u.providerData.find((p) => p.email)?.email || "";
const userPhoto = (u) => u.photoURL || u.providerData.find((p) => p.photoURL)?.photoURL || "";

function setAvatar(user) {
  const btn = $("#userBtn");
  btn.classList.toggle("guest", user.isAnonymous);
  if (user.isAnonymous) {
    btn.style.backgroundImage = "";
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
    btn.setAttribute("aria-label", "Not logged in");
    return;
  }
  btn.setAttribute("aria-label", "Account");
  const photo = userPhoto(user);
  if (photo) {
    btn.style.backgroundImage = `url("${photo}")`;
    btn.textContent = "";
  } else {
    btn.style.backgroundImage = "";
    btn.textContent = (user.displayName || userEmail(user) || "?").charAt(0).toUpperCase();
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

  // Your settings that sync between devices (e.g. the session length buttons).
  unsubs.push(onSnapshot(docRef("settings", "prefs"), (snap) => {
    const p = snap.exists() ? snap.data() : null;
    state.lengths = validLengths(p && p.lengths) || DEFAULT_LENGTHS.slice();
    renderLengthInputs();
    if (dlg.open) updatePreview();
  }, onDbError));
  // Sessions are loaded month by month (see watchMonth), not all at once.
}

/* ---------- Loading sessions only for the months being looked at ----------
   Normal use loads the viewed month ± 1 (so swiping shows the next one at once) and keeps
   each visited month live. The whole history is loaded only when something needs it
   (Gallery, backup, CSV, restore). This keeps Firestore reads low as history grows. */
const monthDocs = new Map();     // "YYYY-MM" (or "all") -> Map(id -> session)
const monthUnsubs = new Map();   // "YYYY-MM" -> stop listening
const monthFromServer = new Set(); // months whose data the server has confirmed (not just the device copy)
let allSessions = null;          // promise once the whole history has been asked for
let fullHistory = false;         // the whole history has come from the server this visit (complete on this device)

function resetSessionLoading() {
  monthUnsubs.forEach((u) => u());
  monthUnsubs.clear();
  monthDocs.clear();
  monthFromServer.clear();
  allSessions = null;
  fullHistory = false;
}

function rebuildSessions() {
  const merged = new Map();
  for (const m of monthDocs.values()) for (const [id, s] of m) merged.set(id, s);
  state.sessions = merged;
  indexSessions();
  renderLists();
  renderCalendar();
  renderPopover();
}

function watchMonth(y, m) {
  if (allSessions || !state.user) return;
  const d = new Date(y, m, 1);
  const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (monthUnsubs.has(key)) return;
  const q = query(col("sessions"), where("date", ">=", `${key}-01`), where("date", "<=", `${key}-31`));
  monthUnsubs.set(key, onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    if (allSessions) return;   // the full history took over
    if (!snap.metadata.fromCache) monthFromServer.add(key);
    monthDocs.set(key, new Map(snap.docs.map((x) => [x.id, { id: x.id, ...x.data() }])));
    rebuildSessions();
  }, onDbError));
}

// The months the current view needs: the viewed month (or both months of a week) plus one on each side.
function ensureLoaded() {
  if (!state.user || allSessions) return;
  let a, b;
  if (state.view === "week") { a = startOfWeek(state.cursor); b = addDays(a, 6); }
  else { a = b = state.cursor; }
  for (let d = new Date(a.getFullYear(), a.getMonth() - 1, 1); d <= new Date(b.getFullYear(), b.getMonth() + 1, 1);
       d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    watchMonth(d.getFullYear(), d.getMonth());
  }
}

// Loads (and keeps live) every session. Resolves once the server has answered,
// or with what's on the device if offline.
function loadAllSessions() {
  if (allSessions) return allSessions;
  allSessions = new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const unsub = onSnapshot(col("sessions"), { includeMetadataChanges: true }, (snap) => {
      if (monthUnsubs.size) { monthUnsubs.forEach((u) => u()); monthUnsubs.clear(); }
      monthDocs.clear();
      monthDocs.set("all", new Map(snap.docs.map((x) => [x.id, { id: x.id, ...x.data() }])));
      rebuildSessions();
      if (!snap.metadata.fromCache) fullHistory = true;
      if (!snap.metadata.fromCache || !navigator.onLine) finish();
    }, (err) => { onDbError(err); finish(); });
    unsubs.push(unsub);
    setTimeout(finish, 10000);   // slow connection: go on with what we have
  });
  return allSessions;
}

// All sessions of one activity (also ones in months not loaded), straight from Firestore.
async function activitySessions(id) {
  const found = new Map(sessionsOf(id).map((s) => [s.id, s]));
  if (!allSessions) {
    try {
      const snap = await getDocs(query(col("sessions"), where("activityId", "==", id)));
      for (const x of snap.docs) found.set(x.id, { id: x.id, ...x.data() });
    } catch (err) { console.error(err); }
  }
  return [...found.values()];
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

// "Delete" but keep its logged sessions: the activity is only hidden (the squares need its name and colour).
function hideActivity(id) {
  const a = state.activities.get(id);
  if (!a) return;
  patch("activities", id, { hidden: true });
  record({
    label: `removed ${a.name}`,
    undo: () => patch("activities", id, { hidden: false }),
    redo: () => patch("activities", id, { hidden: true })
  });
}

// Saves a new dot order (list of activity ids, first = leftmost).
function reorderActivities(ids) {
  const before = new Map(sortedActivities().map((a) => [a.id, a.order]));
  const write = (orderOf) => {
    const b = writeBatch(db);
    for (const id of ids) {
      const o = orderOf(id);
      b.update(docRef("activities", id), { order: o === undefined ? deleteField() : o });
    }
    b.commit().catch(onDbError);
  };
  write((id) => ids.indexOf(id));
  record({
    label: "reordered activities",
    undo: () => write((id) => before.get(id)),
    redo: () => write((id) => ids.indexOf(id))
  });
}

function deleteActivity(id, sessions = sessionsOf(id)) {
  const a = state.activities.get(id);
  if (!a) return;
  const data = strip(a);
  const saved = sessions.map((s) => ({ id: s.id, data: strip(s) }));
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

// Activities shown as dots / in the menu: not hidden, in the user's order (new ones go last).
function sortedActivities() {
  const ord = (a) => (typeof a.order === "number" ? a.order : Infinity);
  return [...state.activities.values()]
    .filter((a) => !a.hidden)
    .sort((a, b) => ord(a) - ord(b) || (a.createdAt || 0) - (b.createdAt || 0));
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
  box.scrollLeft = scroll;
  fitDots();
}

// The scrolling part only ever shows whole dots: its width is cut to as many dots as fit
// next to the +, and scrolling snaps by whole dots. The + sits right after it.
const DOTS_PAD = 4;   // room on each side so a dot can grow on hover (matches style.css)
let dotsPerView = 1;
function fitDots() {
  const box = $("#dots");
  const n = box.children.length;
  box.classList.toggle("hidden", n === 0);
  if (n) {
    const dot = box.children[0].offsetWidth;
    const gap = parseFloat(getComputedStyle(box).columnGap) || 0;
    const group = box.parentElement;
    const groupGap = parseFloat(getComputedStyle(group).columnGap) || 0;
    const room = group.clientWidth - $("#addDot").offsetWidth - groupGap - 2 * DOTS_PAD;
    dotsPerView = Math.max(1, Math.floor((room + gap) / (dot + gap)));
    const show = Math.min(n, dotsPerView);
    box.style.width = `${2 * DOTS_PAD + show * dot + (show - 1) * gap}px`;
  }
  updateDotArrows();
}
function dotStep() {
  const box = $("#dots");
  if (!box.children.length) return 0;
  return box.children[0].offsetWidth + (parseFloat(getComputedStyle(box).columnGap) || 0);
}

function updateDotArrows() {
  const d = $("#dots");
  const overflow = d.scrollWidth > d.clientWidth + 2;
  $("#dotsBar").classList.toggle("overflow", overflow);
  $("#dotsPrev").disabled = d.scrollLeft <= 2;
  $("#dotsNext").disabled = d.scrollLeft + d.clientWidth >= d.scrollWidth - 2;
}

$("#dots").addEventListener("scroll", updateDotArrows, { passive: true });
$("#dotsPrev").addEventListener("click", () => $("#dots").scrollBy({ left: -Math.max(1, dotsPerView - 1) * dotStep() }));
$("#dotsNext").addEventListener("click", () => $("#dots").scrollBy({ left: Math.max(1, dotsPerView - 1) * dotStep() }));
$("#addDot").addEventListener("click", () => openActivityDialog(null));

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
  ensureLoaded();
  if (state.view === "week") renderWeek();
  else renderMonth();
  markSelectedDay();
  showLoadState();
}

// The colour stripe on top of the calendar runs until the viewed month(s) have come from the server.
function viewMonths() {
  const a = state.view === "week" ? startOfWeek(state.cursor) : state.cursor;
  const b = state.view === "week" ? addDays(a, 6) : a;
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  return [...new Set([key(a), key(b)])];
}
function showLoadState() {
  const wrap = $("#calendar").firstElementChild;
  if (!wrap) return;
  const loading = navigator.onLine && !fullHistory && viewMonths().some((k) => !monthFromServer.has(k));
  wrap.classList.toggle("is-loading", loading);
}
// Offline: a message at the bottom (like undo) for a few seconds, when the app opens offline or the connection drops.
const OFFLINE_MSG = "Offline · showing what's saved on device";
window.addEventListener("online", () => {
  renderCalendar();
  if ($("#toast").textContent.startsWith(OFFLINE_MSG)) hideToast();   // not true anymore
});
window.addEventListener("offline", () => { renderCalendar(); if (state.user) toast(OFFLINE_MSG, 0); });

function calendarShell(rows, headCells) {
  const wrap = el("div", "cal");
  wrap.style.setProperty("--rows", rows);
  const head = el("div", "cal-head");
  const lbl = el("div", "wk-lbl");
  const tog = el("button", "wk-toggle");
  tog.type = "button";
  tog.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const hidden = $("#calendar").classList.contains("no-wk");
  tog.setAttribute("aria-label", hidden ? "Show week numbers" : "Hide week numbers");
  tog.setAttribute("aria-expanded", String(!hidden));
  lbl.append(el("span", "wk-word", "Week"), tog);
  head.append(lbl, ...headCells);
  const body = el("div", "cal-body");
  const wknos = el("div", "wknos");
  const box = el("div", "box");
  box.append(el("div", "load-stripe"));   // shows while this month is still loading
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
  const keepScroll = cal.dataset.month === `${y}-${m}` ? window.scrollY : 0;
  cal.dataset.month = `${y}-${m}`;
  const cellScroll = saveCellScroll();
  cal.replaceChildren(wrap);
  sizeRows(wrap, weeks + (extraRow ? 1 : 0));   // the animal's extra row fits on screen too
  window.scrollTo(0, keepScroll);
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

// The weekday row pins right under the pinned top part, whatever its height.
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--top-h", `${$("#appTop").offsetHeight}px`);
}).observe($("#appTop"));

// Base row height: the month's weeks fill the screen. A row with lots of
// circles grows taller than this, and the calendar then scrolls.
function sizeRows(wrap, rowsOnScreen, reserve = 0) {
  const cal = $("#calendar");
  const head = wrap.querySelector(".cal-head");
  const padBottom = (parseFloat(getComputedStyle(cal).paddingBottom) || 0) + (parseFloat(getComputedStyle($("#app")).paddingBottom) || 0);
  const topH = $("#appTop").offsetHeight;
  const avail = window.innerHeight - topH - padBottom - (head ? head.offsetHeight : 30) - 4 - reserve;   // 4 = box outline
  wrap.style.setProperty("--rowh", `${Math.max(minRowHeight(wrap), Math.floor(avail / rowsOnScreen))}px`);
}

// Smallest a month row may get: the date plus two full lines of squares. If the screen is too
// short for that, the rows keep this size and the page scrolls instead of squeezing them.
function minRowHeight(wrap) {
  const cell = wrap.querySelector(".day[data-date]");
  if (!cell) return 56;   // week view: one tall row, nothing to squeeze
  const cs = getComputedStyle(cell);
  const num = cell.querySelector(".day-num");
  const numH = num.offsetHeight + (parseFloat(getComputedStyle(num).marginBottom) || 0);
  const blocks = cell.querySelector(".blocks");
  const gap = parseFloat(getComputedStyle(blocks).rowGap) || 0;
  const block = parseFloat(getComputedStyle(wrap).getPropertyValue("--block")) || 16;
  return Math.ceil((parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + numH + 2 * block + gap + 4);
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
/* ---------- Shuffled animals: tap = random, tap = in order, tap = a new random… ---------- */
// Remembered on this device per month: { "2026-11": seed }. No seed = in order.
const SHUFFLE_KEY = "ct-animal-shuffle";
let shuffleSeeds = {};
try { shuffleSeeds = JSON.parse(localStorage.getItem(SHUFFLE_KEY) || "{}") || {}; } catch { shuffleSeeds = {}; }
let justShuffled = null;   // "YYYY-MM" that was just tapped: its dots play the shuffle animation once

function seededRandom(seed) {   // mulberry32: same seed = same "random" order every time
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Which point each session sits on. In order: session i on point i. Random: the animal's
// main points in a random order (extra points stay last), so a new session lands on a free random spot.
function dotSlots(key, baseN, totalPoints) {
  const order = Array.from({ length: totalPoints }, (_, i) => i);
  const seed = shuffleSeeds[key];
  if (seed === undefined) return order;
  const rnd = seededRandom(seed);
  for (let i = baseN - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function toggleShuffle(y, m) {
  const key = `${y}-${pad(m + 1)}`;
  if (shuffleSeeds[key] === undefined) shuffleSeeds[key] = Math.floor(Math.random() * 2 ** 31);
  else delete shuffleSeeds[key];
  try { localStorage.setItem(SHUFFLE_KEY, JSON.stringify(shuffleSeeds)); } catch { /* ignore */ }
  justShuffled = key;
  renderCalendar();
  justShuffled = null;
  if (galleryOpen) renderGallery();
}

function animalSvg(y, m, { popFrom = Infinity, wiggle = false, align = "xMidYMid" } = {}) {
  const animal = ANIMALS[m];
  const sessions = monthSessions(y, m);
  const count = sessions.length;
  const baseN = animal.base.length;
  const points = [...animal.base, ...animal.extra];
  const total = Math.min(points.length, Math.max(baseN, count));
  const key = `${y}-${pad(m + 1)}`;
  const slots = dotSlots(key, baseN, points.length);
  const sessionAt = new Map();   // point index -> session index
  for (let i = 0; i < Math.min(count, points.length); i++) sessionAt.set(slots[i], i);
  const shuffling = justShuffled === key;

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${animal.width.toFixed(1)} 60`);
  svg.setAttribute("preserveAspectRatio", `${align} meet`);
  svg.setAttribute("class", "fish" + (wiggle ? " wiggle" : "") + (count >= baseN ? " full" : ""));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${animal.name}: ${count} of ${baseN} dots coloured`);
  svg.dataset.ym = `${y}-${m}`;
  for (let i = 0; i < total; i++) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", points[i][0].toFixed(1));
    c.setAttribute("cy", points[i][1].toFixed(1));
    c.setAttribute("r", i < baseN ? 2.7 : 2.2);
    const si = sessionAt.get(i);
    if (si !== undefined) {
      const s = sessions[si];
      c.setAttribute("fill", shade(state.activities.get(s.activityId).color, s.minutes));
      if (shuffling) { c.setAttribute("class", "shuffle"); c.style.animationDelay = `${Math.min(si * 12, 300)}ms`; }
      else if (si >= popFrom) c.setAttribute("class", "pop");
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
  const svg = animalSvg(y, m, { popFrom, wiggle, align }).svg;
  svg.classList.add("tappable");   // tap to shuffle the dots
  return svg;
}

$("#calendar").addEventListener("click", (e) => {
  const fish = e.target.closest("svg.fish.tappable");
  if (!fish || swipeBusy) return;
  const [y, m] = fish.dataset.ym.split("-").map(Number);
  vibrate(10);
  toggleShuffle(y, m);
});

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
setupFold("#activitiesToggle", "#activitiesBody", "ct-fold-activities-v2", false);   // new key: everyone starts closed once
setupFold("#backupToggle", "#backupBody", "ct-fold-backup", false);
setupFold("#settingsToggle", "#settingsBody", "ct-fold-settings", false);
setupFold("#installToggle", "#installBody", "ct-fold-install", false);

$("#galleryToggle").addEventListener("click", () => {
  galleryOpen = !galleryOpen;
  $("#galleryToggle").setAttribute("aria-expanded", String(galleryOpen));
  $("#galleryGrid").classList.toggle("hidden", !galleryOpen);
  $("#galleryDownload").classList.toggle("hidden", !galleryOpen);
  renderGallery();
  if (galleryOpen) loadAllSessions();   // every animal needs its month's sessions
});
$("#galleryDownload").addEventListener("click", async () => {
  if (!needOnline("download all months")) return;
  await loadAllSessions();
  const months = galleryMonths();
  askImage(months, "colortracker-gallery.jpg", months.length === 1 ? "1 month" : `All ${months.length} months`);
});

/* ---------- Animal pictures: drawn on the device and saved as JPEG ---------- */
const imgDlg = $("#imgDialog");
let imgRequest = null;   // { months: [[y, m], ...], name }
let previewToken = 0;

function askImage(months, name, label) {
  if (!months.length) return;
  imgRequest = { months, name };
  $("#imgInfo").textContent = `${label} · JPEG`;
  $("#imgPreview").replaceChildren();
  imgDlg.returnValue = "";
  imgDlg.showModal();
  updateImgPreview();
}

// Draws the real image and shows it shrunk at the top of the popup.
async function updateImgPreview() {
  if (!imgRequest) return;
  if (imgRequest.months.length > 1) await loadAllSessions();
  if (!imgRequest) return;
  const token = ++previewToken;
  const canvas = await animalCanvas(imgRequest.months, $("#imgStats").checked);
  if (token !== previewToken || !imgRequest) return;   // a newer preview is on its way
  $("#imgPreview").replaceChildren(canvas);
}
$("#imgStats").addEventListener("change", updateImgPreview);

imgDlg.addEventListener("close", async () => {
  const req = imgRequest;
  imgRequest = null;
  if (!req || imgDlg.returnValue !== "ok") return;
  try {
    if (req.months.length > 1) await loadAllSessions();
    const canvas = await animalCanvas(req.months, $("#imgStats").checked);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.92));
    saveFile(req.name, blob, "image/jpeg");
  } catch (err) {
    console.error(err);
    toast("Couldn't make the image");
  }
});

// Copy image: the same picture as Download, as a PNG (browsers only copy PNG images).
$("#imgCopy").addEventListener("click", async () => {
  const req = imgRequest;
  if (!req) return;
  const stats = $("#imgStats").checked;
  const makePng = async () => {
    if (req.months.length > 1) await loadAllSessions();
    const canvas = await animalCanvas(req.months, stats);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
  };
  if (!navigator.clipboard || !window.ClipboardItem) return toast("Couldn't copy the image here, use Download instead.");
  try {
    try {
      // Handing over the unfinished picture keeps Safari happy (it must start right on the tap).
      await navigator.clipboard.write([new ClipboardItem({ "image/png": makePng() })]);
    } catch (e) {
      if (e.name === "NotAllowedError") throw e;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await makePng() })]);
    }
    imgDlg.close();
    toast("Image copied. Paste it anywhere: Discord, WhatsApp, email…");
  } catch (err) {
    console.error(err);
    toast("Couldn't copy the image here, use Download instead.");
  }
});

function monthStats(y, m) {
  const sessions = monthSessions(y, m);
  if (!sessions.length) return "No sessions";
  const minutes = sessions.reduce((t, s) => t + (s.minutes || 0), 0);
  return `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${fmtMinutes(minutes)}`;
}

// Draws month m's animal dots into the box (x, y, w, h), centred.
function drawAnimal(ctx, yr, m, x, y, w, h) {
  const { svg } = animalSvg(yr, m);
  const [, , vw, vh] = svg.getAttribute("viewBox").split(" ").map(Number);
  const k = Math.min(w / vw, h / vh);
  const ox = x + (w - vw * k) / 2, oy = y + (h - vh * k) / 2;
  for (const c of svg.querySelectorAll("circle")) {
    ctx.fillStyle = c.getAttribute("fill") || "#c9ccd1";
    ctx.beginPath();
    ctx.arc(ox + c.getAttribute("cx") * k, oy + c.getAttribute("cy") * k, c.getAttribute("r") * k, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFooter(ctx, W, cy) {
  const font = "Fredoka, system-ui, sans-serif";
  ctx.font = `500 30px ${font}`;
  const text = "ColorTracker";
  const tw = ctx.measureText(text).width;
  const logo = 30, gap = 12;
  const x0 = (W - (logo + gap + tw)) / 2;
  const r = 6.5, cols = ["#ff9e9e", "#9ef7f2", "#aef59a", "#d9b4ff"];
  cols.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x0 + r + (i % 2) * 15.5, cy - 8 + Math.floor(i / 2) * 15.5, r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#80868b";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x0 + logo + gap, cy);
}

const COPYRIGHT = () => `Copyright © ${new Date().getFullYear()} Sheet | Sleet Sheet Studio`;
$("#drawerCopyright").textContent = COPYRIGHT();   // same line as on the gallery image

// Logo + name, and the copyright line under it. cy = centre of the logo row.
function drawFooterBlock(ctx, W, cy) {
  drawFooter(ctx, W, cy);
  ctx.fillStyle = "#9aa0a6";
  ctx.font = "400 21px Fredoka, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(COPYRIGHT(), W / 2, cy + 46);
}

async function animalCanvas(months, withStats) {
  // Same font as the app's title (Fredoka). Wait until every weight used here is loaded.
  try { await Promise.all(["400 20px Fredoka", "500 40px Fredoka"].map((f) => document.fonts.load(f))); } catch { /* system font */ }
  const font = "Fredoka, system-ui, sans-serif";
  const INK = "#4a4a4a";   // same dark grey as the title
  const W = 1080, M = 70, GAP = 40, FOOT = 170;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  if (months.length === 1) {
    // One month: big animal, "November 2026", optional stats.
    const [y, m] = months[0];
    canvas.width = W; canvas.height = W;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, W);
    drawAnimal(ctx, y, m, 90, 130, W - 180, 560);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = INK; ctx.font = `500 58px ${font}`;
    ctx.fillText(`${MONTH_NAMES[m]} ${y}`, W / 2, 775);
    if (withStats) {
      ctx.fillStyle = "#80868b"; ctx.font = `400 34px ${font}`;
      ctx.fillText(monthStats(y, m), W / 2, 837);
    }
    drawFooterBlock(ctx, W, W - 110);
  } else {
    // Several months: one block per year (year heading on top), newest first like the Gallery.
    const groups = [];
    for (const [y, m] of months) {
      if (!groups.length || groups[groups.length - 1].year !== y) groups.push({ year: y, months: [] });
      groups[groups.length - 1].months.push(m);
    }
    const n = months.length;
    const cols = n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const cellW = (W - 2 * M - (cols - 1) * GAP) / cols;
    const animalH = cellW * 0.6;
    const labelSize = Math.round(Math.min(40, Math.max(20, cellW * 0.09)));
    const statSize = Math.round(labelSize * 0.68);
    const cellH = animalH + 14 + labelSize * 1.4 + (withStats ? statSize * 1.5 : 0);
    const YEAR_SIZE = 48, YEAR_H = 86, GROUP_GAP = 56;
    const blockH = (g) => { const rows = Math.ceil(g.months.length / cols); return YEAR_H + rows * cellH + (rows - 1) * GAP; };
    const contentH = groups.reduce((t, g) => t + blockH(g), 0) + (groups.length - 1) * GROUP_GAP;
    const H = Math.max(W, Math.ceil(M + contentH + FOOT));
    canvas.width = W; canvas.height = H;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    let top = M + Math.max(0, (H - FOOT - M - contentH) / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const g of groups) {
      ctx.fillStyle = INK; ctx.font = `500 ${YEAR_SIZE}px ${font}`;
      ctx.fillText(String(g.year), W / 2, top + YEAR_H / 2 - 10);
      const gy = top + YEAR_H;
      g.months.forEach((m, i) => {
        const r = Math.floor(i / cols), c = i % cols;
        const inRow = Math.min(cols, g.months.length - r * cols);   // centre a short last row
        const rowX = M + ((cols - inRow) * (cellW + GAP)) / 2;
        const x = rowX + c * (cellW + GAP), cy = gy + r * (cellH + GAP);
        drawAnimal(ctx, g.year, m, x, cy, cellW, animalH);
        ctx.fillStyle = INK; ctx.font = `500 ${labelSize}px ${font}`;
        ctx.fillText(MONTH_NAMES[m], x + cellW / 2, cy + animalH + 14 + labelSize * 0.7);
        if (withStats) {
          ctx.fillStyle = "#80868b"; ctx.font = `400 ${statSize}px ${font}`;
          ctx.fillText(monthStats(g.year, m), x + cellW / 2, cy + animalH + 14 + labelSize * 1.4 + statSize * 0.75);
        }
      });
      top += blockH(g) + GROUP_GAP;
    }
    drawFooterBlock(ctx, W, H - 110);
  }
  return canvas;
}

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

    const c = el("div", "wcol bb-solid" + (i < 6 ? " br-solid" : "") + (key === today ? " today" : ""));
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

  // Bottom row across the whole week, animal in the middle: this month's, or both if the week crosses a month.
  const strip = el("div", "week-animals");
  // Two animals: each hugs its outer edge (left one at the middle of Tue, right one at the middle of Sat).
  strip.classList.toggle("two", !sameMonth);
  strip.append(liveAnimal(start.getFullYear(), start.getMonth(), sameMonth ? "xMidYMid" : "xMinYMid"));
  if (!sameMonth) strip.append(liveAnimal(end.getFullYear(), end.getMonth(), "xMaxYMid"));
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

function neighbourCursor(dir) {
  const c = state.cursor;
  return state.view === "week" ? addDays(c, 7 * dir) : new Date(c.getFullYear(), c.getMonth() + dir, 1);
}

function step(dir) {
  state.cursor = neighbourCursor(dir);
  closePopover();
  render();
}

/* =========================================================
   Touch: drag the calendar sideways to see the next / previous month or week
   slide in, let go to switch (or it springs back). Can be switched off in Settings.
   ========================================================= */
const SWIPE_START = 12;      // px sideways before the calendar starts following the finger
const SWIPE_RATIO = 1.5;     // must be this much more sideways than up/down
const SWIPE_COMMIT = 0.25;   // share of the width to drag before it switches on release
const SWIPE_FLICK = 0.5;     // px per ms: a quick flick switches even if short
const SLIDE_MS = 350;        // finishing slide
const BACK_MS = 250;         // spring back
const SWIPE_KEY = "ct-swipe";   // "0" = swiping switched off in Settings
let swipe = null;
let swipeBusy = false;          // a slide is finishing

function swipeOn() { try { return localStorage.getItem(SWIPE_KEY) !== "0"; } catch { return true; } }
$("#swipeToggle").checked = swipeOn();
$("#swipeToggle").addEventListener("change", (e) => {
  try { localStorage.setItem(SWIPE_KEY, e.target.checked ? "1" : "0"); } catch { /* ignore */ }
});

// Renders the month/week next to the current one and returns it, leaving the current one as it was.
function buildNeighbour(dir) {
  const cal = $("#calendar");
  const current = cal.firstElementChild;
  const saved = { cursor: state.cursor, scroll: window.scrollY, title: $("#title").textContent, month: cal.dataset.month };
  state.cursor = neighbourCursor(dir);
  if (state.view === "week") renderWeek(); else renderMonth();
  const node = cal.firstElementChild;
  cal.replaceChildren(current);
  state.cursor = saved.cursor;
  $("#title").textContent = saved.title;
  if (saved.month === undefined) delete cal.dataset.month; else cal.dataset.month = saved.month;
  window.scrollTo(0, saved.scroll);
  return node;
}

function placePreview(s) {
  const cal = $("#calendar");
  if (s.preview) s.preview.remove();
  s.preview = buildNeighbour(s.dir);
  Object.assign(s.preview.style, {
    position: "absolute", top: `${s.cur.offsetTop}px`, left: `${s.cur.offsetLeft}px`,
    width: `${s.cur.offsetWidth}px`, pointerEvents: "none"
  });
  cal.append(s.preview);
}

// The incoming month/week is dimmed ("not active yet"): 40% at the start, up to 65% as you drag,
// and full strength only once it has switched.
const PREVIEW_DIM = 0.4, PREVIEW_NEAR = 0.65;
function setSwipeX(s, dx, ms = 0, landed = false) {
  const curve = "cubic-bezier(.2,.7,.2,1)";
  s.cur.style.transition = ms ? `transform ${ms}ms ${curve}` : "none";
  s.cur.style.transform = `translateX(${dx}px)`;
  if (s.preview) {
    const progress = Math.min(1, Math.abs(dx) / s.w);
    s.preview.style.transition = ms ? `transform ${ms}ms ${curve}, opacity ${ms}ms ease-out` : "none";
    s.preview.style.transform = `translateX(${dx + s.dir * s.w}px)`;
    s.preview.style.opacity = landed ? "1" : String(PREVIEW_DIM + (PREVIEW_NEAR - PREVIEW_DIM) * progress);
  }
}

function endSwipe(s, commit) {
  swipeBusy = true;
  const finish = () => {
    if (s.preview) s.preview.remove();
    s.cur.style.transition = s.cur.style.transform = "";
    swipeBusy = false;
    if (commit) step(s.dir);
  };
  setSwipeX(s, commit ? -s.dir * s.w : 0, commit ? SLIDE_MS : BACK_MS, commit);
  setTimeout(finish, (commit ? SLIDE_MS : BACK_MS) + 20);
}

$("#calendar").addEventListener("pointerdown", (e) => {
  const mouse = e.pointerType === "mouse";   // computers: click and drag sideways, like a finger swipe
  if ((e.pointerType !== "touch" && !mouse) || (mouse && e.button !== 0) || !swipeOn() || swipeBusy) return;
  if (mouse && e.target.closest("button, a, input")) return;
  if (swipe) { if (swipe.tracking) endSwipe(swipe, false); swipe = null; return; }   // a second finger: not a swipe
  if (!e.isPrimary || e.target.closest("[data-drag]")) return;   // squares are for dragging / flicking
  swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, tracking: false, dir: 0, preview: null,
            lastX: e.clientX, lastT: e.timeStamp, vx: 0, mouse };
});

$("#calendar").addEventListener("pointermove", (e) => {
  const s = swipe;
  if (!s || e.pointerId !== s.id) return;
  const dx = e.clientX - s.x, dy = e.clientY - s.y;
  if (!s.tracking) {
    if ((multi && multi.max > 1) || drag) { swipe = null; return; }
    if (Math.abs(dy) > SWIPE_START && Math.abs(dy) >= Math.abs(dx)) { swipe = null; return; }   // scrolling up/down
    if (Math.abs(dx) < SWIPE_START || Math.abs(dx) < SWIPE_RATIO * Math.abs(dy)) return;
    const cal = $("#calendar");
    s.cur = cal.firstElementChild;
    if (!s.cur) { swipe = null; return; }
    s.tracking = true;
    s.w = cal.clientWidth;
    if (s.mouse) {   // keep following the mouse even if it leaves the calendar
      try { cal.setPointerCapture(s.id); } catch { /* ignore */ }
      document.body.classList.add("mouse-swiping");
    }
    closePopover();
  }
  const dir = dx < 0 ? 1 : -1;   // finger to the left = next
  if (dir !== s.dir) { s.dir = dir; placePreview(s); }
  const dt = e.timeStamp - s.lastT;
  if (dt > 0) s.vx = 0.7 * ((e.clientX - s.lastX) / dt) + 0.3 * s.vx;
  s.lastX = e.clientX; s.lastT = e.timeStamp;
  setSwipeX(s, dx);
});

$("#calendar").addEventListener("pointerup", (e) => {
  const s = swipe;
  if (!s || e.pointerId !== s.id) return;
  swipe = null;
  document.body.classList.remove("mouse-swiping");
  if (!s.tracking) return;
  const dx = e.clientX - s.x;
  const far = Math.abs(dx) > SWIPE_COMMIT * s.w;
  const flick = Math.abs(s.vx) > SWIPE_FLICK && Math.sign(s.vx) === Math.sign(dx);
  endSwipe(s, (far || flick) && !document.querySelector("dialog[open]"));
});

/* ---------- Week numbers: the arrow above them hides / shows them (phones: double-tapping them works too) ---------- */
const HIDE_WK_KEY = "ct-hide-weeknos";
const isPhone = () => window.matchMedia("(pointer: coarse)").matches;
function applyWeekNos() {
  let hide = false;
  try { hide = localStorage.getItem(HIDE_WK_KEY) === "1"; } catch { /* ignore */ }
  $("#calendar").classList.toggle("no-wk", hide);
}
applyWeekNos();

// The numbers slide up into the arrow (hide) or back down out of it (show).
const WK_MS = 260;
let wkBusy = false;
function wkAnimTargets() {
  let tog = $("#calendar .wk-toggle");
  if (tog && !tog.offsetWidth) tog = $("#calendar .wk-lbl");   // phones have no arrow: fly into the "Week" label
  if (!tog) return null;
  const t = tog.getBoundingClientRect();
  const ty = t.top + t.height / 2, tx = t.left + t.width / 2;
  return [...document.querySelectorAll("#calendar .cal .wkno")].filter((n) => n.textContent).map((n) => {
    const r = n.getBoundingClientRect();
    return { n, dx: tx - (r.left + r.width / 2), dy: ty - (r.top + r.height / 2) };
  });
}
function toggleWeekNos() {
  if (wkBusy) return;
  const hide = !$("#calendar").classList.contains("no-wk");
  try { localStorage.setItem(HIDE_WK_KEY, hide ? "1" : "0"); } catch { /* ignore */ }
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finish = () => {
    applyWeekNos();
    renderCalendar();   // rows / animal re-fit to the new width
    if (!hide && !reduce) {
      $("#calendar .wk-toggle svg")?.animate([{ transform: "rotate(-90deg)" }, { transform: "none" }], { duration: WK_MS, easing: "ease" });
      for (const { n, dx, dy } of wkAnimTargets() || []) {
        n.animate([{ transform: `translate(${dx}px, ${dy}px) scale(.3)`, opacity: 0 }, { transform: "none", opacity: 1 }],
          { duration: WK_MS, easing: "cubic-bezier(.2,.8,.3,1)" });
      }
    }
  };
  if (!hide || reduce) return finish();
  wkBusy = true;
  const items = wkAnimTargets() || [];
  const tog = $("#calendar .wk-toggle");
  if (tog) tog.classList.add("turning");
  for (const { n, dx, dy } of items) {
    n.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.3)`, opacity: 0 }],
      { duration: WK_MS, easing: "cubic-bezier(.5,0,.8,.4)", fill: "forwards" });
  }
  $("#calendar .wk-word")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: WK_MS * 0.6, fill: "forwards" });
  setTimeout(() => { wkBusy = false; finish(); }, WK_MS);
}
$("#calendar").addEventListener("click", (e) => {
  if (e.target.closest(".wk-toggle")) toggleWeekNos();
});

let tapStart = null, lastTap = null;
$("#calendar").addEventListener("pointerdown", (e) => {
  tapStart = e.pointerType === "touch" && e.isPrimary ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
});
$("#calendar").addEventListener("pointerup", (e) => {
  const s = tapStart;
  tapStart = null;
  if (!s || e.pointerType !== "touch" || !isPhone()) return;
  if (e.timeStamp - s.t > 300 || Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) { lastTap = null; return; }   // not a tap
  if (e.target.closest("[data-drag], button, a, input") || (multi && multi.max > 1)) { lastTap = null; return; }
  if (!e.target.closest(".wknos, .wk-lbl")) { lastTap = null; return; }   // only the week column
  if (lastTap && e.timeStamp - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
    lastTap = null;
    toggleWeekNos();
    return;
  }
  lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
});

$("#calendar").addEventListener("pointercancel", (e) => {
  const s = swipe;
  if (!s || e.pointerId !== s.id) return;
  swipe = null;
  document.body.classList.remove("mouse-swiping");
  if (s.tracking) endSwipe(s, false);
});

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
  if (pop && !e.target.closest("#popover") && !e.target.closest("dialog") && !e.target.closest("[data-drag]") && !e.target.closest("#userBtn") && !e.target.closest(".gallery-card")) closePopover();
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

// Mouse pointer while dragging: the grey arrow with a dot in the dragged activity's colour.
function dragCursor(color) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='27' height='27' viewBox='0 0 36 36'>` +
    `<path d='M5 3.5 L5 24 Q5 25.6 6.4 24.8 L11 20.6 L14.6 28.2 Q15.2 29.4 16.4 28.8 L18.6 27.8 Q19.8 27.2 19.2 26 L15.6 18.6 L22.2 18.4 Q23.8 18.3 22.7 17.1 L6.7 2.6 Q5 1.3 5 3.5 Z' fill='#4a4a4a' stroke='#fff' stroke-width='2' stroke-linejoin='round'/>` +
    `<circle cx='28.6' cy='26.5' r='5.9' fill='${color}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 4 2, grabbing`;
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

  document.body.style.setProperty("--c-drag", dragCursor(dragColor()));
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
  // Dragging near the bottom / just under the pinned top scrolls the page.
  const pageTop = $("#appTop").getBoundingClientRect().bottom;
  if (document.documentElement.scrollHeight > window.innerHeight) {
    if (drag.y > window.innerHeight - 48) { window.scrollBy(0, 9); updateTarget(); }
    else if (drag.y < pageTop + 48 && drag.y > pageTop - 80) { window.scrollBy(0, -9); updateTarget(); }
  }
  drag.ghost.style.transform = ghostTransform(drag);
  drag.raf = requestAnimationFrame(tick);
}

/* ---------- Reordering dots: drag a dot sideways within the top row ---------- */
function overDotRow(d) {
  const r = $("#dotsBar").getBoundingClientRect();
  return d.kind === "activity" && d.fromDot && d.y >= r.top - 12 && d.y <= r.bottom + 12;
}
// Moves elements in a container and animates everyone sliding to their new places.
function flipMove(box, mutate) {
  const before = new Map([...box.children].map((c) => [c, c.getBoundingClientRect().left]));
  mutate();
  for (const c of box.children) {
    const dx = (before.get(c) ?? c.getBoundingClientRect().left) - c.getBoundingClientRect().left;
    if (dx) c.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 180, easing: "ease-out" });
  }
}
function dotOrder() { return [...$("#dots").children].map((c) => c.dataset.id); }
function setDotOrder(ids) {
  const box = $("#dots");
  flipMove(box, () => ids.forEach((id) => { const c = box.querySelector(`[data-id="${id}"]`); if (c) box.append(c); }));
}
function previewReorder() {
  const box = $("#dots");
  if (!box.contains(drag.el)) drag.el = box.querySelector(`[data-id="${drag.id}"]`) || drag.el;   // row was redrawn
  if (!drag.origOrder) drag.origOrder = dotOrder();
  drag.el.classList.add("reorder-slot");
  const others = [...box.children].filter((c) => c !== drag.el);
  let idx = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = others[i].getBoundingClientRect();
    if (drag.x < r.left + r.width / 2) { idx = i; break; }
  }
  if (idx !== [...box.children].indexOf(drag.el)) {
    flipMove(box, () => box.insertBefore(drag.el, others[idx] || null));
    vibrate(4);
  }
  // Near the row's ends: scroll it one dot at a time so dots further along can be reached.
  const br = box.getBoundingClientRect();
  const now = performance.now();
  if (!drag.lastRowScroll || now - drag.lastRowScroll > 380) {
    if (drag.x > br.right - 24 && box.scrollLeft + box.clientWidth < box.scrollWidth - 2) { box.scrollBy({ left: dotStep() }); drag.lastRowScroll = now; }
    else if (drag.x < br.left + 24 && box.scrollLeft > 2) { box.scrollBy({ left: -dotStep() }); drag.lastRowScroll = now; }
  }
}
function endReorderPreview(d, keep) {
  if (!d.origOrder) return;
  const el = $("#dots").querySelector(`[data-id="${d.id}"]`);
  if (el) el.classList.remove("reorder-slot");
  if (!keep) setDotOrder(d.origOrder);
}

function updateTarget() {
  if (overDotRow(drag)) {   // over the top row: reorder instead of aiming at a day
    if (drag.target) { drag.target.classList.remove("drop-target"); drag.target = null; }
    drag.reordering = true;
    previewReorder();
    return;
  }
  if (drag.reordering) {    // left the row again: put the dots back for now
    drag.reordering = false;
    endReorderPreview(drag, false);
    drag.origOrder = null;
  }
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
  document.body.style.removeProperty("--c-drag");
  return d;
}

// Cancels a drag that never started (or an Escape), with no animation.
function cancelDrag() {
  if (!drag) return;
  const d = takeDrag();
  endReorderPreview(d, false);
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

  // Let go inside the top row: keep the new dot order.
  if (d.reordering) {
    const ids = dotOrder();
    endReorderPreview(d, true);
    if (ids.join() !== d.origOrder.join()) reorderActivities(ids);
    return springBack(d);
  }
  endReorderPreview(d, false);

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
    if (!document.querySelector("dialog[open]")) closePopover();   // Esc in a question only closes the question
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
  <div class="pop-actions spread">
    <button class="trash-btn" data-act="delactivity" aria-label="Delete activity"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg></button>
    <button class="btn small" data-act="edit">Edit</button>
  </div>`;

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
        <div class="pop-actions">
          <button class="btn small" data-act="dlmonth">Download image</button>
          <button class="btn small" data-act="gotomonth">Go to month</button>
        </div>`;
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
      const privacy = `<button class="why-link pop-privacy" data-act="privacy">Privacy &amp; sign-in info</button>`;
      const trash = `<button class="trash-btn" data-act="danger" aria-label="Delete user and all data"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg></button>`;
      if (isGuest()) {
        popEl.innerHTML = `<p class="pop-email pop-guest">User not logged in</p>` +
          `<p class="pop-note">Your data is automatically saved on this device only and doesn't sync. <b class="pop-days"></b></p>` +
          `<div class="pop-acct"><button class="btn primary" data-act="login">Save my data</button>${trash}</div>` + privacy;
      } else {
        popEl.innerHTML = `<p class="pop-email"></p><div class="pop-acct"><button class="btn" data-act="signout">Sign out</button>${trash}</div>` + privacy;
        popEl.querySelector(".pop-email").textContent = state.user ? userEmail(state.user) : "";
      }
      const daysEl = popEl.querySelector(".pop-days");
      if (daysEl) {
        const left = guestDaysLeft();
        daysEl.textContent = left === null ? "" : left <= 0 ? "Deleted today." : left === 1 ? "Deleted in 1 day." : `Deleted in ${left} days.`;
        daysEl.classList.toggle("urgent", left !== null && left <= 3);
      }
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
  if (btn.dataset.act === "login") { closePopover(); closeDrawer(); return showSignin(true); }
  if (btn.dataset.act === "danger") { closePopover(); return openDanger(); }
  if (btn.dataset.act === "privacy") { closePopover(); return $("#whyDialog").showModal(); }
  if (btn.dataset.act === "edit") { const id = pop.id; closePopover(); return openActivityDialog(id); }
  // The info popup stays open behind the question and closes only if the delete goes ahead.
  if (btn.dataset.act === "delactivity") return requestDeleteActivity(pop.id, () => closePopover());
  if (btn.dataset.act === "dlmonth") return askImage([[pop.y, pop.m]], `colortracker-${pop.y}-${pad(pop.m + 1)}.jpg`, `${MONTH_NAMES[pop.m]} ${pop.y}`);
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
  resizeTimer = setTimeout(() => { if (state.user) { renderCalendar(); fitDots(); } }, 150);
});

/* =========================================================
   Add / edit activity dialog
   ========================================================= */
const dlg = $("#activityDialog");
let editingId = null;

function openActivityDialog(id) {
  editingId = id || null;
  const a = id ? state.activities.get(id) : null;
  $("#dialogTitle").textContent = a ? "Edit activity" : "New activity";
  $("#actName").value = a ? a.name : "";
  $("#actMinutes").value = boxDuration(a ? a.defaultMinutes || 30 : 30);
  $("#actColor").value = a ? a.color : autoColor();
  const delBtn = $("#deleteActivityBtn");
  delBtn.classList.toggle("hidden", !a);
  updatePreview();
  dlg.showModal();
  if (window.matchMedia("(hover: hover)").matches) setTimeout(() => $("#actName").focus(), 0);
}

// The shade circles double as quick buttons for the default length.
function updatePreview() {
  const color = $("#actColor").value;
  const current = parseDuration($("#actMinutes").value);
  const box = $("#colorPreview");
  box.innerHTML = "";
  for (const [m, label] of (state.lengths || DEFAULT_LENGTHS).map((m) => [m, fmtMinutes(m)])) {
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
  $("#actMinutes").value = boxDuration(Number(b.dataset.min));
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
  let minutes = parseDuration($("#actMinutes").value);   // "90", "1:30", "2h"…
  if (!minutes) minutes = 30;
  minutes = Math.min(600, minutes);
  const color = $("#actColor").value;
  dlg.close();
  if (editingId) updateActivity(editingId, { name, defaultMinutes: minutes, color });
  else createActivity({ name, defaultMinutes: minutes, color, createdAt: Date.now() });
});

$("#deleteActivityBtn").addEventListener("click", () => {
  // The edit window stays open behind the question, and closes only if the delete goes ahead.
  requestDeleteActivity(editingId, () => dlg.close());
});

/* ---------- Deleting an activity: always asks; a tick box decides whether its logged sessions go too ---------- */
const confirmDlg = $("#confirmDeleteDialog");
let pendingDelete = null;   // { id, before }

async function requestDeleteActivity(id, before) {
  if (!state.activities.has(id) || !needOnline("delete an activity")) return;
  const list = await activitySessions(id);   // includes months that aren't loaded
  if (!state.activities.has(id)) return;
  const n = list.length;
  pendingDelete = { id, before, list };
  $("#cdTitle").textContent = `Delete ${actName(id)}?`;
  $("#cdSessionsText").textContent = `Also delete its ${n} session${n === 1 ? "" : "s"} from the calendar`;
  $("#cdSessionsRow").classList.toggle("hidden", !n);   // nothing logged: nothing to ask
  $("#cdDeleteSessions").checked = true;
  confirmDlg.returnValue = "";
  confirmDlg.showModal();
}
confirmDlg.addEventListener("close", () => {
  const p = pendingDelete;
  pendingDelete = null;
  if (!p || confirmDlg.returnValue !== "accept") return;
  const keep = p.list.length > 0 && !$("#cdDeleteSessions").checked;
  if (p.before) p.before();
  const name = actName(p.id);
  if (keep) hideActivity(p.id); else deleteActivity(p.id, p.list);
  toast(keep ? `Removed ${name} (sessions kept)` : `Deleted ${name}`);
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

// Installed on an iPhone/iPad. Depending on the iOS version, the app either starts below the status bar
// (then only a small gap is needed) or runs underneath it (then the top needs the status bar's height).
// It's underneath when the app's visible height is the whole screen height.
function checkStatusBar() {
  const portrait = window.innerHeight >= window.innerWidth;
  const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  document.documentElement.classList.toggle("ios-under-bar", screenH - window.innerHeight < 20);
}
if (isIOS && isInstalled()) {
  document.documentElement.classList.add("ios-app");
  checkStatusBar();
  window.addEventListener("resize", checkStatusBar);
}

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
  const blob = text instanceof Blob ? text : new Blob([text], { type });
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

// Backup, CSV and restore need the whole history, not just the loaded months.
async function withAllSessions() {
  if (!allSessions) toast("Loading all sessions…");
  await loadAllSessions();
}

/* ---------- Settings: your own session length buttons (synced through Firebase) ---------- */
const DEFAULT_LENGTHS = [15, 30, 45, 60, 120];
function validLengths(v) {
  return Array.isArray(v) && v.length === 5 && v.every((m) => Number.isInteger(m) && m >= 1 && m <= 600) ? v.slice() : null;
}
function renderLengthInputs() {
  const grid = $("#lenInputs");
  const lengths = state.lengths || DEFAULT_LENGTHS;
  if (grid.children.length !== 10) {
    grid.innerHTML = "";
    lengths.forEach((_, i) => {
      const id = `len${i}`;
      const lab = el("label", "", `Time ${i + 1}:`);
      lab.htmlFor = id;
      const inp = el("input");
      inp.id = id; inp.type = "text"; inp.autocomplete = "off"; inp.dataset.i = i;
      grid.append(lab, inp);
    });
  }
  grid.querySelectorAll("input").forEach((inp) => {
    if (document.activeElement !== inp) { inp.value = boxDuration(lengths[inp.dataset.i]); inp.classList.remove("bad"); }
  });
}
function saveLengths(lengths) {
  state.lengths = lengths;
  setDoc(docRef("settings", "prefs"), { lengths }, { merge: true }).catch(onDbError);
  if (dlg.open) updatePreview();
}
$("#lenInputs").addEventListener("input", (e) => {
  const inp = e.target.closest("input");
  if (inp) inp.classList.toggle("bad", inp.value.trim() !== "" && !(parseDuration(inp.value) <= 600));
});
$("#lenInputs").addEventListener("change", (e) => {
  const inp = e.target.closest("input");
  if (!inp || !state.user) return;
  const lengths = (state.lengths || DEFAULT_LENGTHS).slice();
  const m = parseDuration(inp.value);
  if (m && m <= 600) {
    lengths[inp.dataset.i] = m;
    saveLengths(lengths);
  } else if (inp.value.trim()) {
    toast("Use minutes (90) or hours:minutes (1:30), up to 10 h.");
  }
  inp.value = boxDuration(lengths[inp.dataset.i]);   // tidy, or back to the previous value
  inp.classList.remove("bad");
});
$("#lenInputs").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
$("#lenReset").addEventListener("click", () => {
  if (!state.user) return;
  saveLengths(DEFAULT_LENGTHS.slice());
  renderLengthInputs();
  toast("Session length buttons reset.");
});
renderLengthInputs();

/* ---------- Menu: save the whole history on this device for offline use ---------- */
const offlineKey = () => `ct-offline-saved-${state.user ? state.user.uid : ""}`;
function fmtWhen(t) {
  const d = new Date(t), now = new Date();
  const hm = `${d.getHours()}:${pad(d.getMinutes())}`;
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear() === now.getFullYear() ? "" : d.getFullYear()} ${hm}`;
}
function showOfflineInfo() {
  let t = null;
  try { t = localStorage.getItem(offlineKey()); } catch { /* ignore */ }
  $("#offlineInfo").textContent = t ? `Last saved on this device: ${fmtWhen(Number(t))}` : "Not saved on this device yet.";
}
const waitFor = (test, ms) => new Promise((resolve) => {
  const start = Date.now();
  (function check() { if (test() || Date.now() - start > ms) resolve(test()); else setTimeout(check, 150); })();
});
$("#offlineBtn").addEventListener("click", async () => {
  if (!needUser()) return;
  if (!navigator.onLine) return toast("You're offline. Connect to the internet to save all data.");
  const btn = $("#offlineBtn");
  btn.disabled = true;
  toast("Saving all data…");
  await loadAllSessions();
  const ok = await waitFor(() => fullHistory, 10000);   // wait for the server's answer, not just the device copy
  btn.disabled = false;
  if (!ok) return toast("Couldn't reach the server. Please try again.");
  try { localStorage.setItem(offlineKey(), String(Date.now())); } catch { /* ignore */ }
  showOfflineInfo();
  const n = state.sessions.size;
  toast(`All ${n} session${n === 1 ? "" : "s"} saved on this device for offline use.`);
});

// Things that need the whole history can't be done offline (unless it's already all on the device):
// shows a message at the bottom and returns false.
function needOnline(what) {
  if (navigator.onLine || fullHistory) return true;
  toast(`You're offline. Connect to the internet to ${what}.`);
  return false;
}

$("#backupBtn").addEventListener("click", async () => {
  if (!needUser() || !needOnline("make a complete backup")) return;
  await withAllSessions();
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

$("#csvBtn").addEventListener("click", async () => {
  if (!needUser() || !needOnline("export all sessions")) return;
  await withAllSessions();
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
  if (!needUser() || !needOnline("restore a backup")) return;
  withAllSessions();   // "replace" needs to know every current session
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

$("#restoreGo").addEventListener("click", async () => {
  if (!pendingRestore || !state.user) return;
  await withAllSessions();
  if (!pendingRestore) return;
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
// ms = 0: the message stays until closed with its × (used for the offline message).
function toast(message, ms = 2600) {
  const t = $("#toast");
  t.replaceChildren(el("span", "toast-text", message));
  t.classList.toggle("sticky", !ms);
  if (!ms) {
    const x = el("button", "toast-close", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", hideToast);
    t.append(x);
  }
  t.classList.remove("hidden");
  if (t.showPopover) {   // re-open on top of any open window
    try { if (t.matches(":popover-open")) t.hidePopover(); t.showPopover(); } catch { /* older browser: normal toast */ }
  }
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  const t = $("#toast");
  clearTimeout(toastTimer);
  t.classList.add("hidden");
  try { if (t.matches(":popover-open")) t.hidePopover(); } catch { /* ignore */ }
}
