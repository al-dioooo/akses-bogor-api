# Arsitektur

Sumber keputusan: [ADR-0013](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0013-tech-stack-nextjs-fastify.md). Diagram di bawah memuat bagian yang sudah ada dan yang direncanakan; yang direncanakan ditandai garis putus-putus.

```mermaid
flowchart LR
  B[Browser / PWA] -->|halaman| W[akses-bogor-web<br/>Next.js di Vercel]
  B -->|API + sesi| F[akses-bogor-api<br/>Fastify di Azure App Service B1]
  W -->|render di server| F
  F --> DB[(Neon Postgres + PostGIS)]
  F -.-> R2[(Cloudflare R2: foto)]
  F -.-> E[Penyedia email]
  F -.-> G[Google: verifikasi ID token]
  F -.-> M[Mapbox: pencarian tempat]
```

- Browser tidak pernah terhubung langsung ke database atau R2. Setiap request yang menyentuh data diperiksa sesi dan perannya di API.
- Aplikasi memakai koneksi pooled Neon (`DATABASE_URL`); migrasi memakai koneksi langsung (`DATABASE_URL_UNPOOLED`).
- Foto diperkecil di browser, lalu diperiksa ulang, disandikan ulang, dan dihapus metadata EXIF-nya di API sebelum disimpan ke R2 ([ADR-0023](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0023-hingga-sepuluh-foto-bertag-per-laporan.md)).

## Alur Request

```mermaid
sequenceDiagram
  participant K as Klien
  participant F as Fastify
  participant DB as Neon
  K->>F: Request
  F->>F: CORS, rate limit, validasi skema Zod
  F->>DB: Query lewat Drizzle
  DB-->>F: Data
  F-->>K: Respons sesuai skema, atau { galat, pesan }
```

## Struktur Folder

| Folder | Isi |
| --- | --- |
| `src/config` | Validasi environment variable |
| `src/db` | Klien Drizzle dan skema tabel |
| `src/http` | Kelas galat dan skema respons galat |
| `src/routes` | Route Fastify, satu berkas per kelompok |
| `scripts` | Skrip pendukung, mis. pembuat `docs/openapi.json` |
| `test` | Tes Vitest dengan `app.inject` |
| `docs` | Diagram ini dan API spec |
