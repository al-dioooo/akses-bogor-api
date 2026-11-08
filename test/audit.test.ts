import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { audit, diff } from "../src/audit/log.js";
import type { Db } from "../src/db/client.js";
import { auditLog, users } from "../src/db/schema.js";
import { createTestDb } from "./helpers/db.js";

const AT = new Date("2026-11-08T10:00:00.000Z");

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await close();
});

describe("diff", () => {
  it("lists only the fields that changed, with before and after", () => {
    expect(diff({ name: "Halte A", status: "sebagian", landmark: null }, { name: "Halte A", status: "aksesibel", landmark: "Dekat pasar" })).toEqual({
      status: { sebelum: "sebagian", sesudah: "aksesibel" },
      landmark: { sebelum: null, sesudah: "Dekat pasar" },
    });
  });

  it("treats a missing before as null and compares nested values by content", () => {
    expect(diff(null, { name: "Masjid", location: { lat: 1, lng: 2 } })).toEqual({
      name: { sebelum: null, sesudah: "Masjid" },
      location: { sebelum: null, sesudah: { lat: 1, lng: 2 } },
    });
    expect(diff({ location: { lat: 1, lng: 2 } }, { location: { lat: 1, lng: 2 } })).toEqual({});
  });
});

describe("audit", () => {
  it("records the acting account or a system label", async () => {
    const [user] = await db.insert(users).values({ displayName: "Verifikator", email: "v@contoh.id" }).returning({ id: users.id });
    const placeId = crypto.randomUUID();
    await audit(
      db,
      { entity: "lokasi", entityId: placeId, actor: { userId: user!.id }, action: "diubah", changes: { status: { sebelum: "sebagian", sesudah: "aksesibel" } }, at: AT },
      { entity: "laporan", entityId: placeId, actor: { label: "sistem" }, action: "ditolak", at: AT },
    );
    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.id));
    expect(rows).toMatchObject([
      { entityType: "lokasi", entityId: placeId, actorId: user!.id, actorLabel: null, action: "diubah", createdAt: AT },
      { entityType: "laporan", actorId: null, actorLabel: "sistem", action: "ditolak", changes: null },
    ]);
  });

  it("does nothing without entries", async () => {
    await expect(audit(db)).resolves.toBeUndefined();
  });
});
