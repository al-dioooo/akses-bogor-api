// Rute pejalan kaki dari data OpenStreetMap lewat Valhalla di server sendiri (ADR-0055), dengan profil kursi roda atau
// jalan kaki, cakupan data, dan peringatan. Seperti rute Mapbox, posisi pengguna dibulatkan, tidak disimpan, dan rute
// tidak pernah dikirim ke model. Rute ini tidak pernah diganti diam-diam dengan rute Mapbox.
import { HttpError } from "../http/errors.js";
import { OSM_ATTRIBUTION } from "../knowledge/osm.js";
import { WAY, type WayFlags, type WayFlagsSource } from "./accessible-ways.js";
import { encodePolyline } from "./polyline.js";
import { NoNearbyPathError, NoPathError, type AccessibleProfile, type AccessibleRouter, type RouterEdge } from "./valhalla.js";
import { stepFrom } from "./valhalla-steps.js";
import { routeEnds, type RouteContext, type RouteInput } from "./walking-route.js";

export type AccessibleRouteContext = Pick<RouteContext, "db" | "now"> & {
  /** Kosong bila `ACCESSIBLE_ROUTER_URL` belum diatur: fitur mati dan rute Mapbox tetap dipakai. */
  router?: AccessibleRouter;
  /** Ringkasan tag jalur (`ACCESSIBLE_ROUTER_WAYS_FILE`); tanpa ini cakupan data tidak bisa dihitung. */
  ways?: WayFlagsSource;
};

/** Label tetap yang selalu tampil bersama rute ini. */
export const ACCESSIBLE_NOTE = "Dihitung dari data OpenStreetMap; kondisi lapangan bisa berbeda.";

export type Coverage = {
  /** Bagian panjang rute (persen, dibulatkan ke bawah) di jalur pejalan kaki atau jalan yang trotoarnya tercatat. */
  sidewalkPercent: number | null;
  /** Bagian panjang rute yang jenis permukaannya tercatat. */
  surfacePercent: number | null;
  /** Jalur penyeberangan yang dilewati, dan berapa yang kerb-nya tercatat. */
  crossings: number | null;
  crossingsWithKerb: number | null;
  /** Tanggal ekstrak OSM yang dipakai, bila diketahui. */
  dataDate: string | null;
};

export type RouteWarning = { code: string; message: string };

/** Panjang yang dibulatkan untuk kalimat peringatan, mis. "sekitar 120 m" atau "sekitar 1,4 km". */
export function roughDistance(meters: number) {
  const rounded = Math.max(10, Math.round(meters / 10) * 10);
  if (rounded >= 1000) return `sekitar ${(Math.round(meters / 100) / 10).toLocaleString("id-ID")} km`;
  return `sekitar ${rounded} m`;
}

/** Cakupan data dan peringatan dari jalur yang dilewati rute, menurut tag OSM di jalur.json. */
export function coverageOf(found: RouterEdge[] | null, ways: WayFlags | null, profile: AccessibleProfile): { coverage: Coverage; warnings: RouteWarning[] } {
  const warnings: RouteWarning[] = [];
  const edges = found ?? [];
  const total = edges.reduce((sum, e) => sum + e.lengthMeters, 0);
  const lengthWhere = (test: (flags: number, edge: RouterEdge) => boolean) => edges.reduce((sum, e) => (test(ways?.flagsOf(e.wayId) ?? 0, e) ? sum + e.lengthMeters : sum), 0);
  const percent = (meters: number) => (total > 0 ? Math.floor((meters / total) * 100) : 0);

  const steps = lengthWhere((f, e) => e.use === "steps" || (f & WAY.steps) !== 0);
  if (steps > 0) warnings.push({ code: "melewati_tangga", message: `Rute ini melewati tangga ${roughDistance(steps)}.` });
  if (edges.some((e) => e.use === "elevator")) warnings.push({ code: "memakai_lift", message: "Rute ini memakai lift. Pastikan lift-nya berfungsi sebelum berangkat." });
  if (!ways || !found) {
    warnings.push({ code: "cakupan_tidak_diketahui", message: "Cakupan data trotoar, permukaan, dan kerb belum bisa dihitung untuk rute ini." });
    if (profile === "kursi_roda") warnings.push(slopeWarning);
    return { coverage: { sidewalkPercent: null, surfacePercent: null, crossings: null, crossingsWithKerb: null, dataDate: null }, warnings };
  }

  const crossingWays = new Set(edges.filter((e) => ways.flagsOf(e.wayId) & WAY.crossing).map((e) => e.wayId));
  const withKerb = [...crossingWays].filter((id) => ways.flagsOf(id) & WAY.kerbKnown).length;
  const raisedKerbs = new Set(edges.filter((e) => ways.flagsOf(e.wayId) & WAY.raisedKerb).map((e) => e.wayId)).size;
  const noSidewalk = lengthWhere((f) => (f & WAY.noSidewalk) !== 0);
  const rough = lengthWhere((f) => (f & WAY.roughSurface) !== 0);
  const steep = lengthWhere((f) => (f & WAY.steep) !== 0);
  const coverage: Coverage = {
    sidewalkPercent: percent(lengthWhere((f) => (f & WAY.sidewalkKnown) !== 0)),
    surfacePercent: percent(lengthWhere((f) => (f & WAY.surfaceKnown) !== 0)),
    crossings: crossingWays.size,
    crossingsWithKerb: withKerb,
    dataDate: ways.dataDate,
  };

  if (raisedKerbs > 0) warnings.push({ code: "kerb_tinggi", message: `Ada kerb tinggi yang tercatat di ${raisedKerbs} ruas jalur yang dilewati rute ini.` });
  if (noSidewalk > 0) warnings.push({ code: "tanpa_trotoar", message: `${capital(roughDistance(noSidewalk))} rute berada di jalan yang tercatat tanpa trotoar.` });
  if (rough > 0) warnings.push({ code: "permukaan_buruk", message: `${capital(roughDistance(rough))} rute tercatat berpermukaan tidak rata, berbatu, atau tanah.` });
  if (steep > 0) warnings.push({ code: "tanjakan_curam", message: `${capital(roughDistance(steep))} rute tercatat lebih curam dari 8%.` });
  if (coverage.sidewalkPercent! < 100) {
    warnings.push({ code: "data_trotoar_kurang", message: `Data trotoar belum tercatat di OpenStreetMap untuk ${100 - coverage.sidewalkPercent!}% panjang rute.` });
  }
  if (coverage.surfacePercent! < 100) {
    warnings.push({ code: "data_permukaan_kurang", message: `Jenis permukaan belum tercatat untuk ${100 - coverage.surfacePercent!}% panjang rute.` });
  }
  if (withKerb < crossingWays.size) {
    warnings.push({ code: "data_kerb_kurang", message: `Kerb belum tercatat di ${crossingWays.size - withKerb} dari ${crossingWays.size} penyeberangan pada rute ini.` });
  }
  if (profile === "kursi_roda") warnings.push(slopeWarning);
  return { coverage, warnings };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Ubin dibangun tanpa data ketinggian, jadi kemiringan jalan tidak ikut dihitung (ADR-0055). */
const slopeWarning: RouteWarning = { code: "kemiringan_tidak_dihitung", message: "Kemiringan jalan belum ikut dihitung; tanjakan hanya diketahui bila tercatat di OSM." };

/**
 * Rute pejalan kaki dari posisi pengguna ke pin lokasi lewat Valhalla. Posisi dibulatkan ke 4 desimal sebelum dikirim
 * ke Valhalla di server sendiri; rute tidak disimpan.
 */
export async function accessibleRoute(ctx: AccessibleRouteContext, input: RouteInput & { profil: AccessibleProfile }) {
  if (!ctx.router) throw new HttpError(503, "rute_aksesibel_belum_aktif", "Rute dari data OpenStreetMap belum diatur di server.");
  const { from, place } = await routeEnds(ctx, input);
  let route;
  try {
    route = await ctx.router(from, place.location, input.profil);
  } catch (error) {
    if (error instanceof NoPathError) {
      throw input.profil === "kursi_roda"
        ? new HttpError(422, "tanpa_rute_kursi_roda", "Tidak ditemukan rute tanpa tangga yang bisa dilewati kursi roda menurut data OpenStreetMap. Coba profil jalan kaki, lalu periksa hambatannya.")
        : new HttpError(422, "rute_tidak_ditemukan", "Rute jalan kaki ke tempat ini tidak ditemukan di data OpenStreetMap.");
    }
    if (error instanceof NoNearbyPathError) {
      throw new HttpError(422, "jauh_dari_jalur", "Titik awal atau tujuan terlalu jauh dari jalan atau jalur yang tercatat di OpenStreetMap. Pilih titik di dekat jalan.");
    }
    throw new HttpError(502, "rute_gagal", "Rute sedang tidak bisa dimuat. Coba lagi sebentar lagi.");
  }
  const ways = ctx.ways ? await ctx.ways() : null;
  const { coverage, warnings } = coverageOf(route.edges, ways, input.profil);
  return {
    destination: { placeId: place.placeId, osm: place.osm, name: place.name, location: place.location },
    profil: input.profil,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    steps: route.maneuvers.map(stepFrom),
    geometry: { type: "LineString" as const, coordinates: route.coordinates },
    polyline: encodePolyline(route.coordinates),
    coverage,
    warnings,
    note: ACCESSIBLE_NOTE,
    attribution: OSM_ATTRIBUTION,
  };
}
