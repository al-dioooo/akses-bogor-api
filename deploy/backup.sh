#!/usr/bin/env bash
# Cadangan database AksesBogor (ADR-0025, ADR-0026). Dijalankan akses-bogor-backup.service sebagai user postgres.
# Menyimpan BACKUP_KEEP dump terakhir di BACKUP_DIR, lalu menyalin dump baru ke R2 bila BACKUP_R2_REMOTE diisi.
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
if [[ -n ${BACKUP_R2_REMOTE:-} ]]; then
  rclone copyto --s3-no-check-bucket "$file" "$BACKUP_R2_REMOTE/$(basename "$file")"
  echo "disalin ke $BACKUP_R2_REMOTE"
else
  echo "BACKUP_R2_REMOTE kosong; salinan R2 dilewati"
fi
