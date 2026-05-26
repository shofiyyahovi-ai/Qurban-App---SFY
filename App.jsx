// ══════════════════════════════════════════════════════════════
// IMPORT EXCEL — Komponen untuk Qurban App
//
// Dependensi: tambahkan SheetJS ke project
//   npm install xlsx
//   atau pakai CDN di index.html:
//   <script src="https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js"></script>
//
// Di React (Artifact/Claude), import dengan:
//   import * as XLSX from 'xlsx';
// ══════════════════════════════════════════════════════════════

// Untuk dipakai di Artifact claude.ai (sudah tersedia XLSX global):
// import * as XLSX from 'xlsx';   ← pakai ini jika pakai npm/vite

// ── Validator HP ─────────────────────────────────────────────
function isValidHP(hp) {
  if (!hp) return false;
  return /^08\d{8,12}$/.test(String(hp).replace(/\s|-/g, ""));
}

// ── Parser sheet Hewan ────────────────────────────────────────
function parseHewan(rows) {
  // rows = array of objects dengan key = header kolom
  const results = { data: [], errors: [] };
  const JENIS_VALID = ["Sapi", "Kambing", "Domba"];

  rows.forEach((row, idx) => {
    const lineNo = idx + 4; // baris Excel mulai dari row 4
    const jenis   = String(row["Jenis *"] || row["Jenis"] || "").trim();
    const nama    = String(row["Nama Hewan *"] || row["Nama Hewan"] || "").trim();
    const berat   = Number(row["Berat (kg) *"] || row["Berat (kg)"] || 0);
    const asal    = String(row["Asal / Peternak"] || "").trim();
    const harga   = Number(row["Harga (Rp) *"] || row["Harga (Rp)"] || 0);
    const kapasitas = Number(row["Kapasitas Peserta *"] || row["Kapasitas Peserta"] || 1);
    const ket     = String(row["Keterangan"] || "").trim();

    const rowErrors = [];
    if (!jenis) rowErrors.push("Jenis kosong");
    else if (!JENIS_VALID.includes(jenis)) rowErrors.push(`Jenis tidak valid: "${jenis}" (harus Sapi/Kambing/Domba)`);
    if (!nama) rowErrors.push("Nama Hewan kosong");
    if (!berat || berat <= 0) rowErrors.push("Berat harus > 0");
    if (!harga || harga <= 0) rowErrors.push("Harga harus > 0");
    if (!kapasitas || kapasitas < 1) rowErrors.push("Kapasitas minimal 1");

    if (rowErrors.length) {
      results.errors.push({ baris: lineNo, nama: nama || "(kosong)", masalah: rowErrors });
      return;
    }

    const prefix = jenis === "Sapi" ? "S" : jenis === "Kambing" ? "K" : "D";
    results.data.push({
      id: prefix + Date.now() + "_" + idx,
      jenis, nama, berat: String(berat), asal, harga: String(harga),
      kapasitas: String(kapasitas),
      keterangan: ket,
      status: "Menunggu",
      statusHistory: [],
      createdBy: "IMPORT_EXCEL",
      createdAt: new Date().toISOString(),
      updatedBy: "IMPORT_EXCEL",
      updatedAt: new Date().toISOString(),
    });
  });

  return results;
}

// ── Parser sheet Mudhohi ──────────────────────────────────────
function parseMudhohi(rows, hewanList) {
  const results = { data: [], errors: [] };
  const BAYAR_VALID = ["Lunas", "Belum Lunas", "Cicilan"];

  rows.forEach((row, idx) => {
    const lineNo = idx + 4;
    const nama      = String(row["Nama Lengkap *"] || row["Nama Lengkap"] || "").trim();
    const hp        = String(row["No. HP (WA) *"] || row["No. HP"] || row["HP"] || "").replace(/\s|-/g, "");
    const alamat    = String(row["Alamat / RT-RW"] || row["Alamat"] || "").trim();
    const jenisHewan= String(row["Jenis Hewan *"] || row["Jenis Hewan"] || "").trim();
    const namaHewan = String(row["Nama Hewan *"] || row["Nama Hewan"] || "").trim();
    const bayar     = String(row["Status Bayar *"] || row["Status Bayar"] || "").trim();
    const nominal   = Number(row["Nominal (Rp) *"] || row["Nominal (Rp)"] || row["Nominal"] || 0);

    const rowErrors = [];
    if (!nama) rowErrors.push("Nama kosong");
    if (!hp) rowErrors.push("No. HP kosong");
    else if (!isValidHP(hp)) rowErrors.push(`Format HP tidak valid: "${hp}" (harus 08xxxxxxxxxx)`);
    if (!jenisHewan) rowErrors.push("Jenis Hewan kosong");
    if (!namaHewan) rowErrors.push("Nama Hewan kosong");
    if (!bayar) rowErrors.push("Status Bayar kosong");
    else if (!BAYAR_VALID.includes(bayar)) rowErrors.push(`Status Bayar tidak valid: "${bayar}"`);
    if (!nominal || nominal <= 0) rowErrors.push("Nominal harus > 0");

    // Cari hewanId berdasarkan nama hewan
    const hewanObj = hewanList.find(h =>
      h.nama.toLowerCase() === namaHewan.toLowerCase() &&
      h.jenis.toLowerCase() === jenisHewan.toLowerCase()
    );
    if (namaHewan && jenisHewan && !hewanObj) {
      rowErrors.push(`Hewan "${namaHewan}" (${jenisHewan}) tidak ditemukan di sheet Hewan`);
    }

    if (rowErrors.length) {
      results.errors.push({ baris: lineNo, nama: nama || "(kosong)", masalah: rowErrors });
      return;
    }

    results.data.push({
      id: "M" + Date.now() + "_" + idx,
      nama, hp, alamat,
      jenisHewan, hewanId: hewanObj?.id || "",
      bayar, nominal: String(nominal),
      cicilanLog: [], waLog: [],
      createdBy: "IMPORT_EXCEL",
      createdAt: new Date().toISOString(),
      updatedBy: "IMPORT_EXCEL",
      updatedAt: new Date().toISOString(),
    });
  });

  return results;
}

// ── Parser sheet Mustahiq ────────────────────────────────────
function parseMustahiq(rows) {
  const results = { data: [], errors: [] };

  rows.forEach((row, idx) => {
    const lineNo = idx + 4;
    const nama    = String(row["Nama Lengkap *"] || row["Nama Lengkap"] || "").trim();
    const rt      = String(row["RT"] || "").trim();
    const alamat  = String(row["Alamat"] || "").trim();
    const anggota = row["Jumlah Anggota"] ? String(Number(row["Jumlah Anggota"])) : "";
    const sesi    = String(row["Sesi Pengambilan"] || "").trim();
    const ket     = String(row["Keterangan"] || "").trim();

    if (!nama) {
      results.errors.push({ baris: lineNo, nama: "(kosong)", masalah: ["Nama kosong"] });
      return;
    }

    results.data.push({
      id: "P" + Date.now() + "_" + idx,
      nama, rt, alamat, anggota, sesi, keterangan: ket,
      sudahAmbil: false,
      ambilLog: { ditandaiOleh: null, ditandaiWaktu: null, dibatalkanOleh: null, dibatalkanWaktu: null, alasanBatal: null },
      createdBy: "IMPORT_EXCEL",
      createdAt: new Date().toISOString(),
      updatedBy: "IMPORT_EXCEL",
      updatedAt: new Date().toISOString(),
    });
  });

  return results;
}

// ── Baca sheet dari workbook (skip baris header & contoh) ─────
function readSheet(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  // Baca dari baris ke-3 (header) seterusnya
  const raw = XLSX.utils.sheet_to_json(ws, { defval: "", range: 2 }); // range:2 = skip 2 baris pertama (title + instruksi)
  // Filter baris yang benar-benar kosong
  return raw.filter(row => Object.values(row).some(v => String(v).trim() !== ""));
}

// ══════════════════════════════════════════════════════════════
// KOMPONEN UTAMA: ImportExcelModal
// ══════════════════════════════════════════════════════════════
function ImportExcelModal({
  onClose,
  onImport,   // callback(hasil) → { hewan, mudhohi, mustahiq }
  existingHewan = [],
  existingMudhohi = [],
  existingMustahiq = [],
  session,
  addLog,
}) {
  const [step, setStep] = React.useState("upload"); // upload | preview | confirm | done
  const [file, setFile] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [preview, setPreview] = React.useState(null);
  // { hewan: {data,errors}, mudhohi: {data,errors}, mustahiq: {data,errors} }
  const [mode, setMode] = React.useState("append"); // append | replace
  const fileRef = React.useRef();

  const handleFile = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!f.name.match(/\.(xlsx|xls)$/i)) {
      setError("File harus berformat .xlsx atau .xls");
      return;
    }
    setFile(f);
    setError("");
    setLoading(true);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target.result);
        const wb = XLSX.read(data, { type: "array" });

        const sheetNames = wb.SheetNames;
        const hasHewan    = sheetNames.some(s => s.toLowerCase().includes("hewan"));
        const hasMudhohi  = sheetNames.some(s => s.toLowerCase().includes("mudhohi"));
        const hasMustahiq = sheetNames.some(s => s.toLowerCase().includes("mustahiq"));

        if (!hasHewan && !hasMudhohi && !hasMustahiq) {
          setError("File tidak dikenali. Pastikan sheet bernama 'Hewan', 'Mudhohi', atau 'Mustahiq'.");
          setLoading(false);
          return;
        }

        const hewanSheet    = sheetNames.find(s => s.toLowerCase().includes("hewan"));
        const mudhohiSheet  = sheetNames.find(s => s.toLowerCase().includes("mudhohi"));
        const mustahiqSheet = sheetNames.find(s => s.toLowerCase().includes("mustahiq"));

        const hewanRows    = hewanSheet    ? readSheet(wb, hewanSheet)    : [];
        const mudhohiRows  = mudhohiSheet  ? readSheet(wb, mudhohiSheet)  : [];
        const mustahiqRows = mustahiqSheet ? readSheet(wb, mustahiqSheet) : [];

        // Parse — untuk mudhohi, gunakan hasil hewan supaya hewanId terhubung
        const hewanResult    = parseHewan(hewanRows || []);
        // Gabungkan hewan existing + hasil import untuk referensi mudhohi
        const allHewan = [...existingHewan, ...hewanResult.data];
        const mudhohiResult  = parseMudhohi(mudhohiRows || [], allHewan);
        const mustahiqResult = parseMustahiq(mustahiqRows || []);

        setPreview({ hewan: hewanResult, mudhohi: mudhohiResult, mustahiq: mustahiqResult });
        setStep("preview");
      } catch (err) {
        setError("Gagal membaca file: " + err.message);
      }
      setLoading(false);
    };
    reader.readAsArrayBuffer(f);
  };

  const totalErrors = preview
    ? preview.hewan.errors.length + preview.mudhohi.errors.length + preview.mustahiq.errors.length
    : 0;
  const totalImport = preview
    ? preview.hewan.data.length + preview.mudhohi.data.length + preview.mustahiq.data.length
    : 0;

  const doImport = () => {
    if (!preview) return;
    const hasil = {
      hewan:    mode === "replace" ? preview.hewan.data    : [...existingHewan,    ...preview.hewan.data],
      mudhohi:  mode === "replace" ? preview.mudhohi.data  : [...existingMudhohi,  ...preview.mudhohi.data],
      mustahiq: mode === "replace" ? preview.mustahiq.data : [...existingMustahiq, ...preview.mustahiq.data],
    };
    onImport(hasil);
    addLog && addLog(session, "IMPORT_EXCEL", "IMPORT", file?.name, file?.name, {
      hewan: preview.hewan.data.length,
      mudhohi: preview.mudhohi.data.length,
      mustahiq: preview.mustahiq.data.length,
      mode,
    });
    setStep("done");
  };

  // ── Drag & drop handlers ────────────────────────────────────
  const handleDragOver = (e) => { e.preventDefault(); e.currentTarget.classList.add("dz-dragover"); };
  const handleDragLeave = (e) => { e.currentTarget.classList.remove("dz-dragover"); };
  const handleDrop = (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove("dz-dragover");
    const f = e.dataTransfer.files[0];
    if (f) handleFile({ target: { files: [f] } });
  };

  // ── UI: Step Indicator ───────────────────────────────────────
  const steps = ["upload", "preview", "done"];
  const stepIdx = steps.indexOf(step);
  const stepLabels = ["Upload", "Preview", "Selesai"];

  const Stepper = () => (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 28 }}>
      {stepLabels.map((label, i) => {
        const isDone   = i < stepIdx;
        const isActive = i === stepIdx;
        return (
          <React.Fragment key={i}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: i < 2 ? "none" : 1 }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 500,
                border: isDone ? "1.5px solid #3a6e3a" : isActive ? "1.5px solid #c8b46a" : "1.5px solid #2a4a2a",
                background: isDone ? "#1e4a1e" : isActive ? "#c8b46a18" : "#0f1a0f",
                color: isDone ? "#6abf6a" : isActive ? "#c8b46a" : "#4a6a4a",
                transition: "all 0.25s",
                position: "relative", zIndex: 2,
              }}>
                {isDone ? "✓" : i + 1}
              </div>
              <div style={{
                fontSize: 11, marginTop: 6,
                color: isDone ? "#6abf6a" : isActive ? "#c8b46a" : "#4a6a4a",
                transition: "color 0.25s",
              }}>{label}</div>
            </div>
            {i < stepLabels.length - 1 && (
              <div style={{
                flex: 1, height: 1.5, margin: "0 4px", marginBottom: 18,
                background: "#1a2e1a", position: "relative", overflow: "hidden",
              }}>
                <div style={{
                  position: "absolute", top: 0, left: 0, height: "100%",
                  width: i < stepIdx ? "100%" : "0%",
                  background: "#3a6e3a", transition: "width 0.4s ease",
                }} />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );

  // ── UI: Summary Card ─────────────────────────────────────────
  const SummaryCard = ({ icon, label, count, errors, accentColor, total }) => {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const hasErr = errors > 0;
    return (
      <div style={{
        background: "#0a130a",
        border: `0.5px solid ${hasErr ? "#5a1e1e" : count > 0 ? "#3a5e3a" : "#2a4a2a"}`,
        borderTop: hasErr ? "2px solid #9e3a1e" : `2px solid ${count > 0 ? accentColor : "#2a4a2a"}`,
        borderRadius: 10, padding: "14px 12px", flex: 1,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: "#1a3a1a", color: accentColor,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15,
          }}>{icon}</div>
          {hasErr
            ? <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: "#3a1212", color: "#e06060", fontWeight: 500 }}>
                ⚠ {errors} error
              </span>
            : count > 0
              ? <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: "#1e4a1e", color: "#6abf6a", fontWeight: 500 }}>
                  Siap
                </span>
              : <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: "#1a2e1a", color: "#4a6a4a", fontWeight: 500 }}>
                  Kosong
                </span>
          }
        </div>
        <div style={{ fontSize: 26, fontWeight: 500, color: accentColor, lineHeight: 1, marginBottom: 2 }}>{count}</div>
        <div style={{ fontSize: 11, color: "#4a6a4a", marginBottom: 10 }}>{label}</div>
        <div style={{ height: 3, background: "#1a2e1a", borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 2,
            width: pct + "%",
            background: hasErr ? "#9e3a1e" : accentColor,
            transition: "width 0.6s ease",
          }} />
        </div>
      </div>
    );
  };

  // ── UI: Error Accordion ──────────────────────────────────────
  const [openAccordions, setOpenAccordions] = React.useState({});
  const toggleAcc = (key) => setOpenAccordions(prev => ({ ...prev, [key]: !prev[key] }));

  const ErrorAccordion = ({ errors, label }) => {
    if (!errors?.length) return null;
    const open = openAccordions[label] !== false; // default open
    return (
      <div style={{ marginBottom: 8 }}>
        <div
          onClick={() => toggleAcc(label)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "9px 12px",
            background: "#2a0e0e",
            border: "0.5px solid #5a1e1e",
            borderRadius: open ? "8px 8px 0 0" : 8,
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#d48080", fontWeight: 500 }}>
            ⚠ Error di sheet {label}
            <span style={{ fontSize: 11, padding: "2px 8px", background: "#5a1e1e", color: "#e08080", borderRadius: 10 }}>
              {errors.length} baris
            </span>
          </div>
          <span style={{
            fontSize: 13, color: "#8a4a4a",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            display: "inline-block", transition: "transform 0.2s",
          }}>▾</span>
        </div>
        {open && (
          <div style={{
            background: "#1a0808", border: "0.5px solid #5a1e1e", borderTop: "none",
            borderRadius: "0 0 8px 8px", padding: "10px 12px",
          }}>
            {errors.slice(0, 5).map((e, i) => (
              <div key={i} style={{
                padding: "6px 0",
                borderBottom: i < Math.min(errors.length, 5) - 1 ? "0.5px solid #2a1010" : "none",
                fontSize: 12, color: "#c08080", lineHeight: 1.5,
              }}>
                <strong style={{ color: "#e08080" }}>Baris {e.baris}</strong> ({e.nama}): {e.masalah.join(", ")}
              </div>
            ))}
            {errors.length > 5 && (
              <div style={{ fontSize: 11, color: "#6a3a3a", marginTop: 6 }}>
                ...dan {errors.length - 5} error lainnya
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Inline styles ────────────────────────────────────────────
  const S = {
    btn: (color, bg) => ({
      padding: "10px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
      cursor: "pointer", border: `1px solid ${color}`, background: bg,
      color, display: "flex", alignItems: "center", gap: 6, transition: "all 0.15s",
    }),
  };

  return (
    <Modal onClose={onClose} title="Import dari Excel">

      {/* ── Step Indicator ── */}
      <Stepper />

      {/* ══ STEP: UPLOAD ══════════════════════════════════════ */}
      {step === "upload" && (
        <div>
          {/* Drop zone */}
          <div
            className="import-dropzone"
            onClick={() => fileRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              border: `1.5px dashed ${error ? "#9e3a1e" : file ? "#3a6e3a" : "#2a5a2a"}`,
              borderStyle: file ? "solid" : "dashed",
              borderRadius: 12, padding: "36px 24px",
              textAlign: "center", cursor: "pointer",
              background: file ? "#0d1d0d" : "#0a130a",
              marginBottom: 16, transition: "border-color 0.2s, background 0.2s",
            }}
          >
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              background: "#1a3a1a", border: "0.5px solid #2a5a2a",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 14px", fontSize: 22, color: file ? "#6abf6a" : "#4a8a4a",
            }}>📂</div>
            <div style={{ fontSize: 14, fontWeight: 500, color: "#c0d4c0", marginBottom: 6 }}>
              {file ? file.name : "Klik atau seret file Excel ke sini"}
            </div>
            <div style={{ fontSize: 12, color: "#4a6a4a" }}>
              Format .xlsx atau .xls · gunakan template yang disediakan
            </div>
            {file && (
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6, marginTop: 12,
                padding: "5px 12px", background: "#1e3e1e", border: "0.5px solid #3a6a3a",
                borderRadius: 20, fontSize: 12, color: "#8abf8a",
              }}>
                ✓ File dipilih
              </div>
            )}
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ display: "none" }} />
          </div>

          {error && (
            <div style={{
              color: "#e06060", fontSize: 13, marginBottom: 14,
              padding: "10px 14px", background: "#3a100833",
              border: "0.5px solid #9e3a1e55", borderRadius: 8,
              display: "flex", alignItems: "flex-start", gap: 8,
            }}>
              <span style={{ flexShrink: 0 }}>⚠</span> {error}
            </div>
          )}

          {loading && (
            <div style={{ textAlign: "center", color: "#4a6a4a", padding: 16, fontSize: 14 }}>
              ⏳ Membaca file...
            </div>
          )}

          <div style={{
            display: "flex", gap: 10, alignItems: "flex-start",
            padding: "12px 14px", background: "#c8b46a0e",
            border: "0.5px solid #c8b46a33", borderRadius: 8,
            fontSize: 12, color: "#a09050", lineHeight: 1.5,
          }}>
            <span style={{ color: "#c8b46a", flexShrink: 0 }}>💡</span>
            Belum punya template? Download di{" "}
            <strong style={{ color: "#c8b46a" }}>Pengaturan → Template Excel</strong>
          </div>
        </div>
      )}

      {/* ══ STEP: PREVIEW ═════════════════════════════════════ */}
      {step === "preview" && preview && (
        <div>
          {/* File info bar */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 12px", background: "#1a2e1a",
            border: "0.5px solid #2a4a2a", borderRadius: 8, marginBottom: 16,
            fontSize: 13, color: "#8aaf8a",
          }}>
            <span>📄</span>
            <span style={{ flex: 1 }}>{file?.name}</span>
            <span style={{ fontSize: 11, color: "#3a6a3a" }}>Terbaca</span>
            <span style={{ color: "#4a9e4a" }}>✓</span>
          </div>

          {/* Summary cards */}
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <SummaryCard
              icon="🐾" label="Hewan"
              count={preview.hewan.data.length}
              errors={preview.hewan.errors.length}
              accentColor="#c8b46a"
              total={preview.hewan.data.length + preview.hewan.errors.length}
            />
            <SummaryCard
              icon="👥" label="Mudhohi"
              count={preview.mudhohi.data.length}
              errors={preview.mudhohi.errors.length}
              accentColor="#6a9abf"
              total={preview.mudhohi.data.length + preview.mudhohi.errors.length}
            />
            <SummaryCard
              icon="🎟" label="Mustahiq"
              count={preview.mustahiq.data.length}
              errors={preview.mustahiq.errors.length}
              accentColor="#9a8acf"
              total={preview.mustahiq.data.length + preview.mustahiq.errors.length}
            />
          </div>

          {/* Error accordions */}
          {totalErrors > 0 && (
            <div style={{ marginBottom: 12 }}>
              <ErrorAccordion errors={preview.hewan.errors}    label="Hewan" />
              <ErrorAccordion errors={preview.mudhohi.errors}  label="Mudhohi" />
              <ErrorAccordion errors={preview.mustahiq.errors} label="Mustahiq" />
              <div style={{
                fontSize: 12, color: "#a09050",
                padding: "8px 12px", marginTop: 8,
                background: "#c8b46a0a", border: "0.5px solid #c8b46a22",
                borderRadius: 6, display: "flex", alignItems: "flex-start", gap: 8,
              }}>
                <span style={{ color: "#c8b46a", flexShrink: 0 }}>ℹ</span>
                Baris error akan <strong style={{ color: "#c8b46a" }}>dilewati</strong>. {totalImport} data valid akan diimport.
              </div>
            </div>
          )}

          {totalImport === 0 && (
            <div style={{
              color: "#e06060", fontSize: 14, textAlign: "center",
              padding: 16, background: "#2a080833", borderRadius: 8,
              border: "0.5px solid #9e3a1e55", marginBottom: 12,
            }}>
              ✗ Tidak ada data valid yang bisa diimport.
            </div>
          )}

          {/* Mode import */}
          {totalImport > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#4a6a4a", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Mode import
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                {[
                  { val: "append", icon: "＋", name: "Tambahkan", desc: "Gabung dengan data yang ada" },
                  { val: "replace", icon: "↺", name: "Ganti Semua", desc: "Hapus data lama, pakai ini" },
                ].map(m => (
                  <div
                    key={m.val}
                    onClick={() => setMode(m.val)}
                    style={{
                      padding: "12px", borderRadius: 8, cursor: "pointer",
                      background: mode === m.val
                        ? (m.val === "replace" ? "#2e1010" : "#1a3e1a")
                        : "#0a130a",
                      border: `1px solid ${mode === m.val
                        ? (m.val === "replace" ? "#9e3a1e" : "#4a9e4a")
                        : "#2a4a2a"}`,
                      transition: "all 0.15s",
                    }}
                  >
                    <div style={{ fontSize: 18, marginBottom: 6 }}>{m.icon}</div>
                    <div style={{
                      fontSize: 13, fontWeight: 500, marginBottom: 2,
                      color: mode === m.val
                        ? (m.val === "replace" ? "#e06060" : "#8abf8a")
                        : "#c0d4c0",
                    }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: "#4a6a4a" }}>{m.desc}</div>
                  </div>
                ))}
              </div>
              {mode === "replace" && (
                <div style={{
                  padding: "8px 12px", background: "#3a100833",
                  border: "0.5px solid #9e3a1e55", borderRadius: 6,
                  fontSize: 12, color: "#e06060",
                  display: "flex", alignItems: "flex-start", gap: 8,
                }}>
                  <span style={{ flexShrink: 0 }}>⚠</span>
                  Semua data hewan, mudhohi, dan mustahiq yang ada akan terhapus permanen.
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setStep("upload")}
              style={{
                ...S.btn("#4a6a4a", "transparent"),
                border: "1px solid #2a4a2a", color: "#6a8a6a",
              }}
            >
              ← Kembali
            </button>
            {totalImport > 0 && (
              <button
                onClick={doImport}
                style={{
                  ...S.btn(
                    mode === "replace" ? "#e06060" : "#c0e0c0",
                    mode === "replace" ? "#4a1818" : "#2a5e2a",
                  ),
                  flex: 1, border: `1px solid ${mode === "replace" ? "#7a2e2e" : "#3a7e3a"}`,
                  justifyContent: "center",
                }}
              >
                {mode === "replace" ? "↺" : "✓"} Import {totalImport} Data
              </button>
            )}
          </div>
        </div>
      )}

      {/* ══ STEP: DONE ════════════════════════════════════════ */}
      {step === "done" && (
        <div style={{ textAlign: "center", padding: "16px 0 8px" }}>
          <div style={{
            width: 64, height: 64, borderRadius: "50%",
            background: "#1a3e1a", border: "1.5px solid #3a7a3a",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 16px", fontSize: 28, color: "#6abf6a",
          }}>✓</div>
          <div style={{ fontSize: 17, fontWeight: 500, color: "#c8e8c8", marginBottom: 8 }}>Import Berhasil!</div>
          <div style={{ fontSize: 13, color: "#4a6a4a", marginBottom: 20, lineHeight: 1.6 }}>
            Data berhasil ditambahkan ke sistem Qurban.
          </div>

          {/* Done stats */}
          <div style={{
            display: "flex", border: "0.5px solid #2a4a2a",
            borderRadius: 10, overflow: "hidden", marginBottom: 20,
            background: "#0a130a",
          }}>
            {[
              { num: preview.hewan.data.length,    label: "Hewan",    color: "#c8b46a" },
              { num: preview.mudhohi.data.length,  label: "Mudhohi",  color: "#6a9abf" },
              { num: preview.mustahiq.data.length, label: "Mustahiq", color: "#9a8acf" },
            ].map((s, i) => (
              <div key={i} style={{
                flex: 1, padding: "12px 8px", textAlign: "center",
                borderRight: i < 2 ? "0.5px solid #2a4a2a" : "none",
              }}>
                <div style={{ fontSize: 22, fontWeight: 500, marginBottom: 2, color: s.color }}>{s.num}</div>
                <div style={{ fontSize: 11, color: "#4a6a4a" }}>{s.label}</div>
              </div>
            ))}
          </div>

          <button
            onClick={onClose}
            style={{
              ...S.btn("#c0e0c0", "#2a5e2a"),
              border: "1px solid #3a7e3a",
              width: "100%", justifyContent: "center",
            }}
          >
            Tutup
          </button>
        </div>
      )}
    </Modal>
  );
}


// ══════════════════════════════════════════════════════════════
// CARA INTEGRASI KE App.jsx
// ══════════════════════════════════════════════════════════════
//
// 1. Copy komponen ImportExcelModal ke App.jsx
//
// 2. Install SheetJS:
//    npm install xlsx
//    Lalu tambahkan di atas App.jsx:
//    import * as XLSX from 'xlsx';
//
// 3. Di SettingsPage atau halaman manapun, tambahkan state:
//    const [showImport, setShowImport] = useState(false);
//
// 4. Tambahkan tombol Import:
//    <Btn color={C.blue} onClick={() => setShowImport(true)}>
//      📥 Import dari Excel
//    </Btn>
//
// 5. Tambahkan modal:
//    {showImport && (
//      <ImportExcelModal
//        onClose={() => setShowImport(false)}
//        onImport={(hasil) => {
//          setHewan(hasil.hewan);
//          setMudhohi(hasil.mudhohi);
//          setMustahiq(hasil.mustahiq);
//          setShowImport(false);
//        }}
//        existingHewan={hewan}
//        existingMudhohi={mudhohi}
//        existingMustahiq={mustahiq}
//        session={session}
//        addLog={addLog}
//      />
//    )}
//
// 6. (Opsional) Tombol download template di Pengaturan:
//    Simpan file template_qurban.xlsx di /public/,
//    lalu buat link:
//    <a href="/template_qurban.xlsx" download>
//      📋 Download Template Excel
//    </a>
// ══════════════════════════════════════════════════════════════
