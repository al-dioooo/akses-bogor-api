# AksesBogor API

API untuk AksesBogor, aplikasi informasi aksesibilitas fasilitas publik di Kota Bogor. API ini menyimpan lokasi, laporan warga, dan hasil verifikasi, lalu melayani aplikasi web [akses-bogor-web](https://github.com/al-dioooo/akses-bogor-web).

Keputusan produk dan teknis ada di [akses-bogor-docs](https://github.com/al-dioooo/akses-bogor-docs), termasuk [PRD](https://github.com/al-dioooo/akses-bogor-docs/blob/main/product/prd.md) dan [ADR](https://github.com/al-dioooo/akses-bogor-docs/tree/main/decisions).

## Tech Stack

| Bagian | Pilihan |
| --- | --- |
| Runtime | Node.js 22 LTS di CI, Node.js 24 LTS di produksi |
| Framework | Fastify 5, TypeScript 6 |
| Validasi dan API spec | Zod lewat `fastify-type-provider-zod`, OpenAPI dari `@fastify/swagger` |
| Database | PostgreSQL 17 + PostGIS dan `pg_trgm`, Drizzle ORM |
| Tes dan lint | Vitest, ESLint dengan typescript-eslint |
| Hosting | Evergarden (VM OCI region Batam): systemd di balik Cloudflare Tunnel |

Alasan pilihan ini ada di [ADR-0013](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0013-tech-stack-nextjs-fastify.md), [ADR-0025](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0025-api-dan-postgresql-di-vps-sendiri.md), dan [ADR-0026](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0026-api-dan-postgresql-di-evergarden-oci.md).

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

Produksi berjalan di Evergarden, VM Ubuntu 24.04 di OCI region Batam, dan dibuka di `https://akses-bogor-api.yorhagarden.xyz` lewat Cloudflare Tunnel ([ADR-0026](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0026-api-dan-postgresql-di-evergarden-oci.md)). Berkasnya ada di [deploy/](deploy/).

| Bagian | Di Evergarden |
| --- | --- |
| API | `akses-bogor-api.service`: user `aksesbogor`, `node dist/server.js` di `127.0.0.1:8090`, Node 24 |
| Environment | `/etc/akses-bogor/api.env`, contohnya [deploy/api.env.example](deploy/api.env.example) |
| Rilis | `/srv/akses-bogor/releases/<sha>`; rilis aktif ditunjuk tautan `/srv/akses-bogor/current` |
| Deploy | `akses-bogor-deploy.timer` memeriksa branch `release` setiap 5 menit dan menjalankan [deploy/deploy.sh](deploy/deploy.sh) |
| Database | PostgreSQL 17 + PostGIS dari PGDG, cluster `17/main` di port 5433, koneksi lewat Unix socket dengan autentikasi peer |
| Cadangan | `akses-bogor-backup.timer` pukul 02.30 WIB menjalankan [deploy/backup.sh](deploy/backup.sh); dump di `/var/backups/akses-bogor` |
| Tunnel | Public hostname di dashboard Cloudflare Zero Trust, diarahkan ke `http://127.0.0.1:8090` |

### Rilis

Merge `main` ke `release` lewat PR. Paling lama lima menit kemudian, timer mengekspor commit itu ke `releases/<sha>`, menjalankan `pnpm install --frozen-lockfile`, `pnpm build`, dan `pnpm db:migrate`, memindahkan `current`, lalu me-restart API. Tiga rilis terakhir disimpan.

```bash
journalctl -u akses-bogor-deploy -n 50     # hasil deploy terakhir
sudo systemctl start akses-bogor-deploy    # deploy sekarang tanpa menunggu timer
curl https://akses-bogor-api.yorhagarden.xyz/healthz
```

Rollback dilakukan dengan revert di `release`. Bila perlu kembali sebelum revert itu masuk, hentikan timer supaya tidak men-deploy ulang, lalu pindahkan tautan ke rilis sebelumnya:

```bash
sudo systemctl stop akses-bogor-deploy.timer
sudo -u aksesbogor ln -sfn releases/<sha-lama> /srv/akses-bogor/current
sudo systemctl restart akses-bogor-api
```

Migrasi tidak ikut dibatalkan, jadi rilis lama harus tetap cocok dengan skema yang sekarang. Nyalakan lagi timer setelah revert masuk ke `release`.

Unit systemd dan skrip di `deploy/` dipasang dengan tangan, jadi perubahan pada berkas itu baru berlaku setelah dipasang ulang dengan perintah `install` di bawah dan `sudo systemctl daemon-reload`.

### Menyiapkan Server

Sekali saja, sebagai admin, dari checkout repo ini:

```bash
# PostgreSQL 17 + PostGIS dari PGDG, dan rclone untuk salinan cadangan ke R2
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-17 postgresql-17-postgis-3 rclone
pg_lsclusters   # 17/main harus di port 5433; ubah dengan pg_conftool bila tidak

# User sistem dan database. Role aksesbogor masuk lewat peer, tanpa password.
sudo useradd --system --home-dir /srv/akses-bogor --shell /usr/sbin/nologin aksesbogor
sudo install -d -m 0750 -o aksesbogor -g aksesbogor /srv/akses-bogor
sudo -u postgres createuser -p 5433 aksesbogor
sudo -u postgres createdb -p 5433 --owner aksesbogor aksesbogor
sudo -u postgres psql -p 5433 -d aksesbogor -c 'CREATE EXTENSION IF NOT EXISTS postgis'

# Skrip, unit, environment, dan folder cadangan
sudo install -d -m 0755 /usr/local/lib/akses-bogor
sudo install -m 0755 deploy/deploy.sh deploy/backup.sh /usr/local/lib/akses-bogor/
sudo install -m 0644 deploy/*.service deploy/*.timer /etc/systemd/system/
sudo install -d -m 0750 -g aksesbogor /etc/akses-bogor
sudo install -m 0640 -g aksesbogor deploy/api.env.example /etc/akses-bogor/api.env   # lalu sesuaikan
sudo install -d -m 0700 -o postgres -g postgres /var/backups/akses-bogor
sudo systemctl daemon-reload

# Rilis pertama, lalu nyalakan semuanya
sudo -u aksesbogor -H git clone --bare https://github.com/al-dioooo/akses-bogor-api.git /srv/akses-bogor/repo.git
sudo -u aksesbogor -H /usr/local/lib/akses-bogor/deploy.sh release
sudo systemctl enable --now akses-bogor-api akses-bogor-deploy.timer akses-bogor-backup.timer
```

Terakhir, tambahkan public hostname `akses-bogor-api.yorhagarden.xyz` di tunnel Evergarden (Zero Trust → Networks → Tunnels), dengan service `http://127.0.0.1:8090`. Hostname lain di tunnel itu jangan diubah.

### Data Preview

Sampai data lapangan pertama masuk, database produksi berisi data contoh dari `pnpm db:seed` (ADR-0026). Seed menolak `NODE_ENV=production`, jadi untuk preview dijalankan sekali dengan `NODE_ENV=development`, yang menang atas nilai di berkas environment:

```bash
sudo -u aksesbogor -H sh -c 'cd /srv/akses-bogor/current && NODE_ENV=development COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  corepack pnpm exec tsx --env-file=/etc/akses-bogor/api.env scripts/seed.ts'
```

Seed mengosongkan data lokasi dan laporan. Jangan jalankan lagi setelah ada data nyata.

### Cadangan dan Pemulihan

- Tujuh dump terakhir ada di `/var/backups/akses-bogor/aksesbogor-<waktu UTC>.dump`, hanya bisa dibaca user `postgres`.
- Salinan R2: buat bucket privat yang terpisah dari bucket foto, dengan lifecycle rule yang menghapus objek setelah 30 hari, dan token R2 khusus bucket itu. Salin [deploy/backup.env.example](deploy/backup.env.example) ke `/etc/akses-bogor/backup.env` (root, mode `0600`) dan isi kredensialnya.
- Menjalankan cadangan sekarang: `sudo systemctl start akses-bogor-backup`, lalu `journalctl -u akses-bogor-backup -n 20`.

Memulihkan dump ke database baru:

```bash
sudo systemctl stop akses-bogor-deploy.timer akses-bogor-api
sudo -u postgres dropdb -p 5433 aksesbogor
sudo -u postgres createdb -p 5433 --owner aksesbogor aksesbogor
sudo -u postgres pg_restore -p 5433 -d aksesbogor /var/backups/akses-bogor/<dump>
sudo systemctl start akses-bogor-api akses-bogor-deploy.timer
```

## Kontribusi

Ikuti [AGENTS.md](AGENTS.md) dan [guideline tim](https://github.com/al-dioooo/akses-bogor-docs/tree/main/guidelines): issue, branch `feature/`, `fix/`, atau `chore/`, commit kecil dengan Conventional Commits, lalu PR dengan nomor issue di judul. CI menjalankan lint, typecheck, tes, build, dan pemeriksaan API spec di setiap PR.
