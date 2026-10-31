import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db.js";

let client: PGlite;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ client, close } = await createTestDb());
  await client.exec(`INSERT INTO districts (slug, name) VALUES ('bogor-tengah', 'Bogor Tengah')`);
}, 60_000);

afterAll(async () => {
  await close();
});

const insertPlace = (point: string) =>
  client.query<{ id: string }>(
    `INSERT INTO places (name, category, district_slug, location, status, facilities_available, facilities_relevant, facilities_unknown, last_verified_at)
     VALUES ('Halte contoh', 'halte', 'bogor-tengah', ${point}, 'sebagian', 2, 3, 0, now()) RETURNING id`,
  );

describe("migrations", () => {
  it("enable PostGIS and pg_trgm", async () => {
    const { rows } = await client.query<{ extname: string }>(`SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'pg_trgm') ORDER BY extname`);
    expect(rows.map((r) => r.extname)).toEqual(["pg_trgm", "postgis"]);
  });

  it("create every table in the data model", async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'spatial_ref_sys' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(["audit_log", "districts", "photos", "place_facilities", "places", "reports", "users"]);
  });
});

describe("constraints", () => {
  it("store place points in SRID 4326", async () => {
    // A point in another reference system is rejected; a point without one gets the column's SRID.
    await expect(insertPlace("ST_SetSRID(ST_MakePoint(11888000, -736000), 3857)")).rejects.toThrow(/SRID/i);
    const { rows } = await insertPlace("ST_MakePoint(106.7945, -6.5965)");
    const { rows: srid } = await client.query<{ srid: number }>(`SELECT ST_SRID(location) AS srid FROM places WHERE id = $1`, [rows[0]!.id]);
    expect(srid[0]!.srid).toBe(4326);
  });

  it("allow a reason only when the answer is tidak_tersedia (ADR-0022)", async () => {
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM places LIMIT 1`);
    const placeId = rows[0]!.id;
    await expect(
      client.query(`INSERT INTO place_facilities (place_id, facility, answer, reason) VALUES ($1, 'ramp', 'tersedia', 'rusak')`, [placeId]),
    ).rejects.toThrow(/place_facilities_reason_only_when_unavailable/);
    await client.query(`INSERT INTO place_facilities (place_id, facility, answer, reason) VALUES ($1, 'lift', 'tidak_tersedia', 'rusak')`, [placeId]);
  });

  it("require a rejection reason exactly when a report is ditolak", async () => {
    await expect(client.query(`INSERT INTO reports (kind, status, submission) VALUES ('baru', 'ditolak', '{}')`)).rejects.toThrow(
      /reports_rejection_reason_matches_status/,
    );
    await expect(
      client.query(`INSERT INTO reports (kind, status, submission, rejection_reason) VALUES ('baru', 'menunggu', '{}', 'duplikat')`),
    ).rejects.toThrow(/reports_rejection_reason_matches_status/);
  });

  it("treat emails as case-insensitive", async () => {
    await client.query(`INSERT INTO users (display_name, email) VALUES ('Sari', 'sari@contoh.id')`);
    await expect(client.query(`INSERT INTO users (display_name, email) VALUES ('Sari 2', 'Sari@Contoh.id')`)).rejects.toThrow(/users_email_idx/);
  });

  it("keep a report but clear its reporter when the account is deleted (ADR-0024)", async () => {
    const { rows: users } = await client.query<{ id: string }>(`INSERT INTO users (display_name, email) VALUES ('Budi', 'budi@contoh.id') RETURNING id`);
    const userId = users[0]!.id;
    const { rows: reports } = await client.query<{ id: string }>(
      `INSERT INTO reports (kind, status, submission, reporter_id) VALUES ('baru', 'menunggu', '{}', $1) RETURNING id`,
      [userId],
    );
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    const { rows } = await client.query<{ reporter_id: string | null }>(`SELECT reporter_id FROM reports WHERE id = $1`, [reports[0]!.id]);
    expect(rows[0]!.reporter_id).toBeNull();
  });
});
