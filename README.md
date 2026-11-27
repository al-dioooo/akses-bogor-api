# AksesBogor API

API untuk AksesBogor, aplikasi informasi aksesibilitas fasilitas publik di Kota Bogor. API ini menyimpan lokasi, laporan warga, dan hasil verifikasi, lalu melayani aplikasi web [akses-bogor-web](https://github.com/al-dioooo/akses-bogor-web).

Keputusan produk dan teknis ada di [akses-bogor-docs](https://github.com/al-dioooo/akses-bogor-docs), termasuk [PRD](https://github.com/al-dioooo/akses-bogor-docs/blob/main/product/prd.md) dan [ADR](https://github.com/al-dioooo/akses-bogor-docs/tree/main/decisions).

## Tech Stack

| Bagian | Pilihan |
| --- | --- |
| Runtime | Node.js 24 LTS di CI, lokal, dan produksi |
| Framework | Fastify 5, TypeScript 6 |
| Validasi dan API spec | Zod lewat `fastify-type-provider-zod`, OpenAPI dari `@fastify/swagger` |
| Database | PostgreSQL 17 + PostGIS dan `pg_trgm`, Drizzle ORM |
| Tes dan lint | Vitest, ESLint dengan typescript-eslint |
| Model agen kontributor | Claude Haiku 5.5 lewat Claude API (`@anthropic-ai/sdk`), OpenRouter sebagai pilihan |
| Hosting | Evergarden (VM OCI region Batam): systemd di balik Cloudflare Tunnel |

Alasan pilihan ini ada di [ADR-0013](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0013-tech-stack-nextjs-fastify.md), [ADR-0025](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0025-api-dan-postgresql-di-vps-sendiri.md), dan [ADR-0026](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0026-api-dan-postgresql-di-evergarden-oci.md).

## Menjalankan di Lokal

Butuh Node.js 24 atau lebih baru, pnpm 12 (`corepack enable` memakai versi di `package.json`), dan PostgreSQL 17 dengan PostGIS (lihat [Database](#database)).

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
| `pnpm db:seed` | Mengosongkan data lokasi dan laporan, lalu mengisi tujuh lokasi contoh; kecamatan dan batasnya tidak dihapus; ditolak di production |
| `pnpm pengetahuan:osm [--salinan]` | Mengambil fitur dan rute angkutan Kota Bogor dari OpenStreetMap ke basis pengetahuan agen rute (ADR-0042) |
| `pnpm pengetahuan:regulasi [--salinan]` | Mengambil teks resmi UU No. 8 Tahun 2016 dan Permen PUPR No. 14/PRT/M/2017, dipotong per pasal dan per bagian lampiran |
| `pnpm pengetahuan:dokumen [--salinan]` | Mengambil halaman edukasi, Panduan Verifikasi, dan ADR aturan fasilitas dan status; jalankan ulang setelah dokumen itu berubah |
| `pnpm pengetahuan:disabilitas [--salinan]` | Mengambil jumlah penyandang disabilitas terdaftar per kecamatan dari Open Data Kota Bogor (Dinas Sosial) untuk prioritas kecamatan (ADR-0043); dipakai hanya saat `DISABILITY_DATA_ENABLED` menyala |
| `pnpm pengetahuan:fasilitas [--salinan]` | Mengambil kampus, masjid, halte, dan rumah sakit di Kota Bogor dari OpenStreetMap sebagai calon tujuan kontributor (ADR-0043) |
| `pnpm pengetahuan:indeks` | Menghitung ulang bentuk dasar (`search_stem`, ADR-0044) semua potongan basis pengetahuan dari teks yang sudah tersimpan, tanpa mengunduh. Jalankan sekali setelah migrasi 0009, dan setiap kali `src/knowledge/stemmer.ts` atau `src/knowledge/kata-dasar.ts` berubah |
| `pnpm pengetahuan:evaluasi [R01 …] [--terpisah] [--rinci] [--json berkas]` | Mengukur retrieval `search_knowledge` tanpa model: recall@3, recall@5, recall@8, dan MRR terhadap sitasi yang harus ditemukan untuk setiap pertanyaan di `scripts/pengetahuan/uji-retrieval.json`. Butuh basis pengetahuan yang sudah dimuat. `--terpisah` memakai set `uji-retrieval-terpisah.json`, yang hanya untuk memeriksa dan tidak dipakai untuk menyetel |
| `pnpm petunjuk:google-ambil [--rencana] [--limit N]` | Mencari kandidat OSM bernama di Google Maps lewat aktor Apify `compass/crawler-google-places` dan menyimpan dataset mentahnya di `~/data/akses-bogor/google-maps/` (ADR-0056). `--rencana` hanya mencetak jumlah pencarian dan perkiraan biaya. Butuh `APIFY_TOKEN` (env atau `~/credentials/akses-bogor/apify.env`) dan memakai saldo Apify |
| `pnpm petunjuk:google-impor [berkas] [--dry-run] [--kecuali node/1,way/2] [--timpa-cara-lain]` | Memuat dataset dari `petunjuk:google-ambil` (bawaan: berkas terbaru) ke tag `aksesbogor:google_maps` kandidat OSM dalam satu transaksi (ADR-0056): kategori sama, nama mirip, 400 m atau kurang, pasangan terdekat menang. Tidak menambah tempat dan tidak menimpa salinan yang sudah diperiksa tim. `--dry-run` hanya mencetak pasangan dan statistik; `--kecuali` tidak memasangkan kandidat yang pasangannya salah |
| `pnpm verifikasi:daftar` | CSV semua data yang belum diperiksa (salinan petunjuk, tempat admin, laporan yang menunggu, kandidat OSM) ke stdout dan jumlahnya ke stderr, di dalam transaksi read-only (ADR-0057). Laporan hanya id, jenis, dan status |
| `pnpm verifikasi:street-view <manifest.json> [--dry-run] [--batalkan] [--sembunyikan-kandidat]` | Menerapkan manifest verifikasi Street View dalam satu transaksi (ADR-0057): data terjawab menjadi tempat bersumber `street_view` dengan fotonya, data tidak terjawab disembunyikan tanpa dihapus. Aman dijalankan ulang; `--batalkan` mengembalikan yang dibuat manifest itu. Tidak pernah menulis `reports` |
| `pnpm agen:evaluasi [--asisten] [K01 …]` | Menjalankan pertanyaan uji agen kontributor (`scripts/agen/pertanyaan-uji.json`), atau dengan `--asisten` pertanyaan asisten rute publik (`scripts/agen/pertanyaan-uji-asisten.json`, dengan titik awal yang hanya dipakai server), sekali ke penyedia di `AGENT_PROVIDER`; untuk Claude mencetak token dan perkiraan biaya per pertanyaan. Butuh API key penyedianya di environment lokal dan memakai saldo atau kuota, jadi jalankan seperlunya. Berhenti setelah `EVALUASI_MAKS_BERHASIL` permintaan berhasil (bawaan 40 untuk Claude, 14 untuk OpenRouter) |
| `pnpm peran --email <email> --peran <admin\|verifikator\|pengguna>` | Mengganti peran akun yang sudah dilengkapi, mis. membuat admin pertama; dicatat di log audit sebagai `skrip` (ADR-0035) |
| `pnpm hak-subjek:catat --jenis <jenis> [--akun <email\|id>] [--diterima "YYYY-MM-DD HH:MM"] --oleh <email admin>` | Mencatat permintaan hak subjek data yang masuk lewat email kontak dan mencetak nomor serta tenggat 3 × 24 jamnya. `--selesai <nomor>` atau `--tolak <nomor> --alasan "…"` menutupnya; `--daftar` menampilkan yang masih terbuka |
| `pnpm hak-subjek:ekspor --akun <email\|id> --permintaan <nomor> --oleh <email admin> --keluar <berkas.json>` | Menulis salinan semua data akun ke berkas JSON baru bermode 600 (tidak menimpa), dengan `catatan` per bagian. Tanpa kunci sesi, hash kode masuk, catatan internal verifikator, dan identitas anggota tim lain. Untuk permintaan berjenis `salinan` |
| `pnpm hak-subjek:ganti-email --akun <email lama\|id> --email-baru <email> --permintaan <nomor> --oleh <email admin>` | Mengganti email akun (permintaan `perbaikan`): cek unik tanpa membedakan huruf besar, tautan Google dilepas, semua sesi diakhiri, dan `emailVerified` kembali false sampai pemilik masuk dengan kode ke email baru. Setelah itu masuk dengan Google untuk email baru menaut lagi |
| `pnpm hak-subjek:tahan --akun <email\|id> --permintaan <nomor> --oleh <email admin> --alasan "…"` | Menahan laporan akun yang belum diputuskan (permintaan `pembatasan`): tidak muncul di antrean, verifikator mendapat 404 `laporan_ditahan`, dan tidak ditolak otomatis karena tenggat klarifikasi. Laporan yang dikirim kemudian tidak ikut ditahan. `--lepas` mengembalikannya ke antrean dan memperpanjang tenggat klarifikasi selama masa tahan |
| `pnpm hak-subjek:email --akun <email\|id> --permintaan <nomor> --oleh <email admin> (--mati\|--nyala)` | Mematikan atau menyalakan email status laporan (terbit, ditolak, klarifikasi) untuk akun (permintaan `pembatasan`). Saat dimatikan, email yang antre dibuang dan pengirim melewati akun itu. Kode masuk tetap dikirim |
| `pnpm hak-subjek:hapus --akun <email\|id> --permintaan <nomor> --oleh <email admin>` | Menghapus akun atas permintaan `penghapusan` lewat email kontak, sama dengan Hapus akun di Akun Saya (ADR-0024), tanpa email konfirmasi otomatis. Akun admin harus diturunkan dulu dengan `pnpm peran` |

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

### Batas Kecamatan

Kecamatan laporan dihitung dari batas enam kecamatan di `districts.boundary` (FR-22, ADR-0034). Batasnya diisi migrasi `drizzle/0004_laporkan.sql`.

- Sumber: OpenStreetMap, relasi 14745927 (Kota Bogor) dan relasi `admin_level=6` di dalamnya, diunduh 2026-11-07. Batas kecamatan © kontributor OpenStreetMap, berlisensi [ODbL](https://opendatacommons.org/licenses/odbl/); data batas di repo ini tetap berlisensi ODbL.
- Kueri Overpass yang dipakai:

  ```text
  [out:json][timeout:120];
  rel(14745927)->.kota;.kota out geom;
  .kota map_to_area->.a;
  rel(area.a)["boundary"="administrative"]["admin_level"="6"];out geom;
  ```

- Poligon dibangun dari garis anggota setiap relasi dengan `ST_MakeValid(ST_BuildArea(ST_Collect(...)))`, tanpa penyederhanaan, lalu ditulis dengan `ST_AsText(..., 6)`. Sebelum dipakai, periksa bahwa keenam poligon valid, tidak saling bertumpuk, dan gabungannya sama dengan batas kota.
- Untuk memperbarui, buat migrasi baru yang menimpa `boundary` dengan `ON CONFLICT ("slug") DO UPDATE`, dan bandingkan dulu dengan batas lama.

### Basis Pengetahuan Agen Rute

Agen rute (ADR-0042) membaca data dari empat tabel: `knowledge_sources` (sumber, lisensi, tanggal ambil, SHA-256 unduhan), `knowledge_passages` (potongan teks untuk retrieval; kolom `search` dihitung PostgreSQL, kolom bentuk dasar `search_stem` dihitung API dengan stemmer bahasa Indonesia, ADR-0044), `osm_features`, dan `transit_routes`. Isinya dari skrip di `scripts/pengetahuan/`, bukan dari migrasi. Setiap skrip mengganti sumbernya dalam satu transaksi, jadi aman dijalankan ulang, dan menyimpan salinan mentah unduhan di `.data/pengetahuan/` beserta alamat dan waktu ambilnya. Dengan `--salinan`, skrip memuat salinan terakhir itu tanpa mengunduh lagi dan tanpa mengubah tanggal ambil.

| Perintah | Sumber | Isi |
| --- | --- | --- |
| `pnpm pengetahuan:osm` | Satu kueri area Overpass untuk relasi Kota Bogor (14745927) | Fitur bertag `wheelchair`, `toilets:wheelchair`, `ramp`, `kerb`, `tactile_paving`, tangga, lift, pintu masuk bertag akses, halte, dan relasi `route=bus` (BisKita dan angkot) dengan nama jalan yang dilewati |
| `pnpm pengetahuan:regulasi` | PDF resmi UU No. 8 Tahun 2016 dari peraturan.go.id, dan ZIP resmi Permen PUPR No. 14/PRT/M/2017 dari JDIH Kementerian PU | Potongan per pasal (pasal panjang per ayat atau angka) dan per bagian Lampiran I–IV, dengan rujukan seperti "Permen PUPR No. 14/PRT/M/2017, Lampiran II, B.2 Ram" |
| `pnpm pengetahuan:disabilitas` | Satu permintaan ke API Open Data Kota Bogor (`dinas_sosial/jmlh_pnyndng_dsblts_brdsrkn_kcmtn_jns_dsblts_d_kt_bgr`) | Jumlah terdaftar per kecamatan, tahun, dan jenis (fisik, netra, mental, lainnya; label asli sumber disimpan untuk sitasi). Syarat portal: hak pakai non-komersial pribadi, pihak ketiga perlu izin Diskominfo |
| `pnpm pengetahuan:fasilitas` | Satu kueri area Overpass untuk relasi Kota Bogor | `amenity=university|college`, masjid (`amenity=place_of_worship` + `religion=muslim`), halte (`highway=bus_stop`, platform bus), dan `amenity=hospital`, dengan kecamatannya dari batas ADR-0034 |
| `pnpm pengetahuan:dokumen` | Repo publik akses-bogor-web dan akses-bogor-docs di GitHub, cabang `main` | Halaman edukasi Aksesibilitas (`messages/id.json`, masih draf menurut ADR-0041), Panduan Verifikasi, dan ADR-0017, ADR-0018, ADR-0022 tanpa bagian opsi yang tidak dipilih, dipotong per heading. Sumber lama halaman Disabilitas dan Tips, yang sudah dihapus dari situs, ikut dihapus |

- Data OSM © kontributor OpenStreetMap, berlisensi [ODbL](https://www.openstreetmap.org/copyright). Tabel `osm_features` dan `transit_routes` adalah database turunan OSM: bila isinya dibagikan ke publik dalam jumlah besar, bagikan dengan ODbL. Jawaban yang memakai data ini menyebut atribusinya.
- Kueri tanpa `meta`, jadi tidak ada nama penyunting atau changeset. Hanya tag dalam daftar izin di `src/knowledge/osm.ts` yang disimpan; kontak, situs, dan catatan bebas dibuang.
- Fitur di luar batas kecamatan (ADR-0034) dibuang, dan garis rute dipotong ke Kota Bogor.
- Peraturan perundang-undangan tidak dilindungi hak cipta (UU No. 28 Tahun 2014, Pasal 42 huruf b). Salinan Berita Negara Permen PUPR di peraturan.go.id tidak dipakai karena lampirannya berupa gambar pindaian tanpa teks. Skrip berhenti tanpa mengubah data lama bila jumlah pasal yang terbaca tidak sesuai (153 dan 59), dan tidak pernah memakai salinan tidak resmi.
- Kebijakan Overpass: jalankan paling sering sekali sehari, satu skrip pada satu waktu. Server FOSSGIS meminta User-Agent yang menyebut nama aplikasi; isi `PENGETAHUAN_USER_AGENT` sebelum menjalankan skrip secara rutin.

## Environment Variables

Contoh lengkap ada di [.env.example](.env.example). Jangan commit `.env`.

| Variabel | Wajib | Keterangan |
| --- | --- | --- |
| `NODE_ENV` | Tidak | `development` (bawaan), `production`, atau `test` |
| `PORT` | Tidak | Port server, bawaan `8080` |
| `HOST` | Tidak | Alamat bind, bawaan `0.0.0.0` |
| `DATABASE_URL` | Ya | Koneksi PostgreSQL untuk aplikasi, `pnpm db:migrate`, dan `pnpm db:seed` |
| `FRONTEND_ORIGINS` | Di production | Origin web yang boleh memanggil API, dipisah koma. Origin pertama juga menjadi alamat tautan di email status laporan. Di luar production, `http://localhost:*` selalu diizinkan |
| `PHOTO_PUBLIC_URL` | Tidak | Alamat publik bucket foto Cloudflare R2. Kosong berarti `url` foto di respons bernilai `null` |
| `MAPBOX_SECRET_TOKEN` | Tidak | Token rahasia Mapbox (`sk.`) ber-scope `tokens:write`, `styles:read`, `styles:tiles`, dan `fonts:read`, untuk `GET /map/token` (ADR-0016), `POST /map/search` (ADR-0032), dan `POST /route/walking` (Mapbox Directions tidak butuh scope tambahan; ADR-0042). Diisi bersama `MAPBOX_USERNAME` |
| `MAPBOX_USERNAME` | Tidak | Username akun Mapbox pemilik token rahasia |
| `BETTER_AUTH_SECRET` | Di production | Rahasia Better Auth, minimal 32 karakter: tanda tangan token sesi dan kunci HMAC kode email (ADR-0029). Kosong di development berarti memakai rahasia tetap khusus lokal; kosong di production berarti route akun menjawab 503. Mengganti nilainya mengakhiri semua sesi |
| `BETTER_AUTH_URL` | Di production | Alamat publik API |
| `GOOGLE_CLIENT_ID` | Tidak | Client ID OAuth Google untuk memeriksa ID token dari tombol Google. Kosong berarti masuk dengan Google mati |
| `RESEND_API_KEY` | Di production | API key Resend untuk email kode dan konfirmasi akun dihapus (ADR-0030). Kosong di development berarti email dicetak ke log API |
| `EMAIL_FROM` | Bersama `RESEND_API_KEY` | Pengirim pada domain yang sudah diverifikasi di Resend, mis. `AksesBogor <masuk@kirim.contoh.id>` |
| `R2_ACCOUNT_ID` | Untuk foto di production | ID akun Cloudflare (32 karakter heksadesimal) untuk endpoint R2 (ADR-0031). Kelima variabel R2 diisi bersama |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Untuk foto di production | Token R2 ber-izin "Object Read & Write" untuk dua bucket foto saja. Rahasia |
| `R2_BUCKET_LAPORAN` | Untuk foto di production | Bucket privat untuk foto laporan yang belum terbit |
| `R2_BUCKET_PUBLIK` | Untuk foto di production | Bucket publik di balik `PHOTO_PUBLIC_URL` untuk foto yang sudah terbit |
| `PHOTO_STORAGE_DIR` | Tidak | Folder foto di development tanpa R2, bawaan `.data/foto`. Di production tanpa R2, unggah foto menjawab 503 |
| `WEB_SERVER_SECRET` | Di production | Rahasia bersama dengan server Next.js, minimal 32 karakter. Bila cocok, rate limit dihitung per IP pengunjung yang dikirim web, bukan per IP server web |
| `ROUTE_AGENT_ENABLED` | Tidak | `true` membuka route agen rute `/agent/*` dan rute jalan kaki `/route/*` (ADR-0042). Bawaan `false`: route menjawab 503. Biarkan mati di production sampai syarat peluncuran di ADR-0042 terpenuhi |
| `ACCESSIBLE_ROUTER_URL` | Tidak | Alamat Valhalla di host yang sama, mis. `http://127.0.0.1:8002`, untuk `POST /route/accessible`: rute pejalan kaki dari data OpenStreetMap dengan profil kursi roda atau jalan kaki (ADR-0055). Kosong berarti route itu menjawab 503 dan web tetap memakai rute Mapbox |
| `ACCESSIBLE_ROUTER_WAYS_FILE` | Tidak | Ringkasan tag jalur dari pembangunan ubin, mis. `/srv/valhalla/aktif/jalur.json`, untuk cakupan data trotoar, permukaan, dan kerb. Dibaca ulang setelah ubin dibangun ulang. Kosong berarti cakupan dilaporkan tidak diketahui |
| `PROVIDER_HINTS_ENABLED` | Tidak | `true` menyalakan petunjuk aksesibilitas langsung dari Mapbox (dengan `MAPBOX_SECRET_TOKEN`) dan Google (dengan `GOOGLE_MAPS_API_KEY`) di `GET /places/{id}/hints` dan `GET /places/candidates/{osmType}/{osmId}/hints` (ADR-0052). Bawaan `false`: setiap petunjuk berarti panggilan berbayar ke penyedia |
| `GOOGLE_MAPS_API_KEY` | Tidak | API key Google Maps Platform untuk Places API (New), hanya untuk petunjuk aksesibilitas. Kosong berarti Google mati |
| `PROVIDER_HINTS_MAPBOX_PER_DAY` | Tidak | Batas pencarian petunjuk Mapbox per hari WIB, di memori proses. Setelah habis, Mapbox dilaporkan `unavailable` sampai tengah malam WIB. Bawaan 1000 |
| `PROVIDER_HINTS_GOOGLE_PER_DAY` | Tidak | Sama untuk Google. Bawaan 1000 |
| `DISABILITY_DATA_ENABLED` | Tidak | `true` membuka `GET /districts/priority` dan memakai data disabilitas Open Data Kota Bogor untuk prioritas kecamatan (ADR-0043). Bawaan `false`; biarkan mati sampai Diskominfo Kota Bogor mengizinkan pemakaiannya |
| `AGENT_PROVIDER` | Tidak | Penyedia model agen: `anthropic` (Claude API, bawaan) atau `openrouter` (ADR-0047). Tidak ada cadangan otomatis ke penyedia lain |
| `AGENT_REQUESTS_PER_DAY` | Tidak | Permintaan ke model yang berhasil per hari UTC untuk semua pengguna Bantu memetakan. Bawaan 45 |
| `ROUTE_ASSISTANT_ENABLED` | Tidak | `true` membuka asisten rute publik `/route-assistant/*` untuk siapa pun, dan `/route/*` ke lokasi AksesBogor tanpa akun (ADR-0050). Bawaan `false`; nyalakan setelah web dengan Kebijakan Privasi yang menyebut asisten ini dirilis |
| `ROUTE_ASSISTANT_QUESTIONS_PER_DAY` | Tidak | Pertanyaan asisten rute publik per hari WIB untuk semua penanya; satu pertanyaan paling banyak 4 permintaan ke model. Bawaan 300 |
| `ANTHROPIC_API_KEY` | Untuk agen | API key Claude API (ADR-0047). Kosong berarti agen menjawab sibuk; API tetap jalan. Rahasia |
| `ANTHROPIC_MODEL` | Tidak | Model Claude untuk agen. Bawaan `claude-haiku-5-5` |
| `ANTHROPIC_EFFORT` | Tidak | `output_config.effort` Claude: `low`, `medium`, atau `high`. Kosong berarti `low` |
| `OPENROUTER_API_KEY` | Tidak | API key OpenRouter bila `AGENT_PROVIDER=openrouter` (ADR-0042). Kosong berarti agen menjawab sibuk; API tetap jalan |
| `OPENROUTER_MODELS` | Tidak | Model OpenRouter berurutan, dipisah koma; model pertama dicoba dulu. Kosong berarti daftar bawaan API |

## Endpoint

| Endpoint | Isi | Kebutuhan |
| --- | --- | --- |
| `GET /healthz` | Cek server hidup | |
| `GET /districts` | Enam kecamatan dengan jumlah lokasi | FR-03 |
| `GET /districts/boundaries` | Batas keenam kecamatan sebagai GeoJSON yang disederhanakan, dengan atribusi OpenStreetMap; boleh di-cache sehari | ADR-0034, ADR-0043 |
| `GET /districts/priority` | Skor prioritas kecamatan untuk kontributor dari jumlah penyandang disabilitas terdaftar (Dinsos, tahun terbaru) dan kekurangan data AksesBogor, dengan catatan batas data dan sumber; 503 selama `DISABILITY_DATA_ENABLED` mati | ADR-0043 |
| `GET /places` | Daftar lokasi: pencarian `q`, filter `category`, `district`, `facility`, `status` (dipisah koma), `limit`, `offset` | FR-02 sampai FR-04 |
| `GET /places/map` | GeoJSON untuk Mapbox dengan filter yang sama dan `bbox` | FR-05 |
| `GET /places/candidates` | Kandidat "Belum ada data" untuk Peta: tempat OSM empat kategori tanpa lokasi AksesBogor berkategori sama dalam 50 m, dengan kecamatan, tag `wheelchair` mentah, dan `source` (lisensi dan atribusi ODbL); filter `q`, `category`, `district`; tanpa status; cache 5 menit | ADR-0049 |
| `GET /places/{id}/hints` | Petunjuk aksesibilitas langsung dari Mapbox dan Google untuk lokasi AksesBogor: tempat penyedia dalam 75 m dengan nama mirip (terhadap kedua nama), angka dan huruf tunggal yang sama, kata jenis tempat yang sesuai, dan kategori penyedia yang sesuai; tanda aksesibilitas, nama di penyedia, dan tautan Google Maps; belum diperiksa tim dan tidak mengubah status; tidak disimpan (`private, no-store`); 30 per menit per klien; `hints: []` tanpa memeriksa tempatnya selama `PROVIDER_HINTS_ENABLED` mati atau tidak ada penyedia yang menyala; galat penyedia dicatat dengan nama penyedia dan status saja | ADR-0052 |
| `GET /places/candidates/{osmType}/{osmId}/hints` | Sama untuk kandidat OSM; kandidat tanpa nama tidak dicocokkan. Juga salinan tersimpan (`result: "stored"`) dari tag `aksesbogor:google_maps` (Google Maps, dengan tanggal pengambilan) dan `aksesbogor:osm_aksesibilitas` (wheelchair OSM), selama `PROVIDER_HINTS_ENABLED` menyala | ADR-0052 |
| `GET /places/stats` | Jumlah per kategori, pintu masuk tanpa tangga, dan kontributor | FR-01 |
| `GET /places/{id}` | Detail: jawaban, alasan, catatan, ringkasan X dari Y, fasilitas penentu status, foto, `needsRecheck` | FR-06, FR-07, FR-38 |
| `GET /map/token` | Token Mapbox sementara untuk peta di browser; 503 bila `MAPBOX_SECRET_TOKEN` belum diatur | FR-05 |
| `POST /map/search` | Cari tempat untuk pemilih lokasi: lokasi AksesBogor bernama mirip, lalu Mapbox Search Box di sekitar Kota Bogor; 30 per menit per klien, 1.500 per hari; 503 bila `MAPBOX_SECRET_TOKEN` belum diatur | FR-21, ADR-0032 |
| `POST /auth/code` | Kirim kode masuk 6 digit ke email | FR-10 |
| `POST /auth/code/verify` | Masuk dengan email dan kode; membuat akun bila email belum terdaftar | FR-10 |
| `POST /auth/google` | Masuk dengan ID token dari tombol Google Identity Services | FR-10 |
| `POST /auth/logout` | Keluar: mencabut sesi | FR-10 |
| `GET /me` | Akun yang sedang masuk, dengan `needsCompletion` untuk Lengkapi Akun | FR-11, FR-12 |
| `POST /me/complete` | Lengkapi Akun: nama tampilan dan persetujuan Kebijakan Privasi beserta versinya | FR-11, FR-12 |
| `PATCH /me` | Ubah nama tampilan | FR-12 |
| `GET /me/reports` | Laporan saya dengan status, alasan penolakan, dan pertanyaan klarifikasi | FR-14 |
| `GET /me/reports/{id}` | Satu laporan saya dengan pertanyaan dan jawaban klarifikasi | FR-14, FR-41 |
| `POST /me/reports/{id}/clarification` | Jawab klarifikasi sekali sebelum tenggat, dengan teks dan foto baru (total paling banyak 10); laporan kembali ke antrean di posisi aslinya | FR-41, ADR-0036 |
| `DELETE /me` | Hapus akun: data pribadi dan laporan yang belum terbit hilang, laporan terbit tetap tanpa pelapor | FR-13 |
| `POST /reports/location-check` | Kecamatan dari titik, penolakan titik di luar Kota Bogor, dan lokasi terbit bernama mirip dalam radius sekitar 50 m; tanpa akun | FR-22, FR-23 |
| `POST /reports/photos` | Unggah satu foto mentah (JPEG, PNG, WebP, ≤3 MB); disimpan sebagai WebP ≤2048 px tanpa metadata di bucket privat sampai dipasang ke laporan; 100 per akun per jam | FR-25, ADR-0031 |
| `GET /admin/team` | Tim verifikasi (verifikator dan admin) dengan email; khusus admin | FR-36 |
| `POST /admin/team` | Jadikan verifikator akun yang sudah dilengkapi, dengan email yang tepat; khusus admin | FR-36 |
| `DELETE /admin/team/{userId}` | Cabut peran verifikator; peran admin hanya lewat `pnpm peran` | FR-36 |
| `GET /admin/places` | Semua tempat termasuk yang diturunkan, berhalaman; saring `q`, `category`, `district`, `status`, `origin` (`tim`, `admin`), `published` (`ya`, `tidak`); khusus admin | ADR-0051 |
| `GET /admin/places/{id}` | Satu tempat untuk formulir ubah: jawaban, foto tayang, dan `version`; khusus admin | ADR-0051 |
| `GET /admin/places/{id}/history` | Riwayat tempat dari log audit dengan nama tampilan anggota tim; khusus admin | ADR-0038, ADR-0051 |
| `GET /admin/candidates` | Kandidat OpenStreetMap tanpa lokasi AksesBogor dalam 50 m, berhalaman, untuk dibuat menjadi tempat; khusus admin | ADR-0049, ADR-0051 |
| `POST /admin/places` | Tambah tempat yang langsung tayang dengan label admin; Tersedia dan Tidak perlu tanpa foto bertag fasilitas itu menjadi Belum tahu; alasan wajib; khusus admin | ADR-0051 |
| `PATCH /admin/places/{id}` | Ubah data, jawaban, dan foto (tambah dan hapus) dengan `version`; tempat menjadi berlabel admin; khusus admin | ADR-0051 |
| `DELETE /admin/places/{id}` | Turunkan tempat dari tayang dengan alasan; tidak ada yang dihapus permanen; khusus admin | ADR-0051 |
| `POST /admin/places/{id}/restore` | Tayangkan lagi tempat yang diturunkan, dengan alasan; khusus admin | ADR-0051 |
| `GET /verifier/reports` | Antrean verifikasi terlama dulu, atau `status=klarifikasi` untuk yang menunggu jawaban pelapor; tanpa laporan sendiri; khusus verifikator dan admin | FR-30, FR-37 |
| `GET /verifier/reports/{id}` | Isian, foto, titik, klarifikasi, data lokasi saat ini, dan lokasi mirip untuk dibandingkan; laporan sendiri 403 | FR-31, FR-37 |
| `GET /verifier/photos/{id}` | Foto laporan yang belum terbit dari bucket privat, `?versi=kabur` untuk pratinjau area kabur; `Cache-Control: private, no-store` | FR-34, ADR-0031, ADR-0037 |
| `PATCH /verifier/reports/{id}/photos/{photoId}` | Moderasi foto sebelum keputusan: tag, keterangan, sembunyikan, area kabur | FR-34, ADR-0037 |
| `POST /verifier/reports/{id}/publish` | Terbitkan: lokasi baru, atau lokasi yang sama diperbarui untuk perubahan dan kekurangan; jawaban tanpa bukti menjadi Belum tahu; status dihitung; foto disalin ke bucket publik dengan area kabur; email ke pelapor | FR-27, FR-32, FR-33, FR-40 |
| `POST /verifier/reports/{id}/clarify` | Minta klarifikasi dengan tenggat 7 × 24 jam; email ke pelapor | FR-32, FR-41 |
| `POST /verifier/reports/{id}/reject` | Tolak dengan alasan R1–R5; foto laporan dihapus; email ke pelapor | FR-32, FR-40 |
| `GET /verifier/places/recheck` | Lokasi yang terakhir diverifikasi lebih dari 12 bulan lalu, terlama dulu | FR-38 |
| `POST /reports` | Kirim laporan baru, perubahan, atau kekurangan ke antrean verifikasi dengan foto yang sudah diunggah; kecamatan dihitung ulang; kunci draf mencegah laporan ganda; 20 laporan per 24 jam dan 30 laporan menunggu per akun; admin bisa menerbitkan langsung dengan `publishDirectly` dan `publishReason` (ADR-0051) | FR-20 sampai FR-27 |
| `GET /agent/tools` | Larik `tools` format OpenAI untuk ketiga alat yang boleh dipanggil model | FR-60, ADR-0042 |
| `POST /agent/tools/find_place` | Lokasi AksesBogor bernama mirip, paling banyak 5 | FR-60 |
| `POST /agent/tools/place_accessibility` | Status, jawaban fasilitas terverifikasi, dan tanggal verifikasi terakhir sebuah lokasi, tanpa koordinat | FR-60 |
| `POST /agent/tools/search_knowledge` | Potongan regulasi, dokumen AksesBogor, dan rute angkutan dengan sitasi, sumber, dan lisensi | FR-60 |
| `POST /agent/ask` | Pertanyaan kontributor (tempat yang perlu dipetakan, data terverifikasi, regulasi), dijawab Claude Haiku 5.5 lewat Claude API (atau OpenRouter bila dipilih) dengan sumbernya; model tidak menerima posisi atau rute; 5 pertanyaan per akun per hari, 503 `agen_sibuk` bila batas harian atau saldo habis | FR-60, ADR-0043, ADR-0047 |
| `GET /route-assistant/status` | Apakah asisten rute publik dibuka, dan jatah pertanyaan per pengunjung per hari, tanpa sesi | ADR-0050 |
| `POST /route-assistant/ask` | Pertanyaan siapa pun, dengan atau tanpa akun, tentang cara ke lokasi AksesBogor, lokasi terdekat, dan aksesibilitasnya, dengan kartu rute; titik awal opsional hanya dipakai server; 5 pertanyaan per akun atau per IP per hari, 429 `kuota_habis`, 503 `agen_sibuk` | ADR-0050 |
| `POST /route/walking` | Rute jalan kaki Mapbox dari posisi pengguna ke pin lokasi AksesBogor atau ke tempat OpenStreetMap tanpa data (kartu rute untuk kontributor), dengan peringatan tetap dan atribusi, hanya untuk browser pengguna; 30 per akun atau per IP per jam, 1.000 per hari; tanpa akun ke lokasi AksesBogor atau kandidat OpenStreetMap selama asisten rute publik dibuka | FR-60, ADR-0042, ADR-0050 |
| `POST /route/accessible` | Rute pejalan kaki dari data OpenStreetMap lewat Valhalla di server sendiri, profil `kursi_roda` atau `jalan_kaki`, dengan langkah berbahasa Indonesia, cakupan data, peringatan, dan label tetap; tidak pernah diganti rute Mapbox. Pemanggil dan batasnya sama dengan `POST /route/walking`, 30 per akun atau per IP per jam | ADR-0055 |
| `POST /route/obstacles` | Tangga, kerb, ramp, lift, pintu masuk, dan guiding block OSM dalam 20 m (maks. 50 m) dari garis rute, hanya untuk browser pengguna; tanpa akun selama asisten rute publik dibuka | FR-60, ADR-0042, ADR-0050 |

Route akun dipanggil server Next.js, bukan browser. Masuk menjawab token sesi bertanda tangan; web menyimpannya di cookie `HttpOnly` miliknya dan mengirimnya balik sebagai `Authorization: Bearer` (ADR-0029). Batas kode: 60 detik dan 5 kode per email per jam, 10 permintaan dan 30 percobaan kode per klien per 15 menit. Sesi berakhir 30 hari setelah terakhir dipakai, atau 90 hari setelah masuk. Setiap jam API menghapus akun yang tidak dilengkapi dalam 24 jam (dan tidak punya laporan), sesi kedaluwarsa, dan kode kedaluwarsa. Saat akun dihapus, berkas foto yang ikut terhapus, termasuk unggahan yang belum dipasang ke laporan, dicatat di tabel `photo_deletions`. Setiap jam API memindahkan unggahan yang tidak dipasang dalam 24 jam ke antrean itu, lalu menghapus berkas di antrean dari R2 (`src/photos/cleanup.ts`); berkas yang gagal dihapus dicoba lagi jam berikutnya. Di development tanpa `RESEND_API_KEY`, kode masuk dicetak ke log API.

Panel verifikator (ADR-0035 sampai ADR-0037) membaca dan memutuskan laporan lewat route `/verifier/*`, semuanya khusus verifikator dan admin, tanpa laporan sendiri, dan hanya dengan nama tampilan pelapor. Setiap keputusan mengunci baris laporan, jadi keputusan kedua menjawab 409. Terbitkan menyalin foto yang tidak disembunyikan dari bucket privat ke `lokasi/<id lokasi>/<id foto>.webp` di bucket publik, dengan area kabur dari `src/photos/blur.ts`, lalu menghapus berkas asli; foto laporan yang ditolak ikut dihapus. Perubahan data dicatat di `audit_log` tanpa data pribadi (ADR-0038). Setiap jam API juga menolak laporan klarifikasi yang tidak dijawab sampai tenggat 7 × 24 jam dengan alasan R6 (`src/verification/jobs.ts`); tidak ada timer systemd tambahan. Email status laporan (diterbitkan, ditolak, klarifikasi) diantrekan di `report_emails` bersama keputusannya, dikirim setelah transaksi selesai, dan yang gagal dicoba lagi setiap jam selama 3 hari (ADR-0039). Tautannya memakai origin pertama di `FRONTEND_ORIGINS`.

Agen rute (ADR-0042) punya dua jenis pemanggil. Alat untuk model ada di `src/agent/`: fungsinya di `tools.ts`, dan nama, deskripsi, skema input, dan skema output ketiga alat di `registry.ts`, yang juga membuat larik `tools` format OpenAI dan dipakai route `/agent/tools/*`. Tidak ada alat yang menerima posisi pengguna atau mengembalikan rute. Rute jalan kaki dan hambatan di dekatnya ada di `src/map/walking-route.ts` dan hanya dilayani untuk browser pengguna lewat `/route/*`, karena Product Terms Mapbox §1.5 melarang memakai hasil Directions untuk menjalankan AI. Rute memakai Mapbox Directions profil `walking` dengan `MAPBOX_SECRET_TOKEN`; posisi pengguna dibulatkan ke 4 desimal, dan jawaban Mapbox tidak disimpan atau dicatat di log. Semua route ini hanya untuk akun yang sudah dilengkapi, mati selama `ROUTE_AGENT_ENABLED` tidak `true`, dan berbagi batas 120 permintaan per akun per jam. `model.ts` berisi antarmuka model, dan `provider.ts` memilih adapternya dari `AGENT_PROVIDER` tanpa cadangan otomatis. `anthropic.ts` (bawaan, ADR-0047) memanggil Claude Haiku 5.5 lewat SDK resmi `@anthropic-ai/sdk`: thinking adaptif dengan effort dari `ANTHROPIC_EFFORT`, blok thinking dan tool_use dikirim kembali utuh bersama hasil alat, penanda prompt caching di alat, instruksi sistem, dan ujung percakapan, SDK mengulang sekali, log SDK sendiri dimatikan (juga lewat `ANTHROPIC_LOG`), dan log per langkah hanya berisi jumlah token, ditambah kategori untuk penolakan. Penolakan (`refusal`) dan jawaban yang terpotong `max_tokens` dijawab dengan kalimat tetap. `openrouter.ts` tetap bisa dipilih: daftar model gratis berurutan (bawaan di kode, bisa diganti `OPENROUTER_MODELS`), paling banyak 3 model per permintaan lewat parameter `models`, lalu kelompok berikutnya bila semuanya gagal (ADR-0043). Alat untuk model juga mencakup `find_places_to_contribute` dan `kecamatan_priority` (ADR-0043), serta alat kartu `show_place_card` dan `show_route_card` (`cards.ts`): model hanya menerima konfirmasi singkat, sedangkan isi kartu, termasuk lokasi tempat, dikirim ke web di `cards` jawaban `POST /agent/ask`. Kartu rute hanya berisi tujuan; web menghitung rutenya sendiri dari posisi pengguna. `POST /agent/ask` menjalankan `ask.ts`: data terverifikasi tempat yang dipilih masuk instruksi sistem (`prompt.ts`), model boleh memanggil alat paling banyak 3 putaran, argumen setiap panggilan diperiksa skema Zod, dan jawaban yang menyebut rute aksesibel dipotong. Batas harian ada di `limits.ts`: `AGENT_REQUESTS_PER_DAY` (bawaan 45) permintaan ke model yang berhasil per hari untuk semua pengguna (yang gagal tidak dihitung) dan 5 pertanyaan per akun, disimpan di memori proses. Tidak ada percakapan yang disimpan, dan isi pertanyaan atau jawaban tidak dicatat di log.

Rute pejalan kaki dari data OpenStreetMap (ADR-0055) ada di `src/map/`: `valhalla.ts` memanggil Valhalla di host yang sama (`/route`, lalu `/trace_attributes` pada garis yang sama untuk id way OSM), `valhalla-steps.ts` membuat kalimat langkah dalam bahasa Indonesia karena Valhalla belum punya narasi bahasa Indonesia, `accessible-ways.ts` membaca `jalur.json`, dan `accessible-route.ts` menghitung cakupan data dan peringatan. Profil `kursi_roda` memakai costing `pedestrian` dengan `type: wheelchair`, yang tidak pernah lewat tangga. Ubin dibangun tanpa data ketinggian, jadi kemiringan hanya diketahui dari tag `incline`. Posisi dibulatkan seperti rute Mapbox, tidak disimpan, tidak dikirim ke model, dan log Valhalla tidak memuat koordinat. Bila Valhalla mati atau tidak menemukan jalur, API menjawab galat; tidak pernah diam-diam memakai rute Mapbox.

Asisten rute publik (ADR-0050) memakai putaran alat yang sama dengan profil lain (`AgentProfile` di `ask.ts`): alat di `assistant-registry.ts` dan `assistant-tools.ts` (`find_place` menurut nama, kategori, atau kecamatan; `place_accessibility` ditambah `checkedByTeam` dan sumbernya; `search_knowledge`; `nearby_places`; dan alat kartu `show_route`), instruksi dan pemeriksaan jawaban di `assistant-prompt.ts`. `find_place` dan `nearby_places` juga mengembalikan kandidat OpenStreetMap (ADR-0049) dengan id `osm:<tipe>/<id>`, `kind: "kandidat"`, `checkedByTeam: false`, tanpa status, tag pihak ketiga, atau koordinat; `show_route` menerima id itu dan kartu rutenya menuju titik OSM. Titik awal pengunjung ada di `ToolContext.position` dan hanya dipakai `nearby_places` untuk jarak garis lurus PostGIS yang dibulatkan ke 100 m; model hanya diberi tahu apakah titik awal ada. Pemeriksaan jawaban membuang klaim rute aksesibel, klaim tempat aksesibel bila pertanyaan itu tidak membaca lokasi yang diperiksa tim, dan mengganti kata "cacat". `POST /route-assistant/ask` (`src/routes/assistant.ts`) memakai jatah per akun yang sama dengan `POST /agent/ask` untuk akun yang lengkap, 5 pertanyaan per IP per hari untuk yang lain (kunci rate limit yang sama dengan route lain), dan `ROUTE_ASSISTANT_QUESTIONS_PER_DAY` untuk semua; modelnya instans tersendiri tanpa hitungan `AGENT_REQUESTS_PER_DAY`.

Status lokasi dan ringkasannya dihitung dengan aturan "pintu masuk dulu" di `src/domain/status.ts` (ADR-0018) dan disimpan di tabel `places`; panggil `refreshPlaceStatus` setiap kali jawaban fasilitas berubah. Respons memakai nilai enum produk (mis. `sebagian`, `tidak_tersedia`); teks untuk pengguna disusun di web.

## API Spec

[docs/openapi.json](docs/openapi.json) dibuat dari skema Zod di setiap route dan juga tersedia di `GET /openapi.json`. Setelah mengubah route, jalankan `pnpm openapi` dan commit hasilnya; CI gagal bila berkas itu tidak sesuai kode.

Semua galat memakai bentuk `{ "galat": "kode_snake_case", "pesan": "Pesan untuk pengguna" }`.

Setiap klien mendapat 120 permintaan per menit (selain `/healthz`); lewat dari itu API menjawab 429 `terlalu_sering`. Klien dikenali dari header `cf-connecting-ip` yang ditulis Cloudflare, bukan dari `X-Forwarded-For` yang bisa diisi klien. Server Next.js mengirim `x-web-server-secret` dan `x-visitor-ip`; bila rahasianya sama dengan `WEB_SERVER_SECRET`, kuota dihitung per IP pengunjung itu. Kunci yang sama dipakai batas per route, yaitu permintaan dan percobaan kode masuk, masuk dengan Google, pencarian tempat, dan unggah foto, sehingga pengunjung lain di belakang server web yang sama tidak ikut kena 429.

## Arsitektur

Diagram dan struktur folder ada di [docs/arsitektur.md](docs/arsitektur.md).

## Deployment

Produksi berjalan di Evergarden, VM Ubuntu 24.04 di OCI region Batam, dan dibuka di `https://akses-bogor-api.aldio.dev` lewat Cloudflare Tunnel ([ADR-0026](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0026-api-dan-postgresql-di-evergarden-oci.md)). Untuk sementara lingkungan ini disebut staging, dan domain produksinya belum diputuskan ([ADR-0045](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0045-alamat-staging-di-aldio-dev.md)). Berkasnya ada di [deploy/](deploy/).

| Bagian | Di Evergarden |
| --- | --- |
| API | `akses-bogor-api.service`: user `aksesbogor`, `node dist/server.js` di `127.0.0.1:8090`, Node 24 |
| Environment | `/etc/akses-bogor/api.env`, contohnya [deploy/api.env.example](deploy/api.env.example) |
| Rilis | `/srv/akses-bogor/releases/<sha>`; rilis aktif ditunjuk tautan `/srv/akses-bogor/current` |
| Deploy | `akses-bogor-deploy.timer` memeriksa branch `release` setiap 5 menit dan menjalankan [deploy/deploy.sh](deploy/deploy.sh) |
| Database | PostgreSQL 17 + PostGIS dari PGDG, cluster `17/main` di port 5433, koneksi lewat Unix socket dengan autentikasi peer |
| Cadangan | `akses-bogor-backup.timer` pukul 02.30 WIB menjalankan [deploy/backup.sh](deploy/backup.sh); dump di `/var/backups/akses-bogor` |
| Tunnel | Public hostname di dashboard Cloudflare Zero Trust, diarahkan ke `http://127.0.0.1:8090` |
| Rute OpenStreetMap | `akses-bogor-valhalla.service` (Valhalla di Docker, `127.0.0.1:8002`) dan `akses-bogor-valhalla-ubin.timer` setiap Minggu 03.30 WIB, dari [deploy/valhalla/](deploy/valhalla/). Langkah pasang dan angka memori ada di runbook `operations/valhalla-rute-aksesibel.md` di akses-bogor-docs (ADR-0055) |

### Rilis

Merge `main` ke `release` lewat PR. Paling lama lima menit kemudian, timer mengekspor commit itu ke `releases/<sha>`, menjalankan `pnpm install --frozen-lockfile`, `pnpm build`, dan `pnpm db:migrate`, memindahkan `current`, lalu me-restart API. Tiga rilis terakhir disimpan.

```bash
journalctl -u akses-bogor-deploy -n 50     # hasil deploy terakhir
sudo systemctl start akses-bogor-deploy    # deploy sekarang tanpa menunggu timer
curl https://akses-bogor-api.aldio.dev/healthz
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
# PostgreSQL 17 + PostGIS dari PGDG, rclone untuk salinan cadangan ke R2, dan age untuk mengenkripsinya
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-17 postgresql-17-postgis-3 rclone age
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

Terakhir, tambahkan public hostname `akses-bogor-api.aldio.dev` di tunnel Evergarden (Zero Trust → Networks → Tunnels), dengan service `http://127.0.0.1:8090`. Hostname lain di tunnel itu jangan diubah.

### Peran

Admin pertama dibuat dengan skrip, karena tidak ada route API yang bisa membuat admin (ADR-0035). Akunnya harus sudah masuk dan melengkapi nama tampilan di web. Lalu, di Evergarden:

```bash
sudo -u aksesbogor -H sh -c 'cd /srv/akses-bogor/current && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  corepack pnpm exec tsx --env-file=/etc/akses-bogor/api.env scripts/peran.ts --email <email> --peran admin'
```

Admin kemudian memberi dan mencabut peran verifikator di halaman Tim verifikator di web. Perintah yang sama dengan `--peran pengguna` mencabut peran admin.

### Bentuk Dasar Basis Pengetahuan

Kolom `search_stem` (ADR-0044) diisi API, bukan oleh migrasi. Skrip `pnpm pengetahuan:*` mengisinya sendiri saat memuat sumber. Setelah rilis yang membawa migrasi 0009, dan setiap kali `src/knowledge/stemmer.ts` atau `src/knowledge/kata-dasar.ts` berubah, jalankan sekali di Evergarden:

```bash
sudo -u aksesbogor -H sh -c 'cd /srv/akses-bogor/current && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  corepack pnpm exec tsx --env-file=/etc/akses-bogor/api.env scripts/pengetahuan/indeks.ts'
```

Sebelum itu, `search_knowledge` tetap berjalan, tetapi hanya dengan kata apa adanya.

### Atribut Google Maps

Salinan atribut aksesibilitas Google Maps di kandidat OSM (ADR-0056) diambil lewat Apify, lalu dimuat ke tag `aksesbogor:google_maps`. Token Apify ada di `/etc/akses-bogor/apify.env` (`root:aksesbogor`, mode `0640`, isi `APIFY_TOKEN=…`), terpisah dari `api.env` karena server API tidak memakainya. Langkah lengkap, termasuk memeriksa hasil dry run, ada di runbook `operations/impor-atribut-google-maps.md` di akses-bogor-docs. Singkatnya, di Evergarden:

```bash
# Jumlah pencarian dan perkiraan biaya, tanpa memanggil Apify
sudo -u aksesbogor -H sh -c 'cd /srv/akses-bogor/current && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  corepack pnpm exec tsx --env-file=/etc/akses-bogor/api.env scripts/petunjuk/google-maps-ambil.ts --rencana'
# Ambil (mulai dengan --limit 20), lalu dry run dan impor berkas terbaru
sudo -u aksesbogor -H sh -c 'cd /srv/akses-bogor/current && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 APIFY_ENV_FILE=/etc/akses-bogor/apify.env \
  corepack pnpm exec tsx --env-file=/etc/akses-bogor/api.env scripts/petunjuk/google-maps-ambil.ts --limit 20'
sudo -u aksesbogor -H sh -c 'cd /srv/akses-bogor/current && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  corepack pnpm exec tsx --env-file=/etc/akses-bogor/api.env scripts/petunjuk/google-maps-impor.ts --dry-run'
sudo -u aksesbogor -H sh -c 'cd /srv/akses-bogor/current && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  corepack pnpm exec tsx --env-file=/etc/akses-bogor/api.env scripts/petunjuk/google-maps-impor.ts'
```

`pnpm pengetahuan:fasilitas` mengganti semua baris `osm_places`, jadi salinan ini ikut hilang. Setelah memuat ulang OSM, jalankan impor lagi dengan berkas yang sama; tidak perlu mengambil ulang dari Apify.

### Verifikasi Street View

Data yang belum diperiksa diverifikasi dari tangkapan Street View atau disembunyikan (ADR-0057). Gambar diambil dan dinilai di host pekerja; server produksi (fatir-mitya) hanya menerima manifest dan gambarnya di `/srv/akses-bogor/data/street-view/<putaran>/`. Bentuk manifest dan langkah lengkapnya (cadangan, daftar, dry run, terapkan, periksa, batalkan) ada di runbook `operations/verifikasi-street-view.md` di akses-bogor-docs. Di publik dan di Agen AI, tempat Street View tampil sebagai terverifikasi tim (ADR-0058); asalnya tetap di `verification_source`, log audit, Kelola tempat, dan keterangan foto. Foto masuk bucket publik R2 lewat `R2_*` yang sudah ada di `api.env`.

```bash
api() { sudo -u aksesbogor -H sh -c "cd /srv/akses-bogor/current && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm exec tsx --env-file=/etc/akses-bogor/api.env $*"; }
api scripts/verifikasi/daftar.ts > ~/verifikasi-daftar.csv
api scripts/verifikasi/street-view.ts /srv/akses-bogor/data/street-view/<putaran>/manifest.json --dry-run
api scripts/verifikasi/street-view.ts /srv/akses-bogor/data/street-view/<putaran>/manifest.json
```

### Permintaan Hak Subjek Data

Permintaan salinan data, perbaikan, pembatasan pemrosesan, dan penghapusan dari Kebijakan Privasi bagian "Hak Anda" dijalankan dengan skrip `scripts/hak-subjek/` paling lambat 3 × 24 jam setelah emailnya diterima. Setiap permintaan dicatat dulu di tabel `data_subject_requests`; skrip lain wajib menyebut nomornya, harus dijalankan untuk akun yang sama, dan mencatat admin yang menjalankannya (`--oleh`) di log audit. Langkah lengkap, cara memeriksa pengirim, dan templat balasan ada di runbook `operations/permintaan-subjek-data.md` di akses-bogor-docs. Di server produksi (fatir-mitya):

```bash
# Argumen diteruskan apa adanya, jadi alasan yang berisi spasi cukup diberi tanda kutip biasa.
hak() { sudo -u aksesbogor -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 sh -c 'cd /srv/akses-bogor/current && exec corepack pnpm exec tsx --env-file=/etc/akses-bogor/api.env "$@"' hak "$@"; }
hak scripts/hak-subjek/catat.ts --jenis salinan --akun <email> --diterima "2026-11-27 09:15" --oleh <email admin>
hak scripts/hak-subjek/catat.ts --daftar
hak scripts/hak-subjek/ekspor.ts --akun <email> --permintaan <nomor> --oleh <email admin> --keluar /tmp/ekspor-<nomor>.json
hak scripts/hak-subjek/ganti-email.ts --akun <email lama> --email-baru <email baru> --permintaan <nomor> --oleh <email admin>
hak scripts/hak-subjek/tahan.ts --akun <email> --permintaan <nomor> --oleh <email admin> --alasan "Pelapor meminta penundaan"
hak scripts/hak-subjek/email.ts --akun <email> --permintaan <nomor> --oleh <email admin> --mati
hak scripts/hak-subjek/hapus.ts --akun <id akun> --permintaan <nomor> --oleh <email admin>
hak scripts/hak-subjek/catat.ts --selesai <nomor> --oleh <email admin>
hak scripts/hak-subjek/catat.ts --tolak <nomor> --alasan "Akan mengungkap data pribadi orang lain" --oleh <email admin>
```

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
- Enkripsi salinan R2: isi `BACKUP_AGE_RECIPIENT` di `backup.env` dengan kunci publik `age` tim. Server butuh paket `age`. R2 lalu hanya menerima `<dump>.age`, sedangkan dump di server tetap polos. Kunci privatnya disimpan tim di `~/credentials/akses-bogor/age-cadangan.key`, tidak di `backup.env` dan tidak di Cloudflare. Bila `BACKUP_AGE_RECIPIENT` kosong, dump disalin tanpa enkripsi dan log menulis peringatan.
- Menjalankan cadangan sekarang: `sudo systemctl start akses-bogor-backup`, lalu `journalctl -u akses-bogor-backup -n 20`.

Memulihkan dump ke database baru:

```bash
sudo systemctl stop akses-bogor-deploy.timer akses-bogor-api
sudo -u postgres dropdb -p 5433 aksesbogor
sudo -u postgres createdb -p 5433 --owner aksesbogor aksesbogor
sudo -u postgres pg_restore -p 5433 -d aksesbogor /var/backups/akses-bogor/<dump>
sudo systemctl start akses-bogor-api akses-bogor-deploy.timer
```

Dump dari R2 (`<dump>.age`) didekripsi dulu dengan kunci privat, lalu langsung diteruskan ke `pg_restore`, misalnya `age -d -i ~/credentials/akses-bogor/age-cadangan.key <dump>.age | sudo -u postgres pg_restore -p 5433 -d aksesbogor`. Langkah lengkapnya ada di runbook `operations/cadangan-database.md` di akses-bogor-docs.

## Kontribusi

Ikuti [AGENTS.md](AGENTS.md) dan [guideline tim](https://github.com/al-dioooo/akses-bogor-docs/tree/main/guidelines): issue, branch `feature/`, `fix/`, atau `chore/`, commit kecil dengan Conventional Commits, lalu PR dengan nomor issue di judul. CI menjalankan lint, typecheck, tes, build, dan pemeriksaan API spec di setiap PR.
