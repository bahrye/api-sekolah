CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Waktu impor/sync awal (sesuaikan jika perlu)
INSERT INTO sync_meta (key, value) VALUES ('last_sync_at', datetime('now'))
ON CONFLICT(key) DO NOTHING;
