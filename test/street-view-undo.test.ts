import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { listCandidates } from "../src/contribute/facilities.js";
import { photos, placeFacilities, places } from "../src/db/schema.js";
import { storedHints } from "../src/hints/stored.js";
import { hideUnsettled, runRecords, type Handler } from "../src/hints/street-view-apply.js";
import { parseManifest } from "../src/hints/street-view-manifest.js";
import { prepareImages, settle } from "../src/hints/street-view-settle.js";
import { undoRecord } from "../src/hints/street-view-undo.js";
import { ATTAQWA, imageDir, manifestOf, PMI, ref, SILOAM, siloamSettled, streetViewRig, unsettled } from "./helpers/street-view.js";
import { memoryStore } from "./helpers/verification.js";

const APPLIED = new Date("2026-11-27T02:00:00.000Z");
const UNDONE = new Date("2026-11-27T05:00:00.000Z");
let rig: Awaited<ReturnType<typeof streetViewRig>>;
let dir: string;
const memory = memoryStore();

beforeAll(async () => {
  rig = await streetViewRig();
  dir = await imageDir("02-wide.png", "02-close.png", "admin.png");
}, 90_000);

afterAll(async () => {
  await rig.close();
});

const records = () => [
  siloamSettled(),
  siloamSettled({
    record: "11",
    target: { place_id: rig.adminPlaceId },
    place: { name: "Rumah sakit contoh", category: "rumah_sakit", entrance: { lat: -6.5701, lng: 106.7641 } },
    photos: [{ file: "admin.png", kind: "close-up", pano_id: "admin", image_date: "2025-11", heading: 90 }],
  }),
  unsettled("05", { osm: ref(PMI) }),
  unsettled("09", { osm: ref(ATTAQWA) }),
];

async function run(undo: boolean, now: Date, round = "r1", list = records(), extra: { dryRun?: boolean } = {}) {
  const manifest = parseManifest(manifestOf(list, round));
  const { images } = await prepareImages(manifest, dir);
  const handler: Handler = undo ? undoRecord : (ctx, rec) => (rec.verdict === "settled" ? settle(ctx, rec, images) : hideUnsettled(ctx, rec));
  return runRecords(rig.db, manifest, { now, dryRun: extra.dryRun ?? false, undo, hideCandidates: true, store: memory.store }, handler);
}
const place = async (id: string) => (await rig.db.select().from(places).where(eq(places.id, id)))[0]!;
const shownCandidates = async () => (await listCandidates(rig.db, {})).candidates.map((c) => `${c.osm.osmType}/${c.osm.osmId}`);

describe("--batalkan (ADR-0057)", () => {
  let adminBefore: Awaited<ReturnType<typeof place>>;
  let adminAnswers: unknown[];
  let tagsBefore: Record<string, unknown>[];
  let siloamId: string;

  it("applies a manifest first", async () => {
    adminBefore = await place(rig.adminPlaceId);
    adminAnswers = await rig.db.select().from(placeFacilities).where(eq(placeFacilities.placeId, rig.adminPlaceId));
    tagsBefore = [await rig.tagsOf(SILOAM), await rig.tagsOf(PMI), await rig.tagsOf(ATTAQWA)];
    await run(false, APPLIED);
    siloamId = (await rig.db.select({ id: places.id }).from(places).where(eq(places.name, "Siloam Hospitals Bogor")))[0]!.id;
    expect(await shownCandidates()).not.toContain(ref(PMI));
  });

  it("prints the undo in a dry run without changing anything", async () => {
    const tags = await rig.tagsOf(PMI);
    const result = await run(true, UNDONE, "r1", records(), { dryRun: true });
    expect(result.lines).toContain("data 05 way/782982224: kembalikan salinan aksesbogor:google_maps");
    expect(await rig.tagsOf(PMI)).toEqual(tags);
  });

  it("restores the copies, the candidates, the admin place and its photos, and takes down the place it created", async () => {
    const reports = await rig.allReports();
    const result = await run(true, UNDONE);
    expect(Object.fromEntries(result.counts)).toEqual({
      salinan_dikembalikan: 3,
      tanda_dihapus: 1,
      kandidat_ditampilkan: 2,
      tempat_dibatalkan: 1,
      tempat_dipulihkan: 1,
      foto_dihapus: 1,
    });
    expect([await rig.tagsOf(SILOAM), await rig.tagsOf(PMI), await rig.tagsOf(ATTAQWA)]).toEqual(tagsBefore);
    expect((await storedHints(rig.db, { osmType: PMI.type, osmId: PMI.id })).length).toBeGreaterThan(0);
    expect(await shownCandidates()).toEqual(expect.arrayContaining([ref(PMI), ref(ATTAQWA), ref(SILOAM)]));

    const admin = await place(rig.adminPlaceId);
    expect(admin).toMatchObject({
      name: adminBefore.name,
      status: adminBefore.status,
      location: adminBefore.location,
      adminPublishedAt: adminBefore.adminPublishedAt,
      verificationSource: "laporan",
      streetViewImageDate: null,
      lastVerifiedAt: adminBefore.lastVerifiedAt,
    });
    const answers = await rig.db.select().from(placeFacilities).where(eq(placeFacilities.placeId, rig.adminPlaceId));
    expect(answers.map(({ facility, answer, reason, note }) => ({ facility, answer, reason, note })).sort((a, b) => a.facility.localeCompare(b.facility))).toEqual(
      (adminAnswers as typeof answers).map(({ facility, answer, reason, note }) => ({ facility, answer, reason, note })).sort((a, b) => a.facility.localeCompare(b.facility)),
    );
    expect(await rig.db.select().from(photos).where(eq(photos.placeId, rig.adminPlaceId))).toEqual([]);
    expect([...memory.files.keys()].some((key) => key.startsWith(`lokasi/${rig.adminPlaceId}/`))).toBe(false);

    expect(await place(siloamId)).toMatchObject({ unpublishedReason: "Street View r1/02: dibatalkan" });
    expect(await rig.allReports()).toEqual(reports);
  });

  it("brings the created place back when the manifest is applied again", async () => {
    const result = await run(false, new Date("2026-11-27T06:00:00.000Z"));
    expect(result.lines[0]).toMatch(/^data 02 node\/4994301869: ubah tempat "Siloam Hospitals Bogor"/);
    expect(await place(siloamId)).toMatchObject({ unpublishedAt: null, verificationSource: "street_view" });
  });

  it("only undoes its own round, and leaves a place that changed after it was applied", async () => {
    const other = await run(true, new Date("2026-11-27T07:00:00.000Z"), "r-lain");
    expect(Object.fromEntries(other.counts)).toEqual({ salinan_dikembalikan: 0, tanda_dihapus: 0, kandidat_ditampilkan: 0 });
    await rig.db.update(places).set({ name: "Siloam Hospitals Bogor (diubah admin)", updatedAt: new Date("2026-11-27T08:00:00.000Z") }).where(eq(places.id, siloamId));
    const result = await run(true, new Date("2026-11-27T09:00:00.000Z"));
    expect(result.lines).toContain('data 02 node/4994301869: lewati: "Siloam Hospitals Bogor (diubah admin)" sudah berubah sejak diterapkan, tidak disentuh');
    expect(await place(siloamId)).toMatchObject({ unpublishedAt: null });
  });
});
