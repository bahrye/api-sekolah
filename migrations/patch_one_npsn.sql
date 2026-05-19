UPDATE sekolah SET
  -- SatuanPendidikanId dihapus (lihat drop_satuan_pendidikan_id.sql)
  BentukGroup = 'SD SEDERAJAT',
  Provinsi = 'PROV. SULAWESI SELATAN',
  Kelurahan = 'TANUNTUNG',
  Kecamatan = 'KEC. HERLANG',
  Alamat = 'BUTUNG'
WHERE NPSN = '60723552';
