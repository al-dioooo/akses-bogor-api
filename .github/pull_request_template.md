<!--
Judul PR: <type>(<scope>): <deskripsi> (#<nomor-issue>)
Contoh:   feat(laporan): accept unavailable reasons (#12)
-->

## Summary

<!-- Ringkasan singkat perubahan. -->

## Problem

<!-- Masalah atau kebutuhan yang dijawab PR ini. -->

## Solution

<!-- Apa yang ditambahkan atau diubah, dan alasannya. -->

## Test Evidence

<!-- Hasil pnpm lint, typecheck, dan test. Untuk route baru atau yang berubah: contoh request dan response, termasuk kasus galat. -->

## Deployment Prerequisite / Breaking Changes

<!-- Environment variable baru, migrasi database, perubahan kontrak API. Tulis "Tidak ada" bila tidak ada. -->

## Notes

<!-- Hal yang perlu difokuskan reviewer. -->

Closes #

### Checklist

- [ ] Judul PR memuat nomor issue
- [ ] `pnpm lint`, `pnpm typecheck`, dan `pnpm test` lulus
- [ ] Ada tes untuk perilaku baru
- [ ] `docs/openapi.json` diperbarui dengan `pnpm openapi` bila route berubah
- [ ] Migrasi Drizzle ditambahkan bila skema tabel berubah
- [ ] `.env.example` dan README diperbarui bila ada environment variable baru
