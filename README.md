# AksesBogor API

API untuk AksesBogor, aplikasi informasi aksesibilitas fasilitas publik di Kota Bogor. API ini menyimpan lokasi, laporan warga, dan hasil verifikasi, lalu melayani aplikasi web [akses-bogor-web](https://github.com/al-dioooo/akses-bogor-web).

Keputusan produk dan teknis ada di [akses-bogor-docs](https://github.com/al-dioooo/akses-bogor-docs), termasuk [PRD](https://github.com/al-dioooo/akses-bogor-docs/blob/main/product/prd.md) dan [ADR](https://github.com/al-dioooo/akses-bogor-docs/tree/main/decisions).

## Tech Stack

| Bagian | Pilihan |
| --- | --- |
| Runtime | Node.js 22 LTS |
| Framework | Fastify 5, TypeScript 6 |
| Validasi dan API spec | Zod lewat `fastify-type-provider-zod`, OpenAPI dari `@fastify/swagger` |
| Database | PostgreSQL 17 + PostGIS dan `pg_trgm`, Drizzle ORM |
| Tes dan lint | Vitest, ESLint dengan typescript-eslint |
| Hosting | VPS milik tim: systemd di balik Cloudflare Tunnel |

Alasan pilihan ini ada di [ADR-0013](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0013-tech-stack-nextjs-fastify.md) dan [ADR-0025](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0025-api-dan-postgresql-di-vps-sendiri.md).

## Menjalankan di Lokal

Butuh Node.js 22 atau lebih baru, pnpm 12 (`corepack enable` memakai versi di `package.json`), dan PostgreSQL 17 dengan PostGIS (lihat [Database](#database)).

```bash
pnpm install
cp .env.example .env   # lalu isi DATABASE_URL ke PostgreSQL lokal
pnpm db:migrate
pnpm db:seed
pnpm dev               # http://localhost:8080/healthz
```

| Skrip | Fungsi |
| --- | --- |
| `pnpm dev` | Server dengan reload otomatis, membaca `.env` |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | Pemeriksaan tipe TypeScript |
| `pnpm test` | Tes Vitest |
| `pnpm build` | Kompilasi ke `dist/` |
| `pnpm start` | Menjalankan `dist/server.js` |
| `pnpm openapi` | Menulis ulang `docs/openapi.json` dari skema route |
| `pnpm db:generate` | Membuat migrasi Drizzle dari `src/db/schema.ts` |
| `pnpm db:migrate` | Menjalankan migrasi ke database di `DATABASE_URL` |
| `pnpm db:seed` | Mengosongkan data lokasi dan laporan, lalu mengisi enam kecamatan dan tujuh lokasi contoh; ditolak di production |

## Database

PostgreSQL 17 dengan PostGIS dan `pg_trgm`. Skema ada di `src/db/schema.ts` dan diagramnya di [docs/arsitektur.md](docs/arsitektur.md#model-data).

- Setelah mengubah skema, jalankan `pnpm db:generate` lalu commit berkas baru di `drizzle/`. Periksa SQL-nya: drizzle-kit tidak menulis SRID untuk kolom titik, jadi tambahkan `4326` sendiri.
- `pnpm db:migrate` menjalankan migrasi ke database di `DATABASE_URL`.
- `pnpm db:seed` mengisi data contoh untuk pengembangan: nama fiktif ("… contoh") di kecamatan nyata, mencakup keempat status.
- Tes database tidak butuh Docker atau Postgres lokal: `test/helpers/db.ts` menjalankan PGlite dengan PostGIS di dalam proses dan menerapkan migrasi yang sama.

Menyiapkan PostgreSQL di Debian 13. `pg_trgm` sudah ikut paket `postgresql-17`. PostGIS hanya bisa diaktifkan superuser, jadi buat ekstensinya sebelum `pnpm db:migrate`:

```bash
sudo apt install postgresql-17 postgresql-17-postgis-3
sudo -u postgres createuser --pwprompt aksesbogor
sudo -u postgres createdb --owner aksesbogor aksesbogor
sudo -u postgres psql -d aksesbogor -c 'CREATE EXTENSION IF NOT EXISTS postgis'
```

## Environment Variables

Contoh lengkap ada di [.env.example](.env.example). Jangan commit `.env`.

| Variabel | Wajib | Keterangan |
| --- | --- | --- |
| `NODE_ENV` | Tidak | `development` (bawaan), `production`, atau `test` |
| `PORT` | Tidak | Port server, bawaan `8080` |
| `HOST` | Tidak | Alamat bind, bawaan `0.0.0.0` |
| `DATABASE_URL` | Ya | Koneksi PostgreSQL untuk aplikasi, `pnpm db:migrate`, dan `pnpm db:seed` |
| `FRONTEND_ORIGINS` | Di production | Origin web yang boleh memanggil API, dipisah koma. Di luar production, `http://localhost:*` selalu diizinkan |
| `PHOTO_PUBLIC_URL` | Tidak | Alamat publik bucket foto Cloudflare R2. Kosong berarti `url` foto di respons bernilai `null` |

## Endpoint

| Endpoint | Isi | Kebutuhan |
| --- | --- | --- |
| `GET /healthz` | Cek server hidup | |
| `GET /districts` | Enam kecamatan dengan jumlah lokasi | FR-03 |
| `GET /places` | Daftar lokasi: pencarian `q`, filter `category`, `district`, `facility`, `status` (dipisah koma), `limit`, `offset` | FR-02 sampai FR-04 |
| `GET /places/map` | GeoJSON untuk Mapbox dengan filter yang sama dan `bbox` | FR-05 |
| `GET /places/stats` | Jumlah per kategori, pintu masuk tanpa tangga, dan kontributor | FR-01 |
| `GET /places/{id}` | Detail: jawaban, alasan, catatan, ringkasan X dari Y, fasilitas penentu status, foto, `needsRecheck` | FR-06, FR-07, FR-38 |

Status lokasi dan ringkasannya dihitung dengan aturan "pintu masuk dulu" di `src/domain/status.ts` (ADR-0018) dan disimpan di tabel `places`; panggil `refreshPlaceStatus` setiap kali jawaban fasilitas berubah. Respons memakai nilai enum produk (mis. `sebagian`, `tidak_tersedia`); teks untuk pengguna disusun di web.

## API Spec

[docs/openapi.json](docs/openapi.json) dibuat dari skema Zod di setiap route dan juga tersedia di `GET /openapi.json`. Setelah mengubah route, jalankan `pnpm openapi` dan commit hasilnya; CI gagal bila berkas itu tidak sesuai kode.

Semua galat memakai bentuk `{ "galat": "kode_snake_case", "pesan": "Pesan untuk pengguna" }`.

## Arsitektur

Diagram dan struktur folder ada di [docs/arsitektur.md](docs/arsitektur.md).

## Deployment

Belum di-deploy. Rencananya, sesuai [ADR-0025](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0025-api-dan-postgresql-di-vps-sendiri.md):

- API berjalan di VPS milik tim sebagai service systemd dengan user sistem sendiri: Node 22 LTS, `node dist/server.js`, dan `HOST=127.0.0.1`.
- Cloudflare Tunnel meneruskan hostname API ke `localhost:8080`; TLS diurus Cloudflare. Health check di `/healthz`.
- PostgreSQL 17 + PostGIS di VPS yang sama, hanya menerima koneksi dari localhost.
- Environment variable disimpan di berkas environment service systemd, bukan di repo.
- Migrasi dijalankan dengan `pnpm db:migrate` sebelum versi baru menerima trafik.
- Timer systemd menjalankan `pg_dump -Fc` setiap malam: tujuh dump disimpan di VPS dan salinannya di bucket R2 privat selama 30 hari.

Workflow deploy ditambahkan terpisah.

## Kontribusi

Ikuti [AGENTS.md](AGENTS.md) dan [guideline tim](https://github.com/al-dioooo/akses-bogor-docs/tree/main/guidelines): issue, branch `feature/`, `fix/`, atau `chore/`, commit kecil dengan Conventional Commits, lalu PR dengan nomor issue di judul. CI menjalankan lint, typecheck, tes, build, dan pemeriksaan API spec di setiap PR.
