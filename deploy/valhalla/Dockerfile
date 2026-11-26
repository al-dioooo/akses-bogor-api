# Valhalla untuk rute pejalan kaki aksesibel AksesBogor (ADR-0055): image resmi Valhalla ditambah osmium-tool untuk
# memotong ekstrak OpenStreetMap ke Kota Bogor dan membaca tag jalur untuk cakupan data.
#
#   docker build -t akses-bogor-valhalla:3.9.3 deploy/valhalla
FROM ghcr.io/valhalla/valhalla:3.9.3

RUN apt-get update \
  && apt-get install -y --no-install-recommends osmium-tool \
  && rm -rf /var/lib/apt/lists/*

COPY bangun-dalam.sh jalur.py /usr/local/lib/akses-bogor/
