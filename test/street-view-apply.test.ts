import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getOsmPlace, listCandidates } from "../src/contribute/facilities.js";
import { auditLog, places } from "../src/db/schema.js";
import { storedHints } from "../src/hints/stored.js";
import { hideUnsettled, runRecords, type RunOptions } from "../src/hints/street-view-apply.js";
import { ManifestError, parseManifest } from "../src/hints/street-view-manifest.js";
import { hideCandidate, hideCopies, markChecked, restoreCopies, showCandidate, unmarkChecked } from "../src/hints/street-view-tags.js";
import { ATTAQWA, GOOGLE_COPY, manifestOf, OSM_NOTE, PMI, ref, SILOAM, streetViewRig, unsettled } from "./helpers/street-view.js";

const NOW = new Date("2026-11-27T02:00:00.000Z");
const mark = { round: "r1", record: "05", reason: "Pintu masuk terhalang pagar.", at: NOW.toISOString() };

describe("street view tag changes", () => {
  const tags = { name: "RS PMI Bogor", "aksesbogor:google_maps": GOOGLE_COPY, "aksesbogor:osm_aksesibilitas": OSM_NOTE };

  it("moves unchecked copies out of the keys the hint reader shows, with their content, reason and date, and restores them", () => {
    const hidden = hideCopies(tags, mark);
    expect(hidden.moved).toEqual(["aksesbogor:google_maps", "aksesbogor:osm_aksesibilitas"]);
    expect(hidden.tags).toEqual({
      name: "RS PMI Bogor",
      "aksesbogor:disembunyikan": {
        metode: "street_view",
        salinan: {
          "aksesbogor:google_maps": { isi: GOOGLE_COPY, alasan: mark.reason, tanggal: mark.at, putaran: "r1", data: "05" },
          "aksesbogor:osm_aksesibilitas": { isi: OSM_NOTE, alasan: mark.reason, tanggal: mark.at, putaran: "r1", data: "05" },
        },
      },
    });
    expect(restoreCopies(hidden.tags, "r2", "05").restored).toEqual([]);
    expect(restoreCopies(hidden.tags, "r1", "05")).toEqual({ tags, restored: ["aksesbogor:google_maps", "aksesbogor:osm_aksesibilitas"], kept: [] });
  });

  it("keeps a newer copy that arrived after hiding, and leaves copies checked by the team alone", () => {
    const hidden = hideCopies(tags, mark).tags;
    const reimported = { ...hidden, "aksesbogor:google_maps": { ...GOOGLE_COPY, nama: "Baru" } };
    expect(restoreCopies(reimported, "r1", "05")).toMatchObject({ restored: ["aksesbogor:osm_aksesibilitas"], kept: ["aksesbogor:google_maps"] });
    const checked = { "aksesbogor:google_maps": { ...GOOGLE_COPY, belum_diperiksa_tim: false } };
    expect(hideCopies(checked, mark)).toEqual({ tags: checked, moved: [] });
    expect(markChecked(checked, { ...mark, placeId: "p", imageMonth: "2026-01" }).marked).toEqual([]);
  });

  it("marks copies as checked with the street view result, and unmarks only its own round", () => {
    const marked = markChecked(tags, { ...mark, placeId: "tempat-1", imageMonth: "2026-01" });
    expect(marked.tags["aksesbogor:google_maps"]).toMatchObject({ belum_diperiksa_tim: false, street_view: { hasil: "terjawab", tempat: "tempat-1", gambar: "2026-01", putaran: "r1", sebelum: true } });
    expect(marked.tags["aksesbogor:osm_aksesibilitas"]).toMatchObject({ belum_diperiksa_tim: false, street_view: { sebelum: null } });
    expect(unmarkChecked(marked.tags, "r0", "05").unmarked).toEqual([]);
    expect(unmarkChecked(marked.tags, "r1", "05").tags).toEqual(tags);
  });

  it("hides a candidate once and shows it again only for the same round and record", () => {
    const hidden = hideCandidate({ name: "x" }, mark);
    expect(hidden.changed).toBe(true);
    expect(hideCandidate(hidden.tags, { ...mark, round: "r2" }).changed).toBe(false);
    expect(showCandidate(hidden.tags, "r2", "05").changed).toBe(false);
    expect(showCandidate(hidden.tags, "r1", "05")).toEqual({ tags: { name: "x" }, changed: true });
  });
});

describe("applying unsettled records (ADR-0057)", () => {
  let rig: Awaited<ReturnType<typeof streetViewRig>>;
  const opts = (extra: Partial<RunOptions> = {}): RunOptions => ({ now: NOW, dryRun: false, undo: false, hideCandidates: false, ...extra });
  const manifest = () =>
    parseManifest(
      manifestOf([unsettled("05", { osm: ref(PMI) }), unsettled("09", { osm: ref(ATTAQWA) }), unsettled("11", { place_id: rig.adminPlaceId }, "Tempat admin tanpa bukti gambar pintu masuk.")]),
    );
  const run = (extra: Partial<RunOptions> = {}, m = manifest()) => runRecords(rig.db, m, opts(extra), hideUnsettled);

  beforeAll(async () => {
    rig = await streetViewRig();
  }, 90_000);

  afterAll(async () => {
    await rig.close();
  });

  it("prints every change in a dry run and writes nothing", async () => {
    const before = await rig.tagsOf(PMI);
    const result = await run({ dryRun: true });
    expect(result.lines).toEqual([
      "data 05 way/782982224: sembunyikan salinan aksesbogor:google_maps",
      "data 05 way/782982224: sembunyikan salinan aksesbogor:osm_aksesibilitas",
      "data 09 node/14096317881: sembunyikan salinan aksesbogor:osm_aksesibilitas",
      `data 11 ${rig.adminPlaceId}: turunkan tempat "Rumah sakit contoh" (admin)`,
    ]);
    expect(await rig.tagsOf(PMI)).toEqual(before);
    expect((await rig.db.select({ at: places.unpublishedAt }).from(places).where(eq(places.id, rig.adminPlaceId)))[0]!.at).toBeNull();
  });

  it("hides the copies from the hint reader and unpublishes the admin place with the ADR-0051 mechanism, without touching reports", async () => {
    const reports = await rig.allReports();
    const result = await run();
    expect(Object.fromEntries(result.counts)).toEqual({ salinan_disembunyikan: 3, tempat_diturunkan: 1 });
    expect(await storedHints(rig.db, { osmType: PMI.type, osmId: PMI.id })).toEqual([]);
    expect(Object.keys(await rig.tagsOf(PMI))).toContain("aksesbogor:disembunyikan");
    const [place] = await rig.db.select().from(places).where(eq(places.id, rig.adminPlaceId));
    expect(place!.unpublishedReason).toBe("Street View 2026-11-27-uji/11: Tempat admin tanpa bukti gambar pintu masuk.");
    const [entry] = await rig.db.select().from(auditLog).where(and(eq(auditLog.entityId, rig.adminPlaceId), eq(auditLog.action, "diturunkan")));
    expect(entry).toMatchObject({ actorId: null, actorLabel: "skrip" });
    expect(await rig.allReports()).toEqual(reports);
    // Kandidat tetap tampil tanpa opsi --sembunyikan-kandidat.
    expect((await listCandidates(rig.db, {})).candidates.map((c) => `${c.osm.osmType}/${c.osm.osmId}`)).toContain(ref(PMI));
  });

  it("changes nothing when the same manifest runs again", async () => {
    const before = await rig.tagsOf(PMI);
    const result = await run();
    expect(result.lines).toEqual([
      "data 05 way/782982224: lewati: tidak ada salinan yang belum diperiksa",
      "data 09 node/14096317881: lewati: tidak ada salinan yang belum diperiksa",
      `data 11 ${rig.adminPlaceId}: lewati: "Rumah sakit contoh" sudah diturunkan`,
    ]);
    expect(await rig.tagsOf(PMI)).toEqual(before);
  });

  it("hides candidates from the map, the candidate card and the counts only when asked", async () => {
    await run({ hideCandidates: true });
    const shown = (await listCandidates(rig.db, {})).candidates.map((c) => `${c.osm.osmType}/${c.osm.osmId}`);
    expect(shown).not.toContain(ref(PMI));
    expect(shown).toContain(ref(SILOAM));
    expect(await getOsmPlace(rig.db, { osmType: PMI.type, osmId: PMI.id })).toBeNull();
  });

  it("refuses to unpublish a place verified through a report, and rolls back the whole manifest", async () => {
    const before = await rig.tagsOf(SILOAM);
    const m = parseManifest(manifestOf([unsettled("02", { osm: ref(SILOAM) }), unsettled("12", { place_id: rig.teamPlaceId })], "r-gagal"));
    const error = await run({}, m).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManifestError);
    expect((error as ManifestError).problems).toEqual([`data 12 ${rig.teamPlaceId}: "Masjid contoh A" diverifikasi lewat laporan; Street View tidak menurunkannya`]);
    expect(await rig.tagsOf(SILOAM)).toEqual(before);
  });

  it("reports a candidate that is not in osm_places", async () => {
    const m = parseManifest(manifestOf([unsettled("99", { osm: "node/1" })], "r-hilang"));
    await expect(run({}, m)).rejects.toThrow("data 99 node/1: kandidat node/1 tidak ada di osm_places");
  });
});
