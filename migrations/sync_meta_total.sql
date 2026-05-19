INSERT INTO sync_meta (key, value) VALUES ('total_sekolah', '552577')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
