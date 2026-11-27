#!/usr/bin/env bash
# Cadangan database AksesBogor (ADR-0025, ADR-0026). Dijalankan akses-bogor-backup.service sebagai user postgres.
# Menyimpan BACKUP_KEEP dump terakhir di BACKUP_DIR, lalu menyalin dump baru ke R2 bila BACKUP_R2_REMOTE diisi.
# Bila BACKUP_AGE_RECIPIENT juga diisi, yang disalin ke R2 adalah <dump>.age, dienkripsi dengan age ke kunci publik itu.
set -euo pipefail

dir=${BACKUP_DIR:-/var/backups/akses-bogor}
keep=${BACKUP_KEEP:-7}
db=${PGDATABASE:-aksesbogor}
file=$dir/$db-$(date -u +%Y%m%dT%H%M%SZ).dump

umask 077
pg_dump --format=custom --file="$file.tmp" "$db"
mv "$file.tmp" "$file"
echo "dump: $file ($(du -h "$file" | cut -f1))"

ls -1t "$dir/$db"-*.dump | tail -n +$((keep + 1)) | xargs -r rm -f --

# Masa simpan 30 hari di R2 diatur lifecycle rule bucket, bukan skrip ini.
if [[ -z ${BACKUP_R2_REMOTE:-} ]]; then
  echo "BACKUP_R2_REMOTE kosong; salinan R2 dilewati"
  exit 0
fi

if [[ -n ${BACKUP_AGE_RECIPIENT:-} ]]; then
  command -v age >/dev/null || { echo "age tidak terpasang; pasang dengan: apt install age" >&2; exit 1; }
  # Berkas sementara di BACKUP_DIR, satu-satunya folder yang bisa ditulis service. Trap menghapusnya saat skrip
  # selesai, berhasil atau gagal. Bila age gagal, set -e menghentikan skrip sebelum rclone dipanggil.
  upload=$(mktemp "$dir/.$(basename "$file").age.XXXXXX")
  trap 'rm -f -- "$upload"' EXIT
  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" <"$file" >"$upload"
  object=$BACKUP_R2_REMOTE/$(basename "$file").age
else
  echo "PERINGATAN: BACKUP_AGE_RECIPIENT kosong; dump disalin ke R2 tanpa enkripsi (ADR-0025, catatan 2026-11-27)" >&2
  upload=$file
  object=$BACKUP_R2_REMOTE/$(basename "$file")
fi

rclone copyto --s3-no-check-bucket "$upload" "$object"
echo "disalin ke $object"
