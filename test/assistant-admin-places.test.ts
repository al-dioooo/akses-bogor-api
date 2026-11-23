import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assistantPrompt } from "../src/agent/assistant-prompt.js";
import { ADMIN_PUBLISHED_SOURCE, findPlaceForAssistant, nearbyPlaces, placeAccessibilityForAssistant, TEAM_CHECKED_SOURCE } from "../src/agent/assistant-tools.js";
import type { ToolContext } from "../src/agent/tools.js";
import type { Db } from "../src/db/client.js";
import { places } from "../src/db/schema.js";
import { seedSampleData } from "../src/db/seed.js";
import { placesNamed } from "../src/places/queries.js";
import { createTestDb } from "./helpers/db.js";

// Asisten rute publik dan tempat yang dikelola admin (ADR-0051): label sumbernya, dan tempat yang diturunkan tidak muncul.
let db: Db;
let close: () => Promise<void>;
let halteId: string;
let halteBId: string;
const now = () => new Date("2026-11-23T05:00:00.000Z");
/** Beberapa meter dari Halte contoh di Bogor Tengah. */
const nearHalte = { lat: -6.59585, lng: 106.79425 };
const context = (position?: { lat: number; lng: number }): ToolContext => ({ db, now, position });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  const named = await placesNamed(db, "Halte contoh", 5);
  halteId = named.find((p) => p.name === "Halte contoh")!.id;
  halteBId = named.find((p) => p.name === "Halte contoh B")!.id;
  await db.update(places).set({ adminPublishedAt: now() }).where(eq(places.id, halteId));
  await db.update(places).set({ unpublishedAt: now(), unpublishedReason: "Tempat sudah tutup" }).where(eq(places.id, halteBId));
}, 60_000);

afterAll(async () => {
  await close();
});

describe("the public assistant and places published directly by an admin", () => {
  it("names the admin as the source instead of the verifier team", async () => {
    const place = await placeAccessibilityForAssistant(context(), { placeId: halteId });
    expect(place).toMatchObject({ name: "Halte contoh", checkedByTeam: true, verifiedBy: "admin", source: ADMIN_PUBLISHED_SOURCE });
    const found = await findPlaceForAssistant(context(), { query: "halte" });
    expect(found.places).toEqual([expect.objectContaining({ id: halteId, verifiedBy: "admin", source: ADMIN_PUBLISHED_SOURCE })]);
    const nearby = await nearbyPlaces(context(nearHalte), { category: "halte" });
    expect(nearby.places[0]).toMatchObject({ id: halteId, verifiedBy: "admin", source: ADMIN_PUBLISHED_SOURCE });
  });

  it("keeps the team source for places the verifier team published", async () => {
    const { places: masjid } = await findPlaceForAssistant(context(), { category: "masjid" });
    expect(masjid.length).toBeGreaterThan(0);
    for (const p of masjid) expect(p).toMatchObject({ verifiedBy: "tim", source: TEAM_CHECKED_SOURCE });
  });

  it("tells the model not to call an admin-published place verified", () => {
    expect(assistantPrompt()).toContain('bila verifiedBy admin: "data AksesBogor yang diterbitkan langsung oleh admin, <tanggal>" (jangan menyebutnya diverifikasi)');
  });
});

describe("the public assistant and places taken down by an admin", () => {
  it("leaves them out of find_place and nearby_places, and answers 404 for them", async () => {
    expect((await findPlaceForAssistant(context(), { query: "halte" })).places.map((p) => p.id)).not.toContain(halteBId);
    expect((await findPlaceForAssistant(context(), { kecamatan: "tanah-sareal" })).places.map((p) => p.id)).not.toContain(halteBId);
    expect((await nearbyPlaces(context(nearHalte), { limit: 10 })).places.map((p) => p.id)).not.toContain(halteBId);
    await expect(placeAccessibilityForAssistant(context(), { placeId: halteBId })).rejects.toMatchObject({ statusCode: 404 });
  });
});
