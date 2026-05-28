import { useState, useEffect, useRef, useCallback } from "react";

// ══════════════════════════════════════════════════════════════
// FIREBASE SETUP
// ══════════════════════════════════════════════════════════════
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  writeBatch,
  getDocs,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDPelgeAqP726-sZRKBFEhjw7rcyOfk9Fk",
  authDomain: "qurban-app-1f8b7.firebaseapp.com",
  projectId: "qurban-app-1f8b7",
  storageBucket: "qurban-app-1f8b7.firebasestorage.app",
  messagingSenderId: "216486969169",
  appId: "1:216486969169:web:93bdd5b329483391c81d70",
  measurementId: "G-HY9GT50DK0",
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ── Firestore collection helpers ──────────────────────────────
// Each data type maps to a Firestore collection.
// Documents use the item's `id` field as the document ID.
const COL = {
  hewan:    "qurban_hewan",
  mudhohi:  "qurban_mudhohi",
  mustahiq: "qurban_mustahiq",
  sesi:     "qurban_sesi",
  panitia:  "qurban_panitia",
  config:   "qurban_config",
};

// Write a single item to Firestore (upsert by item.id).
async function fsSet(colName, item) {
  if (!item?.id) return;
  try {
    await setDoc(doc(db, colName, item.id), item);
  } catch (e) {
    console.warn("fsSet failed", colName, e);
  }
}

// Delete a single document from Firestore.
async function fsDel(colName, id) {
  if (!id) return;
  try {
    await deleteDoc(doc(db, colName, id));
  } catch (e) {
    console.warn("fsDel failed", colName, e);
  }
}

// Replace an entire collection with a new array (batch write).
async function fsReplaceAll(colName, items) {
  try {
    // Delete all existing docs first.
    const snap = await getDocs(collection(db, colName));
    const batch = writeBatch(db);
    snap.forEach(d => batch.delete(d.ref));
    (items || []).forEach(item => {
      if (item?.id) batch.set(doc(db, colName, item.id), item);
    });
    await batch.commit();
  } catch (e) {
    console.warn("fsReplaceAll failed", colName, e);
  }
}

// Subscribe to a collection and call cb(array) on every change.
// Returns an unsubscribe function.
function fsSubscribe(colName, cb) {
  return onSnapshot(collection(db, colName), snap => {
    const items = snap.docs.map(d => d.data());
    cb(items);
  }, err => console.warn("fsSubscribe error", colName, err));
}

// ── Diff-aware Firestore sync helpers ─────────────────────────
// These compare prev vs next arrays and only write changed/added
// items and delete removed items, avoiding full re-writes.
function fsSync(colName, prevArr, nextArr) {
  const prevMap = Object.fromEntries((prevArr || []).map(x => [x.id, x]));
  const nextMap = Object.fromEntries((nextArr || []).map(x => [x.id, x]));
  // Upsert changed / new items.
  for (const [id, item] of Object.entries(nextMap)) {
    if (JSON.stringify(prevMap[id]) !== JSON.stringify(item)) {
      fsSet(colName, item);
    }
  }
  // Delete removed items.
  for (const id of Object.keys(prevMap)) {
    if (!nextMap[id]) fsDel(colName, id);
  }
}

// ══════════════════════════════════════════════════════════════
// CONSTANTS & UTILS
// ══════════════════════════════════════════════════════════════
const STATUS_FLOW = ["Menunggu", "Disembelih", "Dikuliti", "Selesai"];
const JENIS_HEWAN = ["Sapi", "Kambing", "Domba"];
const KAPASITAS_DEFAULT = { Sapi: 7, Kambing: 1, Domba: 1 };

// ── Password hashing ─────────────────────────────────────────
// BR-AUTH-02
//
// SECURITY: The previous implementation embedded `btoa(reverse(password))`
// in the stored hash, making passwords trivially reversible. It has been
// replaced with PBKDF2-SHA256 (100k iterations) + per-user random salt
// via the Web Crypto API.
//
// Legacy hashes (prefix "H$") are still accepted for backward compatibility
// so existing seed/storage data keeps working, and `verifyPassword` reports
// them via `needsRehash` so callers can transparently migrate on next login.

const _hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const _hexToBytes = (hex) =>
  new Uint8Array(hex.match(/.{1,2}/g)?.map((h) => parseInt(h, 16)) || []);

// Legacy (insecure, kept only for seed init + backward verification).
function legacyHashPassword(pass) {
  let h = 0;
  for (let i = 0; i < pass.length; i++) {
    h = (Math.imul(31, h) + pass.charCodeAt(i)) | 0;
  }
  return (
    "H$" +
    Math.abs(h).toString(36) +
    "$" +
    btoa(pass.split("").reverse().join("")).slice(0, 8)
  );
}

const PBKDF2_ITER = 100000;

async function hashPassword(pass) {
  if (typeof pass !== "string") pass = String(pass ?? "");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pass),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    key,
    256
  );
  return `P2$${PBKDF2_ITER}$${_hex(salt)}$${_hex(bits)}`;
}

// Constant-time string compare (length-safe).
function _ctEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(pass, stored) {
  if (typeof stored !== "string" || !stored) return { ok: false, needsRehash: false };
  if (stored.startsWith("P2$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return { ok: false, needsRehash: false };
    const iterations = Number(parts[1]) || PBKDF2_ITER;
    const salt = _hexToBytes(parts[2]);
    const expected = parts[3];
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(pass),
        "PBKDF2",
        false,
        ["deriveBits"]
      );
      const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        key,
        256
      );
      return { ok: _ctEqual(_hex(bits), expected), needsRehash: iterations < PBKDF2_ITER };
    } catch {
      return { ok: false, needsRehash: false };
    }
  }
  // Legacy hash — accept once, then mark for re-hash.
  return { ok: legacyHashPassword(pass) === stored, needsRehash: true };
}

// ── Generate UUID ─────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Timestamp ISO ─────────────────────────────────────────────
const now = () => new Date().toISOString();

// ── localStorage helpers ──────────────────────────────────────
function loadStorage(key, fallback) {
  // localStorage hanya untuk preferensi lokal (tema, dll).
  // Data utama diambil dari Firestore via onSnapshot.
  try {
    const r = localStorage.getItem(key);
    if (r === null || r === undefined) return fallback;
    const parsed = JSON.parse(r);
    if (parsed === null || parsed === undefined) return fallback;
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    if (
      fallback !== null &&
      typeof fallback === "object" &&
      !Array.isArray(fallback) &&
      (typeof parsed !== "object" || Array.isArray(parsed))
    ) return fallback;
    return parsed;
  } catch { return fallback; }
}
function saveStorage(key, value) {
  // Dipertahankan agar kode theme/config tidak error.
  // Data utama tidak disimpan di localStorage.
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) {
    if (typeof console !== "undefined") console.warn("saveStorage failed for", key, e);
  }
}

// ── sessionStorage / localStorage session ────────────────────
function loadSession() {
  try {
    const raw = sessionStorage.getItem("qurban_session") || localStorage.getItem("qurban_session_remember");
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object" || !s.panitiaId) return null;
    if (s.expiredAt && new Date(s.expiredAt) < new Date()) {
      sessionStorage.removeItem("qurban_session");
      localStorage.removeItem("qurban_session_remember");
      return null;
    }
    return s;
  } catch { return null; }
}
function saveSession(session, remember) {
  if (remember) {
    const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem("qurban_session_remember", JSON.stringify({ ...session, expiredAt: exp }));
  } else {
    sessionStorage.setItem("qurban_session", JSON.stringify(session));
  }
}
function clearSession() {
  sessionStorage.removeItem("qurban_session");
  localStorage.removeItem("qurban_session_remember");
}

// ── Fonnte WA sender ──────────────────────────────────────────
async function sendWA(token, target, message) {
  if (!token) return { status: false, reason: "Token belum diset" };
  if (!target) return { status: false, reason: "Nomor tujuan kosong" };
  try {
    const res = await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: { Authorization: token },
      body: new URLSearchParams({ target, message: message || "", countryCode: "62" }),
    });
    try { return await res.json(); }
    catch { return { status: res.ok, reason: res.ok ? undefined : `HTTP ${res.status}` }; }
  } catch (e) { return { status: false, reason: e?.message || "Gagal kirim" }; }
}
async function sendWAWithImage(token, target, message, imageBase64) {
  if (!token) return { status: false, reason: "Token belum diset" };
  if (!target) return { status: false, reason: "Nomor tujuan kosong" };
  try {
    // Use FormData (multipart) — URLSearchParams is unreliable for the
    // multi-MB base64 payloads produced by FileReader.
    const form = new FormData();
    form.append("target", target);
    form.append("message", message || "");
    form.append("countryCode", "62");
    if (imageBase64) form.append("file", imageBase64);
    const res = await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: { Authorization: token },
      body: form,
    });
    try { return await res.json(); }
    catch { return { status: res.ok, reason: res.ok ? undefined : `HTTP ${res.status}` }; }
  } catch (e) { return { status: false, reason: e?.message || "Gagal kirim" }; }
}



// ══════════════════════════════════════════════════════════════
// INITIAL DATA — Admin account only. No dummy data. (EC-13)
// ══════════════════════════════════════════════════════════════
const SEED_TIMESTAMP = new Date().toISOString();
const SEED_PANITIA = [
  {
    id: "USR_admin",
    nama: "Admin",
    username: "admin",
    passwordHash: legacyHashPassword("panitiaqurban2026"),
    role: "admin",
    status: "aktif",
    mustChangePassword: true,
    loginAttempts: 0,
    lockedUntil: null,
    createdAt: SEED_TIMESTAMP,
    createdBy: "SYSTEM",
    updatedAt: SEED_TIMESTAMP,
    updatedBy: "SYSTEM",
  },
];
const SEED_HEWAN = [];
const SEED_MUDHOHI = [];
const SEED_MUSTAHIQ = [];
const SEED_SESI = [];

// ══════════════════════════════════════════════════════════════
// COLOR & STYLES
// ══════════════════════════════════════════════════════════════

// Theme definitions
const THEMES = {
  dark: {
    bg:         "#0D0F0D",
    surface:    "#161A15",
    surfaceAlt: "#1C211B",
    border:     "#252E23",
    green:      "#4CAF50",
    greenDark:  "#1A2E1A",
    greenLight: "#81C784",
    gold:       "#C8960A",
    red:        "#E53935",
    orange:     "#F57C00",
    blue:       "#1E88E5",
    purple:     "#8E24AA",
    text:       "#D8EDD8",
    muted:      "#5A705A",
    white:      "#EEF5EE",
    inputBg:    "#0D0F0D",
  },
  light: {
    bg:         "#F0F4F0",
    surface:    "#FFFFFF",
    surfaceAlt: "#F5F8F5",
    border:     "#D0DAD0",
    green:      "#2E7D32",
    greenDark:  "#E8F5E9",
    greenLight: "#1B5E20",
    gold:       "#A67C00",
    red:        "#C62828",
    orange:     "#E65100",
    blue:       "#1565C0",
    purple:     "#6A1B9A",
    text:       "#1A261A",
    muted:      "#5A7A5A",
    white:      "#1A261A",
    inputBg:    "#F5F8F5",
  },
};

// Global theme state (mutable ref, updated by ThemeProvider)
let _currentTheme = (() => {
  try { return localStorage.getItem("qurban_theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
})();
let _themeListeners = [];

function getC() { return THEMES[_currentTheme]; }

// Proxy so existing code using C.xxx still works reactively via re-render
const C = new Proxy({}, {
  get(_, key) { return THEMES[_currentTheme][key]; }
});

function useTheme() {
  const [theme, setTheme] = useState(_currentTheme);
  useEffect(() => {
    const cb = (t) => setTheme(t);
    _themeListeners.push(cb);
    return () => { _themeListeners = _themeListeners.filter(x => x !== cb); };
  }, []);
  const toggle = (t) => {
    _currentTheme = t;
    try { localStorage.setItem("qurban_theme", t); } catch {}
    _themeListeners.forEach(cb => cb(t));
  };
  return [theme, toggle];
}
const STATUS_COLOR = { Menunggu: C.muted, Disembelih: C.red, Dikuliti: C.orange, Selesai: C.green };
const BAYAR_COLOR = { Lunas: C.green, "Belum Lunas": C.red, Cicilan: C.orange };
const JENIS_COLOR = { Sapi: C.gold, Kambing: C.green, Domba: C.purple };
const JENIS_EMOJI = { Sapi: "🐄", Kambing: "🐐", Domba: "🐑" };
const css = {
  get card() { return { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "16px 20px", marginBottom: 10 }; },
  get input() { return { background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 12px", color: C.text, fontSize: 15, width: "100%", boxSizing: "border-box", outline: "none" }; },
  get select() { return { background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 12px", color: C.text, fontSize: 15, width: "100%", boxSizing: "border-box" }; },
  btn: (bg, color = "#fff") => ({ background: bg, color, border: "none", borderRadius: 4, padding: "10px 16px", fontWeight: 600, cursor: "pointer", fontSize: 14, minHeight: 42, touchAction: "manipulation" }),
  get label() { return { fontSize: 11, color: C.muted, fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase", marginBottom: 5, display: "block" }; },
  badge: (color) => ({ background: color + "1A", border: `1px solid ${color}55`, color, padding: "2px 8px", borderRadius: 3, fontSize: 11, fontWeight: 700 }),
};

// ══════════════════════════════════════════════════════════════
// BASE UI COMPONENTS
// ══════════════════════════════════════════════════════════════
function Pill({ text, color }) { return <span style={css.badge(color)}>{text}</span>; }

function Btn({ children, color = C.green, onClick, style = {}, disabled = false }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ ...css.btn(disabled ? C.muted : color), ...style, opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>
      {children}
    </button>
  );
}

function Input({ label, value, onChange, type = "text", placeholder = "", onKeyDown, error = "", hint = "" }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={css.label}>{label}</label>}
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ ...css.input, borderColor: error ? C.red : C.border }} onKeyDown={onKeyDown} />
      {hint && !error && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{hint}</div>}
      {error && <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>⚠ {error}</div>}
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={css.label}>{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)} style={css.select}>
        {options.map(o => {
          const val = typeof o === "object" ? o.value : o;
          const lbl = typeof o === "object" ? o.label : o;
          return <option key={val} value={val}>{lbl}</option>;
        })}
      </select>
    </div>
  );
}

function Modal({ children, onClose, title }) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);
  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000099", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose && onClose(); }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "6px 6px 0 0", padding: "20px 20px 32px", width: "100%", maxWidth: 520, maxHeight: "92vh", overflowY: "auto", position: "relative" }}>
        <div style={{ width: 32, height: 3, background: C.border, borderRadius: 99, margin: "0 auto 16px" }} />
        {title && <h3 style={{ margin: "0 0 20px", color: C.white, fontSize: 17 }}>{title}</h3>}
        <button onClick={onClose} style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", color: C.muted, fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 4, minHeight: 44, minWidth: 44 }}>✕</button>
        {children}
      </div>
    </div>
  );
}

function Toast({ msg, type }) {
  if (!msg) return null;
  const isErr = type === "err";
  return (
    <div style={{ position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)", background: isErr ? C.surface : C.surface, border: `1px solid ${isErr ? C.red : C.green}`, borderLeft: `3px solid ${isErr ? C.red : C.green}`, borderRadius: 4, padding: "12px 18px", color: isErr ? C.red : C.green, fontSize: 13, zIndex: 200, boxShadow: "0 2px 12px #00000044", display: "flex", alignItems: "center", gap: 8, maxWidth: "calc(100vw - 32px)", whiteSpace: "pre-wrap", textAlign: "center" }}>
      {isErr ? "⚠️" : "✅"} {msg}
    </div>
  );
}

function ConfirmModal({ pesan, detail, onConfirm, onCancel, confirmLabel = "Ya, Hapus", confirmColor = C.red }) {
  return (
    <Modal onClose={onCancel}>
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
        <h3 style={{ margin: "0 0 10px", color: C.white }}>Konfirmasi</h3>
        <p style={{ color: C.muted, fontSize: 14, marginBottom: detail ? 8 : 24 }}>{pesan}</p>
        {detail && <p style={{ color: C.red, fontSize: 13, marginBottom: 24, background: C.red + "18", borderRadius: 4, padding: "8px 12px", border: `1px solid ${C.red}33` }}>{detail}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <Btn color={confirmColor} onClick={onConfirm} style={{ flex: 1 }}>{confirmLabel}</Btn>
          <Btn color={C.muted} onClick={onCancel} style={{ flex: 1 }}>Batal</Btn>
        </div>
      </div>
    </Modal>
  );
}

function ProgressBar({ value, max, color = C.green }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ height: 8, background: C.border, borderRadius: 99, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 99, transition: "width 0.4s" }} />
    </div>
  );
}

function SectionTitle({ emoji, title, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 24 }}>{emoji}</span>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.white }}>{title}</h2>
          {sub && <p style={{ margin: 0, fontSize: 13, color: C.muted, marginTop: 2 }}>{sub}</p>}
        </div>
      </div>
    </div>
  );
}

// ── AdminOnly wrapper (Section 5.4) ───────────────────────────
function AdminOnly({ session, children }) {
  if (session?.role !== "admin") return null;
  return children;
}

// ── Permission hook — semua aksi diizinkan (no login) ─────────
function usePermission() {
  return {
    canDelete: true,
    canResetStatus: true,
    canManageAccounts: true,
    canConfigWA: true,
    canExport: true,
    canEditLockedData: true,
    canVerifyRAB: true,
    canAdd: true,
    canEdit: true,
    canUpdateStatus: true,
    canSendWA: true,
    canTandaiAmbil: true,
  };
}

// ── isHewanTerkunci — selalu false (no login) ─────────────────
function isHewanTerkunci() { return false; }

// ══════════════════════════════════════════════════════════════
// LOGIN PAGE
// ══════════════════════════════════════════════════════════════
// BR-AUTH-01 ~ BR-AUTH-08
function LoginPage({ onLogin, panitiaList, setPanitiaList}) {
  const [username, setUsername] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [remember, setRemember] = useState(false);
  const [lockMsg, setLockMsg] = useState("");

  const [busy, setBusy] = useState(false);

  const handle = async () => {
    if (busy) return;
    if (!username.trim() || !pass.trim()) { setErr("Username dan password wajib diisi."); return; }

    const user = panitiaList.find(u => u.username === username.toLowerCase().trim());
    if (!user) { setErr("Username atau password salah."); return; }

    // BR-AUTH-03: akun nonaktif
    if (user.status === "nonaktif") {
      setErr("Akun Anda telah dinonaktifkan. Hubungi admin.");
      return;
    }

    // BR-AUTH-07: cek lockout
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      const sisa = Math.ceil((new Date(user.lockedUntil) - new Date()) / 60000);
      setLockMsg(`Akun terkunci. Coba lagi dalam ${sisa} menit.`);
      return;
    }

    setBusy(true);
    let result;
    try {
      result = await verifyPassword(pass, user.passwordHash);
    } catch {
      result = { ok: false, needsRehash: false };
    }

    if (!result.ok) {
      const attempts = (user.loginAttempts || 0) + 1;
      const locked = attempts >= 5;
      const lockedUntil = locked ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
      setPanitiaList(prev => prev.map(u => u.id === user.id ? { ...u, loginAttempts: attempts, lockedUntil } : u));
      setErr("Username atau password salah.");
      if (locked) setLockMsg("Akun dikunci 15 menit karena 5x gagal login.");
      setBusy(false);
      return;
    }

    // SECURITY: migrate legacy/weak hash to PBKDF2 transparently on success.
    let migratedHash = null;
    if (result.needsRehash) {
      try { migratedHash = await hashPassword(pass); } catch { /* keep legacy */ }
    }

    setPanitiaList(prev => prev.map(u => u.id === user.id
      ? { ...u, loginAttempts: 0, lockedUntil: null, ...(migratedHash ? { passwordHash: migratedHash } : {}) }
      : u));

    const session = {
      panitiaId: user.id,
      panitiaName: user.nama,
      role: user.role,
      loginAt: now(),
      token: uuid(),
      mustChangePassword: user.mustChangePassword || false,
      remember,
    };
    saveSession(session, remember);
    setBusy(false);
    onLogin(session);
  };

  const handleKey = (e) => { if (e.key === "Enter") handle(); };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 52, marginBottom: 8 }}>🕌</div>
          <h1 style={{ fontSize: 26, fontWeight: 900, color: C.white, margin: 0, letterSpacing: "-0.5px" }}>Qurban App</h1>
          <p style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>Sistem Manajemen Qurban Digital · {new Date().getFullYear()} M</p>
        </div>
        <div style={{ ...css.card, padding: 28 }}>
          <Input label="Username" value={username} onChange={v => { setUsername(v); setErr(""); setLockMsg(""); }} placeholder="Masukkan username" onKeyDown={handleKey} />
          <div style={{ marginBottom: 14 }}>
            <label style={css.label}>Password</label>
            <div style={{ position: "relative" }}>
              <input type={showPass ? "text" : "password"} value={pass} onChange={e => { setPass(e.target.value); setErr(""); }} placeholder="••••••••" style={{ ...css.input, paddingRight: 48 }} onKeyDown={handleKey} />
              <button onClick={() => setShowPass(v => !v)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14 }}>
                {showPass ? "🙈" : "👁"}
              </button>
            </div>
          </div>

          {/* BR-AUTH-06: Ingat saya */}
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer", fontSize: 13, color: C.muted }}>
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Ingat saya (7 hari)
          </label>

          {(err || lockMsg) && <div style={{ color: C.red, fontSize: 13, marginBottom: 12 }}>⚠️ {lockMsg || err}</div>}
          <Btn color={C.green} onClick={handle} disabled={busy} style={{ width: "100%", padding: "11px 0", fontSize: 14 }}>{busy ? "⏳ Memverifikasi..." : "Masuk →"}</Btn>

          <div style={{ marginTop: 14, textAlign: "center", fontSize: 12, color: C.muted }}>
            Hubungi admin jika lupa username atau password.
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// GANTI PASSWORD (BR-AUTH-08)
// ══════════════════════════════════════════════════════════════
function GantiPasswordModal({ session, setPanitiaList, onDone }) {
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");
  const [showPass1, setShowPass1] = useState(false);
  const [showPass2, setShowPass2] = useState(false);

  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    if (pass1.length < 6) { setErr("Password minimal 6 karakter."); return; }
    if (pass1 !== pass2) { setErr("Password tidak cocok."); return; }
    setBusy(true);
    let newHash;
    try {
      newHash = await hashPassword(pass1);
    } catch {
      setBusy(false);
      setErr("Gagal mengamankan password. Coba lagi.");
      return;
    }
    setPanitiaList(prev => prev.map(u =>
      u.id === session.panitiaId
        ? { ...u, passwordHash: newHash, mustChangePassword: false, loginAttempts: 0, lockedUntil: null, updatedAt: now(), updatedBy: session.panitiaId }
        : u
    ));
    setBusy(false);
    onDone();
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ ...css.card, padding: 28 }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 36 }}>🔑</div>
            <h2 style={{ color: C.white, margin: "8px 0 4px" }}>Ganti Password</h2>
            <p style={{ color: C.muted, fontSize: 13 }}>Wajib ganti password sebelum melanjutkan.</p>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={css.label}>Password Baru</label>
            <div style={{ position: "relative" }}>
              <input type={showPass1 ? "text" : "password"} value={pass1} onChange={e => setPass1(e.target.value)} placeholder="••••••••" style={{ ...css.input, paddingRight: 48 }} />
              <button onClick={() => setShowPass1(v => !v)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, minHeight: 36, minWidth: 36 }}>
                {showPass1 ? "🙈" : "👁"}
              </button>
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={css.label}>Konfirmasi Password</label>
            <div style={{ position: "relative" }}>
              <input type={showPass2 ? "text" : "password"} value={pass2} onChange={e => setPass2(e.target.value)} placeholder="••••••••" style={{ ...css.input, paddingRight: 48, borderColor: err ? C.red : C.border }} />
              <button onClick={() => setShowPass2(v => !v)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, minHeight: 36, minWidth: 36 }}>
                {showPass2 ? "🙈" : "👁"}
              </button>
            </div>
            {err && <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>⚠ {err}</div>}
          </div>
          <Btn color={C.green} onClick={save} disabled={busy} style={{ width: "100%" }}>{busy ? "⏳ Menyimpan..." : "Simpan Password"}</Btn>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
function Dashboard({ hewan, mudhohi, mustahiq, setPage }) {
  const totalHewan = hewan.length;
  const selesai = hewan.filter(h => h.status === "Selesai").length;
  const lunas = mudhohi.filter(m => m.bayar === "Lunas").length;
  const belumLunas = mudhohi.filter(m => m.bayar === "Belum Lunas").length;
  const sudahAmbil = mustahiq.filter(m => m.sudahAmbil).length;
  const belumAmbil = mustahiq.length - sudahAmbil;
  const pct = totalHewan ? Math.round((selesai / totalHewan) * 100) : 0;
  const pctAmbil = mustahiq.length ? Math.round((sudahAmbil / mustahiq.length) * 100) : 0;

  const GOLD = "#C9A84C";
  const GOLD_DIM = "#C9A84C22";
  const GOLD_BORDER = "#C9A84C44";

  const statusData = STATUS_FLOW.map(st => ({
    label: st,
    value: hewan.filter(h => h.status === st).length,
    color: STATUS_COLOR[st],
  }));

  const jenisData = [
    { label: "Sapi", emoji: "🐄", value: hewan.filter(h => h.jenis === "Sapi").length, color: C.gold },
    { label: "Kambing", emoji: "🐐", value: hewan.filter(h => h.jenis === "Kambing").length, color: C.green },
    { label: "Domba", emoji: "🐑", value: hewan.filter(h => h.jenis === "Domba").length, color: C.purple },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* ── Alert belum lunas ── */}
      {belumLunas > 0 && (
        <div onClick={() => setPage("mudhohi")} style={{
          background: C.red + "18", border: `1px solid ${C.red}44`,
          borderLeft: `4px solid ${C.red}`, borderRadius: 5,
          padding: "12px 16px", cursor: "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ fontSize: 13, color: C.red }}>⚠️ {belumLunas} shohibul qurban belum lunas</span>
          <span style={{ fontSize: 12, color: C.muted }}>Lihat →</span>
        </div>
      )}

      {/* ══ SEKSI 1: HEWAN QURBAN ══ */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden" }}>
        {/* Header seksi */}
        <div style={{
          background: `linear-gradient(135deg, #1B4332 0%, #0A1F14 100%)`,
          borderBottom: `1px solid ${GOLD_BORDER}`,
          padding: "14px 18px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: GOLD, letterSpacing: 0.3 }}>🐾 Hewan Qurban</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Total terdaftar</div>
          </div>
          <div style={{
            background: GOLD_DIM, border: `1px solid ${GOLD_BORDER}`,
            borderRadius: 5, padding: "6px 16px", textAlign: "center",
          }}>
            <div style={{ fontSize: 28, fontWeight: 900, color: GOLD, lineHeight: 1 }}>{totalHewan}</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>ekor</div>
          </div>
        </div>

        {/* Jumlah per jenis */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: `1px solid ${C.border}` }}>
          {jenisData.map((j, idx) => (
            <div key={j.label} onClick={() => setPage("hewan")} style={{
              padding: "14px 10px", textAlign: "center", cursor: "pointer",
              borderRight: idx < 2 ? `1px solid ${C.border}` : "none",
              transition: "background 0.15s",
            }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>{j.emoji}</div>
              <div style={{ fontSize: 24, fontWeight: 900, color: j.color, lineHeight: 1 }}>{j.value}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{j.label}</div>
            </div>
          ))}
        </div>

        {/* Status per tahap */}
        <div style={{ padding: "14px 18px" }}>
          <div style={{ fontSize: 11, color: C.muted, fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Status Penyembelihan</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            {statusData.map(s => (
              <div key={s.label} style={{
                background: s.color + "11", border: `1px solid ${s.color}33`,
                borderRadius: 4, padding: "10px 14px",
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <span style={{ fontSize: 13, color: C.muted }}>{s.label}</span>
                <span style={{ fontSize: 20, fontWeight: 900, color: s.color }}>{s.value}</span>
              </div>
            ))}
          </div>
          {/* Progress bar */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: C.muted }}>Selesai disembelih</span>
            <span style={{ fontSize: 14, fontWeight: 900, color: C.green }}>{pct}%</span>
          </div>
          <div style={{ height: 10, background: C.border, borderRadius: 99, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, #2E7D32, #4CAF50)`, borderRadius: 99, transition: "width 0.4s" }} />
          </div>
        </div>
      </div>

      {/* ══ SEKSI 2: PENERIMA DAGING ══ */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden" }}
        onClick={() => setPage("mustahiq")} >
        {/* Header */}
        <div style={{
          background: `linear-gradient(135deg, #1A2B1A 0%, #0C1A0C 100%)`,
          borderBottom: `1px solid ${C.border}`,
          padding: "14px 18px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          cursor: "pointer",
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: C.greenLight, letterSpacing: 0.3 }}>🤲 Penerima Daging</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Total terdaftar</div>
          </div>
          <div style={{
            background: C.green + "22", border: `1px solid ${C.green}44`,
            borderRadius: 5, padding: "6px 16px", textAlign: "center",
          }}>
            <div style={{ fontSize: 28, fontWeight: 900, color: C.greenLight, lineHeight: 1 }}>{mustahiq.length}</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>orang</div>
          </div>
        </div>

        {/* Sudah & Belum ambil */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ padding: "16px", textAlign: "center", borderRight: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 26, fontWeight: 900, color: C.green, lineHeight: 1 }}>{sudahAmbil}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>✅ Sudah Ambil</div>
          </div>
          <div style={{ padding: "16px", textAlign: "center" }}>
            <div style={{ fontSize: 26, fontWeight: 900, color: C.red, lineHeight: 1 }}>{belumAmbil}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>⏳ Belum Ambil</div>
          </div>
        </div>

        {/* Progress */}
        <div style={{ padding: "14px 18px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: C.muted }}>Distribusi daging</span>
            <span style={{ fontSize: 14, fontWeight: 900, color: C.green }}>{pctAmbil}%</span>
          </div>
          <div style={{ height: 10, background: C.border, borderRadius: 99, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pctAmbil}%`, background: `linear-gradient(90deg, #1B4332, #4CAF50)`, borderRadius: 99, transition: "width 0.4s" }} />
          </div>
        </div>
      </div>

      {/* ══ SEKSI 3: PEMBAYARAN (lebih kecil) ══ */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 18px" }}
        onClick={() => setPage("mudhohi")} >
        <div style={{ fontWeight: 700, fontSize: 13, color: C.muted, fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>💳 Pembayaran Shohibul Qurban</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div style={{ background: C.green + "11", border: `1px solid ${C.green}33`, borderRadius: 4, padding: "10px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: C.green }}>{lunas}</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Lunas</div>
          </div>
          <div style={{ background: C.red + "11", border: `1px solid ${C.red}33`, borderRadius: 4, padding: "10px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: C.red }}>{belumLunas}</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Belum Lunas</div>
          </div>
          <div style={{ background: C.orange + "11", border: `1px solid ${C.orange}33`, borderRadius: 4, padding: "10px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: C.orange }}>{mudhohi.filter(m => m.bayar === "Cicilan").length}</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Cicilan</div>
          </div>
        </div>
      </div>

    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// HEWAN PAGE
// ══════════════════════════════════════════════════════════════
function HewanPage({ hewan, setHewan, mudhohi, setMudhohi, session }) {
  const perm = usePermission(session);
  const [tabJenis, setTabJenis] = useState("Sapi");
  const [modal, setModal] = useState(null); // null | "add" | "edit"
  const [confirmId, setConfirmId] = useState(null);
  const [rollbackModal, setRollbackModal] = useState(null); // { id, targetStatus }
  const [rollbackAlasan, setRollbackAlasan] = useState("");
  const [form, setForm] = useState({ jenis: "Sapi", nama: "", berat: "", asal: "", harga: "", kapasitas: "7", status: "Menunggu" });
  const [errors, setErrors] = useState({});
  const [toast, setToast] = useState({ msg: "", type: "ok" });

  const showToast = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast({ msg: "", type: "ok" }), 3000); };

  const openAdd = () => {
    setForm({ jenis: tabJenis, nama: "", berat: "", asal: "", harga: "", kapasitas: String(KAPASITAS_DEFAULT[tabJenis]), status: "Menunggu" });
    setErrors({});
    setModal("add");
  };

  const openEdit = (h) => {
    // EC-09: Guard hewan terkunci
    if (isHewanTerkunci(h, session)) { showToast("Hewan berstatus Selesai hanya bisa diedit oleh admin.", "err"); return; }
    setForm({ ...h }); setErrors({}); setModal("edit");
  };

  const validate = () => {
    const e = {};
    if (!form.nama.trim()) e.nama = "Nama wajib diisi";
    if (!form.harga || Number(form.harga) <= 0) e.harga = "Harga harus lebih dari 0";
    if (!form.berat || Number(form.berat) <= 0) e.berat = "Berat harus lebih dari 0";
    if (!form.kapasitas || Number(form.kapasitas) < 1) e.kapasitas = "Kapasitas minimal 1";
    // BR-HEWAN-02: kapasitas tidak boleh dikurangi di bawah peserta existing
    if (modal === "edit" && form.id) {
      const terisi = mudhohi.filter(m => m.hewanId === form.id).length;
      if (Number(form.kapasitas) < terisi) e.kapasitas = `Kapasitas tidak boleh kurang dari ${terisi} (jumlah shohibul qurban terdaftar)`;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = () => {
    if (!validate()) return;
    if (modal === "add") {
      const prefix = form.jenis === "Sapi" ? "S" : form.jenis === "Kambing" ? "K" : "D";
      const newHewan = { ...form, id: prefix + uuid(), createdBy: session.panitiaId, createdAt: now(), updatedBy: session.panitiaId, updatedAt: now(), statusHistory: [] };
      setHewan(prev => [...prev, newHewan]);
      showToast(`${form.jenis} "${form.nama}" berhasil ditambahkan!`);
    } else {
      // EC-09: Guard di handler
      const existing = hewan.find(h => h.id === form.id);
      if (isHewanTerkunci(existing, session)) { showToast("Tidak bisa edit hewan yang sudah Selesai.", "err"); return; }
      const updated = { ...form, updatedBy: session.panitiaId, updatedAt: now() };
      setHewan(prev => prev.map(h => h.id === form.id ? updated : h));
      showToast(`Data "${form.nama}" berhasil diperbarui.`);
    }
    setModal(null);
  };

  const nextStatus = (s) => {
    const idx = STATUS_FLOW.indexOf(s);
    return idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1] : null;
  };

  // BR-HEWAN-04: Status hanya maju. Mundur hanya admin + alasan.
  const updateStatus = (id, newStatus) => {
    const h = hewan.find(x => x.id === id);
    if (!h) { showToast("Hewan tidak ditemukan.", "err"); return; }
    // Defense in depth: even if the UI button somehow appears, refuse to
    // mutate a Selesai-locked record from a non-admin session.
    if (isHewanTerkunci(h, session)) { showToast("Hewan terkunci, tidak bisa ubah status.", "err"); return; }
    // Validate that newStatus is the immediate next step in the flow.
    const expectedNext = STATUS_FLOW[STATUS_FLOW.indexOf(h.status) + 1];
    if (newStatus !== expectedNext) { showToast("Transisi status tidak valid.", "err"); return; }
    const histEntry = { dari: h.status, ke: newStatus, oleh: session.panitiaId, waktu: now() };
    setHewan(prev => prev.map(x => x.id === id ? { ...x, status: newStatus, updatedBy: session.panitiaId, updatedAt: now(), statusHistory: [...(x.statusHistory || []), histEntry] } : x));
    showToast(`Status diperbarui ke "${newStatus}"`);
  };

  const doRollback = () => {
    if (!rollbackAlasan.trim()) { showToast("Alasan wajib diisi untuk rollback status.", "err"); return; }
    const h = hewan.find(x => x.id === rollbackModal.id);
    const histEntry = { dari: h.status, ke: rollbackModal.targetStatus, oleh: session.panitiaId, waktu: now(), alasan: rollbackAlasan };
    setHewan(prev => prev.map(x => x.id === rollbackModal.id ? { ...x, status: rollbackModal.targetStatus, updatedBy: session.panitiaId, updatedAt: now(), statusHistory: [...(x.statusHistory || []), histEntry] } : x));
    showToast(`Status di-rollback ke "${rollbackModal.targetStatus}"`);
    setRollbackModal(null);
    setRollbackAlasan("");
  };

  // BR-HEWAN-03: Hapus — cek shohibul qurban terdampak, cascade confirm
  const del = () => {
    const h = hewan.find(x => x.id === confirmId);
    const terdampak = mudhohi.filter(m => m.hewanId === confirmId).length;
    setHewan(prev => prev.filter(x => x.id !== confirmId));
    if (terdampak) setMudhohi(prev => prev.filter(m => m.hewanId !== confirmId));
    setConfirmId(null);
    if (terdampak) showToast(`Hewan dihapus beserta ${terdampak} shohibul qurban terdampak.`, "err");
    else showToast("Hewan berhasil dihapus.");
  };

  const pesertaCount = (hewanId) => mudhohi.filter(m => m.hewanId === hewanId).length;
  const list = hewan.filter(h => h.jenis === tabJenis);
  const confirmingHewan = hewan.find(h => h.id === confirmId);
  const terdampakCount = confirmId ? mudhohi.filter(m => m.hewanId === confirmId).length : 0;

  return (
    <div>
      <Toast msg={toast.msg} type={toast.type} />
      <SectionTitle emoji="🐾" title="Manajemen Hewan" sub="Kelola sapi, kambing, dan domba qurban" />

      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {JENIS_HEWAN.map(j => (
          <button key={j} onClick={() => setTabJenis(j)} style={{ ...css.btn(tabJenis === j ? JENIS_COLOR[j] + "33" : C.surface, tabJenis === j ? JENIS_COLOR[j] : C.muted), border: `1px solid ${tabJenis === j ? JENIS_COLOR[j] : C.border}`, fontSize: 13 }}>
            {JENIS_EMOJI[j]} {j} <span style={{ fontSize: 11, opacity: 0.8 }}>({hewan.filter(h => h.jenis === j).length})</span>
          </button>
        ))}
      </div>

      <Btn color={JENIS_COLOR[tabJenis]} onClick={openAdd} style={{ marginBottom: 16 }}>+ Tambah {tabJenis}</Btn>

      {list.length === 0 && (
        <div style={{ ...css.card, textAlign: "center", color: C.muted, padding: "40px 16px" }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>{JENIS_EMOJI[tabJenis]}</div>
          <div style={{ marginBottom: 12 }}>Belum ada {tabJenis.toLowerCase()} terdaftar.</div>
          <Btn color={JENIS_COLOR[tabJenis]} onClick={openAdd}>+ Tambah {tabJenis} Pertama</Btn>
        </div>
      )}

      {list.map(h => {
        const terisi = pesertaCount(h.id);
        const penuh = terisi >= Number(h.kapasitas);
        const next = nextStatus(h.status);
        const terkunci = isHewanTerkunci(h, session);
        return (
          <div key={h.id} style={{ ...css.card, borderLeft: `3px solid ${STATUS_COLOR[h.status]}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{JENIS_EMOJI[h.jenis]}</span>
                  <div style={{ fontWeight: 700, fontSize: 16, color: C.white }}>{h.nama}</div>
                  {/* Badge terkunci untuk panitia */}
                  {terkunci && <span style={{ ...css.badge(C.muted), fontSize: 10 }}>🔒 Terkunci</span>}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                  {h.berat} kg · {h.asal} · Rp {Number(h.harga).toLocaleString("id")}
                </div>
                <div style={{ fontSize: 12, marginTop: 6 }}>
                  <span style={{ color: penuh ? C.red : C.green }}>👥 {terisi}/{h.kapasitas} peserta{penuh ? " · Penuh" : ""}</span>
                </div>
                <div style={{ marginTop: 6, width: 120 }}>
                  <ProgressBar value={terisi} max={Number(h.kapasitas)} color={penuh ? C.red : C.green} />
                </div>
              </div>
              <Pill text={h.status} color={STATUS_COLOR[h.status]} />
            </div>
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {/* BR-HEWAN-04: tombol maju status */}
              {next && perm.canUpdateStatus && (
                <button onClick={() => updateStatus(h.id, next)} style={{ ...css.btn(STATUS_COLOR[next] + "22", STATUS_COLOR[next]), fontSize: 13, padding: "8px 14px", border: `1px solid ${STATUS_COLOR[next]}44`, flex: 1, minWidth: 110 }}>
                  → {next}
                </button>
              )}
              {/* BR-SEMBELIH-02: Rollback status hanya admin */}
              {h.status !== "Menunggu" && (
                <AdminOnly session={session}>
                  <button onClick={() => setRollbackModal({ id: h.id, targetStatus: STATUS_FLOW[STATUS_FLOW.indexOf(h.status) - 1] })} style={{ ...css.btn(C.orange + "22", C.orange), fontSize: 13, padding: "8px 14px", border: `1px solid ${C.orange}44` }}>
                    ↩ Mundur
                  </button>
                </AdminOnly>
              )}
              {/* Edit: disembunyikan jika terkunci untuk panitia */}
              {!terkunci && (
                <Btn color={C.blue} onClick={() => openEdit(h)} style={{ fontSize: 13, padding: "8px 14px" }}>Edit</Btn>
              )}
              {/* Hapus: AdminOnly (Section 5.4) */}
              <AdminOnly session={session}>
                <Btn color={C.red} onClick={() => setConfirmId(h.id)} style={{ fontSize: 13, padding: "8px 14px" }}>Hapus</Btn>
              </AdminOnly>
            </div>
          </div>
        );
      })}

      {/* Modal tambah/edit */}
      {modal && (
        <Modal onClose={() => setModal(null)} title={`${modal === "add" ? "Tambah" : "Edit"} Hewan`}>
          <Select label="Jenis Hewan" value={form.jenis} onChange={v => setForm(p => ({ ...p, jenis: v, kapasitas: String(KAPASITAS_DEFAULT[v]) }))} options={JENIS_HEWAN} />
          <Input label={`Nama ${form.jenis}`} value={form.nama} onChange={v => setForm(p => ({ ...p, nama: v }))} error={errors.nama} />
          <Input label="Berat (kg)" type="number" value={form.berat} onChange={v => setForm(p => ({ ...p, berat: v }))} error={errors.berat} />
          <Input label="Asal / Peternak" value={form.asal} onChange={v => setForm(p => ({ ...p, asal: v }))} />
          <Input label="Harga (Rp)" type="number" value={form.harga} onChange={v => setForm(p => ({ ...p, harga: v }))} error={errors.harga} />
          <Input label="Kapasitas Peserta" type="number" value={form.kapasitas} onChange={v => setForm(p => ({ ...p, kapasitas: v }))} error={errors.kapasitas} hint={form.jenis === "Sapi" ? "Sapi biasanya 7 orang" : "Kambing/Domba = 1 orang"} />
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <Btn color={C.green} onClick={save} style={{ flex: 1 }}>Simpan</Btn>
            <Btn color={C.muted} onClick={() => setModal(null)} style={{ flex: 1 }}>Batal</Btn>
          </div>
        </Modal>
      )}

      {/* Modal rollback status (admin only) */}
      {rollbackModal && (
        <Modal onClose={() => { setRollbackModal(null); setRollbackAlasan(""); }} title="↩ Rollback Status Hewan">
          <div style={{ marginBottom: 14, padding: "10px 14px", background: C.red + "18", borderRadius: 4, border: `1px solid ${C.red}44`, fontSize: 13, color: C.red }}>
            ⚠️ Mundur ke status: <strong>{rollbackModal.targetStatus}</strong>
          </div>
          <Input label="Alasan Rollback (wajib)" value={rollbackAlasan} onChange={setRollbackAlasan} placeholder="Masukkan alasan..." error={!rollbackAlasan.trim() ? "" : ""} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn color={C.orange} onClick={doRollback} style={{ flex: 1 }}>Konfirmasi Rollback</Btn>
            <Btn color={C.muted} onClick={() => { setRollbackModal(null); setRollbackAlasan(""); }} style={{ flex: 1 }}>Batal</Btn>
          </div>
        </Modal>
      )}

      {confirmId && (
        <ConfirmModal
          pesan={`Yakin hapus "${confirmingHewan?.nama}"?`}
          detail={terdampakCount > 0 ? `⚠️ ${terdampakCount} shohibul qurban yang terdaftar juga akan ikut terhapus.` : null}
          onConfirm={del}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// NOTIF SEMBELIH MODAL
// ══════════════════════════════════════════════════════════════
function NotifSembelihModal({ mudhohi: m, hewanObj, fonnteToken, session, setMudhohi, onClose }) {
  const [foto, setFoto] = useState(null);
  const [fotoPreview, setFotoPreview] = useState(null);
  const [pesanCustom, setPesanCustom] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef();
  const lastSentRef = useRef(null);

  const statusHewan = hewanObj?.status || "Menunggu";
  const sudahSembelih = ["Disembelih", "Dikuliti", "Selesai"].includes(statusHewan);

  const defaultPesan = sudahSembelih
    ? `Assalamu'alaikum ${m.nama},\n\nAlhamdulillah, hewan qurban Anda (${hewanObj?.nama || m.jenisHewan}) telah ${statusHewan === "Selesai" ? "selesai diproses" : "disembelih"}. 🐾\n\nInsyaAllah daging akan segera didistribusikan.\n\nBarakallahu fiikum. Panitia Qurban`
    : `Assalamu'alaikum ${m.nama},\n\nHewan qurban Anda masih dalam antrean penyembelihan.\n\nBarakallahu fiikum. Panitia Qurban`;

  const pesan = pesanCustom || defaultPesan;

  const handleFoto = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type || !file.type.startsWith("image/")) {
      setResult({ ok: false, msg: "File harus berupa gambar." });
      e.target.value = "";
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setResult({ ok: false, msg: "Ukuran foto maks 2MB." });
      e.target.value = "";
      return;
    }
    // Keep the File for upload (Fonnte expects binary in `file` field),
    // and build a separate base64 data URL only for the preview <img>.
    setFoto(file);
    const reader = new FileReader();
    reader.onload = (ev) => setFotoPreview(ev.target.result);
    reader.onerror = () => {
      setResult({ ok: false, msg: "Gagal membaca file foto. Coba lagi." });
      setFoto(null);
      setFotoPreview(null);
    };
    reader.readAsDataURL(file);
  };

  const send = async () => {
    if (!fonnteToken) { setResult({ ok: false, msg: "Token Fonnte belum diset di Pengaturan." }); return; }
    // BR-WA-03: anti-spam 5 menit
    if (lastSentRef.current && Date.now() - lastSentRef.current < 5 * 60 * 1000) {
      if (!window.confirm("WA ke nomor ini baru dikirim < 5 menit lalu. Kirim ulang?")) return;
    }
    setSending(true); setResult(null);
    const res = foto ? await sendWAWithImage(fonnteToken, m.hp, pesan, foto) : await sendWA(fonnteToken, m.hp, pesan);
    setSending(false);
    const ok = !!res.status;
    if (ok) { lastSentRef.current = Date.now(); setResult({ ok: true, msg: "Notifikasi WA berhasil dikirim! ✅" }); }
    else setResult({ ok: false, msg: `Gagal kirim: ${res.reason || "error"}` });
    // BR-WA-02: catat log WA
    setMudhohi(prev => prev.map(x => x.id === m.id ? { ...x, waLog: [...(x.waLog || []), { waktu: now(), dikirimOleh: session.panitiaId, status: ok ? "ok" : "gagal", reason: res.reason }] } : x));
  };

  return (
    <Modal onClose={onClose} title="📲 Kirim Notif Penyembelihan">
      <div style={{ padding: "10px 14px", background: C.inputBg, borderRadius: 5, border: `1px solid ${STATUS_COLOR[statusHewan] || C.border}44`, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.muted }}>Status Hewan</div>
        <div style={{ fontWeight: 700, color: STATUS_COLOR[statusHewan] || C.text }}>{statusHewan}</div>
        <div style={{ fontSize: 12, color: C.muted }}>{hewanObj?.nama || "-"}</div>
      </div>
      <div style={{ marginBottom: 14, padding: "10px 14px", background: C.inputBg, borderRadius: 5, border: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 11, color: C.muted }}>DIKIRIM KE</div>
        <div style={{ fontWeight: 700, color: C.white }}>{m.nama}</div>
        <div style={{ fontSize: 12, color: C.muted }}>📱 {m.hp}</div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={css.label}>Foto (opsional, maks 2MB)</label>
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFoto} style={{ display: "none" }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => fileRef.current.click()} style={{ ...css.btn(C.inputBg, C.muted), border: `1px dashed ${C.border}`, fontSize: 12, padding: "9px 14px", flex: 1 }}>📷 {foto ? "Ganti Foto" : "Pilih Foto"}</button>
          {foto && <button onClick={() => { setFoto(null); setFotoPreview(null); }} style={{ ...css.btn(C.red + "22", C.red), border: `1px solid ${C.red}44`, fontSize: 12, padding: "9px 12px" }}>✕</button>}
        </div>
        {fotoPreview && <img src={fotoPreview} alt="preview" style={{ width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: 4, marginTop: 8 }} />}
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={css.label}>Pesan WA</label>
        <textarea value={pesanCustom || defaultPesan} onChange={e => setPesanCustom(e.target.value)} rows={5} style={{ ...css.input, resize: "vertical", lineHeight: 1.6, fontSize: 13 }} />
        {pesanCustom && <button onClick={() => setPesanCustom("")} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11, marginTop: 2 }}>↩ Reset ke default</button>}
      </div>
      {result && <div style={{ marginBottom: 14, padding: "10px 13px", background: result.ok ? C.green + "18" : C.red + "18", border: `1px solid ${result.ok ? C.green : C.red}`, borderRadius: 4, fontSize: 13, color: result.ok ? C.green : C.red }}>{result.msg}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn color={C.green} onClick={send} disabled={sending} style={{ flex: 1 }}>{sending ? "⏳ Mengirim..." : "📲 Kirim WA"}</Btn>
        <Btn color={C.muted} onClick={onClose} style={{ flex: 1 }}>Tutup</Btn>
      </div>
    </Modal>
  );
}

// ══════════════════════════════════════════════════════════════
// MUDHOHI PAGE
// ══════════════════════════════════════════════════════════════
function MudhohiPage({ mudhohi, setMudhohi, hewan, fonnteToken, session}) {
  const perm = usePermission(session);
  const [modal, setModal] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [notifTarget, setNotifTarget] = useState(null);
  const [form, setForm] = useState({ nama: "", hp: "", alamat: "", jenisHewan: "Sapi", hewanId: hewan.find(h => h.jenis === "Sapi")?.id || "", bayar: "Lunas", nominal: "" });
  const [errors, setErrors] = useState({});
  const [waPreview, setWaPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState({ msg: "", type: "ok" });
  const [search, setSearch] = useState("");
  const [filterBayar, setFilterBayar] = useState("Semua");
  const [filterJenis, setFilterJenis] = useState("Semua");
  const [dupWarning, setDupWarning] = useState("");

  const showToast = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast({ msg: "", type: "ok" }), 3500); };

  const handleJenisChange = (jenis) => {
    const first = hewan.find(h => h.jenis === jenis);
    setForm(p => ({ ...p, jenisHewan: jenis, hewanId: first?.id || "" }));
  };

  // BR-MUDHOHI-01: validasi format HP
  const validateHP = (hp) => /^08\d{8,12}$/.test(hp.replace(/\s/g, ""));

  const validate = () => {
    const e = {};
    if (!form.nama.trim()) e.nama = "Nama wajib diisi";
    if (!form.hp.trim()) e.hp = "Nomor HP wajib diisi";
    else if (!validateHP(form.hp)) e.hp = "Format: 08xxxxxxxxxx";
    if (!form.nominal || Number(form.nominal) <= 0) e.nominal = "Nominal harus lebih dari 0";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const hewanObj = hewan.find(h => h.id === form.hewanId);

  const buildWAMsg = () =>
    `Assalamu'alaikum ${form.nama},\n\nPendaftaran qurban Anda telah berhasil! ${JENIS_EMOJI[form.jenisHewan] || "🐾"}\nJenis: ${form.jenisHewan} (${hewanObj?.nama || "-"})\nStatus Bayar: ${form.bayar}\nNominal: Rp ${Number(form.nominal).toLocaleString("id")}\n\nBarakallahu fiikum. Panitia Qurban`;

  const save = async (skipWA = false) => {
    if (!validate()) return;
    const hewanObj2 = hewan.find(h => h.id === form.hewanId);
    // EC-03: Cek kapasitas
    if (hewanObj2) {
      const terisi = mudhohi.filter(m => m.hewanId === form.hewanId && m.id !== form.id).length;
      if (terisi >= Number(hewanObj2.kapasitas)) { showToast(`${hewanObj2.jenis} "${hewanObj2.nama}" sudah penuh.`, "err"); return; }
    }

    if (modal === "add") {
      const newM = { ...form, id: "M" + uuid(), createdBy: session.panitiaId, createdAt: now(), updatedBy: session.panitiaId, updatedAt: now(), cicilanLog: [], waLog: [] };
      setMudhohi(prev => [...prev, newM]);
      if (fonnteToken && !skipWA) {
        setSending(true);
        const res = await sendWA(fonnteToken, form.hp, buildWAMsg());
        setSending(false);
        setMudhohi(prev => prev.map(x => x.id === newM.id ? { ...x, waLog: [{ waktu: now(), dikirimOleh: session.panitiaId, status: res.status ? "ok" : "gagal", reason: res.reason }] } : x));
        showToast("Data disimpan & notif WA terkirim!");
      } else {
        showToast("Data disimpan!");
      }
    } else {
      const existing = mudhohi.find(m => m.id === form.id);
      const updated = { ...form, updatedBy: session.panitiaId, updatedAt: now(), cicilanLog: existing.cicilanLog, waLog: existing.waLog };
      setMudhohi(prev => prev.map(m => m.id === form.id ? updated : m));
      showToast("Data diperbarui!");
    }
    setModal(null);
  };

  // BR-MUDHOHI-01: cek duplikat HP (warning)
  const checkDupHP = (hp) => {
    if (!hp || !validateHP(hp)) { setDupWarning(""); return; }
    const dup = mudhohi.find(m => m.hp === hp && m.id !== form.id);
    setDupWarning(dup ? `⚠️ Nomor HP ini sudah terdaftar atas nama "${dup.nama}" di ${dup.jenisHewan}.` : "");
  };

  // BR-MUDHOHI-05: hapus shohibul qurban — cek status hewan
  const del = () => {
    const m = mudhohi.find(x => x.id === confirmId);
    const hw = hewan.find(h => h.id === m?.hewanId);
    // Guard: hapus setelah Disembelih hanya admin
    if (hw && ["Disembelih", "Dikuliti", "Selesai"].includes(hw.status) && session.role !== "admin") {
      showToast("Shohibul qurban dari hewan yang sudah disembelih hanya bisa dihapus oleh admin.", "err");
      setConfirmId(null);
      return;
    }
    setMudhohi(prev => prev.filter(x => x.id !== confirmId));
    setConfirmId(null);
    showToast("Shohibul qurban dihapus.");
  };

  const filtered = mudhohi.filter(m => {
    const matchSearch = m.nama.toLowerCase().includes(search.toLowerCase()) || m.hp.includes(search);
    const matchBayar = filterBayar === "Semua" || m.bayar === filterBayar;
    const matchJenis = filterJenis === "Semua" || m.jenisHewan === filterJenis;
    return matchSearch && matchBayar && matchJenis;
  });

  const hewanOptions = hewan.filter(h => h.jenis === form.jenisHewan).map(h => {
    const terisi = mudhohi.filter(m => m.hewanId === h.id).length;
    const penuh = terisi >= Number(h.kapasitas);
    return { value: h.id, label: `${h.nama} (${terisi}/${h.kapasitas})${penuh ? " — Penuh" : ""}` };
  });

  const totalTerkumpul = mudhohi.reduce((a, m) => a + Number(m.nominal || 0), 0);
  const totalLunas = mudhohi.filter(m => m.bayar === "Lunas").length;

  return (
    <div>
      <Toast msg={toast.msg} type={toast.type} />
      <SectionTitle emoji="💳" title="Shohibul Qurban" sub="Kelola data peserta qurban" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div style={{ ...css.card, marginBottom: 0, borderLeft: `3px solid ${C.green}`, padding: "12px 16px" }}>
          <div style={{ fontSize: 11, color: C.muted }}>Total Terkumpul</div>
          <div style={{ fontWeight: 900, color: C.green, fontSize: 15 }}>Rp {totalTerkumpul.toLocaleString("id")}</div>
        </div>
        <div style={{ ...css.card, marginBottom: 0, borderLeft: `3px solid ${C.blue}`, padding: "12px 16px" }}>
          <div style={{ fontSize: 11, color: C.muted }}>Lunas</div>
          <div style={{ fontWeight: 900, color: C.blue, fontSize: 15 }}>{totalLunas} / {mudhohi.length}</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Cari nama atau HP..." style={css.input} />
        <div style={{ display: "flex", gap: 8 }}>
          <select value={filterBayar} onChange={e => setFilterBayar(e.target.value)} style={{ ...css.select, flex: 1 }}>
            <option value="Semua">Semua Status</option>
            {["Lunas", "Belum Lunas", "Cicilan"].map(v => <option key={v}>{v}</option>)}
          </select>
          <select value={filterJenis} onChange={e => setFilterJenis(e.target.value)} style={{ ...css.select, flex: 1 }}>
            <option value="Semua">Semua Jenis</option>
            {JENIS_HEWAN.map(j => <option key={j}>{j}</option>)}
          </select>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8 }}>
        <span style={{ fontSize: 13, color: C.muted }}>{filtered.length} dari {mudhohi.length} peserta</span>
        <Btn color={C.green} onClick={() => {
          const first = hewan.find(h => h.jenis === "Sapi");
          setForm({ nama: "", hp: "", alamat: "", jenisHewan: "Sapi", hewanId: first?.id || "", bayar: "Lunas", nominal: "" });
          setErrors({}); setDupWarning(""); setModal("add");
        }}>+ Tambah</Btn>
      </div>

      {filtered.length === 0 && (
        <div style={{ ...css.card, textAlign: "center", color: C.muted, padding: "40px 16px" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>💳</div>
          {search || filterBayar !== "Semua" || filterJenis !== "Semua"
            ? <div>Tidak ada shohibul qurban yang sesuai filter.<br /><button onClick={() => { setSearch(""); setFilterBayar("Semua"); setFilterJenis("Semua"); }} style={{ background: "none", border: "none", color: C.green, cursor: "pointer", marginTop: 8 }}>Reset filter</button></div>
            : "Belum ada shohibul qurban terdaftar."
          }
        </div>
      )}

      {filtered.map(m => {
        const hw = hewan.find(h => h.id === m.hewanId);
        return (
          <div key={m.id} style={{ ...css.card, borderLeft: `3px solid ${BAYAR_COLOR[m.bayar]}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: C.white }}>{m.nama}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>📱 {m.hp} · 📍 {m.alamat}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{JENIS_EMOJI[m.jenisHewan] || "🐾"} {m.jenisHewan} · {hw?.nama || "-"}</div>
                {hw && <div style={{ marginTop: 4 }}><span style={{ ...css.badge(STATUS_COLOR[hw.status]), fontSize: 10 }}>🔪 {hw.status}</span></div>}
                <div style={{ fontSize: 13, color: C.text, marginTop: 4, fontWeight: 600 }}>Rp {Number(m.nominal).toLocaleString("id")}</div>
              </div>
              <Pill text={m.bayar} color={BAYAR_COLOR[m.bayar]} />
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => setNotifTarget(m)}
                disabled={!hw || hw.status === "Menunggu"}
                style={{ ...css.btn((hw?.status && hw.status !== "Menunggu" ? STATUS_COLOR[hw.status] : C.muted) + "22", hw?.status && hw.status !== "Menunggu" ? STATUS_COLOR[hw.status] : C.muted), fontSize: 13, padding: "8px 14px", border: `1px solid ${(hw?.status && hw.status !== "Menunggu" ? STATUS_COLOR[hw.status] : C.muted)}44`, flex: 1, minWidth: 130, opacity: (!hw || hw.status === "Menunggu") ? 0.4 : 1, cursor: (!hw || hw.status === "Menunggu") ? "not-allowed" : "pointer" }}
              >
                📲 Notif Sembelih
              </button>
              <Btn color={C.blue} onClick={() => { setForm({ ...m }); setErrors({}); setDupWarning(""); setModal("edit"); }} style={{ fontSize: 13, padding: "8px 14px" }}>Edit</Btn>
              {/* BR-MUDHOHI-05 + AdminOnly guard */}
              <AdminOnly session={session}>
                <Btn color={C.red} onClick={() => setConfirmId(m.id)} style={{ fontSize: 13, padding: "8px 14px" }}>Hapus</Btn>
              </AdminOnly>
            </div>
          </div>
        );
      })}

      {modal && (
        <Modal onClose={sending ? undefined : () => setModal(null)} title={`${modal === "add" ? "Tambah" : "Edit"} Shohibul Qurban`}>
          <fieldset disabled={sending} style={{ border: "none", padding: 0, margin: 0 }}>
            <Input label="Nama Lengkap" value={form.nama} onChange={v => setForm(p => ({ ...p, nama: v }))} error={errors.nama} />
            <div style={{ marginBottom: 14 }}>
              <label style={css.label}>No. HP / WhatsApp</label>
              <input type="tel" value={form.hp} onChange={e => { setForm(p => ({ ...p, hp: e.target.value })); checkDupHP(e.target.value); }} placeholder="08xxxxxxxxxx" style={{ ...css.input, borderColor: errors.hp ? C.red : C.border }} />
              {dupWarning && <div style={{ fontSize: 11, color: C.orange, marginTop: 3 }}>{dupWarning}</div>}
              {errors.hp && <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>⚠ {errors.hp}</div>}
            </div>
            <Input label="Alamat / RT-RW" value={form.alamat} onChange={v => setForm(p => ({ ...p, alamat: v }))} />
            <Select label="Jenis Qurban" value={form.jenisHewan} onChange={handleJenisChange} options={JENIS_HEWAN} />
            {hewanOptions.length > 0
              ? <Select label={`Pilih ${form.jenisHewan}`} value={form.hewanId} onChange={v => setForm(p => ({ ...p, hewanId: v }))} options={hewanOptions} />
              : <div style={{ background: C.red + "18", border: `1px solid ${C.red}44`, borderRadius: 4, padding: "10px 13px", color: C.red, fontSize: 13, marginBottom: 14 }}>⚠️ Belum ada {form.jenisHewan.toLowerCase()} terdaftar.</div>
            }
            <Select label="Status Bayar" value={form.bayar} onChange={v => setForm(p => ({ ...p, bayar: v }))} options={["Lunas", "Belum Lunas", "Cicilan"]} />
            <Input label="Nominal Bayar (Rp)" type="number" value={form.nominal} onChange={v => setForm(p => ({ ...p, nominal: v }))} error={errors.nominal} hint={hewanObj ? `Harga ${hewanObj.jenis}: Rp ${Number(hewanObj.harga).toLocaleString("id")}` : ""} />
            {modal === "add" && fonnteToken && (
              <div style={{ marginBottom: 14 }}>
                <button onClick={() => setWaPreview(v => !v)} style={{ background: "none", border: `1px solid ${C.green}44`, borderRadius: 4, padding: "6px 12px", color: C.greenLight, cursor: "pointer", fontSize: 12 }}>
                  {waPreview ? "Sembunyikan" : "👁 Preview"} pesan WA
                </button>
                {waPreview && <div style={{ marginTop: 8, background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 13px", fontSize: 12, color: C.text, whiteSpace: "pre-line", lineHeight: 1.6 }}>{buildWAMsg()}</div>}
              </div>
            )}
            {modal === "add" && fonnteToken ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn color={C.green} onClick={() => save(false)} style={{ flex: 1 }} disabled={sending}>{sending ? "⏳ Mengirim WA..." : "Simpan & Kirim WA"}</Btn>
                  <Btn color={C.muted} onClick={() => save(true)} style={{ flex: 1 }} disabled={sending}>Simpan Tanpa WA</Btn>
                </div>
                <Btn color={C.muted} onClick={() => setModal(null)} disabled={sending} style={{ width: "100%" }}>Batal</Btn>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <Btn color={C.green} onClick={() => save(false)} style={{ flex: 1 }} disabled={sending}>{sending ? "⏳ Menyimpan..." : "Simpan"}</Btn>
                <Btn color={C.muted} onClick={() => setModal(null)} style={{ flex: 1 }}>Batal</Btn>
              </div>
            )}
          </fieldset>
        </Modal>
      )}

      {confirmId && <ConfirmModal pesan="Yakin hapus data shohibul qurban ini?" onConfirm={del} onCancel={() => setConfirmId(null)} />}
      {notifTarget && (
        <NotifSembelihModal
          mudhohi={notifTarget}
          hewanObj={hewan.find(h => h.id === notifTarget.hewanId)}
          fonnteToken={fonnteToken}
          session={session}
          setMudhohi={setMudhohi}
          onClose={() => setNotifTarget(null)}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MUSTAHIQ PAGE
// ══════════════════════════════════════════════════════════════
function MustahiqPage({ mustahiq, setMustahiq, sesi, setSesi, session}) {
  const perm = usePermission(session);
  const [tab, setTab] = useState("mustahiq");
  const [modal, setModal] = useState(null);
  const [sesiModal, setSesiModal] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [confirmSesiId, setConfirmSesiId] = useState(null);
  const [confirmTandai, setConfirmTandai] = useState(null);
  const [batalModal, setBatalModal] = useState(null); // { id, nama }
  const [batalAlasan, setBatalAlasan] = useState("");
  const [form, setForm] = useState({ nama: "", rt: "", alamat: "", anggota: "", sesi: sesi[0]?.nama || "" });
  const [errors, setErrors] = useState({});
  const [sesiForm, setSesiForm] = useState({ nama: "", jam: "", kuota: "50" });
  const [sesiWarning, setSesiWarning] = useState("");
  const [filterSesi, setFilterSesi] = useState("Semua");
  const [searchMustahiq, setSearchMustahiq] = useState("");
  const [toast, setToast] = useState({ msg: "", type: "ok" });
  const tandaiLockRef = useRef(false); // EC-10: debounce

  const showToast = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast({ msg: "", type: "ok" }), 3000); };

  const validateMustahiq = () => {
    const e = {};
    if (!form.nama.trim()) e.nama = "Nama wajib diisi";
    if (form.anggota !== "" && (isNaN(Number(form.anggota)) || Number(form.anggota) < 1)) e.anggota = "Minimal 1 orang";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const saveMustahiq = () => {
    if (!validateMustahiq()) return;
    if (modal === "add") {
      const newM = { ...form, id: "P" + uuid(), sudahAmbil: false, createdBy: session.panitiaId, createdAt: now(), updatedBy: session.panitiaId, updatedAt: now(), ambilLog: { ditandaiOleh: null, ditandaiWaktu: null, dibatalkanOleh: null, dibatalkanWaktu: null, alasanBatal: null } };
      setMustahiq(prev => [...prev, newM]);
      showToast(`${form.nama} berhasil ditambahkan!`);
    } else {
      const existing = mustahiq.find(m => m.id === form.id);
      const updated = { ...form, sudahAmbil: existing.sudahAmbil, ambilLog: existing.ambilLog, updatedBy: session.panitiaId, updatedAt: now(), createdBy: existing.createdBy, createdAt: existing.createdAt, cicilanLog: existing.cicilanLog, waLog: existing.waLog };
      setMustahiq(prev => prev.map(m => m.id === form.id ? updated : m));
      showToast("Data diperbarui.");
    }
    setModal(null);
  };

  const saveSesi = () => {
    if (!sesiForm.nama.trim()) return;
    if (sesiModal === "add") {
      const newS = { ...sesiForm, id: "SE" + uuid(), createdBy: session.panitiaId, createdAt: now() };
      setSesi(prev => [...prev, newS]);
    } else {
      setSesi(prev => prev.map(s => s.id === sesiForm.id ? { ...sesiForm, createdBy: s.createdBy, createdAt: s.createdAt } : s));
    }
    setSesiModal(null);
    showToast("Sesi disimpan.");
  };

  // EC-10: Debounce + cek state
  const doTandai = () => {
    if (tandaiLockRef.current) return;
    tandaiLockRef.current = true;
    const target = mustahiq.find(m => m.id === confirmTandai.id);
    if (!target) { tandaiLockRef.current = false; return; }
    const sudahAmbilBaru = !target.sudahAmbil;
    const ambilLog = sudahAmbilBaru
      ? { ...target.ambilLog, ditandaiOleh: session.panitiaId, ditandaiWaktu: now() }
      : target.ambilLog; // batalkan ditangani lewat batalModal
    setMustahiq(prev => prev.map(m => m.id === confirmTandai.id ? { ...m, sudahAmbil: sudahAmbilBaru, ambilLog } : m));
    showToast(sudahAmbilBaru ? `${confirmTandai.nama} sudah ambil daging.` : "Ditandai ulang.");
    setConfirmTandai(null);
    setTimeout(() => { tandaiLockRef.current = false; }, 1000);
  };

  // BR-AMBIL-02, BR-MUSTAHIQ-04: Batalkan dengan alasan wajib
  const doBatal = () => {
    if (!batalAlasan.trim()) { showToast("Alasan wajib diisi.", "err"); return; }
    const target = mustahiq.find(m => m.id === batalModal.id);
    const ambilLog = { ...target.ambilLog, dibatalkanOleh: session.panitiaId, dibatalkanWaktu: now(), alasanBatal: batalAlasan };
    setMustahiq(prev => prev.map(m => m.id === batalModal.id ? { ...m, sudahAmbil: false, ambilLog } : m));
    showToast("Pengambilan dibatalkan.");
    setBatalModal(null); setBatalAlasan("");
  };

  // BR-SESI-02: Block hapus sesi jika ada mustahiq
  const confirmDelSesi = (id) => {
    const s = sesi.find(x => x.id === id);
    const dipakai = mustahiq.some(m => m.sesi === s?.nama);
    if (dipakai) { setSesiWarning("Sesi ini masih dipakai. Pindahkan penerima daging dulu."); return; }
    setConfirmSesiId(id);
  };

  // BR-MUSTAHIQ-05: Hapus setelah event dimulai hanya admin
  const delMustahiq = () => {
    const m = mustahiq.find(x => x.id === confirmId);
    setMustahiq(prev => prev.filter(x => x.id !== confirmId));
    setConfirmId(null);
    showToast("Penerima daging dihapus.");
  };

  const delSesi = () => {
    const s = sesi.find(x => x.id === confirmSesiId);
    setSesi(prev => prev.filter(x => x.id !== confirmSesiId));
    setConfirmSesiId(null);
    showToast("Sesi dihapus.");
  };

  const filtered = mustahiq.filter(m => {
    const matchSesi = filterSesi === "Semua" || m.sesi === filterSesi;
    const matchSearch = !searchMustahiq || m.nama.toLowerCase().includes(searchMustahiq.toLowerCase()) || m.rt.toLowerCase().includes(searchMustahiq.toLowerCase());
    return matchSesi && matchSearch;
  });

  return (
    <div>
      <Toast msg={toast.msg} type={toast.type} />
      <SectionTitle emoji="🎟️" title="Penerima Daging" sub="Kelola penerima daging & sesi pengambilan" />
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {["mustahiq", "sesi"].map(t => (
          <button key={t} onClick={() => { setTab(t); setSesiWarning(""); }} style={{ ...css.btn(tab === t ? C.green : C.surface, tab === t ? "#fff" : C.muted), border: `1px solid ${C.border}`, fontSize: 13 }}>
            {t === "mustahiq" ? "🤲 Penerima Daging" : "🗓️ Sesi"}
          </button>
        ))}
      </div>

      {tab === "mustahiq" && (
        <>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, marginBottom: 14 }}>
            {sesi.map(s => {
              const peserta = mustahiq.filter(m => m.sesi === s.nama);
              const sudah = peserta.filter(m => m.sudahAmbil).length;
              return (
                <div key={s.id} style={{ ...css.card, marginBottom: 0, minWidth: 160, padding: "12px 14px", flexShrink: 0, borderTop: `3px solid ${C.blue}` }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: C.white, marginBottom: 2 }}>{s.nama}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>⏱ {s.jam}</div>
                  <ProgressBar value={sudah} max={peserta.length || 1} />
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{sudah}/{peserta.length} ambil</div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            <input value={searchMustahiq} onChange={e => setSearchMustahiq(e.target.value)} placeholder="🔍 Cari nama atau RT..." style={css.input} />
            <div style={{ display: "flex", gap: 8 }}>
              <select value={filterSesi} onChange={e => setFilterSesi(e.target.value)} style={{ ...css.select, flex: 1 }}>
                <option>Semua</option>
                {sesi.map(s => <option key={s.id}>{s.nama}</option>)}
              </select>
              <Btn color={C.green} onClick={() => { setForm({ nama: "", rt: "", alamat: "", anggota: "", sesi: sesi[0]?.nama || "" }); setErrors({}); setModal("add"); }}>+ Tambah</Btn>
            </div>
          </div>

          <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: C.green }}>✅ Sudah: {filtered.filter(m => m.sudahAmbil).length}</div>
            <div style={{ fontSize: 13, color: C.red }}>⏳ Belum: {filtered.filter(m => !m.sudahAmbil).length}</div>
            <div style={{ fontSize: 13, color: C.muted }}>Total: {filtered.length}</div>
          </div>

          {filtered.map(m => (
            <div key={m.id} style={{ ...css.card, borderLeft: `3px solid ${m.sudahAmbil ? C.green : C.muted}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700, color: m.sudahAmbil ? C.muted : C.white }}>{m.nama}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{m.rt} · {m.alamat} · {m.anggota} anggota KK</div>
                  <div style={{ fontSize: 12, color: C.blue, marginTop: 2 }}>🗓️ {m.sesi}</div>
                </div>
                <Pill text={m.sudahAmbil ? "Sudah Ambil" : "Belum"} color={m.sudahAmbil ? C.green : C.muted} />
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {!m.sudahAmbil ? (
                  <button onClick={() => setConfirmTandai({ id: m.id, nama: m.nama })}
                    style={{ ...css.btn(C.green + "22", C.green), fontSize: 13, padding: "8px 16px", border: `1px solid ${C.green}44`, flex: 1, minWidth: 120 }}>
                    ✓ Tandai Ambil
                  </button>
                ) : (
                  // BR-AMBIL-02: batalkan wajib alasan
                  <button onClick={() => setBatalModal({ id: m.id, nama: m.nama })}
                    style={{ ...css.btn(C.orange + "33", C.orange), fontSize: 13, padding: "8px 16px", border: `1px solid ${C.orange}44`, flex: 1, minWidth: 120 }}>
                    ↩ Batalkan
                  </button>
                )}
                <Btn color={C.blue} onClick={() => { setForm({ ...m }); setErrors({}); setModal("edit"); }} style={{ fontSize: 13, padding: "8px 14px" }}>Edit</Btn>
                <AdminOnly session={session}>
                  <Btn color={C.red} onClick={() => setConfirmId(m.id)} style={{ fontSize: 13, padding: "8px 14px" }}>Hapus</Btn>
                </AdminOnly>
              </div>
            </div>
          ))}
        </>
      )}

      {tab === "sesi" && (
        <>
          {sesiWarning && (
            <div style={{ background: C.red + "18", border: `1px solid ${C.red}`, borderRadius: 4, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>⚠️ {sesiWarning}</span>
              <button onClick={() => setSesiWarning("")} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 16 }}>✕</button>
            </div>
          )}
          <Btn color={C.green} onClick={() => { setSesiForm({ nama: "", jam: "", kuota: "50" }); setSesiModal("add"); }} style={{ marginBottom: 14 }}>+ Tambah Sesi</Btn>
          {sesi.map(s => {
            const peserta = mustahiq.filter(m => m.sesi === s.nama);
            const sudah = peserta.filter(m => m.sudahAmbil).length;
            return (
              <div key={s.id} style={{ ...css.card, borderLeft: `3px solid ${C.blue}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: C.white }}>{s.nama}</div>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>⏱ {s.jam} · Kuota: {s.kuota}</div>
                    <ProgressBar value={sudah} max={peserta.length || 1} />
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{sudah}/{peserta.length} sudah ambil</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: C.blue }}>{peserta.length}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>terdaftar</div>
                  </div>
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                  <Btn color={C.blue} onClick={() => { setSesiForm({ ...s }); setSesiModal("edit"); }} style={{ fontSize: 12, padding: "5px 12px" }}>Edit</Btn>
                  <AdminOnly session={session}>
                    <Btn color={C.red} onClick={() => confirmDelSesi(s.id)} style={{ fontSize: 12, padding: "5px 12px" }}>Hapus</Btn>
                  </AdminOnly>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* Modals */}
      {modal && (
        <Modal onClose={() => setModal(null)} title={`${modal === "add" ? "Tambah" : "Edit"} Penerima Daging`}>
          <Input label="Nama" value={form.nama} onChange={v => setForm(p => ({ ...p, nama: v }))} error={errors.nama} />
          <Input label="RT / RW" value={form.rt} onChange={v => setForm(p => ({ ...p, rt: v }))} placeholder="RT 01" />
          <Input label="Alamat" value={form.alamat} onChange={v => setForm(p => ({ ...p, alamat: v }))} />
          <Input label="Jumlah Anggota KK" type="number" value={form.anggota} onChange={v => setForm(p => ({ ...p, anggota: v }))} error={errors.anggota} hint="Minimal 1 orang" />
          <Select label="Sesi Pengambilan" value={form.sesi} onChange={v => setForm(p => ({ ...p, sesi: v }))} options={sesi.map(s => s.nama)} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn color={C.green} onClick={saveMustahiq} style={{ flex: 1 }}>Simpan</Btn>
            <Btn color={C.muted} onClick={() => setModal(null)} style={{ flex: 1 }}>Batal</Btn>
          </div>
        </Modal>
      )}

      {sesiModal && (
        <Modal onClose={() => setSesiModal(null)} title={`${sesiModal === "add" ? "Tambah" : "Edit"} Sesi`}>
          <Input label="Nama Sesi" value={sesiForm.nama} onChange={v => setSesiForm(p => ({ ...p, nama: v }))} placeholder="Sesi 1 - Pagi" />
          <Input label="Jam" value={sesiForm.jam} onChange={v => setSesiForm(p => ({ ...p, jam: v }))} placeholder="08:00 - 10:00" />
          <Input label="Kuota Maks" type="number" value={sesiForm.kuota} onChange={v => setSesiForm(p => ({ ...p, kuota: v }))} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn color={C.green} onClick={saveSesi} style={{ flex: 1 }}>Simpan</Btn>
            <Btn color={C.muted} onClick={() => setSesiModal(null)} style={{ flex: 1 }}>Batal</Btn>
          </div>
        </Modal>
      )}

      {/* Modal batalkan pengambilan dengan alasan */}
      {batalModal && (
        <Modal onClose={() => { setBatalModal(null); setBatalAlasan(""); }} title="↩ Batalkan Pengambilan">
          <p style={{ color: C.muted, fontSize: 14, marginBottom: 14 }}>Batalkan status ambil untuk <strong style={{ color: C.white }}>{batalModal.nama}</strong>?</p>
          <Input label="Alasan Pembatalan (wajib)" value={batalAlasan} onChange={setBatalAlasan} placeholder="Masukkan alasan..." />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn color={C.orange} onClick={doBatal} style={{ flex: 1 }}>Konfirmasi Batal</Btn>
            <Btn color={C.muted} onClick={() => { setBatalModal(null); setBatalAlasan(""); }} style={{ flex: 1 }}>Tutup</Btn>
          </div>
        </Modal>
      )}

      {confirmTandai && (
        <ConfirmModal
          pesan={`Konfirmasi bahwa "${confirmTandai.nama}" sudah mengambil daging qurban?`}
          onConfirm={doTandai}
          onCancel={() => setConfirmTandai(null)}
          confirmLabel="Ya, Sudah Ambil"
          confirmColor={C.green}
        />
      )}
      {confirmId && <ConfirmModal pesan="Yakin hapus data penerima daging ini?" onConfirm={delMustahiq} onCancel={() => setConfirmId(null)} />}
      {confirmSesiId && <ConfirmModal pesan="Yakin hapus sesi ini?" onConfirm={delSesi} onCancel={() => setConfirmSesiId(null)} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// IMPORT PAGE — Paste tepat sebelum // ROOT APP (baris 2060)
// Requires: xlsx (npm install xlsx  ATAU  pakai CDN di index.html)
//   <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
// ══════════════════════════════════════════════════════════════

// Jika pakai bundler (Vite/CRA), uncomment baris ini:
// import * as XLSX from 'xlsx';
// Jika pakai CDN, biarkan — XLSX sudah tersedia via window.XLSX

const IMPORT_SCHEMAS = {
  hewan: {
    label: "Hewan",
    emoji: "🐾",
    fields: [
      { key: "nama",      label: "Nama Hewan",        required: true,  hint: "Cth: Sapi Gemuk 1" },
      { key: "jenis",     label: "Jenis",             required: true,  hint: "Sapi / Kambing / Domba" },
      { key: "berat",     label: "Berat (kg)",        required: true,  hint: "Angka, cth: 350" },
      { key: "asal",      label: "Asal / Peternak",   required: false, hint: "Cth: Pak Budi" },
      { key: "harga",     label: "Harga (Rp)",        required: true,  hint: "Angka, cth: 15000000" },
      { key: "kapasitas", label: "Kapasitas Peserta", required: false, hint: "7 untuk sapi, 1 untuk kambing/domba" },
    ],
    template: [
      ["nama","jenis","berat","asal","harga","kapasitas"],
      ["Sapi Gemuk 1","Sapi","380","Pak Budi - Magelang","18000000","7"],
      ["Kambing Hitam 1","Kambing","35","Pak Ahmad","2500000","1"],
    ],
  },
  mudhohi: {
    label: "Shohibul Qurban",
    emoji: "💳",
    fields: [
      { key: "nama",       label: "Nama Lengkap",       required: true,  hint: "Cth: Ahmad Fauzi" },
      { key: "hp",         label: "No. HP / WA",        required: true,  hint: "Format: 08xxxxxxxxxx" },
      { key: "alamat",     label: "Alamat / RT-RW",     required: false, hint: "Cth: RT 03/RW 02" },
      { key: "jenisHewan", label: "Jenis Qurban",       required: true,  hint: "Sapi / Kambing / Domba" },
      { key: "bayar",      label: "Status Bayar",       required: true,  hint: "Lunas / Belum Lunas / Cicilan" },
      { key: "nominal",    label: "Nominal Bayar (Rp)", required: true,  hint: "Angka, cth: 3000000" },
    ],
    template: [
      ["nama","hp","alamat","jenisHewan","bayar","nominal"],
      ["Ahmad Fauzi","081234567890","RT 03/RW 02","Sapi","Lunas","3000000"],
      ["Siti Aminah","082345678901","RT 01/RW 01","Kambing","Belum Lunas","2500000"],
    ],
  },
  mustahiq: {
    label: "Penerima Daging",
    emoji: "🎟️",
    fields: [
      { key: "nama",    label: "Nama",                  required: true,  hint: "Cth: Ibu Fatimah" },
      { key: "rt",      label: "RT / RW",               required: false, hint: "Cth: RT 02" },
      { key: "alamat",  label: "Alamat",                required: false, hint: "Cth: Gg. Mawar No. 3" },
      { key: "anggota", label: "Jumlah Anggota KK",     required: false, hint: "Angka, cth: 4" },
      { key: "sesi",    label: "Sesi Pengambilan",      required: false, hint: "Nama sesi yang ada di sistem" },
    ],
    template: [
      ["nama","rt","alamat","anggota","sesi"],
      ["Ibu Fatimah","RT 02","Gg. Mawar No. 3","4","Sesi 1 - Pagi"],
      ["Pak Umar","RT 05","Jl. Melati 12","3","Sesi 2 - Siang"],
    ],
  },
  nomorHewan: {
    label: "Daftar Nomor Hewan",
    emoji: "📋",
    description: "Format dari e-kwitansi / daftar nomor hewan qurban. Data diimport sebagai Shohibul Qurban dengan nomor hewan.",
    fields: [
      { key: "no",         label: "No. Urut",           required: false, hint: "Nomor urut baris (opsional)" },
      { key: "nama",       label: "Nama Shohibul Qurban", required: true,  hint: "Nama dari e-kwitansi" },
      { key: "nomorHewan", label: "Nomor Hewan",         required: true,  hint: "Cth: 001, 002, ..." },
      { key: "catatan",    label: "Catatan",             required: false, hint: "Perbaikan nama, ambil bagian, dll" },
    ],
    template: [
      ["No","Nama Shohibul Qurban (Domba/Kambing)","Nomor Hewan","Catatan / Perbaikan Nama"],
      ["1","Poppy Pudjiastuti binti Moestadhi","001","Perbaikan Nama, 18 April 2026"],
      ["2","Al Nazaha Zaahidah dan Keiko Margaret","002","-"],
      ["3","Kion Ibrahim Teja Arkatama","003","-"],
    ],
  },
};

const IMPORT_SYNONYMS = {
  nama:       ["nama","name","nama hewan","nama lengkap","nama penerima","nama shohibul"],
  jenis:      ["jenis","jenis hewan","type","tipe","kategori hewan"],
  berat:      ["berat","berat (kg)","bobot","kg","weight"],
  asal:       ["asal","asal/peternak","peternak","asal hewan","origin"],
  harga:      ["harga","harga (rp)","harga beli","price","nilai"],
  kapasitas:  ["kapasitas","kapasitas peserta","slot","max peserta"],
  hp:         ["hp","no hp","no. hp","nomor hp","whatsapp","wa","telepon","phone","no wa","no. wa"],
  alamat:     ["alamat","address","alamat/rt-rw","rt-rw","domisili"],
  jenisHewan: ["jenis qurban","jenis hewan","qurban","type","tipe qurban","hewan"],
  bayar:      ["status bayar","bayar","pembayaran","status pembayaran","status"],
  nominal:    ["nominal","nominal bayar (rp)","nominal (rp)","jumlah bayar","bayar (rp)","amount","nominal bayar"],
  rt:         ["rt","rt/rw","rtrw","rt / rw"],
  anggota:    ["anggota","jumlah anggota kk","anggota kk","jumlah anggota","kk","jumlah kk"],
  sesi:       ["sesi","sesi pengambilan","waktu ambil","jadwal"],
  no:         ["no","no.","no urut","no. urut","number"],
  nomorHewan: ["nomor hewan","no hewan","no. hewan","hewan no","animal no","kode hewan","id hewan","nomor\nhewan"],
  catatan:    ["catatan","catatan / perbaikan nama","catatan/perbaikan nama","keterangan","notes","note","info","perbaikan"],
};

function ImportPage({ hewan, setHewan, mudhohi, setMudhohi, mustahiq, setMustahiq, session}) {
  const [tab, setTab] = useState("nomorHewan");
  const [step, setStep] = useState("upload"); // upload | mapping | preview
  const [headers, setHeaders] = useState([]);
  const [rawRows, setRawRows] = useState([]);
  const [colMap, setColMap] = useState({});
  const [processed, setProcessed] = useState([]);
  const [filter, setFilter] = useState("all");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [toast, setToast] = useState({ msg: "", type: "ok" });
  const fileRef = useRef();

  const showToast = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast({ msg: "", type: "ok" }), 3000);
  };

  const schema = IMPORT_SCHEMAS[tab];

  // ── Reset saat ganti tab ──────────────────────────────────────
  const switchTab = (t) => {
    setTab(t);
    setStep("upload");
    setHeaders([]);
    setRawRows([]);
    setColMap({});
    setProcessed([]);
    setFilter("all");
    setFileName("");
    if (fileRef.current) fileRef.current.value = "";
  };

  // ── Download template ─────────────────────────────────────────
  const downloadTemplate = (type) => {
    const XLSXlib = window.XLSX;
    if (!XLSXlib) { showToast("Library XLSX belum dimuat. Tambahkan CDN di index.html.", "err"); return; }
    const s = IMPORT_SCHEMAS[type];
    const wb = XLSXlib.utils.book_new();
    const ws = XLSXlib.utils.aoa_to_sheet(s.template);
    XLSXlib.utils.book_append_sheet(wb, ws, s.label);
    XLSXlib.writeFile(wb, `template_${type}.xlsx`);
    showToast(`Template ${s.label} diunduh!`);
  };

  // ── PDF text parser for nomorHewan ───────────────────────────
  const parsePdf = (file) => {
    const loadPdfJs = () => new Promise((resolve, reject) => {
      if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error("Gagal memuat PDF.js"));
      document.head.appendChild(script);
    });

    showToast("⏳ Membaca PDF...");
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const pdfjsLib = await loadPdfJs();
        const pdf = await pdfjsLib.getDocument({ data: e.target.result }).promise;
        let fullText = "";
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const content = await page.getTextContent();
          // Join items with space, add newline between pages
          fullText += content.items.map(i => i.str).join(" ") + "\n";
        }

        // ── Parse rows from extracted text ──────────────────────
        // Pattern: number (1-3 digits) followed by name followed by 3-digit nomor hewan
        // We look for lines like: "1 Poppy Pudjiastuti binti Moestadhi 001 Perbaikan Nama..."
        // Strategy: find all occurrences of a row number at start, then extract name + nomor
        const rows = [];
        // Match: row_no (1-999), then text (name), then hewan_no (001-999), then optional catatan
        // Row numbers increment sequentially so we use that as anchor
        const linePattern = /\b(\d{1,3})\s+([\w][\s\S]{2,80}?)\s+(\d{3})\s*(-|[A-Z][^0-9\n]{0,80})?/g;
        let match;
        const seen = new Set();
        while ((match = linePattern.exec(fullText)) !== null) {
          const rowNo = parseInt(match[1]);
          const nama = match[2].trim().replace(/\s+/g, " ");
          const nomorHewan = match[3];
          const catatan = (match[4] || "").trim().replace(/^-$/, "");
          // Skip if rowNo out of plausible range or nama looks like garbage
          if (rowNo < 1 || rowNo > 999) continue;
          if (nama.length < 2) continue;
          // Skip known non-data patterns
          if (/^(no|nama|nomor|catatan|perbaikan|update|warna|keterangan|datang|shohibul)/i.test(nama)) continue;
          const key = `${rowNo}-${nomorHewan}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push([rowNo, nama, nomorHewan, catatan]);
        }

        if (rows.length === 0) {
          showToast("Tidak ada data yang berhasil diekstrak dari PDF. Pastikan PDF berisi teks (bukan scan).", "err");
          return;
        }

        // Set up as if it were an Excel file with fixed columns: no, nama, nomorHewan, catatan
        const hdrs = ["No", "Nama Shohibul Qurban", "Nomor Hewan", "Catatan"];
        setHeaders(hdrs);
        setRawRows(rows);
        setFileName(file.name);
        setColMap({ no: 0, nama: 1, nomorHewan: 2, catatan: 3 });
        setStep("mapping");
        showToast(`✅ ${rows.length} data berhasil diekstrak dari PDF!`);
      } catch (err) {
        showToast("Gagal membaca PDF: " + err.message, "err");
      }
    };
    reader.onerror = () => showToast("Gagal membaca file.", "err");
    reader.readAsArrayBuffer(file);
  };

  // ── File parsing ──────────────────────────────────────────────
  const parseFile = (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showToast("File terlalu besar (maks 10MB)", "err"); return; }
    // PDF: only supported for nomorHewan tab
    if (file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf") {
      if (tab !== "nomorHewan") {
        showToast("❌ Upload PDF hanya didukung di tab Daftar Nomor Hewan.", "err");
        return;
      }
      parsePdf(file);
      return;
    }
    const XLSXlib = window.XLSX;
    if (!XLSXlib) { showToast("Library XLSX belum dimuat. Tambahkan CDN di index.html.", "err"); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSXlib.read(new Uint8Array(e.target.result), { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSXlib.utils.sheet_to_json(ws, { header: 1, defval: "" });
        if (!data || data.length < 2) { showToast("File kosong atau tidak valid.", "err"); return; }

        // ── Smart header detection ──────────────────────────────
        // Scan first 10 rows to find the actual header row.
        // For nomorHewan: look for a row containing "nama" and a row containing "nomor" or angka.
        // For others: use row 0 as before.
        let headerRowIdx = 0;
        if (tab === "nomorHewan") {
          for (let i = 0; i < Math.min(10, data.length); i++) {
            const rowStr = data[i].map(c => String(c).toLowerCase()).join(" ");
            if (rowStr.includes("nama") && (rowStr.includes("nomor") || rowStr.includes("hewan") || rowStr.includes("no"))) {
              headerRowIdx = i;
              break;
            }
          }
        }

        const hdrs = (data[headerRowIdx] || []).map(h => String(h).trim());
        const rows = data.slice(headerRowIdx + 1).filter(r => r.some(c => c !== ""));

        setHeaders(hdrs);
        setRawRows(rows);
        setFileName(file.name);

        // ── Auto-detect mapping ─────────────────────────────────
        const map = {};
        schema.fields.forEach(f => {
          const syns = IMPORT_SYNONYMS[f.key] || [f.key];
          // Exact match first
          let idx = hdrs.findIndex(h => syns.includes(h.toLowerCase().trim()));
          // Contains match fallback (for nomorHewan with long/unusual headers)
          if (idx < 0) {
            if (f.key === "nama") {
              idx = hdrs.findIndex(h => {
                const hl = h.toLowerCase();
                return hl.includes("nama") && !hl.includes("nomor") && !hl.includes("no.");
              });
            } else if (f.key === "nomorHewan") {
              idx = hdrs.findIndex(h => {
                const hl = h.toLowerCase().replace(/\s+/g," ").replace(/\n/g," ");
                return (hl.includes("nomor") || hl.includes("no")) && hl.includes("hewan");
              });
              // Last resort: if there's a column with short numeric-looking header like "Nomor\nHewan"
              if (idx < 0) idx = hdrs.findIndex(h => /nomor[\s\n]*hewan/i.test(h));
            } else if (f.key === "catatan") {
              idx = hdrs.findIndex(h => h.toLowerCase().includes("catatan") || h.toLowerCase().includes("perbaikan") || h.toLowerCase().includes("keterangan"));
            } else if (f.key === "no") {
              idx = hdrs.findIndex(h => /^no\.?$/i.test(h.trim()));
            }
          }
          map[f.key] = idx >= 0 ? idx : -1;
        });
        setColMap(map);
        setStep("mapping");
        showToast(`${rows.length} baris berhasil dibaca dari baris header ke-${headerRowIdx + 1}!`);
      } catch (err) {
        showToast("Gagal membaca file: " + err.message, "err");
      }
    };
    reader.onerror = () => showToast("Gagal membaca file.", "err");
    reader.readAsArrayBuffer(file);
  };

  // ── Validation ────────────────────────────────────────────────
  const getVal = (row, key, map) => {
    const idx = map[key];
    return (idx !== undefined && idx >= 0) ? String(row[idx] || "").trim() : "";
  };

  const validateRow = (row, map) => {
    const errors = [];
    const g = (k) => getVal(row, k, map);
    if (tab === "hewan") {
      if (!g("nama")) errors.push("Nama wajib");
      if (!["sapi","kambing","domba"].includes(g("jenis").toLowerCase())) errors.push("Jenis: Sapi/Kambing/Domba");
      if (!g("berat") || isNaN(Number(g("berat"))) || Number(g("berat")) <= 0) errors.push("Berat tidak valid");
      if (!g("harga") || isNaN(Number(g("harga"))) || Number(g("harga")) <= 0) errors.push("Harga tidak valid");
    } else if (tab === "mudhohi") {
      if (!g("nama")) errors.push("Nama wajib");
      if (!/^08\d{8,12}$/.test(g("hp").replace(/\s/g,""))) errors.push("Format HP: 08xxxxxxxxxx");
      if (!["sapi","kambing","domba"].includes(g("jenisHewan").toLowerCase())) errors.push("Jenis: Sapi/Kambing/Domba");
      if (!["lunas","belum lunas","cicilan"].includes(g("bayar").toLowerCase())) errors.push("Bayar: Lunas/Belum Lunas/Cicilan");
      if (!g("nominal") || isNaN(Number(g("nominal"))) || Number(g("nominal")) <= 0) errors.push("Nominal tidak valid");
    } else if (tab === "mustahiq") {
      if (!g("nama")) errors.push("Nama wajib");
    } else if (tab === "nomorHewan") {
      if (!g("nama") || g("nama").toLowerCase().startsWith("update terakhir")) errors.push("Nama shohibul qurban wajib");
      const nomorRaw = g("nomorHewan").replace(/\D/g, ""); // strip non-digits
      if (!nomorRaw || isNaN(Number(nomorRaw))) errors.push("Nomor hewan wajib");
    }
    return errors;
  };

  const checkDup = (row, map) => {
    const g = (k) => getVal(row, k, map);
    if (tab === "mudhohi") {
      const hp = g("hp").replace(/\s/g,"");
      return mudhohi.some(m => m.hp === hp) ? "Nomor HP sudah terdaftar" : null;
    }
    if (tab === "hewan") {
      return hewan.some(h => h.nama.toLowerCase() === g("nama").toLowerCase()) ? "Nama hewan sudah ada" : null;
    }
    if (tab === "nomorHewan") {
      const nomorHewan = g("nomorHewan").trim().replace(/^0+/, "").padStart(3, "0");
      const namaLower = g("nama").toLowerCase().trim();
      if (mudhohi.some(m => m.nomorHewan === nomorHewan)) return "Nomor hewan sudah terdaftar";
      if (mudhohi.some(m => m.nama.toLowerCase().trim() === namaLower)) return "Nama sudah terdaftar";
      return null;
    }
    return null;
  };

  // ── Process preview ───────────────────────────────────────────
  const processPreview = () => {
    const rows = rawRows.map((row, idx) => {
      const errors = validateRow(row, colMap);
      const dup = errors.length === 0 ? checkDup(row, colMap) : null;
      const status = errors.length > 0 ? "invalid" : dup ? "duplicate" : "valid";
      return { idx, row, errors, dup, status };
    });
    setProcessed(rows);
    setStep("preview");
    setFilter("all");
  };

  // ── Import ────────────────────────────────────────────────────
  const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
  const fixBayar = (s) => {
    const v = s.toLowerCase().trim();
    if (v === "lunas") return "Lunas";
    if (v === "belum lunas") return "Belum Lunas";
    if (v === "cicilan") return "Cicilan";
    return s;
  };

  const doImport = () => {
    const valid = processed.filter(r => r.status === "valid");
    if (!valid.length) { showToast("Tidak ada data valid.", "err"); return; }
    const g = (row, k) => getVal(row, k, colMap);
    const ts = new Date().toISOString();

    const newItems = valid.map(r => {
      const base = { id: tab[0].toUpperCase() + uuid(), createdAt: ts, createdBy: session.panitiaId, updatedAt: ts, updatedBy: session.panitiaId };
      if (tab === "hewan") {
        const jenis = capitalize(g(r.row,"jenis"));
        return { ...base, jenis, nama: g(r.row,"nama"), berat: g(r.row,"berat"), asal: g(r.row,"asal"), harga: g(r.row,"harga"), kapasitas: g(r.row,"kapasitas") || (jenis === "Sapi" ? "7" : "1"), status: "Menunggu", statusHistory: [] };
      } else if (tab === "mudhohi") {
        return { ...base, nama: g(r.row,"nama"), hp: g(r.row,"hp").replace(/\s/g,""), alamat: g(r.row,"alamat"), jenisHewan: capitalize(g(r.row,"jenisHewan")), bayar: fixBayar(g(r.row,"bayar")), nominal: g(r.row,"nominal"), hewanId: "", cicilanLog: [], waLog: [] };
      } else if (tab === "nomorHewan") {
        const nomorRaw = g(r.row,"nomorHewan").replace(/\D/g, ""); // strip non-digits
        const nomorHewan = String(Number(nomorRaw)).padStart(3, "0");
        const catatanRaw = g(r.row,"catatan").trim();
        const catatan = (catatanRaw === "-" || catatanRaw === "") ? "" : catatanRaw;
        return {
          ...base,
          nama: g(r.row,"nama"),
          hewanId: "",
          nomorHewan,
          catatan,
          cicilanLog: [],
          waLog: [],
        };
      } else {
        return { ...base, nama: g(r.row,"nama"), rt: g(r.row,"rt"), alamat: g(r.row,"alamat"), anggota: g(r.row,"anggota") || "1", sesi: g(r.row,"sesi"), sudahAmbil: false, ambilLog: { ditandaiOleh: null, ditandaiWaktu: null, dibatalkanOleh: null, dibatalkanWaktu: null, alasanBatal: null } };
      }
    });

    if (tab === "hewan") setHewan(prev => [...prev, ...newItems]);
    else if (tab === "mudhohi") setMudhohi(prev => [...prev, ...newItems]);
    else if (tab === "nomorHewan") setMudhohi(prev => [...prev, ...newItems]);
    else setMustahiq(prev => [...prev, ...newItems]);
    showToast(`🎉 ${newItems.length} data berhasil diimport!`);
    setTimeout(() => switchTab(tab), 1200);
  };

  // ── Filtered rows ─────────────────────────────────────────────
  const filtered = processed.filter(r => filter === "all" || r.status === filter);
  const cntValid = processed.filter(r => r.status === "valid").length;
  const cntInvalid = processed.filter(r => r.status === "invalid").length;
  const cntDup = processed.filter(r => r.status === "duplicate").length;
  const visibleFields = schema.fields.filter(f => colMap[f.key] >= 0);

  const STATUS_ROW_COLOR = { valid: C.green, invalid: C.red, duplicate: C.orange };

  return (
    <div>
      <Toast msg={toast.msg} type={toast.type} />
      <SectionTitle emoji="📥" title="Import Data Excel" sub="Upload file .xlsx / .xls / .csv" />

      {/* Tab jenis data */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {Object.entries(IMPORT_SCHEMAS).map(([key, s]) => (
          <button key={key} onClick={() => switchTab(key)}
            style={{ ...css.btn(tab === key ? C.greenDark : C.surface, tab === key ? C.green : C.muted), border: `1px solid ${tab === key ? C.green : C.border}`, fontSize: 13 }}>
            {s.emoji} {s.label}
          </button>
        ))}
      </div>

      {/* Download template */}
      <div style={{ ...css.card, borderLeft: `3px solid ${C.blue}`, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>📄 Download template Excel sesuai format yang dibutuhkan:</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {Object.entries(IMPORT_SCHEMAS).map(([key, s]) => (
            <button key={key} onClick={() => downloadTemplate(key)}
              style={{ ...css.btn(C.blue + "22", C.blue), border: `1px solid ${C.blue}44`, fontSize: 12, padding: "8px 14px" }}>
              ⬇️ {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* STEP 1: Upload */}
      {step === "upload" && (
        <div style={css.card}>
          {tab === "nomorHewan" && (
            <div style={{ background: C.blue + "18", border: `1px solid ${C.blue}44`, borderRadius: 4, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: C.blue }}>
              ℹ️ <strong>Format Daftar Nomor Hewan</strong> — cocok untuk file Excel dari e-kwitansi qurban (seperti Masjid Mutiara Sunnah). Kolom yang dikenali: <em>No, Nama Shohibul Qurban, Nomor Hewan, Catatan</em>. Data akan masuk sebagai <strong>Shohibul Qurban</strong> dengan field nomor hewan.
            </div>
          )}
          <label style={css.label}>Upload File — {schema.label}</label>
          <div
            onClick={() => fileRef.current.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); parseFile(e.dataTransfer.files[0]); }}
            style={{ border: `2px dashed ${dragging ? C.green : C.border}`, borderRadius: 6, padding: "40px 20px", textAlign: "center", cursor: "pointer", background: dragging ? C.greenDark + "22" : C.inputBg, transition: "all 0.2s" }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>📊</div>
            <div style={{ fontWeight: 700, color: C.white, marginBottom: 4 }}>Klik atau drag file ke sini</div>
            <div style={{ fontSize: 12, color: C.muted }}>{tab === "nomorHewan" ? ".xlsx · .xls · .csv · .pdf — Maks 10MB" : ".xlsx · .xls · .csv — Maks 5MB"}</div>
          </div>
          <input ref={fileRef} type="file" accept={tab === "nomorHewan" ? ".xlsx,.xls,.csv,.pdf" : ".xlsx,.xls,.csv"} style={{ display: "none" }} onChange={e => { parseFile(e.target.files[0]); e.target.value = ""; }} />

          {/* Format guide */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, color: C.muted, fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Format Kolom — {schema.label}</div>
            {schema.fields.map(f => (
              <div key={f.key} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}22`, fontSize: 13 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: C.white }}>{f.label}</span>
                  {f.required
                    ? <span style={{ ...css.badge(C.green), fontSize: 10 }}>Wajib</span>
                    : <span style={{ ...css.badge(C.muted), fontSize: 10 }}>Opsional</span>}
                </div>
                <span style={{ color: C.muted, fontSize: 12 }}>{f.hint}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* STEP 2: Mapping */}
      {step === "mapping" && (
        <div style={css.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 700, color: C.white }}>🔗 Peta Kolom</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{fileName} · {rawRows.length} baris</div>
            </div>
            <Btn color={C.muted} onClick={() => setStep("upload")} style={{ fontSize: 12, padding: "6px 12px" }}>✕ Ganti File</Btn>
          </div>

          {/* Show detected headers */}
          <div style={{ background: C.border + "33", borderRadius: 4, padding: "8px 12px", marginBottom: 14, fontSize: 11, color: C.muted }}>
            <span style={{ color: C.white, fontWeight: 600 }}>Header terdeteksi: </span>
            {headers.map((h, i) => (
              <span key={i} style={{ background: C.border, borderRadius: 4, padding: "1px 6px", marginRight: 4, marginBottom: 4, display: "inline-block", color: C.text }}>{h || <em>(kosong)</em>}</span>
            ))}
          </div>

          {/* Warning if required fields unmapped */}
          {schema.fields.filter(f => f.required && (colMap[f.key] === undefined || colMap[f.key] < 0)).length > 0 && (
            <div style={{ background: C.red + "18", border: `1px solid ${C.red}44`, borderRadius: 4, padding: "8px 12px", marginBottom: 14, fontSize: 13, color: C.red }}>
              ⚠️ Field wajib belum terpetakan: <strong>{schema.fields.filter(f => f.required && (colMap[f.key] === undefined || colMap[f.key] < 0)).map(f => f.label).join(", ")}</strong>. Pilih kolom yang sesuai dari dropdown di bawah.
            </div>
          )}
          {schema.fields.map(f => (
            <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <div style={{ minWidth: 160 }}>
                <div style={{ fontSize: 13, color: C.white, fontWeight: 600 }}>{f.label}</div>
                <div style={{ fontSize: 10, color: f.required ? C.green : C.muted }}>{f.required ? "Wajib" : "Opsional"}</div>
              </div>
              <span style={{ color: C.muted, fontSize: 14 }}>→</span>
              <select value={colMap[f.key] ?? -1} onChange={e => setColMap(prev => ({ ...prev, [f.key]: parseInt(e.target.value) }))}
                style={{ ...css.select, flex: 1, minWidth: 160 }}>
                <option value={-1}>— Tidak dipetakan —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
              </select>
            </div>
          ))}
          <Btn color={C.green} onClick={processPreview} style={{ width: "100%", marginTop: 4 }}>👁 Preview & Validasi Data →</Btn>
        </div>
      )}

      {/* STEP 3: Preview */}
      {step === "preview" && (
        <div>
          <div style={css.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 700, color: C.white }}>Preview Data</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                  <span style={{ color: C.green }}>✅ Valid: {cntValid}</span>
                  {" · "}
                  <span style={{ color: C.red }}>❌ Error: {cntInvalid}</span>
                  {" · "}
                  <span style={{ color: C.orange }}>⚠️ Duplikat: {cntDup}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn color={C.muted} onClick={() => setStep("mapping")} style={{ fontSize: 12, padding: "8px 12px" }}>← Kembali</Btn>
                <Btn color={C.green} onClick={doImport} disabled={cntValid === 0} style={{ fontSize: 12, padding: "8px 14px" }}>
                  ✅ Import {cntValid} Data Valid
                </Btn>
              </div>
            </div>

            {/* Filter */}
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              {[
                { id: "all", label: `Semua (${processed.length})`, color: C.green },
                { id: "valid", label: `✅ Valid (${cntValid})`, color: C.green },
                { id: "invalid", label: `❌ Error (${cntInvalid})`, color: C.red },
                { id: "duplicate", label: `⚠️ Duplikat (${cntDup})`, color: C.orange },
              ].map(f => (
                <button key={f.id} onClick={() => setFilter(f.id)}
                  style={{ ...css.btn(filter === f.id ? f.color + "22" : C.surface, filter === f.id ? f.color : C.muted), border: `1px solid ${filter === f.id ? f.color + "44" : C.border}`, fontSize: 12, padding: "6px 12px" }}>
                  {f.label}
                </button>
              ))}
            </div>

            {/* Tabel */}
            <div style={{ overflowX: "auto", borderRadius: 4, border: `1px solid ${C.border}` }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ background: C.surfaceAlt, color: C.muted, fontSize: 11, padding: "9px 12px", textAlign: "left", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>#</th>
                    {visibleFields.map(f => (
                      <th key={f.key} style={{ background: C.surfaceAlt, color: C.muted, fontSize: 11, padding: "9px 12px", textAlign: "left", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{f.label}</th>
                    ))}
                    <th style={{ background: C.surfaceAlt, color: C.muted, fontSize: 11, padding: "9px 12px", textAlign: "left", borderBottom: `1px solid ${C.border}` }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 200).map(r => (
                    <tr key={r.idx} style={{ borderLeft: `3px solid ${STATUS_ROW_COLOR[r.status]}` }}>
                      <td style={{ padding: "8px 12px", color: C.muted, fontSize: 11, borderBottom: `1px solid ${C.border}22` }}>{r.idx + 1}</td>
                      {visibleFields.map(f => (
                        <td key={f.key} style={{ padding: "8px 12px", color: C.text, borderBottom: `1px solid ${C.border}22`, whiteSpace: "nowrap" }}>
                          {getVal(r.row, f.key, colMap) || <span style={{ color: C.muted }}>—</span>}
                        </td>
                      ))}
                      <td style={{ padding: "8px 12px", borderBottom: `1px solid ${C.border}22` }}>
                        {r.status === "valid" && <span style={{ ...css.badge(C.green), fontSize: 11 }}>✅ Valid</span>}
                        {r.status === "duplicate" && <span style={{ ...css.badge(C.orange), fontSize: 11 }} title={r.dup}>⚠️ Duplikat</span>}
                        {r.status === "invalid" && <span style={{ ...css.badge(C.red), fontSize: 11 }} title={r.errors.join(", ")}>❌ {r.errors[0]}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length > 200 && (
                <div style={{ textAlign: "center", color: C.muted, fontSize: 12, padding: "10px" }}>Menampilkan 200 dari {filtered.length} baris</div>
              )}
              {filtered.length === 0 && (
                <div style={{ textAlign: "center", color: C.muted, fontSize: 13, padding: "30px" }}>Tidak ada data untuk filter ini.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ══════════════════════════════════════════════════════════════
// SETTINGS PAGE
// ══════════════════════════════════════════════════════════════
function SettingsPage({ session, hewan, mudhohi, mustahiq, sesi, setHewan, setMudhohi, setMustahiq, setSesi }) {
  const [theme, setTheme] = useTheme();

  const handleThemeChange = (t) => {
    setTheme(t);
  };

  const isAdmin = session?.role === "admin";

  return (
    <div>
      <SectionTitle emoji="⚙️" title="Pengaturan" sub="Konfigurasi tampilan dan data aplikasi" />

      {/* Tampilan / Theme */}
      <div style={css.card}>
        <div style={{ fontWeight: 700, color: C.white, marginBottom: 4 }}>🎨 Tampilan</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>Pilih tema tampilan aplikasi sesuai preferensi kamu.</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => handleThemeChange("dark")}
            style={{
              flex: 1, padding: "14px 10px", borderRadius: 4,
              border: `2px solid ${theme === "dark" ? C.green : C.border}`,
              background: theme === "dark" ? C.greenDark : C.inputBg,
              cursor: "pointer", display: "flex", flexDirection: "column",
              alignItems: "center", gap: 6, transition: "all 0.15s",
            }}>
            <span style={{ fontSize: 22 }}>🌙</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: theme === "dark" ? C.green : C.muted }}>Dark Mode</span>
            {theme === "dark" && <span style={{ fontSize: 10, color: C.green, fontWeight: 700 }}>✓ Aktif</span>}
          </button>
          <button
            onClick={() => handleThemeChange("light")}
            style={{
              flex: 1, padding: "14px 10px", borderRadius: 4,
              border: `2px solid ${theme === "light" ? C.green : C.border}`,
              background: theme === "light" ? C.greenDark : C.inputBg,
              cursor: "pointer", display: "flex", flexDirection: "column",
              alignItems: "center", gap: 6, transition: "all 0.15s",
            }}>
            <span style={{ fontSize: 22 }}>☀️</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: theme === "light" ? C.green : C.muted }}>Light Mode</span>
            {theme === "light" && <span style={{ fontSize: 10, color: C.green, fontWeight: 700 }}>✓ Aktif</span>}
          </button>
        </div>
      </div>

      <div style={{ ...css.card, borderLeft: `3px solid ${C.green}` }}>
        <div style={{ fontWeight: 700, color: C.green, marginBottom: 8 }}>☁️ Penyimpanan Cloud</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
          Data aplikasi tersimpan di <strong style={{ color: C.green }}>Firebase Firestore</strong> dan tersinkronisasi secara real-time di semua perangkat. Backup tetap disarankan sebagai cadangan tambahan.
        </div>
      </div>

      {isAdmin && (
        <ResetDataSection
          session={session}
          hewan={hewan} mudhohi={mudhohi} mustahiq={mustahiq} sesi={sesi}
          setHewan={setHewan} setMudhohi={setMudhohi} setMustahiq={setMustahiq} setSesi={setSesi}
        />
      )}
    </div>
  );
}

// ── Reset & Export section (Admin Only) ───────────────────────
function ResetDataSection({ session, hewan, mudhohi, mustahiq, sesi, setHewan, setMudhohi, setMustahiq, setSesi }) {
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetInput, setResetInput] = useState("");
  const [toast, setToast] = useState({ msg: "", type: "ok" });
  const showToast = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast({ msg: "", type: "ok" }), 3000); };

  const exportData = () => {
    try {
      const data = {
        qurban_hewan: hewan || [],
        qurban_mudhohi: mudhohi || [],
        qurban_mustahiq: mustahiq || [],
        qurban_sesi: sesi || [],
        exportedAt: new Date().toISOString(),
        source: "Firebase Firestore",
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `qurban-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      showToast("Data berhasil diekspor!");
    } catch (e) {
      showToast("Gagal mengekspor data.", "err");
    }
  };

  const doReset = async () => {
    if (resetInput !== "RESET") { showToast("Ketik RESET untuk konfirmasi.", "err"); return; }
    try {
      showToast("⏳ Menghapus data dari Firestore...");
      await Promise.all([
        fsReplaceAll(COL.hewan, []),
        fsReplaceAll(COL.mudhohi, []),
        fsReplaceAll(COL.mustahiq, []),
        fsReplaceAll(COL.sesi, []),
      ]);
      setHewan([]);
      setMudhohi([]);
      setMustahiq([]);
      setSesi([]);
      setShowResetConfirm(false);
      setResetInput("");
      showToast("✅ Data berhasil direset.");
    } catch (e) {
      showToast("Gagal reset data: " + e.message, "err");
    }
  };

  return (
    <div>
      <Toast msg={toast.msg} type={toast.type} />
      <div style={{ ...css.card, borderLeft: `3px solid ${C.blue}` }}>
        <div style={{ fontWeight: 700, color: C.blue, marginBottom: 8 }}>💾 Backup Data</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
          Unduh semua data sebagai file JSON sebagai cadangan.
        </div>
        <Btn color={C.blue} onClick={exportData}>⬇️ Ekspor Backup JSON</Btn>
      </div>

      <div style={{ ...css.card, borderLeft: `3px solid ${C.red}` }}>
        <div style={{ fontWeight: 700, color: C.red, marginBottom: 8 }}>🗑️ Reset Seluruh Data</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
          Hapus semua data hewan, shohibul qurban, dan penerima daging. Aksi ini tidak bisa dibatalkan.
        </div>
        {!showResetConfirm ? (
          <Btn color={C.red} onClick={() => setShowResetConfirm(true)}>Reset Data...</Btn>
        ) : (
          <div>
            <div style={{ fontSize: 13, color: C.red, marginBottom: 10 }}>Ketik <strong>RESET</strong> untuk mengkonfirmasi:</div>
            <Input value={resetInput} onChange={setResetInput} placeholder="RESET" />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn color={C.red} onClick={doReset} style={{ flex: 1 }}>Konfirmasi Reset</Btn>
              <Btn color={C.muted} onClick={() => { setShowResetConfirm(false); setResetInput(""); }} style={{ flex: 1 }}>Batal</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ROOT APP
// ══════════════════════════════════════════════════════════════
const NAV = [
  { id: "dashboard", emoji: "📊", label: "Dashboard" },
  { id: "hewan", emoji: "🐾", label: "Hewan" },
  { id: "mudhohi", emoji: "💳", label: "Shohibul Qurban" },
  { id: "mustahiq", emoji: "🎟️", label: "Penerima Daging" },
  { id: "import", emoji: "📥", label: "Import" },
  { id: "settings", emoji: "⚙️", label: "Pengaturan" },
];

const DUMMY_SESSION = { panitiaId: "SYSTEM", panitiaName: "Panitia", role: "admin" };

// ── Firebase loading screen ───────────────────────────────────
function FirebaseLoading() {
  const [theme] = useTheme();
  return (
    <div style={{ background: THEMES[theme].bg, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
      <div style={{ fontSize: 48 }}>🕌</div>
      <div style={{ fontWeight: 900, fontSize: 18, color: THEMES[theme].white }}>Qurban App</div>
      <div style={{ fontSize: 13, color: THEMES[theme].muted }}>⏳ Memuat data dari Firebase...</div>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState("dashboard");
  const navRef = useRef(null);
  const [theme] = useTheme();

  // ── Firestore state ───────────────────────────────────────────
  // Semua data utama diambil realtime dari Firestore.
  // `loading` true sampai semua 6 koleksi sudah menerima snapshot pertama.
  const [loading, setLoading] = useState(true);
  const loadedRef = useRef({ hewan: false, mudhohi: false, mustahiq: false, sesi: false });

  const markLoaded = (key) => {
    loadedRef.current[key] = true;
    if (Object.values(loadedRef.current).every(Boolean)) setLoading(false);
  };

  const [hewan, setHewanState] = useState(SEED_HEWAN);
  const [mudhohi, setMudhohiState] = useState(SEED_MUDHOHI);
  const [mustahiq, setMustahiqState] = useState(SEED_MUSTAHIQ);
  const [sesi, setSesiState] = useState(SEED_SESI);

  // Keep prev refs for diff-sync
  const prevHewan    = useRef(hewan);
  const prevMudhohi  = useRef(mudhohi);
  const prevMustahiq = useRef(mustahiq);
  const prevSesi     = useRef(sesi);

  // ── Subscribe to Firestore collections on mount ───────────────
  useEffect(() => {
    const unsubs = [
      fsSubscribe(COL.hewan, data => { setHewanState(data); prevHewan.current = data; markLoaded("hewan"); }),
      fsSubscribe(COL.mudhohi, data => { setMudhohiState(data); prevMudhohi.current = data; markLoaded("mudhohi"); }),
      fsSubscribe(COL.mustahiq, data => { setMustahiqState(data); prevMustahiq.current = data; markLoaded("mustahiq"); }),
      fsSubscribe(COL.sesi, data => { setSesiState(data); prevSesi.current = data; markLoaded("sesi"); }),
    ];
    return () => unsubs.forEach(u => u());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Firestore-aware setters (sync diff to Firestore) ──────────
  // Components call these exactly like the old setState — the wrapper
  // additionally syncs the changes to Firestore.

  const setHewan = useCallback((updater) => {
    setHewanState(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      fsSync(COL.hewan, prev, next);
      prevHewan.current = next;
      return next;
    });
  }, []);

  const setMudhohi = useCallback((updater) => {
    setMudhohiState(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      fsSync(COL.mudhohi, prev, next);
      prevMudhohi.current = next;
      return next;
    });
  }, []);

  const setMustahiq = useCallback((updater) => {
    setMustahiqState(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      fsSync(COL.mustahiq, prev, next);
      prevMustahiq.current = next;
      return next;
    });
  }, []);

  const setSesi = useCallback((updater) => {
    setSesiState(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      fsSync(COL.sesi, prev, next);
      prevSesi.current = next;
      return next;
    });
  }, []);



  useEffect(() => {
    if (navRef.current) {
      const active = navRef.current.querySelector("[data-active='true']");
      if (active) active.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
    }
  }, [page]);

  if (loading) return <FirebaseLoading />;

  return (
    <div style={{ background: THEMES[theme].bg, minHeight: "100vh", fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif", color: THEMES[theme].text }}>
      {/* Top bar */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "10px 16px", display: "flex", alignItems: "center", position: "sticky", top: 0, zIndex: 50 }}>
        <span style={{ fontSize: 20, marginRight: 10 }}>🕌</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: C.white, lineHeight: 1.1 }}>Qurban App</div>
          <div style={{ fontSize: 10, color: C.muted, fontFamily: "monospace" }}>{new Date().getFullYear()} M</div>
        </div>
      </div>

      {/* Nav */}
      <div style={{ background: C.surface, borderBottom: `2px solid ${C.border}` }}>
        <div ref={navRef} style={{ display: "flex", overflowX: "auto", scrollbarWidth: "none" }}>
          {NAV.map(n => (
            <button key={n.id} data-active={page === n.id ? "true" : "false"} onClick={() => setPage(n.id)}
              style={{ flex: "1 0 auto", background: "transparent", border: "none", color: page === n.id ? C.green : C.muted, padding: "10px 4px 8px", cursor: "pointer", fontSize: 10, borderBottom: page === n.id ? `2px solid ${C.green}` : "2px solid transparent", marginBottom: -2, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, transition: "color 0.15s, border-color 0.15s", minHeight: 52, minWidth: 48, touchAction: "manipulation" }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{n.emoji}</span>
              <span style={{ whiteSpace: "nowrap", fontWeight: page === n.id ? 700 : 400 }}>{n.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Pages */}
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "16px 12px 96px" }}>
        {page === "dashboard" && <Dashboard hewan={hewan} mudhohi={mudhohi} mustahiq={mustahiq} setPage={setPage} />}
        {page === "hewan" && <HewanPage hewan={hewan} setHewan={setHewan} mudhohi={mudhohi} setMudhohi={setMudhohi} session={DUMMY_SESSION} />}
        {page === "mudhohi" && <MudhohiPage mudhohi={mudhohi} setMudhohi={setMudhohi} hewan={hewan} fonnteToken="" session={DUMMY_SESSION} />}
        {page === "mustahiq" && <MustahiqPage mustahiq={mustahiq} setMustahiq={setMustahiq} sesi={sesi} setSesi={setSesi} session={DUMMY_SESSION} />}
        {page === "import" && <ImportPage hewan={hewan} setHewan={setHewan} mudhohi={mudhohi} setMudhohi={setMudhohi} mustahiq={mustahiq} setMustahiq={setMustahiq} session={DUMMY_SESSION} />}
        {page === "settings" && <SettingsPage session={DUMMY_SESSION} hewan={hewan} mudhohi={mudhohi} mustahiq={mustahiq} sesi={sesi} setHewan={setHewan} setMudhohi={setMudhohi} setMustahiq={setMustahiq} setSesi={setSesi} />}
      </div>
    </div>
  );
}
