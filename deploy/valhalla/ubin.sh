#!/usr/bin/env bash
# Membangun ulang ubin Valhalla Kota Bogor dari ekstrak Geofabrik terbaru (ADR-0055). Dijalankan oleh
# akses-bogor-valhalla-ubin.service setiap minggu, atau langsung: `sudo systemctl start akses-bogor-valhalla-ubin`.
#
#   ubin.sh           unduh ekstrak bila lebih baru, bangun versi baru, pindahkan tautan aktif, buang versi lama
#   ubin.sh --lokal   pakai ekstrak yang sudah ada tanpa mengunduh
#
# Versi baru dibangun di versi/<waktu>/ dan baru dipakai setelah dua rute contoh berhasil. Restart Valhalla dilakukan
# unit systemd sesudahnya, jadi skrip ini tidak butuh hak root selain akses ke Docker.
set -euo pipefail

data=${VALHALLA_DATA_DIR:-/srv/valhalla}
image=${VALHALLA_IMAGE:-akses-bogor-valhalla:3.9.3}
url=${OSM_EXTRACT_URL:-https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf}
simpan=${SIMPAN_VERSI:-2}
# Batas memori kontainer pembangun: memotong ekstrak Jawa butuh sekitar 1,9 GB. Bila terlampaui, hanya pembangunan
# yang dihentikan kernel; versi aktif tetap dipakai.
memori=${BATAS_MEMORI:-2400m}
# User-Agent umum, tanpa nama aplikasi atau akun.
ua=${UNDUH_USER_AGENT:-osm-extract-download}

umask 022
mkdir -p "$data/unduhan" "$data/versi"
pbf=$data/unduhan/$(basename "$url")

if [[ ${1:-} != --lokal ]]; then
  # -z: hanya mengunduh bila berkas di Geofabrik lebih baru dari salinan lokal.
  sementara=$pbf.unduh
  sejak=()
  [[ -s $pbf ]] && sejak=(-z "$pbf")
  curl -fsSL -A "$ua" --retry 3 "${sejak[@]}" -R -o "$sementara" "$url"
  if [[ -s $sementara ]]; then
    curl -fsSL -A "$ua" --retry 3 -o "$sementara.md5" "$url.md5"
    (cd "$data/unduhan" && sed "s#  .*#  $(basename "$sementara")#" "$sementara.md5" | md5sum -c --quiet -)
    mv "$sementara" "$pbf"
    rm -f "$sementara.md5"
  else
    rm -f "$sementara"
    echo "ekstrak belum berubah sejak $(date -u -r "$pbf" +%Y-%m-%d)"
  fi
fi
[[ -s $pbf ]] || { echo "ekstrak $pbf tidak ada" >&2; exit 1; }

versi=$(date -u +%Y%m%dT%H%M%SZ)
mkdir "$data/versi/$versi"
mulai=$(date +%s)
if ! docker run --rm --user "$(id -u):$(id -g)" --network none --memory "$memori" --memory-swap "$memori" \
  -e BBOX -e KONKURENSI \
  -v "$data:/data" "$image" \
  /usr/local/lib/akses-bogor/bangun-dalam.sh "/data/versi/$versi" "/data/unduhan/$(basename "$pbf")"; then
  rm -rf "${data:?}/versi/$versi"
  echo "pembangunan gagal; versi aktif tidak diubah" >&2
  exit 1
fi
rm -f "$data/versi/$versi/bogor.osm.pbf"
echo "versi $versi selesai dalam $(($(date +%s) - mulai)) detik, ubin $(du -sh "$data/versi/$versi/ubin.tar" | cut -f1)"

# Pindah tautan secara atomik: Valhalla dan API membaca lewat aktif/.
ln -sfn "versi/$versi" "$data/aktif.baru"
mv -T "$data/aktif.baru" "$data/aktif"

# Simpan versi terbaru saja; versi aktif selalu termasuk.
ls -1d "$data"/versi/*/ | sort -r | tail -n +"$((simpan + 1))" | xargs -r rm -rf
