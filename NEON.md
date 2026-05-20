# Database Neon (PostgreSQL)

API publik dan sinkronisasi memakai **Neon** — bukan Cloudflare D1.

## Konfigurasi wajib

### 1. Cloudflare Pages (`api-sekolah-kita`)

Dashboard → **Settings** → **Environment variables** (Production):

| Nama | Nilai |
|------|--------|
| `DATABASE_URL` | Connection string Neon (pooler) |
| `SYNC_SECRET` | Secret sync (sama seperti sebelumnya) |

### 2. Worker cron (`api-sekolah-cron`)

```bash
npx wrangler secret put DATABASE_URL -c wrangler.cron.toml
npx wrangler secret put SYNC_SECRET -c wrangler.cron.toml
```

### 3. Lokal (opsional)

Salin `.dev.vars.example` → `.dev.vars` dan isi `DATABASE_URL`.

## Skema sync (sekali)

Setelah migrasi data sekolah, jalankan:

```bash
npm run neon:schema
```

Ini membuat `sync_meta`, `sync_page_fp`, dan kolom `row_fp` di tabel `sekolah`.

## Deploy

```bash
npm run deploy
```

## Limit API publik

`GET /api/sekolah` — maksimal **50** baris per halaman (default 20).
