import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client.js";
import { photos, places, reports, users } from "../src/db/schema.js";
import { seedSampleData } from "../src/db/seed.js";
import { reportBody, type ReportBody } from "../src/reports/schemas.js";
import { altText, REPORTS_PER_DAY, submitReport, WAITING_REPORTS } from "../src/reports/submit.js";
import { createTestDb } from "./helpers/db.js";

const NOW = new Date("2026-11-07T10:00:00.000Z");

let db: Db;
let close: () => Promise<void>;
let halteId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  halteId = (await db.select({ id: places.id }).from(places).where(eq(places.name, "Halte contoh")))[0]!.id;
}, 60_000);

afterAll(async () => {
  await close();
});

const account = async (email: string) => (await db.insert(users).values({ displayName: "Pelapor", email }).returning({ id: users.id }))[0]!.id;

const upload = async (uploaderId: string) =>
  (
    await db
      .insert(photos)
      .values({ uploaderId, storageKey: `laporan/${crypto.randomUUID()}.webp`, altText: "", width: 10, height: 10, bytes: 100 })
      .returning({ id: photos.id })
  )[0]!.id;

const facilities = (overrides: Record<string, object> = {}) =>
  ["ramp", "toilet_difabel", "guiding_block", "lift"].map((facility) => ({ facility, answer: "belum_tahu", ...overrides[facility] }));

const newPlace = (extra: object = {}) => ({
  submissionKey: crypto.randomUUID(),
  kind: "baru",
  name: "Masjid Al-Ikhlas contoh",
  category: "masjid",
  location: { lat: -6.5976, lng: 106.7991 },
  facilities: facilities(),
  ...extra,
});

/** Isian seperti yang diterima route: lewat skema Zod dulu. */
const parse = (payload: object) => reportBody.parse(payload) as ReportBody;

const galat = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return [(error as { statusCode?: number }).statusCode, (error as { code?: string }).code];
  }
  throw new Error("expected a rejection");
};

describe("reportBody", () => {
  it("accepts the form as the web sends it", () => {
    expect(reportBody.safeParse(newPlace({ description: "Ramp di pintu utama.\nToilet di lantai 2." })).success).toBe(true);
    expect(reportBody.safeParse({ submissionKey: crypto.randomUUID(), kind: "kekurangan", placeId: halteId, facilities: facilities() }).success).toBe(true);
  });

  it("rejects incomplete or inconsistent forms", () => {
    const invalid = [
      newPlace({ name: undefined }),
      newPlace({ location: undefined }),
      newPlace({ category: "pasar" }),
      newPlace({ placeId: halteId }),
      { ...newPlace(), kind: "kekurangan" },
      newPlace({ facilities: facilities().slice(0, 3) }),
      newPlace({ facilities: [...facilities().slice(0, 3), { facility: "ramp", answer: "tersedia" }] }),
      newPlace({ facilities: facilities({ ramp: { answer: "tersedia", reason: "rusak" } }) }),
      newPlace({ facilities: facilities({ lift: { note: "x".repeat(201) } }) }),
      newPlace({ name: "  " }),
      newPlace({ landmark: "x".repeat(141) }),
      newPlace({ description: "a\u0000b" }),
      newPlace({ photos: Array.from({ length: 11 }, () => ({ id: crypto.randomUUID(), tag: "lainnya" })) }),
      newPlace({ photos: [{ id: halteId, tag: "lift" }, { id: halteId, tag: "lift" }] }),
      newPlace({ submissionKey: "bukan-uuid" }),
    ];
    for (const payload of invalid) expect(reportBody.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
  });
});

describe("altText", () => {
  it("builds the alt text from the tag and place name (ADR-0023)", () => {
    expect(altText("pintu_masuk", "Halte contoh")).toBe("Foto pintu masuk dan ramp, Halte contoh");
    expect(altText("lainnya", "Halte contoh")).toBe("Foto Halte contoh");
    expect(altText("lift", "x".repeat(300))).toHaveLength(200);
  });
});

describe("submitReport", () => {
  it("queues a new place with the computed kecamatan and keeps the form as sent", async () => {
    const sari = await account("sari@contoh.id");
    const body = parse(
      newPlace({
        landmark: "Pintu samping dekat parkir motor",
        facilities: facilities({ ramp: { answer: "tersedia", note: "Landai" }, lift: { answer: "tidak_tersedia", reason: "rusak" } }),
      }),
    );
    const { report, created } = await submitReport(db, sari, body, NOW);
    expect(created).toBe(true);
    expect(report).toEqual({
      id: expect.any(String),
      kind: "baru",
      status: "menunggu",
      placeId: null,
      name: "Masjid Al-Ikhlas contoh",
      district: { slug: "bogor-tengah", name: "Bogor Tengah" },
      photos: 0,
      submittedAt: NOW.toISOString(),
    });
    const [row] = await db.select().from(reports).where(eq(reports.id, report.id));
    expect(row).toMatchObject({ reporterId: sari, status: "menunggu", districtSlug: "bogor-tengah", location: { x: 106.7991, y: -6.5976 } });
    expect(row!.submission).toMatchObject({ versi: 1, name: "Masjid Al-Ikhlas contoh", category: "masjid", landmark: "Pintu samping dekat parkir motor", description: null });
    expect((row!.submission as { facilities: unknown[] }).facilities).toContainEqual({ facility: "lift", answer: "tidak_tersedia", reason: "rusak", note: null });
  });

  it("attaches the reporter's own uploads with tag, caption, and alt text", async () => {
    const ani = await account("ani@contoh.id");
    const [entrance, other] = [await upload(ani), await upload(ani)];
    const { report } = await submitReport(
      db,
      ani,
      parse(newPlace({ name: "Halte Baru contoh", photos: [{ id: entrance, tag: "pintu_masuk", caption: "Dari tepi jalan" }, { id: other, tag: "lainnya" }] })),
      NOW,
    );
    expect(report.photos).toBe(2);
    const rows = await db.select().from(photos).where(eq(photos.reportId, report.id));
    expect(rows.map(({ id, tag, caption, altText: alt, uploaderId }) => ({ id, tag, caption, alt, uploaderId })).sort((a, b) => a.tag.localeCompare(b.tag))).toEqual([
      { id: other, tag: "lainnya", caption: null, alt: "Foto Halte Baru contoh", uploaderId: null },
      { id: entrance, tag: "pintu_masuk", caption: "Dari tepi jalan", alt: "Foto pintu masuk dan ramp, Halte Baru contoh", uploaderId: null },
    ]);
  });

  it("refuses someone else's upload or one attached already, and saves nothing", async () => {
    const [budi, citra] = [await account("budi@contoh.id"), await account("citra@contoh.id")];
    const budiPhoto = await upload(budi);
    const before = (await db.select({ id: reports.id }).from(reports)).length;
    expect(await galat(submitReport(db, citra, parse(newPlace({ photos: [{ id: budiPhoto, tag: "lift" }] })), NOW))).toEqual([400, "foto_tidak_ditemukan"]);
    expect(await db.select({ id: reports.id }).from(reports)).toHaveLength(before);
    expect((await db.select().from(photos).where(eq(photos.id, budiPhoto)))[0]).toMatchObject({ reportId: null, uploaderId: budi });
    await submitReport(db, budi, parse(newPlace({ photos: [{ id: budiPhoto, tag: "lift" }] })), NOW);
    expect(await galat(submitReport(db, budi, parse(newPlace({ photos: [{ id: budiPhoto, tag: "lift" }] })), NOW))).toEqual([400, "foto_tidak_ditemukan"]);
  });

  it("returns the same report when a draft is sent again", async () => {
    const dewi = await account("dewi@contoh.id");
    const body = parse(newPlace({ name: "Kampus contoh C", photos: [{ id: await upload(dewi), tag: "lift" }] }));
    const first = await submitReport(db, dewi, body, NOW);
    const again = await submitReport(db, dewi, body, NOW);
    expect(again).toEqual({ report: first.report, created: false });
    expect(await db.select().from(reports).where(eq(reports.submissionKey, body.submissionKey))).toHaveLength(1);
  });

  it("rejects a point outside Kota Bogor (FR-22)", async () => {
    const eko = await account("eko@contoh.id");
    expect(await galat(submitReport(db, eko, parse(newPlace({ location: { lat: -6.5579, lng: 106.7268 } })), NOW))).toEqual([422, "di_luar_kota_bogor"]);
  });

  it("keeps the current name, category, point, and landmark for a gap report (FR-27)", async () => {
    const fajar = await account("fajar@contoh.id");
    const body = parse({ submissionKey: crypto.randomUUID(), kind: "kekurangan", placeId: halteId, name: "Nama lain", facilities: facilities({ guiding_block: { answer: "tidak_tersedia", reason: "terhalang" } }) });
    const { report } = await submitReport(db, fajar, body, NOW);
    expect(report).toMatchObject({ kind: "kekurangan", placeId: halteId, name: "Halte contoh", district: { slug: "bogor-tengah" } });
    const [row] = await db.select().from(reports).where(eq(reports.id, report.id));
    expect(row!.location).toEqual({ x: 106.7942, y: -6.5958 });
  });

  it("uses the edited name and point for a place edit", async () => {
    const gita = await account("gita@contoh.id");
    const body = parse(newPlace({ kind: "perubahan", placeId: halteId, name: "Halte contoh (pintu utara)", category: "halte", location: { lat: -6.5955, lng: 106.7942 } }));
    expect((await submitReport(db, gita, body, NOW)).report).toMatchObject({ kind: "perubahan", placeId: halteId, name: "Halte contoh (pintu utara)" });
  });

  it("answers 404 for a place that does not exist", async () => {
    const hadi = await account("hadi@contoh.id");
    const body = parse({ submissionKey: crypto.randomUUID(), kind: "kekurangan", placeId: crypto.randomUUID(), facilities: facilities() });
    expect(await galat(submitReport(db, hadi, body, NOW))).toEqual([404, "lokasi_tidak_ditemukan"]);
  });

  it(`allows ${REPORTS_PER_DAY} reports per account per 24 hours`, async () => {
    const busy = await account("rajin@contoh.id");
    for (let i = 0; i < REPORTS_PER_DAY; i++) await submitReport(db, busy, parse(newPlace()), NOW);
    expect(await galat(submitReport(db, busy, parse(newPlace()), NOW))).toEqual([429, "laporan_terlalu_sering"]);
    // Laporan lebih dari 24 jam lalu tidak dihitung.
    expect((await submitReport(db, busy, parse(newPlace()), new Date(NOW.getTime() + 25 * 3600_000))).created).toBe(true);
  });

  it(`allows at most ${WAITING_REPORTS} waiting reports per account`, async () => {
    const waiting = await account("menunggu@contoh.id");
    const old = new Date(NOW.getTime() - 3 * 24 * 3600_000);
    await db.insert(reports).values(Array.from({ length: WAITING_REPORTS }, () => ({ kind: "baru" as const, reporterId: waiting, submission: { name: "Lama" }, submittedAt: old })));
    expect(await galat(submitReport(db, waiting, parse(newPlace()), NOW))).toEqual([429, "antrean_penuh"]);
  });
});
