# Sinkron via GitHub Actions

Cloudflare Cron hanya bisa **1× per menit** dan chunk besar sering memblokir `/tick` berikutnya (~80 baris/menit).

GitHub Actions menjalankan **12× `/step`** per menit (jeda 5 detik) → **~240 sekolah/menit** (12 × 20 baris API).

## Setup

1. GitHub repo → **Settings → Secrets and variables → Actions**
2. Secret: `SYNC_SECRET` (sama dengan Worker `wrangler secret put SYNC_SECRET`)
3. Opsional variable: `WORKER_BASE` = `https://api-sekolah-cron....workers.dev`

## Mulai sync

```bash
# Lanjut dari offset terakhir (disarankan untuk GHA)
curl -H "X-Sync-Secret: ..." \
  "https://api-sekolah-cron..../resume?driver=github"

# Atau mulai dari nol
curl -H "X-Sync-Secret: ..." \
  "https://api-sekolah-cron..../run?offset=0&resume=1&driver=github"
```

Atau: **Actions → Sync sekolah (GitHub Actions) → Run workflow** → centang **Mulai dari offset 0**.

## Perilaku

- **Cloudflare Cron Trigger dinonaktifkan** di `wrangler.cron.toml` (tidak ada `/tick` otomatis atau sync mingguan Senin 01:00 WITA dari CF).
- `driver=github` → jika Cron diaktifkan lagi, CF tidak memproses chunk sync (hanya backfill).
- Setiap `/step` = **1 hal API** (20 sekolah), tanpa chunk lock.
- Workflow `sync-github.yml` jalan **tiap menit** (schedule `* * * * *`).

## Kembali ke Cron Cloudflare

```bash
curl -H "X-Sync-Secret: ..." \
  "https://api-sekolah-cron..../run?offset=OFFSET&resume=1&driver=cron"
```

Nonaktifkan workflow GHA atau biarkan; dengan `driver=cron`, GHA `/step` tetap menulis DB jika dijalankan — sebaiknya **disable** workflow saat pakai cron saja.
