import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { listCandidates } from "../src/contribute/facilities.js";
import { auditLog, photos, places } from "../src/db/schema.js";
import { getPlace } from "../src/places/queries.js";
import { storedHints } from "../src/hints/stored.js";
import { hideUnsettled, runRecords, type Handler, type RunOptions } from "../src/hints/street-view-apply.js";
import { parseManifest, type Manifest } from "../src/hints/street-view-manifest.js";
import { photoIdFor, prepareImages, settle, type PreparedImage } from "../src/hints/street-view-settle.js";
import { imageDir, KESATUAN, kesatuanSettled, manifestOf, ref, SILOAM, siloamSettled, streetViewRig } from "./helpers/street-view.js";
import { memoryStore } from "./helpers/verification.js";

const NOW = new Date("2026-11-27T02:00:00.000Z");
let rig: Awaited<ReturnType<typeof streetViewRig>>;
let dir: string;
const memory = memoryStore();

beforeAll(async () => {
  rig = await streetViewRig();
  dir = await imageDir("02-wide.png", "02-close.png", "10-close.png", "admin.png");
}, 90_000);

afterAll(async () => {
  await rig.close();
});

async function run(records: unknown[], extra: Partial<RunOptions> = {}, round = "2026-11-27-uji") {
  const manifest: Manifest = parseManifest(manifestOf(records, round));
  const { images, problems } = await prepareImages(manifest, dir);
  expect(problems).toEqual([]);
  const handler: Handler = (ctx, rec) => (rec.verdict === "settled" ? settle(ctx, rec, images as Map<string, PreparedImage>) : hideUnsettled(ctx, rec));
  return runRecords(rig.db, manifest, { now: NOW, dryRun: false, undo: false, hideCandidates: false, store: memory.store, ...extra }, handler);
}
const placeAt = async (name: string) => (await rig.db.select().from(places).where(eq(places.name, name)))[0];

describe("prepareImages", () => {
  it("refuses files outside the manifest folder and files that are not photos", async () => {
    const manifest = parseManifest(manifestOf([siloamSettled({ photos: [{ ...siloamSettled().photos[0], file: "../rahasia.png" }, { ...siloamSettled().photos[1], file: "hilang.png" }] })]));
    const { problems } = await prepareImages(manifest, dir);
    expect(problems).toEqual(["data 02: ../rahasia.png ada di luar folder manifest", expect.stringMatching(/^data 02: hilang\.png tidak bisa dipakai/)]);
  });

  it("gives the same image on the same target the same version 8 UUID", () => {
    expect(photoIdFor("node/1", "ab".repeat(32))).toBe(photoIdFor("node/1", "ab".repeat(32)));
    expect(photoIdFor("node/1", "ab".repeat(32))).not.toBe(photoIdFor("node/2", "ab".repeat(32)));
    expect(photoIdFor("node/1", "ab".repeat(32))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("applying settled records (ADR-0057)", () => {
  it("prints the new place and its photos in a dry run without writing or uploading", async () => {
    const result = await run([siloamSettled()], { dryRun: true });
    expect(result.lines).toEqual([
      'data 02 node/4994301869: buat tempat "Siloam Hospitals Bogor" (rumah_sakit, Bogor Tengah): belum_diketahui; ramp=tidak_perlu, toilet_difabel=belum_tahu, guiding_block=belum_tahu, lift=belum_tahu; gambar 2026-01',
      "data 02 node/4994301869: akan unggah foto 02-wide.png (pintu_masuk, wide, gambar 2026-01)",
      "data 02 node/4994301869: akan unggah foto 02-close.png (pintu_masuk, close-up, gambar 2026-01)",
      "data 02 node/4994301869: tandai salinan aksesbogor:google_maps sudah diperiksa",
    ]);
    expect(await placeAt("Siloam Hospitals Bogor")).toBeUndefined();
    expect(memory.files.size).toBe(0);
  });

  it("creates the place from the candidate with the judged answers, street view source, image month and photos", async () => {
    const reports = await rig.allReports();
    const result = await run([siloamSettled(), kesatuanSettled()]);
    expect(Object.fromEntries(result.counts)).toEqual({ tempat_dibuat: 2, foto_diunggah: 3, salinan_ditandai: 1 });
    const siloam = (await placeAt("Siloam Hospitals Bogor"))!;
    expect(siloam).toMatchObject({ verificationSource: "street_view", streetViewImageDate: "2026-01-01", lastVerifiedAt: new Date("2026-01-01T00:00:00Z"), adminPublishedAt: null, status: "belum_diketahui", districtSlug: "bogor-tengah" });
    const detail = (await getPlace(rig.db, siloam.id, NOW))!;
    expect(detail).toMatchObject({ verificationSource: "street_view", streetViewImageDate: "2026-01", location: { lat: -6.5956638, lng: 106.8046881 } });
    expect(detail.facilities.find((f) => f.facility === "ramp")).toMatchObject({ answer: "tidak_perlu" });
    expect(detail.photos).toEqual([
      expect.objectContaining({ tag: "pintu_masuk", source: "street_view", caption: "Sumber: Google Street View, gambar Januari 2026", alt: "Pintu masuk Siloam Hospitals Bogor dilihat dari jalan, tangkapan Google Street View Januari 2026" }),
      expect.objectContaining({ tag: "pintu_masuk", source: "street_view", alt: "Pintu masuk Siloam Hospitals Bogor dari dekat, tangkapan Google Street View Januari 2026" }),
    ]);
    const rows = await rig.db.select().from(photos).where(eq(photos.placeId, siloam.id));
    for (const p of rows) {
      expect(p).toMatchObject({ reportId: null, uploaderId: null, moderation: "tayang" });
      expect(p.storageKey).toBe(`lokasi/${siloam.id}/${p.id}.webp`);
      expect(memory.files.get(p.storageKey)?.contentType).toBe("image/webp");
    }
    const kesatuan = (await placeAt("IBI Kesatuan"))!;
    expect(kesatuan).toMatchObject({ status: "tidak_aksesibel", streetViewImageDate: "2026-02-01" });
    expect(await rig.allReports()).toEqual(reports);
  });

  it("marks the candidate's copies as checked, so they are no longer shown, and the 50 m rule hides the candidate", async () => {
    expect((await rig.tagsOf(SILOAM))["aksesbogor:google_maps"]).toMatchObject({ belum_diperiksa_tim: false, street_view: { hasil: "terjawab", gambar: "2026-01" } });
    expect(await storedHints(rig.db, { osmType: SILOAM.type, osmId: SILOAM.id })).toEqual([]);
    const shown = (await listCandidates(rig.db, {})).candidates.map((c) => `${c.osm.osmType}/${c.osm.osmId}`);
    expect(shown).not.toContain(ref(SILOAM));
    expect(shown).not.toContain(ref(KESATUAN));
  });

  it("records the change and the state before it in the audit log, by the server script", async () => {
    const siloam = (await placeAt("Siloam Hospitals Bogor"))!;
    const [entry] = await rig.db.select().from(auditLog).where(and(eq(auditLog.entityId, siloam.id), eq(auditLog.action, "dibuat_street_view")));
    expect(entry).toMatchObject({ actorLabel: "skrip", changes: { alasan: siloamSettled().reason, putaran: "2026-11-27-uji", data: "02", sasaran: ref(SILOAM), gambar: "2026-01", sebelum: null } });
  });

  it("changes nothing and uploads nothing when the same manifest runs again", async () => {
    const files = memory.files.size;
    const audits = (await rig.db.select().from(auditLog)).length;
    const result = await run([siloamSettled(), kesatuanSettled()]);
    expect(result.lines).toEqual([
      'data 02 node/4994301869: lewati: "Siloam Hospitals Bogor" sudah diterapkan, tidak ada perubahan',
      'data 10 way/158830244: lewati: "IBI Kesatuan" sudah diterapkan, tidak ada perubahan',
    ]);
    expect(memory.files.size).toBe(files);
    expect((await rig.db.select().from(auditLog)).length).toBe(audits);
  });

  it("turns an admin place into a street view place, and leaves a place verified through a report alone", async () => {
    const admin = siloamSettled({
      record: "11",
      target: { place_id: rig.adminPlaceId },
      place: { name: "Rumah sakit contoh", category: "rumah_sakit", entrance: { lat: -6.57, lng: 106.764 } },
      photos: [{ file: "admin.png", kind: "close-up", pano_id: "admin", image_date: "2025-11", heading: 90 }],
    });
    const team = siloamSettled({ record: "12", target: { place_id: rig.teamPlaceId }, place: { name: "Masjid contoh A", category: "masjid", entrance: { lat: -6.605, lng: 106.813 } }, photos: [{ file: "admin.png", kind: "wide", pano_id: "team", image_date: "2026-01", heading: 0 }] });
    const result = await run([admin, team], {}, "r-admin");
    expect(result.lines[0]).toMatch(/^data 11 .*: ubah tempat "Rumah sakit contoh"/);
    expect(result.lines.at(-1)).toBe(`data 12 ${rig.teamPlaceId}: lewati: "Masjid contoh A" sudah diverifikasi lewat laporan, tidak diubah`);
    expect(await rig.db.select().from(places).where(inArray(places.id, [rig.adminPlaceId]))).toEqual([
      expect.objectContaining({ adminPublishedAt: null, verificationSource: "street_view", streetViewImageDate: "2025-11-01" }),
    ]);
    expect((await rig.db.select().from(places).where(eq(places.id, rig.teamPlaceId)))[0]!.verificationSource).toBe("laporan");
  });

  it("refuses to write photos without a photo store, and rolls everything back", async () => {
    const record = siloamSettled({ record: "13", target: { osm: "way/782982224" }, place: { name: "RS PMI Bogor", category: "rumah_sakit", entrance: { lat: -6.5985866, lng: 106.8050248 } } });
    await expect(run([record], { store: undefined }, "r-tanpa-r2")).rejects.toThrow("penyimpanan foto belum diatur");
    expect(await placeAt("RS PMI Bogor")).toBeUndefined();
  });
});
