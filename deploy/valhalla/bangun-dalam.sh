#!/usr/bin/env bash
# Langkah pembangunan ubin di dalam kontainer akses-bogor-valhalla (ADR-0055). Dipanggil oleh ubin.sh, bukan langsung.
#
#   bangun-dalam.sh <direktori versi> <ekstrak .osm.pbf>
#
# Memotong ekstrak ke kotak Kota Bogor plus tepi, membangun ubin Valhalla untuk pejalan kaki, membuat jalur.json
# (ringkasan tag untuk cakupan data), lalu mencoba dua rute contoh. Semua berkas ditulis di direktori versi.
set -euo pipefail

versi=$1
ekstrak=$2
# Kota Bogor (KOTA_BOGOR_BBOX di src/map/search.ts) ditambah sekitar 3 km di setiap sisi.
bbox=${BBOX:-106.69,-6.72,106.89,-6.47}
konkurensi=${KONKURENSI:-$(nproc)}

cd "$versi"
echo "memotong $(basename "$ekstrak") ke $bbox"
# Strategi simple memotong way di tepi kotak; tepi 3 km cukup untuk rute di dalam kota. complete_ways butuh sekitar
# 3,3 GB memori untuk ekstrak Jawa, simple sekitar 1,9 GB (diukur 2026-11-26, lihat runbook).
osmium extract --bbox "$bbox" --strategy simple --overwrite --no-progress -o bogor.osm.pbf "$ekstrak"

# Konfigurasi untuk membangun (jalur versi) dan untuk melayani (lewat tautan aktif). Tanpa basis data admin dan zona
# waktu: ekstrak potongan tidak memuat batas negara yang utuh, dan rute pejalan kaki tidak membutuhkannya.
konfigurasi() {
  valhalla_build_config \
    --mjolnir-tile-dir "$1/ubin" \
    --mjolnir-tile-extract "$1/ubin.tar" \
    --mjolnir-admin /tidak-ada/admin.sqlite \
    --mjolnir-timezone /tidak-ada/timezone.sqlite \
    --mjolnir-data-processing-use-admin-db False \
    --mjolnir-concurrency "$konkurensi" \
    --additional-data-elevation /tidak-ada/elevasi/ \
    --service-limits-pedestrian-max-distance 20000 \
    --service-limits-pedestrian-max-locations 2 \
    --service-limits-trace-max-shape 20000 \
    --httpd-service-listen 'tcp://*:8002' \
    --logging-type "${2:-std_out}" \
    --logging-color False
}
konfigurasi "$versi" > bangun.json
# Log Valhalla saat melayani tidak boleh mencatat koordinat permintaan; lihat ADR-0055 dan runbook.
konfigurasi /data/aktif "${LOG_LAYANAN:-std_err}" > valhalla.json

echo "membangun ubin dengan $konkurensi thread"
valhalla_build_tiles -c bangun.json bogor.osm.pbf
valhalla_build_extract -c bangun.json --overwrite
rm -rf ubin

echo "membuat jalur.json"
osmium tags-filter --overwrite --no-progress -R -o jalur.osm.pbf bogor.osm.pbf w/highway n/kerb n/barrier=kerb
osmium cat -f opl,add_metadata=false jalur.osm.pbf | python3 -I /usr/local/lib/akses-bogor/jalur.py "$(basename "$ekstrak") $(date -u -r "$ekstrak" +%Y-%m-%d)" > jalur.json
rm -f jalur.osm.pbf

# Rute contoh: Stasiun Bogor ke Balai Kota Bogor, sebagai pejalan kaki dan sebagai pengguna kursi roda.
for jenis in foot wheelchair; do
  permintaan='{"locations":[{"lat":-6.5954,"lon":106.7906},{"lat":-6.5946,"lon":106.7963}],"costing":"pedestrian","costing_options":{"pedestrian":{"type":"'$jenis'"}},"directions_type":"none"}'
  if ! valhalla_service bangun.json route "$permintaan" | python3 -I -c 'import json,sys; t=json.load(sys.stdin)["trip"]; print("rute contoh", sys.argv[1], round(t["summary"]["length"], 2), "km")' "$jenis"; then
    echo "rute contoh $jenis gagal" >&2
    exit 1
  fi
done
