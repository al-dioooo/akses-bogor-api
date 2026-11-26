// Perubahan tag `osm_places` oleh verifikasi Street View (ADR-0057), sebagai fungsi murni atas objek tag. Salinan yang
// tidak terjawab dipindahkan ke `aksesbogor:disembunyikan` beserta isinya, salinan yang terjawab ditandai sudah
// diperiksa, dan kandidat bisa disembunyikan. Setiap perubahan mencatat putaran dan nomor datanya, jadi `--batalkan`
// hanya mengembalikan yang dibuat putaran itu.
import { HIDDEN_CANDIDATE_TAG } from "../contribute/facilities.js";
import { GOOGLE_MAPS_TAG } from "./google-maps-import.js";
import { OSM_NOTE_TAG, record } from "./stored.js";
import { unchecked } from "./verification-list.js";

export const HIDDEN_TAG = "aksesbogor:disembunyikan";
/** Salinan petunjuk yang dibaca kartu kandidat dan peringkat kecamatan (ADR-0052, ADR-0053). */
export const COPY_TAGS = [GOOGLE_MAPS_TAG, OSM_NOTE_TAG] as const;
export const METHOD = "street_view";

export type Tags = Record<string, unknown>;
/** Asal satu perubahan: putaran dan nomor data di manifest, alasan, dan waktunya (ISO). */
export type Mark = { round: string; record: string; reason: string; at: string };

type HiddenCopy = { isi: Record<string, unknown>; alasan: string; tanggal: string; putaran: string; data: string };
type Hidden = { metode: string; salinan: Record<string, HiddenCopy> };

const hiddenOf = (tags: Tags): Hidden => {
  const value = record(tags[HIDDEN_TAG]);
  const copies = record(value?.salinan) ?? {};
  return { metode: METHOD, salinan: copies as Record<string, HiddenCopy> };
};

/** Memindahkan salinan yang belum diperiksa ke `aksesbogor:disembunyikan`. Salinan lama di kunci yang sama diganti. */
export function hideCopies(tags: Tags, mark: Mark) {
  const next: Tags = { ...tags };
  const hidden = hiddenOf(tags);
  const moved: string[] = [];
  for (const key of COPY_TAGS) {
    const copy = record(tags[key]);
    if (!unchecked(copy)) continue;
    hidden.salinan[key] = { isi: copy, alasan: mark.reason, tanggal: mark.at, putaran: mark.round, data: mark.record };
    delete next[key];
    moved.push(key);
  }
  if (moved.length === 0) return { tags, moved };
  next[HIDDEN_TAG] = hidden;
  return { tags: next, moved };
}

/**
 * Mengembalikan salinan yang disembunyikan putaran `round` ke kunci asalnya. Bila kunci itu sudah berisi salinan baru
 * (mis. dari impor ulang), salinan baru dipertahankan dan yang tersembunyi tetap di tempatnya.
 */
export function restoreCopies(tags: Tags, round: string, recordId: string) {
  const next: Tags = { ...tags };
  const hidden = hiddenOf(tags);
  const restored: string[] = [];
  const kept: string[] = [];
  for (const [key, entry] of Object.entries(hidden.salinan)) {
    if (entry?.putaran !== round || entry.data !== recordId) continue;
    if (next[key] !== undefined) {
      kept.push(key);
      continue;
    }
    next[key] = entry.isi;
    delete hidden.salinan[key];
    restored.push(key);
  }
  if (Object.keys(hidden.salinan).length === 0) delete next[HIDDEN_TAG];
  else next[HIDDEN_TAG] = hidden;
  return { tags: restored.length > 0 ? next : tags, restored, kept };
}

/** Menandai salinan yang belum diperiksa sebagai sudah diperiksa lewat Street View, dengan tempat hasilnya. */
export function markChecked(tags: Tags, mark: Mark & { placeId: string; imageMonth: string }) {
  const next: Tags = { ...tags };
  const marked: string[] = [];
  for (const key of COPY_TAGS) {
    const copy = record(tags[key]);
    if (!unchecked(copy)) continue;
    const before = typeof copy.belum_diperiksa_tim === "boolean" ? copy.belum_diperiksa_tim : null;
    const street_view = { hasil: "terjawab", tempat: mark.placeId, gambar: mark.imageMonth, alasan: mark.reason, tanggal: mark.at, putaran: mark.round, data: mark.record, sebelum: before };
    next[key] = { ...copy, belum_diperiksa_tim: false, street_view };
    marked.push(key);
  }
  return { tags: marked.length > 0 ? next : tags, marked };
}

/** Menghapus tanda sudah diperiksa yang dibuat putaran `round`, dan mengembalikan nilai `belum_diperiksa_tim` semula. */
export function unmarkChecked(tags: Tags, round: string, recordId: string) {
  const next: Tags = { ...tags };
  const unmarked: string[] = [];
  for (const key of COPY_TAGS) {
    const copy = record(tags[key]);
    const mark = record(copy?.street_view);
    if (!copy || mark?.putaran !== round || mark.data !== recordId) continue;
    const rest = { ...copy };
    delete rest.street_view;
    delete rest.belum_diperiksa_tim;
    next[key] = typeof mark.sebelum === "boolean" ? { ...rest, belum_diperiksa_tim: mark.sebelum } : rest;
    unmarked.push(key);
  }
  return { tags: unmarked.length > 0 ? next : tags, unmarked };
}

/** Menyembunyikan kandidat dari Peta, daftar kandidat, hitungan kecamatan, dan alat agen. */
export function hideCandidate(tags: Tags, mark: Mark) {
  if (tags[HIDDEN_CANDIDATE_TAG] !== undefined) return { tags, changed: false };
  return { tags: { ...tags, [HIDDEN_CANDIDATE_TAG]: { metode: METHOD, alasan: mark.reason, tanggal: mark.at, putaran: mark.round, data: mark.record } }, changed: true };
}

/** Menampilkan lagi kandidat yang disembunyikan putaran `round`. */
export function showCandidate(tags: Tags, round: string, recordId: string) {
  const mark = record(tags[HIDDEN_CANDIDATE_TAG]);
  if (mark?.metode !== METHOD || mark.putaran !== round || mark.data !== recordId) return { tags, changed: false };
  const rest = { ...tags };
  delete rest[HIDDEN_CANDIDATE_TAG];
  return { tags: rest, changed: true };
}
