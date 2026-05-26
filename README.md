# Qurban App SFY

Aplikasi web ringan untuk pencatatan dan manajemen data **qurban** oleh panitia masjid.
Dibangun dengan **React + Vite**, berjalan sepenuhnya di sisi browser (data disimpan di `localStorage`).

> 🕌 Cocok untuk panitia kecil–menengah yang ingin mencatat hewan, shohibul qurban,
> penerima daging, sesi pembagian, RAB, dan log aktivitas tanpa perlu server backend.

---

## ✨ Fitur Utama

- **Autentikasi Panitia** — login dengan username/password, lockout setelah 5x gagal,
  opsi "Ingat saya" (7 hari), pemaksaan ganti password saat pertama login.
- **Manajemen Hewan Qurban** — status alur (`Menunggu → Disembelih → Dikuliti → Selesai`),
  jenis (Sapi/Kambing/Domba), kapasitas per ekor.
- **Shohibul Qurban & Pembayaran** — pencatatan peserta qurban, status bayar (Lunas / Belum Lunas / Cicilan).
- **Penerima Daging & Sesi Distribusi** — pencatatan penerima dan sesi pembagian daging.
- **RAB (Rencana Anggaran)** — pencatatan dan verifikasi anggaran (admin).
- **Notifikasi WhatsApp** — integrasi opsional dengan API [Fonnte](https://fonnte.com/).
- **Audit Log** — semua aksi penting dicatat (maks. 500 entri terakhir).
- **Role-based Access** — `admin` memiliki hak penuh; `panitia` terbatas.
- **Mobile-first UI** — gelap, ramah sentuh, sticky top-bar & nav.

---

## 🚀 Menjalankan Lokal

Prasyarat: **Node.js ≥ 18.18** dan **npm**.

```bash
# 1. Install dependencies
npm install

# 2. Jalankan dev server
npm run dev

# 3. Build untuk produksi
npm run build

# 4. Preview hasil build
npm run preview
```

Dev server akan tersedia di [http://localhost:5173](http://localhost:5173).

---

## 🔐 Akun Default

Saat pertama kali dibuka (database `localStorage` masih kosong), aplikasi membuat akun admin:

| Field    | Nilai                     |
| -------- | ------------------------- |
| Username | `admin`                   |
| Password | `panitiaqurban2026`       |
| Role     | `admin`                   |

> ⚠️ Password **wajib diganti** saat login pertama.

---

## 🗂️ Struktur Proyek

```
.
├── App.jsx           # Seluruh logika & UI aplikasi (single-file React app)
├── main.jsx          # Entry point React
├── styles.css        # Global styles & resets
├── index.html        # Shell HTML + splash screen
├── vite.config.js    # Konfigurasi Vite
├── package.json
└── README.md
```

---

## 💾 Penyimpanan Data

Semua data disimpan di **`localStorage` browser** dengan key:

| Key                  | Isi                          |
| -------------------- | ---------------------------- |
| `qurban_panitia`     | Daftar akun panitia          |
| `qurban_hewan`       | Daftar hewan qurban          |
| `qurban_mudhohi`     | Daftar shohibul qurban       |
| `qurban_mustahiq`    | Daftar penerima daging       |
| `qurban_sesi`        | Sesi pembagian daging        |
| `qurban_rab`         | Rencana Anggaran Biaya       |
| `qurban_token`       | Token API Fonnte (opsional)  |
| `qurban_auditlog`    | Log aktivitas (maks. 500)    |
| `qurban_session*`    | Sesi login (sessionStorage)  |

> 🧹 Untuk reset total: buka DevTools → Application → Storage → Clear site data.

---

## 📲 Integrasi WhatsApp (Opsional)

Untuk mengirim notifikasi WA ke shohibul qurban, daftarkan token API
[Fonnte](https://fonnte.com/) di halaman **Pengaturan** (khusus admin).

---

## 🛠️ Catatan Teknis

- Single-file SPA, **tidak butuh backend**.
- Password di-hash secara deterministik di browser (bukan bcrypt — keterbatasan client-side).
  Untuk produksi sebenarnya, disarankan menyambungkannya ke backend dengan autentikasi server.
- Audit log dibatasi 500 entri terakhir agar `localStorage` tidak meledak.

---

## 📜 Lisensi

Penggunaan internal panitia. Sesuaikan sebelum dipublikasikan.
