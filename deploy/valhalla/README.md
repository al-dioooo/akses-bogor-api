# Valhalla untuk rute OpenStreetMap

Berkas untuk Valhalla yang melayani `POST /route/accessible` ([ADR-0055](https://github.com/al-dioooo/akses-bogor-docs/blob/main/decisions/0055-rute-pejalan-kaki-aksesibel-dengan-valhalla.md)). Langkah pasang di server dan angka memori yang diukur ada di runbook [operations/valhalla-rute-aksesibel.md](https://github.com/al-dioooo/akses-bogor-docs/blob/main/operations/valhalla-rute-aksesibel.md) di akses-bogor-docs.

| Berkas | Isi |
| --- | --- |
| `Dockerfile` | Image Valhalla 3.9.3 resmi ditambah osmium-tool |
| `ubin.sh` | Di host: unduh ekstrak Geofabrik Jawa bila lebih baru, bangun versi baru di kontainer, pindahkan tautan `aktif`, simpan dua versi terakhir |
| `bangun-dalam.sh` | Di kontainer: potong ke kotak Kota Bogor plus 3 km, bangun ubin, buat `jalur.json`, coba dua rute contoh |
| `jalur.py` | Ringkasan tag trotoar, permukaan, kerb, tangga, dan kemiringan per way OSM untuk cakupan data rute |
| `akses-bogor-valhalla.service` | Valhalla di `127.0.0.1:8002`, data dibaca saja |
| `akses-bogor-valhalla-ubin.service`, `.timer` | Bangun ulang setiap Minggu 03.30 WIB, lalu restart Valhalla |

## Di komputer sendiri

Butuh Docker, sekitar 2 GB memori kosong saat memotong ekstrak, dan 1 GB ruang disk untuk ekstrak Jawa.

```bash
docker build -t akses-bogor-valhalla:3.9.3 deploy/valhalla
VALHALLA_DATA_DIR=$HOME/valhalla deploy/valhalla/ubin.sh
docker run -d --rm --name akses-bogor-valhalla --read-only --tmpfs /tmp -p 127.0.0.1:8002:8002 \
  -v $HOME/valhalla:/data:ro akses-bogor-valhalla:3.9.3 valhalla_service /data/aktif/valhalla.json 2
```

Lalu isi `.env` API dengan `ACCESSIBLE_ROUTER_URL=http://127.0.0.1:8002` dan `ACCESSIBLE_ROUTER_WAYS_FILE=$HOME/valhalla/aktif/jalur.json` (tulis jalurnya lengkap). Ekstrak Geofabrik berlisensi ODbL; atribusi OpenStreetMap ikut di setiap jawaban rute.
