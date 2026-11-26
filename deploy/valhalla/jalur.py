#!/usr/bin/env python3
"""Ringkasan tag jalur OpenStreetMap untuk cakupan data rute aksesibel (ADR-0055).

Membaca keluaran OPL dari `osmium tags-filter ... | osmium cat -f opl,add_metadata=false` dari stdin dan menulis JSON
`{versi, dibuat, sumber, jalur: {id_way: bendera}}` ke stdout. API membaca berkas ini untuk menghitung berapa bagian
rute yang punya data trotoar, permukaan, dan kerb di OSM. Valhalla sendiri tidak membedakan tag yang kosong dari tag
yang bernilai "tidak", jadi tag mentahnya dibaca di sini dari ekstrak yang sama dengan ubin rute.

Dijalankan dengan `python3 -I` dan hanya membaca stdin, karena masukannya data unduhan.
"""

import json
import math
import re
import sys
from datetime import datetime, timezone

# Bendera per way. Nilainya sama dengan src/map/accessible-ways.ts di API.
TROTOAR_TERCATAT = 1  # jalur pejalan kaki sendiri, atau jalan dengan tag sidewalk* (termasuk "no" dan "separate")
PERMUKAAN_TERCATAT = 2  # ada tag surface
PENYEBERANGAN = 4  # jalur penyeberangan (footway=crossing atau tag crossing pada jalur pejalan kaki)
KERB_TERCATAT = 8  # jalur ini atau salah satu node-nya punya tag kerb
TANPA_TROTOAR = 16  # jalan yang dicatat tanpa trotoar di kedua sisi
PERMUKAAN_BURUK = 32  # permukaan tidak rata atau tanah, atau smoothness buruk
CURAM = 64  # incline lebih dari 8 persen (lebih curam dari ramp 1:12)
KERB_TINGGI = 128  # ada node kerb=raised
TANGGA = 256  # highway=steps

JALUR_PEJALAN_KAKI = {"footway", "pedestrian", "path", "steps", "corridor", "platform"}
SISI_TROTOAR = ("sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right", "footway:both", "footway:left", "footway:right")
TANPA = {"no", "none"}
PERMUKAAN_TIDAK_RATA = {
    "unpaved", "gravel", "fine_gravel", "dirt", "earth", "ground", "grass", "grass_paver", "mud", "sand",
    "pebblestone", "rock", "stone", "woodchips", "cobblestone", "unhewn_cobblestone", "sett",
}
SMOOTHNESS_BURUK = {"bad", "very_bad", "horrible", "very_horrible", "impassable"}
ESCAPE = re.compile(r"%([0-9a-fA-F]+)%")


def opl_text(value: str) -> str:
    return ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), value)


def opl_tags(field: str) -> dict:
    tags = {}
    if not field:
        return tags
    for pair in field.split(","):
        key, _, value = pair.partition("=")
        tags[opl_text(key)] = opl_text(value)
    return tags


def incline_percent(value: str):
    """Nilai incline dalam persen, atau None bila hanya "up"/"down" atau tidak terbaca."""
    match = re.fullmatch(r"\s*([-+]?\d+(?:[.,]\d+)?)\s*(%|°)?\s*", value)
    if not match:
        return None
    number = float(match.group(1).replace(",", "."))
    if match.group(2) == "°":
        return abs(math.tan(math.radians(number)) * 100)
    return abs(number)


def way_flags(tags: dict, nodes: list, kerb_nodes: dict) -> int:
    highway = tags.get("highway", "")
    flags = 0
    pejalan_kaki = highway in JALUR_PEJALAN_KAKI or tags.get("footway") == "sidewalk"
    sisi = [tags[k] for k in SISI_TROTOAR if k in tags]
    if pejalan_kaki or sisi:
        flags |= TROTOAR_TERCATAT
    if not pejalan_kaki and sisi and all(v in TANPA for v in sisi) and ("sidewalk" in tags or "sidewalk:both" in tags or len(sisi) >= 2):
        flags |= TANPA_TROTOAR
    if "surface" in tags:
        flags |= PERMUKAAN_TERCATAT
    if tags.get("surface") in PERMUKAAN_TIDAK_RATA or tags.get("smoothness") in SMOOTHNESS_BURUK:
        flags |= PERMUKAAN_BURUK
    if tags.get("footway") == "crossing" or (highway in {"footway", "path"} and "crossing" in tags):
        flags |= PENYEBERANGAN
    kerbs = [kerb_nodes[n] for n in nodes if n in kerb_nodes]
    if "kerb" in tags or kerbs:
        flags |= KERB_TERCATAT
    if tags.get("kerb") == "raised" or "raised" in kerbs:
        flags |= KERB_TINGGI
    incline = incline_percent(tags.get("incline", ""))
    if incline is not None and incline > 8:
        flags |= CURAM
    if highway == "steps":
        flags |= TANGGA
    return flags


def main() -> None:
    source = sys.argv[1] if len(sys.argv) > 1 else ""
    kerb_nodes = {}
    ways = []
    for line in sys.stdin:
        fields = line.rstrip("\n").split(" ")
        kind, osm_id = fields[0][0], fields[0][1:]
        parts = {f[0]: f[1:] for f in fields[1:] if f}
        tags = opl_tags(parts.get("T", ""))
        if kind == "n":
            if "kerb" in tags or tags.get("barrier") == "kerb":
                kerb_nodes[osm_id] = tags.get("kerb", "")
        elif kind == "w" and "highway" in tags:
            nodes = [n[1:] for n in parts.get("N", "").split(",") if n]
            ways.append((osm_id, tags, nodes))
    # Node selalu datang sebelum way di OPL dari osmium, tetapi way baru dihitung setelah semua node kerb terbaca.
    jalur = {osm_id: way_flags(tags, nodes, kerb_nodes) for osm_id, tags, nodes in ways}
    json.dump(
        {
            "versi": 1,
            "dibuat": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sumber": source,
            "jalur": {k: v for k, v in jalur.items() if v},
            "jumlahWay": len(jalur),
        },
        sys.stdout,
        separators=(",", ":"),
    )


if __name__ == "__main__":
    main()
