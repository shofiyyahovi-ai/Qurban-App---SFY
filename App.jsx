import { useState, useEffect, useRef, useCallback } from "react";

// ══════════════════════════════════════════════════════════════
// CONSTANTS & UTILS
// ══════════════════════════════════════════════════════════════
const STATUS_FLOW = ["Menunggu", "Disembelih", "Dikuliti", "Selesai"];
const JENIS_HEWAN = ["Sapi", "Kambing", "Domba"];
const KAPASITAS_DEFAULT = { Sapi: 7, Kambing: 1, Domba: 1 };

// ── Simple hash (XOR-based, not bcrypt – browser limitation) ──
// BR-AUTH-02: Hash deterministik untuk lingkungan browser
function hashPassword(pass) {
  // Minimal, deterministik, tidak reversible trivially
  let h = 0;
  for (let i = 0; i < pass.length; i++) {
    h = Math.imul(31, h) + pass.charCodeAt(i) | 0;
  }
  return "H$" + Math.abs(h).toString(36) + "$" + btoa(pass.split("").reverse().join("")).slice(0, 8);
}
function verifyPassword(pass, hash) {
  return hashPassword(pass) === hash;
}

// ── Generate UUID ─────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Timestamp ISO ─────────────────────────────────────────────
const now = () => new Date().toISOString();

// ── localStorage helpers ──────────────────────────────────────
function loadStorage(key, fallback) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
  catch { return fallback; }
}
function saveStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ── sessionStorage / localStorage session ────────────────────
function loadSession() {
  try {
    const raw = sessionStorage.getItem("qurban_session") || localStorage.getItem("qurban_session_remember");
    if (!raw) return null;
    const s = JSON.parse(raw);
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

// ── Audit log helper ──────────────────────────────────────────
// BR-LOG-01, BR-LOG-02, BR-LOG-03
function createLogEntry(session, aksi, modul, targetId, targetDesc, detail = {}) {
  return {
    id: "LOG_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    waktu: now(),
    panitiaId: session?.panitiaId || "SYSTEM",
    panitiaName: session?.panitiaName || "System",
    role: session?.role || "-",
    aksi,
    modul,
    targetId: targetId || "",
    targetDesc: targetDesc || "",
    detail,
  };
}

// ── Fonnte WA sender ──────────────────────────────────────────
async function sendWA(token, target, message) {
  try {
    const res = await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: { Authorization: token },
      body: new URLSearchParams({ target, message, countryCode: "62" }),
    });
    return await res.json();
  } catch { return { status: false, reason: "Gagal kirim" }; }
}
async function sendWAWithImage(token, target, message, imageBase64) {
  try {
    const body = new URLSearchParams({ target, message, countryCode: "62" });
    if (imageBase64) body.append("image", imageBase64);
    const res = await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: { Authorization: token },
      body,
    });
    return await res.json();
  } catch { return { status: false, reason: "Gagal kirim" }; }
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
    passwordHash: hashPassword("panitiaqurban2026"),
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
const SEED_RAB = [];

// ══════════════════════════════════════════════════════════════
// COLOR & STYLES
// ══════════════════════════════════════════════════════════════
const C = {
  bg: "#0C0F0A", surface: "#131810", border: "#1E2B1A",
  green: "#4CAF50", greenDark: "#1B4332", greenLight: "#81C784",
  gold: "#D4A017", red: "#EF5350", orange: "#FF8F00",
  blue: "#42A5F5", purple: "#AB47BC", text: "#E8F5E9",
  muted: "#607D6B", white: "#F1F8F0",
};
const STATUS_COLOR = { Menunggu: C.muted, Disembelih: C.red, Dikuliti: C.orange, Selesai: C.green };
const BAYAR_COLOR = { Lunas: C.green, "Belum Lunas": C.red, Cicilan: C.orange };
const JENIS_COLOR = { Sapi: C.gold, Kambing: C.green, Domba: C.purple };
const JENIS_EMOJI = { Sapi: "🐄", Kambing: "🐐", Domba: "🐑" };
const css = {
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 20px", marginBottom: 12 },
  input: { background: "#0A0D09", border: `1px solid ${C.border}`, borderRadius: 8, padding: "11px 13px", color: C.text, fontSize: 16, width: "100%", boxSizing: "border-box", outline: "none" },
  select: { background: "#0A0D09", border: `1px solid ${C.border}`, borderRadius: 8, padding: "11px 13px", color: C.text, fontSize: 16, width: "100%", boxSizing: "border-box" },
  btn: (bg, color = "#fff") => ({ background: bg, color, border: "none", borderRadius: 8, padding: "11px 18px", fontWeight: 700, cursor: "pointer", fontSize: 14, minHeight: 44, touchAction: "manipulation" }),
  label: { fontSize: 12, color: C.muted, fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6, display: "block" },
  badge: (color) => ({ background: color + "22", border: `1px solid ${color}44`, color, padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 700 }),
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
    <div style={{ position: "fixed", inset: 0, background: "#000000CC", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose && onClose(); }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "20px 20px 0 0", padding: "20px 20px 32px", width: "100%", maxWidth: 520, maxHeight: "92vh", overflowY: "auto", position: "relative" }}>
        <div style={{ width: 40, height: 4, background: C.border, borderRadius: 99, margin: "0 auto 16px" }} />
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
    <div style={{ position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)", background: isErr ? "#3B0000" : C.greenDark, border: `1px solid ${isErr ? C.red : C.green}`, borderRadius: 10, padding: "12px 20px", color: isErr ? C.red : C.greenLight, fontSize: 14, zIndex: 200, boxShadow: "0 4px 20px #00000088", display: "flex", alignItems: "center", gap: 8, maxWidth: "calc(100vw - 32px)", whiteSpace: "pre-wrap", textAlign: "center" }}>
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
        {detail && <p style={{ color: C.red, fontSize: 13, marginBottom: 24, background: "#3B000033", borderRadius: 8, padding: "8px 12px", border: `1px solid ${C.red}33` }}>{detail}</p>}
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

// ── Permission hook (Section 5.1) ─────────────────────────────
function usePermission(session) {
  const isAdmin = session?.role === "admin";
  return {
    canDelete: isAdmin,
    canResetStatus: isAdmin,
    canManageAccounts: isAdmin,
    canConfigWA: isAdmin,
    canExport: isAdmin,
    canEditLockedData: isAdmin,
    canVerifyRAB: isAdmin,
    canAdd: true,
    canEdit: true,
    canUpdateStatus: true,
    canSendWA: true,
    canTandaiAmbil: true,
  };
}

// ── isHewanTerkunci (Section 5.3) ─────────────────────────────
function isHewanTerkunci(hewan, session) {
  return hewan.status === "Selesai" && session?.role !== "admin";
}

// ══════════════════════════════════════════════════════════════
// LOGIN PAGE
// ══════════════════════════════════════════════════════════════
// BR-AUTH-01 ~ BR-AUTH-08
function LoginPage({ onLogin, panitiaList, setPanitiaList, addLog }) {
  const [username, setUsername] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [remember, setRemember] = useState(false);
  const [lockMsg, setLockMsg] = useState("");

  const handle = () => {
    if (!username.trim() || !pass.trim()) { setErr("Username dan password wajib diisi."); return; }

    const user = panitiaList.find(u => u.username === username.toLowerCase().trim());
    if (!user) { setErr("Username atau password salah."); return; }

    // BR-AUTH-03: akun nonaktif
    if (user.status === "nonaktif") {
      setErr("Akun Anda telah dinonaktifkan. Hubungi admin.");
      addLog(null, "AUTH_LOGIN_LOCKED", "AUTH", user.id, user.nama, { info: "Akun nonaktif" });
      return;
    }

    // BR-AUTH-07: cek lockout
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      const sisa = Math.ceil((new Date(user.lockedUntil) - new Date()) / 60000);
      setLockMsg(`Akun terkunci. Coba lagi dalam ${sisa} menit.`);
      addLog(null, "AUTH_LOGIN_LOCKED", "AUTH", user.id, user.nama, { info: "Akun terkunci sementara" });
      return;
    }

    if (!verifyPassword(pass, user.passwordHash)) {
      const attempts = (user.loginAttempts || 0) + 1;
      const locked = attempts >= 5;
      const lockedUntil = locked ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
      setPanitiaList(prev => prev.map(u => u.id === user.id ? { ...u, loginAttempts: attempts, lockedUntil } : u));
      setErr("Username atau password salah.");
      addLog(null, "AUTH_LOGIN_FAIL", "AUTH", user.id, user.nama, { attempts });
      if (locked) setLockMsg("Akun dikunci 15 menit karena 5x gagal login.");
      return;
    }

    // Reset attempts on success
    setPanitiaList(prev => prev.map(u => u.id === user.id ? { ...u, loginAttempts: 0, lockedUntil: null } : u));

    const session = {
      panitiaId: user.id,
      panitiaName: user.nama,
      role: user.role,
      loginAt: now(),
      token: uuid(),
      mustChangePassword: user.mustChangePassword || false,
    };
    saveSession(session, remember);
    addLog(session, "AUTH_LOGIN_OK", "AUTH", user.id, user.nama, {});
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
          <Btn color={C.green} onClick={handle} style={{ width: "100%", padding: "11px 0", fontSize: 14 }}>Masuk →</Btn>

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
function GantiPasswordModal({ session, setPanitiaList, onDone, addLog }) {
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");

  const save = () => {
    if (pass1.length < 6) { setErr("Password minimal 6 karakter."); return; }
    if (pass1 !== pass2) { setErr("Password tidak cocok."); return; }
    setPanitiaList(prev => prev.map(u =>
      u.id === session.panitiaId
        ? { ...u, passwordHash: hashPassword(pass1), mustChangePassword: false, updatedAt: now(), updatedBy: session.panitiaId }
        : u
    ));
    addLog(session, "AUTH_CHANGE_PASSWORD", "AUTH", session.panitiaId, session.panitiaName, {});
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
          <Input label="Password Baru" type="password" value={pass1} onChange={setPass1} />
          <Input label="Konfirmasi Password" type="password" value={pass2} onChange={setPass2} error={err} />
          <Btn color={C.green} onClick={save} style={{ width: "100%" }}>Simpan Password</Btn>
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
  const pct = totalHewan ? Math.round((selesai / totalHewan) * 100) : 0;

  const statCards = [
    { icon: "🐄", label: "Sapi", value: hewan.filter(h => h.jenis === "Sapi").length, color: C.gold, page: "hewan" },
    { icon: "🐐", label: "Kambing", value: hewan.filter(h => h.jenis === "Kambing").length, color: C.green, page: "hewan" },
    { icon: "🐑", label: "Domba", value: hewan.filter(h => h.jenis === "Domba").length, color: C.purple, page: "hewan" },
    { icon: "👥", label: "Mudhohi", value: mudhohi.length, color: C.blue, page: "mudhohi" },
    { icon: "✅", label: "Lunas", value: lunas, color: C.greenLight, page: "mudhohi" },
    { icon: "⏳", label: "Belum Lunas", value: belumLunas, color: C.red, page: "mudhohi" },
    { icon: "🤲", label: "Mustahiq", value: mustahiq.length, color: C.orange, page: "mustahiq" },
    { icon: "🧺", label: "Sudah Ambil", value: sudahAmbil, color: C.greenLight, page: "mustahiq" },
  ];

  return (
    <div>
      <SectionTitle emoji="📊" title="Dashboard" sub="Ringkasan status qurban hari ini" />
      {belumLunas > 0 && (
        <div onClick={() => setPage("mudhohi")} style={{ ...css.card, borderLeft: `3px solid ${C.red}`, background: "#3B000022", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: C.red }}>⚠️ {belumLunas} mudhohi belum lunas pembayaran</div>
          <span style={{ fontSize: 12, color: C.muted }}>Lihat →</span>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, marginBottom: 20 }}>
        {statCards.map(sc => (
          <div key={sc.label} onClick={() => setPage(sc.page)} style={{ ...css.card, borderLeft: `3px solid ${sc.color}`, marginBottom: 0, textAlign: "center", padding: "16px 10px", cursor: "pointer" }}>
            <div style={{ fontSize: 24 }}>{sc.icon}</div>
            <div style={{ fontSize: 26, fontWeight: 900, color: sc.color, lineHeight: 1.2 }}>{sc.value}</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sc.label}</div>
          </div>
        ))}
      </div>
      <div style={css.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontWeight: 700, color: C.white }}>🔪 Progress Penyembelihan</span>
          <span style={{ fontWeight: 900, color: C.green, fontSize: 18 }}>{pct}%</span>
        </div>
        <ProgressBar value={selesai} max={totalHewan} />
        <div style={{ marginTop: 10, display: "flex", gap: 12, flexWrap: "wrap" }}>
          {STATUS_FLOW.map(st => (
            <div key={st} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLOR[st] }} />
              <span style={{ fontSize: 12, color: C.muted }}>{st}: <strong style={{ color: C.text }}>{hewan.filter(h => h.status === st).length}</strong></span>
            </div>
          ))}
        </div>
      </div>
      <div style={css.card}>
        <div style={{ fontWeight: 700, color: C.white, marginBottom: 12 }}>🎟️ Distribusi Daging</div>
        <div style={{ display: "flex", gap: 20, marginBottom: 12 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: C.green }}>{sudahAmbil}</div>
            <div style={{ fontSize: 12, color: C.muted }}>Sudah Ambil</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: C.red }}>{mustahiq.length - sudahAmbil}</div>
            <div style={{ fontSize: 12, color: C.muted }}>Belum Ambil</div>
          </div>
        </div>
        <ProgressBar value={sudahAmbil} max={mustahiq.length} />
      </div>
      <div style={css.card}>
        <div style={{ fontWeight: 700, color: C.white, marginBottom: 10 }}>🐾 Status Semua Hewan</div>
        {JENIS_HEWAN.map(jenis => {
          const list = hewan.filter(h => h.jenis === jenis);
          if (!list.length) return null;
          return (
            <div key={jenis} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: JENIS_COLOR[jenis], fontFamily: "monospace", letterSpacing: 1, marginBottom: 6, textTransform: "uppercase" }}>{JENIS_EMOJI[jenis]} {jenis}</div>
              {list.map(h => (
                <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 14, color: C.text }}>{h.nama}</span>
                  <Pill text={h.status} color={STATUS_COLOR[h.status]} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// HEWAN PAGE
// ══════════════════════════════════════════════════════════════
function HewanPage({ hewan, setHewan, mudhohi, setMudhohi, session, addLog }) {
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
      if (Number(form.kapasitas) < terisi) e.kapasitas = `Kapasitas tidak boleh kurang dari ${terisi} (jumlah mudhohi terdaftar)`;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = () => {
    if (!validate()) return;
    if (modal === "add") {
      const prefix = form.jenis === "Sapi" ? "S" : form.jenis === "Kambing" ? "K" : "D";
      const newHewan = { ...form, id: prefix + Date.now(), createdBy: session.panitiaId, createdAt: now(), updatedBy: session.panitiaId, updatedAt: now(), statusHistory: [] };
      setHewan(prev => [...prev, newHewan]);
      addLog(session, "HEWAN_CREATED", "HEWAN", newHewan.id, newHewan.nama, { sesudah: newHewan });
      showToast(`${form.jenis} "${form.nama}" berhasil ditambahkan!`);
    } else {
      // EC-09: Guard di handler
      const existing = hewan.find(h => h.id === form.id);
      if (isHewanTerkunci(existing, session)) { showToast("Tidak bisa edit hewan yang sudah Selesai.", "err"); return; }
      const updated = { ...form, updatedBy: session.panitiaId, updatedAt: now() };
      setHewan(prev => prev.map(h => h.id === form.id ? updated : h));
      addLog(session, "HEWAN_UPDATED", "HEWAN", form.id, form.nama, { sebelum: existing, sesudah: updated });
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
    const histEntry = { dari: h.status, ke: newStatus, oleh: session.panitiaId, waktu: now() };
    setHewan(prev => prev.map(x => x.id === id ? { ...x, status: newStatus, updatedBy: session.panitiaId, updatedAt: now(), statusHistory: [...(x.statusHistory || []), histEntry] } : x));
    addLog(session, "HEWAN_STATUS_UPDATED", "HEWAN", id, h.nama, { dari: h.status, ke: newStatus });
    showToast(`Status diperbarui ke "${newStatus}"`);
  };

  const doRollback = () => {
    if (!rollbackAlasan.trim()) { showToast("Alasan wajib diisi untuk rollback status.", "err"); return; }
    const h = hewan.find(x => x.id === rollbackModal.id);
    const histEntry = { dari: h.status, ke: rollbackModal.targetStatus, oleh: session.panitiaId, waktu: now(), alasan: rollbackAlasan };
    setHewan(prev => prev.map(x => x.id === rollbackModal.id ? { ...x, status: rollbackModal.targetStatus, updatedBy: session.panitiaId, updatedAt: now(), statusHistory: [...(x.statusHistory || []), histEntry] } : x));
    addLog(session, "HEWAN_STATUS_ROLLBACK", "HEWAN", rollbackModal.id, h.nama, { dari: h.status, ke: rollbackModal.targetStatus, alasan: rollbackAlasan });
    showToast(`Status di-rollback ke "${rollbackModal.targetStatus}"`);
    setRollbackModal(null);
    setRollbackAlasan("");
  };

  // BR-HEWAN-03: Hapus — cek mudhohi terdampak, cascade confirm
  const del = () => {
    const h = hewan.find(x => x.id === confirmId);
    const terdampak = mudhohi.filter(m => m.hewanId === confirmId).length;
    setHewan(prev => prev.filter(x => x.id !== confirmId));
    if (terdampak) setMudhohi(prev => prev.filter(m => m.hewanId !== confirmId));
    addLog(session, "HEWAN_DELETED", "HEWAN", confirmId, h?.nama, { terdampakMudhohi: terdampak });
    setConfirmId(null);
    if (terdampak) showToast(`Hewan dihapus beserta ${terdampak} mudhohi terdampak.`, "err");
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
          <div style={{ marginBottom: 14, padding: "10px 14px", background: "#3B0000", borderRadius: 8, border: `1px solid ${C.red}44`, fontSize: 13, color: C.red }}>
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
          detail={terdampakCount > 0 ? `⚠️ ${terdampakCount} mudhohi yang terdaftar juga akan ikut terhapus.` : null}
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
function NotifSembelihModal({ mudhohi: m, hewanObj, fonnteToken, session, setMudhohi, addLog, onClose }) {
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
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setResult({ ok: false, msg: "Ukuran foto maks 2MB." }); return; }
    const reader = new FileReader();
    reader.onload = ev => { setFoto(ev.target.result); setFotoPreview(ev.target.result); };
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
    addLog(session, ok ? "MUDHOHI_WA_SENT" : "MUDHOHI_WA_FAILED", "WA", m.id, m.nama, { hp: m.hp, status: ok ? "ok" : "gagal" });
  };

  return (
    <Modal onClose={onClose} title="📲 Kirim Notif Penyembelihan">
      <div style={{ padding: "10px 14px", background: "#0A0D09", borderRadius: 10, border: `1px solid ${STATUS_COLOR[statusHewan] || C.border}44`, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.muted }}>Status Hewan</div>
        <div style={{ fontWeight: 700, color: STATUS_COLOR[statusHewan] || C.text }}>{statusHewan}</div>
        <div style={{ fontSize: 12, color: C.muted }}>{hewanObj?.nama || "-"}</div>
      </div>
      <div style={{ marginBottom: 14, padding: "10px 14px", background: "#0A0D09", borderRadius: 10, border: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 11, color: C.muted }}>DIKIRIM KE</div>
        <div style={{ fontWeight: 700, color: C.white }}>{m.nama}</div>
        <div style={{ fontSize: 12, color: C.muted }}>📱 {m.hp}</div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={css.label}>Foto (opsional, maks 2MB)</label>
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFoto} style={{ display: "none" }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => fileRef.current.click()} style={{ ...css.btn("#0A0D09", C.muted), border: `1px dashed ${C.border}`, fontSize: 12, padding: "9px 14px", flex: 1 }}>📷 {foto ? "Ganti Foto" : "Pilih Foto"}</button>
          {foto && <button onClick={() => { setFoto(null); setFotoPreview(null); }} style={{ ...css.btn(C.red + "22", C.red), border: `1px solid ${C.red}44`, fontSize: 12, padding: "9px 12px" }}>✕</button>}
        </div>
        {fotoPreview && <img src={fotoPreview} alt="preview" style={{ width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: 8, marginTop: 8 }} />}
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={css.label}>Pesan WA</label>
        <textarea value={pesanCustom || defaultPesan} onChange={e => setPesanCustom(e.target.value)} rows={5} style={{ ...css.input, resize: "vertical", lineHeight: 1.6, fontSize: 13 }} />
        {pesanCustom && <button onClick={() => setPesanCustom("")} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11, marginTop: 2 }}>↩ Reset ke default</button>}
      </div>
      {result && <div style={{ marginBottom: 14, padding: "10px 13px", background: result.ok ? C.greenDark : "#3B0000", border: `1px solid ${result.ok ? C.green : C.red}`, borderRadius: 8, fontSize: 13, color: result.ok ? C.greenLight : C.red }}>{result.msg}</div>}
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
function MudhohiPage({ mudhohi, setMudhohi, hewan, fonnteToken, session, addLog }) {
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
      const newM = { ...form, id: "M" + Date.now(), createdBy: session.panitiaId, createdAt: now(), updatedBy: session.panitiaId, updatedAt: now(), cicilanLog: [], waLog: [] };
      setMudhohi(prev => [...prev, newM]);
      addLog(session, "MUDHOHI_CREATED", "MUDHOHI", newM.id, newM.nama, { sesudah: newM });
      if (fonnteToken && !skipWA) {
        setSending(true);
        const res = await sendWA(fonnteToken, form.hp, buildWAMsg());
        setSending(false);
        setMudhohi(prev => prev.map(x => x.id === newM.id ? { ...x, waLog: [{ waktu: now(), dikirimOleh: session.panitiaId, status: res.status ? "ok" : "gagal", reason: res.reason }] } : x));
        addLog(session, res.status ? "MUDHOHI_WA_SENT" : "MUDHOHI_WA_FAILED", "WA", newM.id, newM.nama, { hp: form.hp });
        showToast("Data disimpan & notif WA terkirim!");
      } else {
        showToast("Data disimpan!");
      }
    } else {
      const existing = mudhohi.find(m => m.id === form.id);
      const updated = { ...form, updatedBy: session.panitiaId, updatedAt: now(), cicilanLog: existing.cicilanLog, waLog: existing.waLog };
      setMudhohi(prev => prev.map(m => m.id === form.id ? updated : m));
      addLog(session, "MUDHOHI_UPDATED", "MUDHOHI", form.id, form.nama, { sebelum: existing, sesudah: updated });
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

  // BR-MUDHOHI-05: hapus mudhohi — cek status hewan
  const del = () => {
    const m = mudhohi.find(x => x.id === confirmId);
    const hw = hewan.find(h => h.id === m?.hewanId);
    // Guard: hapus setelah Disembelih hanya admin
    if (hw && ["Disembelih", "Dikuliti", "Selesai"].includes(hw.status) && session.role !== "admin") {
      showToast("Mudhohi dari hewan yang sudah disembelih hanya bisa dihapus oleh admin.", "err");
      setConfirmId(null);
      return;
    }
    setMudhohi(prev => prev.filter(x => x.id !== confirmId));
    addLog(session, "MUDHOHI_DELETED", "MUDHOHI", confirmId, m?.nama, {});
    setConfirmId(null);
    showToast("Mudhohi dihapus.");
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
      <SectionTitle emoji="💳" title="Mudhohi (Peserta)" sub="Kelola data peserta qurban" />

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
            ? <div>Tidak ada mudhohi yang sesuai filter.<br /><button onClick={() => { setSearch(""); setFilterBayar("Semua"); setFilterJenis("Semua"); }} style={{ background: "none", border: "none", color: C.green, cursor: "pointer", marginTop: 8 }}>Reset filter</button></div>
            : "Belum ada mudhohi terdaftar."
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
        <Modal onClose={sending ? undefined : () => setModal(null)} title={`${modal === "add" ? "Tambah" : "Edit"} Mudhohi`}>
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
              : <div style={{ background: "#3B0000", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "10px 13px", color: C.red, fontSize: 13, marginBottom: 14 }}>⚠️ Belum ada {form.jenisHewan.toLowerCase()} terdaftar.</div>
            }
            <Select label="Status Bayar" value={form.bayar} onChange={v => setForm(p => ({ ...p, bayar: v }))} options={["Lunas", "Belum Lunas", "Cicilan"]} />
            <Input label="Nominal Bayar (Rp)" type="number" value={form.nominal} onChange={v => setForm(p => ({ ...p, nominal: v }))} error={errors.nominal} hint={hewanObj ? `Harga ${hewanObj.jenis}: Rp ${Number(hewanObj.harga).toLocaleString("id")}` : ""} />
            {modal === "add" && fonnteToken && (
              <div style={{ marginBottom: 14 }}>
                <button onClick={() => setWaPreview(v => !v)} style={{ background: "none", border: `1px solid ${C.green}44`, borderRadius: 8, padding: "6px 12px", color: C.greenLight, cursor: "pointer", fontSize: 12 }}>
                  {waPreview ? "Sembunyikan" : "👁 Preview"} pesan WA
                </button>
                {waPreview && <div style={{ marginTop: 8, background: "#0A0D09", border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 13px", fontSize: 12, color: C.text, whiteSpace: "pre-line", lineHeight: 1.6 }}>{buildWAMsg()}</div>}
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

      {confirmId && <ConfirmModal pesan="Yakin hapus data mudhohi ini?" onConfirm={del} onCancel={() => setConfirmId(null)} />}
      {notifTarget && (
        <NotifSembelihModal
          mudhohi={notifTarget}
          hewanObj={hewan.find(h => h.id === notifTarget.hewanId)}
          fonnteToken={fonnteToken}
          session={session}
          setMudhohi={setMudhohi}
          addLog={addLog}
          onClose={() => setNotifTarget(null)}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MUSTAHIQ PAGE
// ══════════════════════════════════════════════════════════════
function MustahiqPage({ mustahiq, setMustahiq, sesi, setSesi, session, addLog }) {
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
      const newM = { ...form, id: "P" + Date.now(), sudahAmbil: false, createdBy: session.panitiaId, createdAt: now(), updatedBy: session.panitiaId, updatedAt: now(), ambilLog: { ditandaiOleh: null, ditandaiWaktu: null, dibatalkanOleh: null, dibatalkanWaktu: null, alasanBatal: null } };
      setMustahiq(prev => [...prev, newM]);
      addLog(session, "MUSTAHIQ_CREATED", "MUSTAHIQ", newM.id, newM.nama, { sesudah: newM });
      showToast(`${form.nama} berhasil ditambahkan!`);
    } else {
      const existing = mustahiq.find(m => m.id === form.id);
      const updated = { ...form, sudahAmbil: existing.sudahAmbil, ambilLog: existing.ambilLog, updatedBy: session.panitiaId, updatedAt: now(), createdBy: existing.createdBy, createdAt: existing.createdAt, cicilanLog: existing.cicilanLog, waLog: existing.waLog };
      setMustahiq(prev => prev.map(m => m.id === form.id ? updated : m));
      addLog(session, "MUSTAHIQ_UPDATED", "MUSTAHIQ", form.id, form.nama, { sebelum: existing, sesudah: updated });
      showToast("Data diperbarui.");
    }
    setModal(null);
  };

  const saveSesi = () => {
    if (!sesiForm.nama.trim()) return;
    if (sesiModal === "add") {
      const newS = { ...sesiForm, id: "SE" + Date.now(), createdBy: session.panitiaId, createdAt: now() };
      setSesi(prev => [...prev, newS]);
      addLog(session, "SESI_CREATED", "SESI", newS.id, newS.nama, {});
    } else {
      setSesi(prev => prev.map(s => s.id === sesiForm.id ? { ...sesiForm, createdBy: s.createdBy, createdAt: s.createdAt } : s));
      addLog(session, "SESI_UPDATED", "SESI", sesiForm.id, sesiForm.nama, {});
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
    addLog(session, "MUSTAHIQ_AMBIL_DITANDAI", "MUSTAHIQ", target.id, target.nama, { sudahAmbil: sudahAmbilBaru });
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
    addLog(session, "MUSTAHIQ_AMBIL_DIBATALKAN", "MUSTAHIQ", batalModal.id, batalModal.nama, { alasan: batalAlasan });
    showToast("Pengambilan dibatalkan.");
    setBatalModal(null); setBatalAlasan("");
  };

  // BR-SESI-02: Block hapus sesi jika ada mustahiq
  const confirmDelSesi = (id) => {
    const s = sesi.find(x => x.id === id);
    const dipakai = mustahiq.some(m => m.sesi === s?.nama);
    if (dipakai) { setSesiWarning("Sesi ini masih dipakai. Pindahkan mustahiq dulu."); return; }
    setConfirmSesiId(id);
  };

  // BR-MUSTAHIQ-05: Hapus setelah event dimulai hanya admin
  const delMustahiq = () => {
    const m = mustahiq.find(x => x.id === confirmId);
    setMustahiq(prev => prev.filter(x => x.id !== confirmId));
    addLog(session, "MUSTAHIQ_DELETED", "MUSTAHIQ", confirmId, m?.nama, {});
    setConfirmId(null);
    showToast("Mustahiq dihapus.");
  };

  const delSesi = () => {
    const s = sesi.find(x => x.id === confirmSesiId);
    setSesi(prev => prev.filter(x => x.id !== confirmSesiId));
    addLog(session, "SESI_DELETED", "SESI", confirmSesiId, s?.nama, {});
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
      <SectionTitle emoji="🎟️" title="Distribusi Mustahiq" sub="Kelola penerima daging & sesi pengambilan" />
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {["mustahiq", "sesi"].map(t => (
          <button key={t} onClick={() => { setTab(t); setSesiWarning(""); }} style={{ ...css.btn(tab === t ? C.green : C.surface, tab === t ? "#fff" : C.muted), border: `1px solid ${C.border}`, fontSize: 13 }}>
            {t === "mustahiq" ? "🤲 Mustahiq" : "🗓️ Sesi"}
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
            <div style={{ background: "#3B0000", border: `1px solid ${C.red}`, borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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
        <Modal onClose={() => setModal(null)} title={`${modal === "add" ? "Tambah" : "Edit"} Mustahiq`}>
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
      {confirmId && <ConfirmModal pesan="Yakin hapus data mustahiq ini?" onConfirm={delMustahiq} onCancel={() => setConfirmId(null)} />}
      {confirmSesiId && <ConfirmModal pesan="Yakin hapus sesi ini?" onConfirm={delSesi} onCancel={() => setConfirmSesiId(null)} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// RAB PAGE
// ══════════════════════════════════════════════════════════════
function RABPage({ rab, setRab, mudhohi, session, addLog }) {
  const perm = usePermission(session);
  const [modal, setModal] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const [form, setForm] = useState({ nama: "", kategori: "Hewan", jumlah: "", ket: "" });
  const [errors, setErrors] = useState({});
  const [toast, setToast] = useState({ msg: "", type: "ok" });
  const KATEGORI = ["Hewan", "Operasional", "Konsumsi", "Lainnya"];
  const KCOLOR = { Hewan: C.gold, Operasional: C.blue, Konsumsi: C.green, Lainnya: C.muted };

  const totalPemasukan = mudhohi.reduce((a, m) => a + Number(m.nominal || 0), 0);
  const totalPengeluaran = rab.reduce((a, r) => a + Number(r.jumlah || 0), 0);
  const saldo = totalPemasukan - totalPengeluaran;

  const showToast = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast({ msg: "", type: "ok" }), 3000); };

  const validate = () => {
    const e = {};
    if (!form.nama.trim()) e.nama = "Nama item wajib diisi";
    if (!form.jumlah || Number(form.jumlah) <= 0) e.jumlah = "Jumlah harus lebih dari 0";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = () => {
    if (!validate()) return;
    if (modal === "add") {
      const newR = { ...form, id: "R" + Date.now(), createdBy: session.panitiaId, createdAt: now(), updatedBy: session.panitiaId, updatedAt: now(), verified: false, verifiedBy: null, verifiedAt: null };
      setRab(prev => [...prev, newR]);
      addLog(session, "RAB_CREATED", "RAB", newR.id, newR.nama, { sesudah: newR });
    } else {
      const existing = rab.find(r => r.id === form.id);
      // BR-RAB-04: item verified tidak bisa diedit panitia
      if (existing?.verified && session.role !== "admin") { showToast("Item yang sudah diverifikasi tidak bisa diedit oleh panitia.", "err"); return; }
      const updated = { ...form, createdBy: existing.createdBy, createdAt: existing.createdAt, updatedBy: session.panitiaId, updatedAt: now(), verified: existing.verified, verifiedBy: existing.verifiedBy, verifiedAt: existing.verifiedAt };
      setRab(prev => prev.map(r => r.id === form.id ? updated : r));
      addLog(session, "RAB_UPDATED", "RAB", form.id, form.nama, { sebelum: existing, sesudah: updated });
    }
    setModal(null);
    showToast("Item RAB disimpan.");
  };

  const del = () => {
    const r = rab.find(x => x.id === confirmId);
    setRab(prev => prev.filter(r => r.id !== confirmId));
    addLog(session, "RAB_DELETED", "RAB", confirmId, r?.nama, {});
    setConfirmId(null);
    showToast("Item dihapus.");
  };

  // BR-RAB-04: Verifikasi admin
  const doVerify = (r) => {
    const updated = { ...r, verified: !r.verified, verifiedBy: !r.verified ? session.panitiaId : null, verifiedAt: !r.verified ? now() : null };
    setRab(prev => prev.map(x => x.id === r.id ? updated : x));
    addLog(session, "RAB_VERIFIED", "RAB", r.id, r.nama, { verified: !r.verified });
    showToast(updated.verified ? "Item diverifikasi." : "Verifikasi dibatalkan.");
  };

  return (
    <div>
      <Toast msg={toast.msg} type={toast.type} />
      <SectionTitle emoji="💰" title="Laporan RAB" sub="Rencana Anggaran Biaya qurban" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
        {[
          { label: "Pemasukan", value: totalPemasukan, color: C.green, icon: "📥" },
          { label: "Pengeluaran", value: totalPengeluaran, color: C.red, icon: "📤" },
          { label: saldo >= 0 ? "Surplus" : "Defisit", value: Math.abs(saldo), color: saldo >= 0 ? C.green : C.red, icon: saldo >= 0 ? "✅" : "⚠️" },
        ].map(item => (
          <div key={item.label} style={{ ...css.card, borderLeft: `3px solid ${item.color}`, marginBottom: 0, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{item.icon} {item.label}</div>
            <div style={{ fontSize: 15, fontWeight: 900, color: item.color }}>Rp {item.value.toLocaleString("id")}</div>
          </div>
        ))}
      </div>
      <div style={{ ...css.card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 6 }}>Pemasukan vs Pengeluaran</div>
        <ProgressBar value={totalPengeluaran} max={Math.max(totalPemasukan, totalPengeluaran, 1)} color={saldo >= 0 ? C.green : C.red} />
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{totalPemasukan > 0 ? Math.round(totalPengeluaran / totalPemasukan * 100) : 0}% dari pemasukan terpakai</div>
      </div>
      <Btn color={C.green} onClick={() => { setForm({ nama: "", kategori: "Hewan", jumlah: "", ket: "" }); setErrors({}); setModal("add"); }} style={{ marginBottom: 14 }}>+ Tambah Item</Btn>
      {KATEGORI.map(kat => {
        const items = rab.filter(r => r.kategori === kat);
        if (!items.length) return null;
        const subtotal = items.reduce((a, r) => a + Number(r.jumlah || 0), 0);
        return (
          <div key={kat} style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: KCOLOR[kat], fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase" }}>● {kat}</div>
              <span style={{ fontSize: 12, color: C.muted }}>Rp {subtotal.toLocaleString("id")}</span>
            </div>
            {items.map(r => (
              <div key={r.id} style={{ ...css.card, padding: "12px 16px", borderLeft: r.verified ? `3px solid ${C.green}` : undefined }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, color: C.white }}>{r.nama}</div>
                      {r.verified && <span style={{ ...css.badge(C.green), fontSize: 10 }}>✓ Verified</span>}
                    </div>
                    {r.ket && <div style={{ fontSize: 12, color: C.muted }}>{r.ket}</div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, color: C.red }}>Rp {Number(r.jumlah).toLocaleString("id")}</span>
                    {/* BR-RAB-04: edit disabled jika verified dan bukan admin */}
                    {(!r.verified || session.role === "admin") && (
                      <Btn color={C.blue} onClick={() => { setForm({ ...r }); setErrors({}); setModal("edit"); }} style={{ fontSize: 13, padding: "8px 14px" }}>Edit</Btn>
                    )}
                    {/* Verifikasi hanya admin */}
                    <AdminOnly session={session}>
                      <Btn color={r.verified ? C.orange : C.green} onClick={() => doVerify(r)} style={{ fontSize: 13, padding: "8px 14px" }}>{r.verified ? "Batal Verif" : "Verifikasi"}</Btn>
                      <Btn color={C.red} onClick={() => setConfirmId(r.id)} style={{ fontSize: 13, padding: "8px 14px" }}>Hapus</Btn>
                    </AdminOnly>
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      })}
      {modal && (
        <Modal onClose={() => setModal(null)} title={`${modal === "add" ? "Tambah" : "Edit"} Item RAB`}>
          <Input label="Nama Item" value={form.nama} onChange={v => setForm(p => ({ ...p, nama: v }))} error={errors.nama} />
          <Select label="Kategori" value={form.kategori} onChange={v => setForm(p => ({ ...p, kategori: v }))} options={KATEGORI} />
          <Input label="Jumlah (Rp)" type="number" value={form.jumlah} onChange={v => setForm(p => ({ ...p, jumlah: v }))} error={errors.jumlah} />
          <Input label="Keterangan (opsional)" value={form.ket} onChange={v => setForm(p => ({ ...p, ket: v }))} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn color={C.green} onClick={save} style={{ flex: 1 }}>Simpan</Btn>
            <Btn color={C.muted} onClick={() => setModal(null)} style={{ flex: 1 }}>Batal</Btn>
          </div>
        </Modal>
      )}
      {confirmId && <ConfirmModal pesan="Yakin hapus item RAB ini?" onConfirm={del} onCancel={() => setConfirmId(null)} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// KELOLA AKUN (Admin Only)
// ══════════════════════════════════════════════════════════════
function KelolaPanitiaPage({ panitiaList, setPanitiaList, session, addLog }) {
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ nama: "", username: "", password: "", role: "panitia" });
  const [errors, setErrors] = useState({});
  const [toast, setToast] = useState({ msg: "", type: "ok" });

  const showToast = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast({ msg: "", type: "ok" }), 3000); };

  const validate = () => {
    const e = {};
    if (!form.nama.trim()) e.nama = "Nama wajib diisi";
    if (!form.username.trim()) e.username = "Username wajib diisi";
    const dupUser = panitiaList.find(u => u.username === form.username.toLowerCase() && u.id !== form.id);
    if (dupUser) e.username = "Username sudah dipakai";
    if (modal === "add" && !form.password.trim()) e.password = "Password wajib diisi untuk akun baru";
    if (form.password && form.password.length < 6) e.password = "Minimal 6 karakter";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = () => {
    if (!validate()) return;
    if (modal === "add") {
      const newU = { id: "USR_" + Date.now(), nama: form.nama, username: form.username.toLowerCase(), passwordHash: hashPassword(form.password), role: form.role, status: "aktif", mustChangePassword: true, loginAttempts: 0, lockedUntil: null, createdAt: now(), createdBy: session.panitiaId, updatedAt: now(), updatedBy: session.panitiaId };
      setPanitiaList(prev => [...prev, newU]);
      addLog(session, "AUTH_ACCOUNT_CREATED", "AUTH", newU.id, newU.nama, { role: newU.role });
      showToast(`Akun "${form.nama}" berhasil dibuat.`);
    } else {
      const existing = panitiaList.find(u => u.id === form.id);
      // BR-AUTH-05: cek minimal 1 admin aktif jika role berubah dari admin
      if (existing.role === "admin" && form.role !== "admin") {
        const activeAdmins = panitiaList.filter(u => u.role === "admin" && u.status === "aktif" && u.id !== form.id).length;
        if (activeAdmins === 0) { showToast("Harus ada minimal 1 admin aktif.", "err"); return; }
      }
      const updated = { ...existing, nama: form.nama, username: form.username.toLowerCase(), role: form.role, updatedAt: now(), updatedBy: session.panitiaId };
      if (form.password) { updated.passwordHash = hashPassword(form.password); updated.mustChangePassword = true; }
      if (existing.role !== form.role) addLog(session, "AUTH_ROLE_CHANGED", "AUTH", form.id, form.nama, { dari: existing.role, ke: form.role });
      setPanitiaList(prev => prev.map(u => u.id === form.id ? updated : u));
      showToast("Akun diperbarui.");
    }
    setModal(null);
  };

  // BR-AUTH-04: nonaktifkan, bukan hapus
  const toggleStatus = (u) => {
    if (u.status === "aktif") {
      // BR-AUTH-05: cek minimal 1 admin
      if (u.role === "admin") {
        const activeAdmins = panitiaList.filter(x => x.role === "admin" && x.status === "aktif" && x.id !== u.id).length;
        if (activeAdmins === 0) { showToast("Tidak bisa menonaktifkan satu-satunya admin aktif.", "err"); return; }
      }
      // EC-07: tidak bisa nonaktifkan diri sendiri jika admin terakhir
      if (u.id === session.panitiaId && u.role === "admin") {
        const activeAdmins = panitiaList.filter(x => x.role === "admin" && x.status === "aktif" && x.id !== u.id).length;
        if (activeAdmins === 0) { showToast("Tidak bisa menonaktifkan diri sendiri sebagai admin terakhir.", "err"); return; }
      }
    }
    const newStatus = u.status === "aktif" ? "nonaktif" : "aktif";
    setPanitiaList(prev => prev.map(x => x.id === u.id ? { ...x, status: newStatus, updatedAt: now(), updatedBy: session.panitiaId } : x));
    addLog(session, newStatus === "nonaktif" ? "AUTH_ACCOUNT_DEACTIVATED" : "AUTH_ACCOUNT_REACTIVATED", "AUTH", u.id, u.nama, {});
    showToast(`Akun "${u.nama}" ${newStatus === "nonaktif" ? "dinonaktifkan" : "diaktifkan"}.`);
  };

  return (
    <div>
      <Toast msg={toast.msg} type={toast.type} />
      <SectionTitle emoji="👤" title="Kelola Akun Panitia" sub="Tambah, edit, dan kelola status akun" />
      <Btn color={C.green} onClick={() => { setForm({ nama: "", username: "", password: "", role: "panitia" }); setErrors({}); setModal("add"); }} style={{ marginBottom: 16 }}>+ Tambah Akun</Btn>
      {panitiaList.map(u => (
        <div key={u.id} style={{ ...css.card, borderLeft: `3px solid ${u.status === "aktif" ? C.green : C.muted}`, opacity: u.status === "nonaktif" ? 0.7 : 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontWeight: 700, color: C.white }}>{u.nama}</div>
                <Pill text={u.role} color={u.role === "admin" ? C.gold : C.blue} />
                {u.mustChangePassword && <span style={{ ...css.badge(C.orange), fontSize: 10 }}>Ganti Pass</span>}
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>@{u.username}</div>
              {u.id === session.panitiaId && <div style={{ fontSize: 11, color: C.greenLight, marginTop: 2 }}>← Akun Anda</div>}
            </div>
            <Pill text={u.status} color={u.status === "aktif" ? C.green : C.muted} />
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn color={C.blue} onClick={() => { setForm({ ...u, password: "" }); setErrors({}); setModal("edit"); }} style={{ fontSize: 13, padding: "8px 14px" }}>Edit</Btn>
            <Btn color={u.status === "aktif" ? C.orange : C.green} onClick={() => toggleStatus(u)} style={{ fontSize: 13, padding: "8px 14px" }}>
              {u.status === "aktif" ? "Nonaktifkan" : "Aktifkan"}
            </Btn>
          </div>
        </div>
      ))}
      {modal && (
        <Modal onClose={() => setModal(null)} title={`${modal === "add" ? "Tambah" : "Edit"} Akun`}>
          <Input label="Nama Lengkap" value={form.nama} onChange={v => setForm(p => ({ ...p, nama: v }))} error={errors.nama} />
          <Input label="Username" value={form.username} onChange={v => setForm(p => ({ ...p, username: v.toLowerCase() }))} error={errors.username} hint="Lowercase, tanpa spasi" />
          <Input label={modal === "add" ? "Password" : "Password Baru (kosongkan jika tidak diubah)"} type="password" value={form.password} onChange={v => setForm(p => ({ ...p, password: v }))} error={errors.password} />
          <Select label="Role" value={form.role} onChange={v => setForm(p => ({ ...p, role: v }))} options={["admin", "panitia"]} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn color={C.green} onClick={save} style={{ flex: 1 }}>Simpan</Btn>
            <Btn color={C.muted} onClick={() => setModal(null)} style={{ flex: 1 }}>Batal</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// AUDIT LOG PAGE (Admin: semua; Panitia: milik sendiri)
// ══════════════════════════════════════════════════════════════
function AuditLogPage({ auditLog, session }) {
  const [filterModul, setFilterModul] = useState("Semua");
  const [search, setSearch] = useState("");

  const MODUL_LIST = ["AUTH", "HEWAN", "MUDHOHI", "MUSTAHIQ", "SESI", "RAB", "WA"];

  const logs = session.role === "admin"
    ? auditLog
    : auditLog.filter(l => l.panitiaId === session.panitiaId);

  const filtered = logs.filter(l => {
    const matchModul = filterModul === "Semua" || l.modul === filterModul;
    const matchSearch = !search || l.targetDesc?.toLowerCase().includes(search.toLowerCase()) || l.aksi?.toLowerCase().includes(search.toLowerCase()) || l.panitiaName?.toLowerCase().includes(search.toLowerCase());
    return matchModul && matchSearch;
  });

  const AKSI_COLOR = {
    AUTH_LOGIN_OK: C.green, AUTH_LOGIN_FAIL: C.red, AUTH_LOGIN_LOCKED: C.red,
    HEWAN_CREATED: C.green, HEWAN_UPDATED: C.blue, HEWAN_DELETED: C.red, HEWAN_STATUS_UPDATED: C.orange, HEWAN_STATUS_ROLLBACK: C.red,
    MUDHOHI_CREATED: C.green, MUDHOHI_UPDATED: C.blue, MUDHOHI_DELETED: C.red,
    MUSTAHIQ_AMBIL_DITANDAI: C.green, MUSTAHIQ_AMBIL_DIBATALKAN: C.orange,
    RAB_VERIFIED: C.gold,
  };

  return (
    <div>
      <SectionTitle emoji="📋" title="Audit Log" sub={session.role === "admin" ? "Semua aktivitas panitia" : "Aktivitas Anda"} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Cari aksi, nama, target..." style={css.input} />
        <select value={filterModul} onChange={e => setFilterModul(e.target.value)} style={css.select}>
          <option value="Semua">Semua Modul</option>
          {MODUL_LIST.map(m => <option key={m}>{m}</option>)}
        </select>
      </div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>{filtered.length} entri log</div>
      {filtered.length === 0 && (
        <div style={{ ...css.card, textAlign: "center", color: C.muted, padding: "40px 16px" }}>Belum ada log.</div>
      )}
      {filtered.slice(0, 100).map(l => (
        <div key={l.id} style={{ ...css.card, padding: "10px 14px", borderLeft: `3px solid ${AKSI_COLOR[l.aksi] || C.muted}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: AKSI_COLOR[l.aksi] || C.text }}>{l.aksi}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                👤 {l.panitiaName} ({l.role}) · 📁 {l.modul}
              </div>
              {l.targetDesc && <div style={{ fontSize: 12, color: C.text, marginTop: 2 }}>🎯 {l.targetDesc}</div>}
              {l.detail?.alasan && <div style={{ fontSize: 11, color: C.orange, marginTop: 2 }}>Alasan: {l.detail.alasan}</div>}
            </div>
            <div style={{ fontSize: 10, color: C.muted, textAlign: "right", flexShrink: 0 }}>
              {new Date(l.waktu).toLocaleDateString("id", { day: "2-digit", month: "short" })}
              <br />{new Date(l.waktu).toLocaleTimeString("id", { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        </div>
      ))}
      {filtered.length > 100 && <div style={{ textAlign: "center", color: C.muted, fontSize: 12, padding: "8px 0" }}>Menampilkan 100 terbaru dari {filtered.length} log</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SETTINGS PAGE
// ══════════════════════════════════════════════════════════════
function SettingsPage({ fonnteToken, setFonnteToken, session, addLog }) {
  const [token, setToken] = useState(fonnteToken);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [testNumber, setTestNumber] = useState("");
  const isAdmin = session?.role === "admin";

  const save = () => {
    if (!isAdmin) return;
    setFonnteToken(token);
    setSaved(true);
    addLog(session, "CONFIG_UPDATED", "AUTH", "CONFIG", "Fonnte Token", {});
    setTimeout(() => setSaved(false), 2000);
  };

  const test = async () => {
    if (!token || !testNumber.trim()) return;
    setTesting(true); setTestResult("");
    const res = await sendWA(token, testNumber.replace(/\D/g, ""), "Test koneksi Qurban App ✅");
    setTestResult(res.status ? "✅ Berhasil terhubung!" : `❌ Gagal: ${res.reason}`);
    setTesting(false);
  };

  return (
    <div>
      <SectionTitle emoji="⚙️" title="Pengaturan" sub="Konfigurasi integrasi Fonnte WhatsApp" />

      {/* BR-WA-01: Token hanya admin */}
      <div style={css.card}>
        <div style={{ fontWeight: 700, color: C.white, marginBottom: 4 }}>📲 Fonnte API Token</div>
        {!isAdmin && (
          <div style={{ background: "#3B0000", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "10px 13px", color: C.red, fontSize: 13, marginBottom: 14 }}>
            🔒 Konfigurasi token hanya bisa dilakukan oleh admin.
          </div>
        )}
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>
          Dapatkan token di <span style={{ color: C.greenLight }}>fonnte.com</span> → Device → Token
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={css.label}>API Token</label>
          <div style={{ position: "relative" }}>
            <input type={showToken ? "text" : "password"} value={token} onChange={e => setToken(e.target.value)} placeholder="Paste token Fonnte di sini..." style={{ ...css.input, paddingRight: 40 }} disabled={!isAdmin} />
            <button onClick={() => setShowToken(v => !v)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14 }}>
              {showToken ? "🙈" : "👁"}
            </button>
          </div>
        </div>
        <Btn color={C.green} onClick={save} disabled={!isAdmin} style={{ flex: 1 }}>{saved ? "✅ Tersimpan!" : "Simpan Token"}</Btn>
        <div style={{ marginTop: 16 }}>
          <label style={css.label}>Test Kirim WA</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="tel" value={testNumber} onChange={e => setTestNumber(e.target.value)} placeholder="08xxxxxxxxxx" style={{ ...css.input, flex: 1 }} />
            <Btn color={C.blue} onClick={test} disabled={!token || !testNumber.trim() || testing}>{testing ? "Testing..." : "Test"}</Btn>
          </div>
        </div>
        {testResult && <div style={{ marginTop: 10, fontSize: 13, color: testResult.startsWith("✅") ? C.green : C.red }}>{testResult}</div>}
      </div>

      <div style={{ ...css.card, background: "#0F1A0D", border: `1px solid ${C.greenDark}` }}>
        <div style={{ fontWeight: 700, color: C.greenLight, marginBottom: 8 }}>📋 Cara Setup Fonnte</div>
        {["1. Daftar di fonnte.com (gratis)", "2. Scan QR dengan WhatsApp kamu", "3. Copy token dari menu Device", "4. Paste token di atas lalu klik Simpan", "5. Test kirim untuk memastikan koneksi"].map((s, i) => (
          <div key={i} style={{ fontSize: 13, color: C.muted, marginBottom: 6 }}>{s}</div>
        ))}
      </div>

      <div style={{ ...css.card, borderLeft: `3px solid ${C.orange}` }}>
        <div style={{ fontWeight: 700, color: C.orange, marginBottom: 8 }}>⚠️ Catatan Penting</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
          Data aplikasi tersimpan di browser ini (localStorage). Jika kamu ganti browser atau perangkat, data tidak akan ikut. Catat atau backup data secara berkala.
        </div>
      </div>

      {isAdmin && <ResetDataSection session={session} addLog={addLog} />}
    </div>
  );
}

// ── Reset & Export section (Admin Only) ───────────────────────
function ResetDataSection({ session, addLog }) {
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetInput, setResetInput] = useState("");
  const [toast, setToast] = useState({ msg: "", type: "ok" });
  const showToast = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast({ msg: "", type: "ok" }), 3000); };

  const exportData = () => {
    const keys = ["qurban_panitia", "qurban_hewan", "qurban_mudhohi", "qurban_mustahiq", "qurban_sesi", "qurban_rab", "qurban_auditlog"];
    const data = {};
    keys.forEach(k => { try { data[k] = JSON.parse(localStorage.getItem(k) || "null"); } catch { data[k] = null; } });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qurban-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    addLog(session, "DATA_EXPORTED", "SETTINGS", "BACKUP", "Backup JSON", {});
    showToast("Data berhasil diekspor!");
  };

  const doReset = () => {
    if (resetInput !== "RESET") { showToast("Ketik RESET untuk konfirmasi.", "err"); return; }
    const keys = ["qurban_hewan", "qurban_mudhohi", "qurban_mustahiq", "qurban_sesi", "qurban_rab", "qurban_auditlog", "qurban_token"];
    keys.forEach(k => localStorage.removeItem(k));
    addLog(session, "DATA_RESET", "SETTINGS", "RESET", "Reset Data App", {});
    setShowResetConfirm(false);
    setResetInput("");
    showToast("Data berhasil direset. Halaman akan dimuat ulang...");
    setTimeout(() => window.location.reload(), 1500);
  };

  return (
    <div>
      <Toast msg={toast.msg} type={toast.type} />
      <div style={{ ...css.card, borderLeft: `3px solid ${C.blue}` }}>
        <div style={{ fontWeight: 700, color: C.blue, marginBottom: 8 }}>💾 Backup Data</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
          Unduh semua data sebagai file JSON sebagai cadangan sebelum ganti perangkat atau browser.
        </div>
        <Btn color={C.blue} onClick={exportData}>⬇️ Ekspor Backup JSON</Btn>
      </div>

      <div style={{ ...css.card, borderLeft: `3px solid ${C.red}` }}>
        <div style={{ fontWeight: 700, color: C.red, marginBottom: 8 }}>🗑️ Reset Seluruh Data</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
          Hapus semua data hewan, mudhohi, mustahiq, RAB, dan log. Akun panitia dan token WA tidak ikut dihapus. Aksi ini tidak bisa dibatalkan.
        </div>
        {!showResetConfirm ? (
          <Btn color={C.red} onClick={() => setShowResetConfirm(true)}>Reset Data...</Btn>
        ) : (
          <div>
            <div style={{ fontSize: 13, color: C.red, marginBottom: 10 }}>Ketik <strong>RESET</strong> untuk mengkonfirmasi penghapusan data:</div>
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
const NAV_BASE = [
  { id: "dashboard", emoji: "📊", label: "Dashboard" },
  { id: "hewan", emoji: "🐾", label: "Hewan" },
  { id: "mudhohi", emoji: "💳", label: "Mudhohi" },
  { id: "mustahiq", emoji: "🎟️", label: "Mustahiq" },
  { id: "rab", emoji: "💰", label: "RAB" },
  { id: "log", emoji: "📋", label: "Log" },
  { id: "settings", emoji: "⚙️", label: "Pengaturan" },
];
const NAV_ADMIN = [
  ...NAV_BASE,
  { id: "panitia", emoji: "👤", label: "Panitia" },
];

export default function App() {
  const [session, setSession] = useState(() => loadSession());
  const [page, setPage] = useState("dashboard");
  const navRef = useRef(null);

  // Lazy init storage — EC-13: seed hanya jika kosong (first run)
  const [panitiaList, setPanitiaList] = useState(() => {
    const raw = localStorage.getItem("qurban_panitia");
    if (raw) try { const parsed = JSON.parse(raw); if (parsed.length > 0) return parsed; } catch {}
    return SEED_PANITIA;
  });
  const [hewan, setHewan] = useState(() => {
    const raw = localStorage.getItem("qurban_hewan");
    if (raw) try { return JSON.parse(raw); } catch {}
    return SEED_HEWAN;
  });
  const [mudhohi, setMudhohi] = useState(() => {
    const raw = localStorage.getItem("qurban_mudhohi");
    if (raw) try { return JSON.parse(raw); } catch {}
    return SEED_MUDHOHI;
  });
  const [mustahiq, setMustahiq] = useState(() => {
    const raw = localStorage.getItem("qurban_mustahiq");
    if (raw) try { return JSON.parse(raw); } catch {}
    return SEED_MUSTAHIQ;
  });
  const [sesi, setSesi] = useState(() => {
    const raw = localStorage.getItem("qurban_sesi");
    if (raw) try { return JSON.parse(raw); } catch {}
    return SEED_SESI;
  });
  const [rab, setRab] = useState(() => {
    const raw = localStorage.getItem("qurban_rab");
    if (raw) try { return JSON.parse(raw); } catch {}
    return SEED_RAB;
  });
  const [fonnteToken, setFonnteToken] = useState(() => loadStorage("qurban_token", ""));
  const [auditLog, setAuditLog] = useState(() => loadStorage("qurban_auditlog", []));

  useEffect(() => { saveStorage("qurban_panitia", panitiaList); }, [panitiaList]);
  useEffect(() => { saveStorage("qurban_hewan", hewan); }, [hewan]);
  useEffect(() => { saveStorage("qurban_mudhohi", mudhohi); }, [mudhohi]);
  useEffect(() => { saveStorage("qurban_mustahiq", mustahiq); }, [mustahiq]);
  useEffect(() => { saveStorage("qurban_sesi", sesi); }, [sesi]);
  useEffect(() => { saveStorage("qurban_rab", rab); }, [rab]);
  useEffect(() => { saveStorage("qurban_token", fonnteToken); }, [fonnteToken]);
  useEffect(() => { saveStorage("qurban_auditlog", auditLog); }, [auditLog]);

  // BR-LOG-01: audit log helper
  const addLog = useCallback((sess, aksi, modul, targetId, targetDesc, detail = {}) => {
    const entry = createLogEntry(sess || session, aksi, modul, targetId, targetDesc, detail);
    // Limit 500 entry (Catatan implementasi §9)
    setAuditLog(prev => [entry, ...prev].slice(0, 500));
  }, [session]);

  // Scroll nav aktif ke tengah
  useEffect(() => {
    if (navRef.current) {
      const active = navRef.current.querySelector("[data-active='true']");
      if (active) active.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
    }
  }, [page]);

  // EC-14, EC-15: re-check session validity + user status on every write
  const checkSession = () => {
    if (!session) return false;
    const user = panitiaList.find(u => u.id === session.panitiaId);
    if (!user || user.status === "nonaktif") { handleLogout(); return false; }
    return true;
  };

  const handleLogin = (sess) => { setSession(sess); setPage("dashboard"); };

  const handleLogout = () => {
    if (session) addLog(session, "AUTH_LOGOUT", "AUTH", session.panitiaId, session.panitiaName, {});
    clearSession();
    setSession(null);
    setPage("dashboard");
  };

  // BR-AUTH-08: ganti password wajib saat pertama login
  if (!session) {
    return <LoginPage onLogin={handleLogin} panitiaList={panitiaList} setPanitiaList={setPanitiaList} addLog={addLog} />;
  }
  if (session.mustChangePassword) {
    return <GantiPasswordModal session={session} setPanitiaList={setPanitiaList} onDone={() => { const s = { ...session, mustChangePassword: false }; saveSession(s, false); setSession(s); }} addLog={addLog} />;
  }

  const isAdmin = session.role === "admin";
  const NAV = isAdmin ? NAV_ADMIN : NAV_BASE;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "'Segoe UI', 'Noto Sans', sans-serif", color: C.text }}>
      {/* Top bar */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 20 }}>🕌</span>
          <div>
            <div style={{ fontWeight: 900, fontSize: 14, color: C.white, lineHeight: 1.1 }}>Qurban App</div>
            <div style={{ fontSize: 10, color: C.muted, fontFamily: "monospace" }}>{new Date().getFullYear()} M</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 12, color: C.text }}>{session.panitiaName}</div>
            <div style={{ fontSize: 10, color: isAdmin ? C.gold : C.blue }}>
              {isAdmin ? "👑 Admin" : "👤 Panitia"}
            </div>
          </div>
          <button onClick={handleLogout} style={{ ...css.btn(C.red + "22", C.red), fontSize: 12, padding: "6px 12px", border: `1px solid ${C.red}44`, minHeight: 36 }}>Keluar</button>
        </div>
      </div>

      {/* Nav */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <div ref={navRef} style={{ display: "flex", overflowX: "auto", scrollbarWidth: "none" }}>
          {NAV.map(n => (
            <button key={n.id} data-active={page === n.id ? "true" : "false"} onClick={() => setPage(n.id)}
              style={{ flex: "1 0 auto", background: page === n.id ? C.greenDark : "transparent", border: "none", color: page === n.id ? C.greenLight : C.muted, padding: "10px 4px 8px", cursor: "pointer", fontSize: 10, borderBottom: page === n.id ? `2px solid ${C.green}` : "2px solid transparent", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, transition: "all 0.15s", minHeight: 52, minWidth: 48, touchAction: "manipulation" }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{n.emoji}</span>
              <span style={{ whiteSpace: "nowrap" }}>{n.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Pages */}
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "16px 12px 96px" }}>
        {page === "dashboard" && <Dashboard hewan={hewan} mudhohi={mudhohi} mustahiq={mustahiq} setPage={setPage} />}
        {page === "hewan" && <HewanPage hewan={hewan} setHewan={setHewan} mudhohi={mudhohi} setMudhohi={setMudhohi} session={session} addLog={addLog} />}
        {page === "mudhohi" && <MudhohiPage mudhohi={mudhohi} setMudhohi={setMudhohi} hewan={hewan} fonnteToken={fonnteToken} session={session} addLog={addLog} />}
        {page === "mustahiq" && <MustahiqPage mustahiq={mustahiq} setMustahiq={setMustahiq} sesi={sesi} setSesi={setSesi} session={session} addLog={addLog} />}
        {page === "rab" && <RABPage rab={rab} setRab={setRab} mudhohi={mudhohi} session={session} addLog={addLog} />}
        {page === "log" && <AuditLogPage auditLog={auditLog} session={session} />}
        {page === "settings" && <SettingsPage fonnteToken={fonnteToken} setFonnteToken={setFonnteToken} session={session} addLog={addLog} />}
        {page === "panitia" && isAdmin && <KelolaPanitiaPage panitiaList={panitiaList} setPanitiaList={setPanitiaList} session={session} addLog={addLog} />}
      </div>
    </div>
  );
}
