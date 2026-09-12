# Sinkronisasi Otomatis via GitHub Actions & Cloudflare Pages

Sinkronisasi data sekolah berjalan otomatis dari portal resmi `api.data.belajar.id` ke database **Supabase (PostgreSQL)** melalui aplikasi Cloudflare Pages.

Tidak ada lagi Worker terpisah (`api-sekolah-cron.dunia-sekolah.workers.dev`) maupun database Cloudflare D1. Seluruh proses sinkronisasi kini terpusat langsung di dalam aplikasi ini.

## Arsitektur

1. **GitHub Actions Scheduler** (`.github/workflows/sync-belajar-15m.yml`):
   - Berjalan terjadwal (cron) secara berkala (atau manual via `workflow_dispatch`).
   - Menjalankan `node scripts/fetch-custom.cjs`.
2. **Smart Sync & Batching** (`scripts/fetch-custom.cjs`):
   - Mengambil data dari API resmi Belajar.id secara bertahap.
   - Mengirim batch data langsung ke Cloudflare Pages endpoint `/sync-batch`.
3. **Penyimpanan Supabase** (`functions/sync-batch.js` & `functions/lib/sync-supabase-core.js`):
   - Menerima batch data, memvalidasi `x-cron-secret`.
   - Menghitung fingerprint baris (`row_fp`), melakukan deduplikasi NPSN, dan mengeksekusi upsert ke tabel `sekolah`.
   - Memperbarui tabel `status_sinkronisasi`, `provinsi_sync_status`, dan `npsn_ganda_detail`.

## Konfigurasi Rahasia (GitHub Repository Secrets)

Atur di **Settings → Secrets and variables → Actions**:
- `CRON_SECRET` atau `SYNC_SECRET`: Kode rahasia autentikasi sinkronisasi (wajib sama dengan `SYNC_SECRET` di Cloudflare Pages).
- `CLOUDFLARE_WORKER_URL`: URL aplikasi Cloudflare Pages, default: `https://api-sekolah-kita.pages.dev`.

## Menjalankan Sinkronisasi Manual

- Di GitHub: Buka tab **Actions** → **Sinkronisasi Data Sekolah Otomatis** → **Run workflow**.
- Atau jalankan lokal:
  ```bash
  npm run sync:belajar
  ```
