# 🏫 EduAPI Indonesia — API Data Sekolah Kita

[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare_Pages-F38020?style=for-the-badge&logo=Cloudflare&logoColor=white)](https://pages.cloudflare.com)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare_D1-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://developers.cloudflare.com/d1)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

**EduAPI Indonesia** adalah gateway API super cepat berbasis *Edge Serverless* untuk mengakses ratusan ribu data master satuan pendidikan di seluruh Indonesia (dan sekolah luar negeri di bawah pembinaan Indonesia). 

Data pada API ini disinkronisasikan secara berkala dari portal data induk pendidikan nasional melalui proses otomatisasi di GitHub Actions menuju database **Supabase (PostgreSQL)** dengan cadangan replika statis di Edge CDN.

---

## 🚀 Base URL

Semua request API dapat diarahkan ke base URL berikut:

```http
https://api-sekolah-kita.pages.dev
```

---

## 🗺️ Fitur Utama

- ⚡ **Super Cepat**: Berjalan di Cloudflare Edge Serverless Network dengan latensi sangat rendah.
- 🔍 **Pencarian Cerdas**: Pencarian instan (1ms) untuk exact match NPSN (8 digit) serta pencarian parsial nama sekolah.
- 🎛️ **Filter Fleksibel**: Saring data berdasarkan Provinsi, bentuk pendidikan (SD, SMP, SMA, SMK, dll), atau kombinasi keduanya.
- 📊 **Rekapitulasi Data**: Endpoint khusus untuk statistik persebaran jenjang pendidikan per wilayah.
- 🔄 **Sinkronisasi Otomatis**: Pipeline sinkronisasi yang terus memperbarui data agar tetap aktual.

---

## 📖 Dokumentasi Endpoint API

### 1. Pencarian & Filter Sekolah
Mengembalikan daftar sekolah sesuai kata kunci pencarian atau filter yang ditentukan.

* **Endpoint**: `/api/sekolah`
* **Method**: `GET`
* **Query Parameters**:

| Parameter | Tipe Data | Wajib | Deskripsi | Contoh |
| :--- | :--- | :---: | :--- | :--- |
| `keyword` | `string` | Tidak | Cari berdasarkan **NPSN** (8 digit angka) atau **nama sekolah** (pencarian parsial). | `60723552` atau `SDN 1` |
| `provinsi` | `string` | Tidak | Saring berdasarkan nama provinsi lengkap (case-sensitive sesuai data). Gunakan `LUAR NEGERI` untuk sekolah luar negeri, atau `LUAR NEGERI - [Nama Negara]` untuk negara spesifik. | `PROV. SULAWESI SELATAN` atau `LUAR NEGERI - JEPANG` |
| `bentuk` | `string` | Tidak | Saring berdasarkan bentuk satuan pendidikan (jenjang). | `SD`, `SMP`, `SMA`, `SMK`, `TK`, `MI`, `MTS`, `MA`, `SLB` |
| `limit` | `integer` | Tidak | Membatasi jumlah data yang dikembalikan. Default: `20`, Maksimal: `50`. | `10` |
| `offset` | `integer` | Tidak | Paginasi data (memulai hasil dari indeks ke-n). Default: `0`. | `40` |

---

### 2. Rekapitulasi Wilayah & Jenjang
Mengembalikan daftar nama provinsi, negara, jenjang yang tersedia, beserta jumlah sekolah per jenjang di setiap wilayah.

* **Endpoint**: `/api/rekap`
* **Method**: `GET`
* **Respons**: Objek JSON berisi daftar unik provinsi/negara/jenjang serta total data yang dipetakan per wilayah.

---

### 3. Status Sinkronisasi
Menampilkan informasi tentang total data yang terindeks serta waktu pembaruan terakhir.

* **Endpoint**: `/api/status`
* **Method**: `GET`

---

## 💡 Panduan & Cara Penggunaan Pencarian

Berikut adalah beberapa contoh skenario penggunaan API beserta URL lengkapnya yang bisa dicoba:

### A. Pencarian Cepat Berdasarkan NPSN (Paling Direkomendasikan)
Jika Anda menginputkan 8 digit angka sebagai `keyword`, API secara otomatis mendeteksi parameter ini sebagai NPSN dan melakukan pencarian langsung menggunakan Primary Key di database. Proses ini hanya memakan waktu sekitar **1ms**.

```http
GET https://api-sekolah-kita.pages.dev/api/sekolah?keyword=60723552
```

### B. Pencarian Parsial Berdasarkan Nama Sekolah
Untuk mencari sekolah berdasarkan nama, masukkan penggalan nama pada parameter `keyword`.

```http
GET https://api-sekolah-kita.pages.dev/api/sekolah?keyword=merdeka
```

### C. Penyaringan (Filtering) Berdasarkan Provinsi
Gunakan nama provinsi lengkap dengan prefix `PROV. ` (contoh: `PROV. DKI JAKARTA`, `PROV. JAWA BARAT`, dll).

```http
GET https://api-sekolah-kita.pages.dev/api/sekolah?provinsi=PROV.+JAWA+TIMUR
```

### D. Penyaringan Berdasarkan Bentuk Pendidikan (Jenjang)
Mencari sekolah dengan jenjang pendidikan tertentu, misalnya hanya SMK atau MA.

```http
GET https://api-sekolah-kita.pages.dev/api/sekolah?bentuk=SMK
```

### E. Kombinasi Pencarian & Multi-Filter
Anda dapat menggabungkan pencarian teks dengan filter provinsi dan bentuk pendidikan untuk hasil yang lebih spesifik.

```http
GET https://api-sekolah-kita.pages.dev/api/sekolah?keyword=sains&provinsi=PROV.+DI+YOGYAKARTA&bentuk=SMA
```

### F. Sekolah di Luar Negeri (Berdasarkan Negara)
Untuk menampilkan daftar sekolah Indonesia di luar negeri, Anda bisa menggunakan filter provinsi `LUAR NEGERI` atau menyaring spesifik per negara.

* **Semua Sekolah Luar Negeri**:
  ```http
  GET https://api-sekolah-kita.pages.dev/api/sekolah?provinsi=LUAR+NEGERI
  ```
* **Spesifik Negara (contoh: Jepang)**:
  ```http
  GET https://api-sekolah-kita.pages.dev/api/sekolah?provinsi=LUAR+NEGERI+-+JEPANG
  ```

### G. Paginasi Hasil Pencarian
Untuk mengambil halaman berikutnya dari suatu pencarian, gunakan kombinasi `limit` dan `offset`.

* **Mengambil 10 data pertama**:
  ```http
  GET https://api-sekolah-kita.pages.dev/api/sekolah?limit=10&offset=0
  ```
* **Mengambil 10 data berikutnya (Halaman 2)**:
  ```http
  GET https://api-sekolah-kita.pages.dev/api/sekolah?limit=10&offset=10
  ```

---

## 📦 Struktur Respons JSON

Berikut adalah format respons JSON standar yang dikembalikan oleh `/api/sekolah`:

```json
{
  "status": "success",
  "source": "API Sekolah Mandiri",
  "developer": "Syamsul Bahri",
  "metadata": {
    "limit_ditampilkan": 5,
    "offset_saat_ini": 0,
    "waktu_update_data_terakhir": "17 Mei 2026 pukul 18.26",
    "waktu_update_data_terakhir_iso": "2026-05-17T11:26:31Z",
    "developer": "Syamsul Bahri",
    "total_data_tersedia": null,
    "catatan_total": "Total hasil pencarian tidak dihitung agar kuota baca database tetap hemat.",
    "has_more": true
  },
  "data": [
    {
      "npsn": "60723552",
      "nama": "MIS BUTUNG",
      "bentuk_pendidikan": "MI",
      "bentuk_pendidikan_group": "SD SEDERAJAT",
      "jenis_pendidikan": "PENDIDIKAN UMUM",
      "status_satuan_pendidikan": "SWASTA",
      "jenjang_pendidikan": "PENDIDIKAN DASAR",
      "pembina": "KEMENTERIAN AGAMA",
      "jalur_pendidikan": "FORMAL",
      "nama_desa": "TANUNTUNG",
      "nama_kecamatan": "KEC. HERLANG",
      "nama_kabupaten": "KAB. BULUKUMBA",
      "nama_provinsi": "PROV. SULAWESI SELATAN",
      "alamat_jalan": "BUTUNG"
    }
  ]
}
```

---

## 🛠️ Pengembangan Lokal & Deployment

### Prasyarat
- Node.js versi terbaru
- Cloudflare Wrangler CLI (`npm install -g wrangler`)

### Langkah-langkah
1. **Kloning Repositori**:
   ```bash
   git clone https://github.com/username/api-sekolah.git
   cd api-sekolah
   ```

2. **Instal Dependensi**:
   ```bash
   npm install
   ```

3. **Konfigurasi Environment**:
   Salin `.dev.vars.example` ke `.dev.vars` untuk pengembangan lokal.
   ```bash
   cp .dev.vars.example .dev.vars
   ```

4. **Jalankan Lokal**:
   Untuk menjalankan database dan server simulasi Cloudflare Pages Functions secara lokal:
   ```bash
   npx wrangler pages dev .
   ```

5. **Deploy ke Cloudflare**:
   Pastikan Anda sudah login ke akun Cloudflare melalui CLI, lalu jalankan script deploy:
   ```bash
   npm run deploy
   ```

---

## 🤝 Kontribusi & Dukungan

Proyek ini bersifat open-source. Jika Anda menemukan bug atau ingin menambahkan fitur baru, silakan buka *Issue* atau kirimkan *Pull Request*.

* **Developer**: [Syamsul Bahri](https://github.com/bahrye)
* **Hubungi**: [WhatsApp Developer](https://wa.me/qr/FMVS3NLDIRUAA1)

---

*Dibuat dengan ❤️ untuk kemudahan akses data pendidikan di Indonesia.*
