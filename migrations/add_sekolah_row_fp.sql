-- Hash per baris: skip UPDATE jika isi sama (hemat kuota tulis D1)
ALTER TABLE sekolah ADD COLUMN row_fp TEXT;
