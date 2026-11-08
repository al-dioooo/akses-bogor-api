# Arsitektur

Sumber keputusan: [ADR-0013](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0013-tech-stack-nextjs-fastify.md), [ADR-0025](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0025-api-dan-postgresql-di-vps-sendiri.md), [ADR-0026](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0026-api-dan-postgresql-di-evergarden-oci.md), [ADR-0029](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0029-akun-better-auth-dan-sesi-lewat-server-web.md), dan [ADR-0030](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0030-email-transaksional-resend.md). Diagram di bawah memuat bagian yang sudah ada dan yang direncanakan; yang direncanakan ditandai garis putus-putus.

```mermaid
flowchart LR
  B[Browser / PWA] -->|halaman + cookie sesi| W[akses-bogor-web<br/>Next.js di Vercel]
  W -->|render di server, Bearer sesi| F[akses-bogor-api<br/>Fastify + Better Auth di Evergarden, lewat Cloudflare Tunnel]
  F --> DB[(PostgreSQL 17 + PostGIS di Evergarden)]
  DB -.->|pg_dump tiap malam| BK[(R2 privat: cadangan)]
  F -->|foto laporan, WebP tanpa metadata| R2[(Cloudflare R2: bucket foto privat dan publik)]
  F -->|kode masuk| E[Resend: email]
  F -->|kunci publik| G[Google: verifikasi ID token]
  F -->|token peta sementara, pencarian tempat| M[Mapbox: Tokens API, Search Box]
```

- Browser tidak pernah terhubung langsung ke API, database, atau R2. Server web menyimpan token sesi di cookie miliknya dan mengirimnya ke API sebagai `Authorization: Bearer`; setiap request yang menyentuh data akun diperiksa sesi dan perannya di API ([ADR-0029](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0029-akun-better-auth-dan-sesi-lewat-server-web.md)).
- Aplikasi, migrasi, dan seed memakai satu koneksi (`DATABASE_URL`) ke PostgreSQL di mesin yang sama, lewat Unix socket dengan autentikasi peer. Produksi berjalan di Evergarden, VM OCI region Batam; cara deploy ada di [README](../README.md#deployment).
- Foto diperkecil di browser, lalu diperiksa ulang, disandikan ulang dengan sharp, dan dihapus metadata EXIF-nya di API sebelum disimpan ke bucket R2 privat ([ADR-0023](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0023-hingga-sepuluh-foto-bertag-per-laporan.md), [ADR-0031](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0031-foto-laporan-di-bucket-r2-privat.md)). Di development tanpa R2, foto disimpan di folder `.data/foto`.

## Alur Request

```mermaid
sequenceDiagram
  participant K as Klien
  participant F as Fastify
  participant DB as PostgreSQL
  K->>F: Request
  F->>F: CORS, rate limit, validasi skema Zod
  F->>DB: Query lewat Drizzle
  DB-->>F: Data
  F-->>K: Respons sesuai skema, atau { galat, pesan }
```

## Model Data

Mengikuti model data di [PRD bagian 9](https://github.com/al-dioooo/akses-bogor-docs/blob/main/product/prd.md). Skema ada di [src/db/schema.ts](../src/db/schema.ts), migrasi di [drizzle/](../drizzle).

```mermaid
erDiagram
  districts ||--o{ places : "kecamatan"
  places ||--|{ place_facilities : "4 fasilitas"
  places ||--o{ reports : "perubahan, kekurangan"
  places ||--o{ photos : "foto terbit"
  reports ||--o{ photos : "foto laporan"
  users |o--o{ reports : "pelapor, verifikator"
  users |o--o{ photos : "unggahan belum terpasang"
  districts |o--o{ reports : "kecamatan hasil hitung"
  users |o--o{ audit_log : "pengubah"
  reports ||--o{ report_clarifications : "pertanyaan dan jawaban"
  report_clarifications |o--o{ photos : "foto dari jawaban"
  reports ||--o{ report_emails : "email yang menunggu"
```

| Tabel | Isi | Keputusan |
| --- | --- | --- |
| `districts` | Enam kecamatan Kota Bogor dengan batas wilayah (MultiPolygon) dari OpenStreetMap, diisi migrasi | ADR-0010, ADR-0034 |
| `places` | Lokasi yang sudah terbit: kategori, titik (SRID 4326), patokan, deskripsi, status dan ringkasan fasilitas yang disimpan, tanggal verifikasi terakhir | ADR-0004, ADR-0015, ADR-0018 |
| `place_facilities` | Jawaban, alasan, dan catatan untuk setiap fasilitas; alasan hanya boleh ada saat Tidak tersedia | ADR-0017, ADR-0022 |
| `reports` | Laporan baru, perubahan, dan kekurangan dengan isian apa adanya, titik dan kecamatan hasil hitung, kunci draf, status verifikasi, alasan baku R1–R6, pertanyaan klarifikasi yang sedang terbuka, dan catatan internal verifikator | ADR-0006, ADR-0019, ADR-0033, ADR-0036 |
| `report_clarifications` | Pertanyaan klarifikasi verifikator dan jawaban pelapor, berurutan, masing-masing dengan tenggat 7 hari | ADR-0036 |
| `photos` | Berkas di R2, tag objek, teks alternatif, keterangan, dan status moderasi, area yang dikaburkan saat terbit, dan klarifikasi asal foto. Foto yang baru diunggah mencatat pengunggahnya sampai dipasang ke laporan | ADR-0023, ADR-0031, ADR-0037 |
| `users` | Nama tampilan, email (unik tanpa membedakan huruf besar), peran, waktu dan versi persetujuan Kebijakan Privasi | ADR-0011, ADR-0014, ADR-0029 |
| `sessions`, `accounts`, `verifications` | Milik Better Auth: sesi (token tanpa tanda tangan), tautan akun Google, dan kode email (HMAC). Kolom token Google, IP, dan user agent selalu kosong | ADR-0029 |
| `photo_deletions` | Berkas foto di R2 yang menunggu dihapus, mis. foto laporan belum terbit milik akun yang dihapus | ADR-0024 |
| `audit_log` | Siapa mengubah apa dan kapan, tanpa data pribadi; pengubah kosong dengan label `sistem` atau `skrip` untuk tindakan tanpa akun, dan kosong tanpa label berarti akunnya sudah dihapus | FR-35, ADR-0024, ADR-0038 |
| `report_emails` | Email status laporan yang menunggu dikirim atau dicoba ulang: hanya id laporan dan jenis email | ADR-0039 |

Saat akun dihapus, `reporter_id` di laporan menjadi kosong (`ON DELETE SET NULL`); penghapusan laporan yang belum terbit dan foto yang tidak tayang dijalankan `src/auth/delete-account.ts` dalam satu transaksi (ADR-0024).

## Struktur Folder

| Folder | Isi |
| --- | --- |
| `src/config` | Validasi environment variable |
| `src/db` | Klien Drizzle dan skema tabel |
| `drizzle` | Migrasi SQL hasil `pnpm db:generate` |
| `src/http` | Kelas galat dan skema respons galat |
| `src/domain` | Aturan bisnis tanpa HTTP, mis. aturan status lokasi |
| `src/places` | Skema Zod dan query baca lokasi |
| `src/reports` | Query dan skema laporan: Laporan saya, cek kecamatan dan lokasi mirip |
| `src/photos` | Pemeriksaan dan pemrosesan foto (sharp), penyimpanan R2 atau folder lokal, dan pembersihan berkas (ADR-0031) |
| `src/map` | Token Mapbox sementara untuk browser (ADR-0016) dan pencarian tempat lewat Search Box (ADR-0032) |
| `src/auth` | Konfigurasi Better Auth, pemeriksaan sesi, dan aturan akun (ADR-0029) |
| `src/email` | Isi email dan pengirim Resend atau log (ADR-0030) |
| `src/admin` | Peran akun: tim verifikasi, memberi dan mencabut peran (ADR-0035) |
| `src/audit` | Penulis log audit dan pembanding nilai sebelum dan sesudah (ADR-0038) |
| `src/verification` | Panel verifikator: antrean, laporan untuk diperiksa, dan lokasi yang perlu dicek ulang (ADR-0035, ADR-0036) |
| `src/routes` | Route Fastify, satu berkas per kelompok |
| `scripts` | Skrip pendukung, mis. pembuat `docs/openapi.json` |
| `test` | Tes Vitest dengan `app.inject`; tes database memakai PGlite + PostGIS di dalam proses |
| `docs` | Diagram ini dan API spec |
