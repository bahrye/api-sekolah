-- Setelah PAGE_SIZE naik ke 200, indeks halaman API berubah — hapus fingerprint lama.
DELETE FROM sync_page_fp;
