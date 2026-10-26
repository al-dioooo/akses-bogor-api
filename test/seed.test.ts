import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db/client.js";
import { placeFacilities, places } from "../src/db/schema.js";
import { seedSampleData, SAMPLE_PLACES } from "../src/db/seed.js";
import { refreshPlaceStatus } from "../src/domain/places.js";
import { createTestDb } from "./helpers/db.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
}, 60_000);

afterAll(async () => {
  await close();
});

const placeByName = async (name: string) => (await db.select().from(places).where(eq(places.name, name)))[0]!;

describe("seedSampleData", () => {
  it("stores every sample place with the status the rules give", async () => {
    const rows = await db.select({ name: places.name, status: places.status }).from(places);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.status]))).toEqual({
      "Kampus contoh A": "aksesibel",
      "Halte contoh": "sebagian",
      "Rumah sakit contoh": "aksesibel",
      "Kampus contoh B": "sebagian",
      "Masjid contoh A": "aksesibel",
      "Masjid contoh B": "tidak_aksesibel",
      "Halte contoh B": "belum_diketahui",
    });
  });

  it("keeps the point, summary, and four facilities for the Halte contoh", async () => {
    const halte = await placeByName("Halte contoh");
    expect(halte.location).toEqual({ x: 106.7942, y: -6.5958 });
    expect([halte.facilitiesAvailable, halte.facilitiesRelevant, halte.facilitiesUnknown]).toEqual([2, 3, 0]);
    const facilities = await db.select().from(placeFacilities).where(eq(placeFacilities.placeId, halte.id));
    expect(facilities).toHaveLength(4);
  });

  it("can run again without duplicating data", async () => {
    await seedSampleData(db);
    expect(await db.$count(places)).toBe(SAMPLE_PLACES.length);
  });
});

describe("refreshPlaceStatus", () => {
  it("recomputes the stored status after an answer changes", async () => {
    const halte = await placeByName("Halte contoh");
    await db
      .update(placeFacilities)
      .set({ answer: "tersedia", reason: null })
      .where(and(eq(placeFacilities.placeId, halte.id), eq(placeFacilities.facility, "guiding_block")));
    const result = await refreshPlaceStatus(db, halte.id);
    expect(result).toMatchObject({ status: "aksesibel", available: 3, relevant: 3 });
    expect((await placeByName("Halte contoh")).status).toBe("aksesibel");
  });
});
