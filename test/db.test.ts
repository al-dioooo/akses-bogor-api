import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db.js";

let client: PGlite;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ client, close } = await createTestDb());
  await client.exec(`INSERT INTO districts (slug, name) VALUES ('bogor-tengah', 'Bogor Tengah') ON CONFLICT DO NOTHING`);
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
    expect(rows.map((r) => r.table_name)).toEqual([
      "accounts",
      "audit_log",
      "districts",
      "photo_deletions",
      "photos",
      "place_facilities",
      "places",
      "report_clarifications",
      "report_emails",
      "reports",
      "sessions",
      "users",
      "verifications",
    ]);
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

describe("kecamatan boundaries (ADR-0034)", () => {
  const districtAt = async (lng: number, lat: number) => {
    const { rows } = await client.query<{ slug: string }>(
      `SELECT slug FROM districts WHERE ST_Covers(boundary, ST_SetSRID(ST_MakePoint($1, $2), 4326)) ORDER BY slug`,
      [lng, lat],
    );
    return rows.map((r) => r.slug);
  };

  it("fill valid boundaries for all six kecamatan", async () => {
    const { rows } = await client.query<{ slug: string; valid: boolean }>(
      `SELECT slug, ST_IsValid(boundary) AS valid FROM districts WHERE boundary IS NOT NULL ORDER BY slug`,
    );
    expect(rows).toEqual(
      ["bogor-barat", "bogor-selatan", "bogor-tengah", "bogor-timur", "bogor-utara", "tanah-sareal"].map((slug) => ({ slug, valid: true })),
    );
  });

  it("put a point in exactly one kecamatan and none outside Kota Bogor", async () => {
    // Kebun Raya Bogor, Bogor Tengah
    expect(await districtAt(106.7991, -6.5976)).toEqual(["bogor-tengah"]);
    // Kampus IPB Dramaga, Kabupaten Bogor (ADR-0010)
    expect(await districtAt(106.7268, -6.5579)).toEqual([]);
  });

  it("keep boundaries when sample data is seeded again", async () => {
    const { seedSampleData } = await import("../src/db/seed.js");
    const { drizzle } = await import("drizzle-orm/pglite");
    await seedSampleData(drizzle(client) as never);
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM districts WHERE boundary IS NOT NULL`);
    expect(rows[0]!.n).toBe(6);
  });

  it("place every sample location inside its own kecamatan", async () => {
    const { rows } = await client.query<{ name: string; district_slug: string; found: string | null }>(
      `SELECT p.name, p.district_slug, d.slug AS found FROM places p LEFT JOIN districts d ON ST_Covers(d.boundary, p.location) ORDER BY p.name`,
    );
    for (const row of rows) expect(row.found, row.name).toBe(row.district_slug);
  });
});

describe("photo uploads (ADR-0031)", () => {
  it("keep exactly one of report and uploader on a photo", async () => {
    const insert = (reportId: string | null, uploaderId: string | null) =>
      client.query(
        `INSERT INTO photos (report_id, uploader_id, storage_key, alt_text, width, height, bytes) VALUES ($1, $2, $3, '', 10, 10, 100)`,
        [reportId, uploaderId, `laporan/${crypto.randomUUID()}.webp`],
      );
    const { rows: users } = await client.query<{ id: string }>(`INSERT INTO users (display_name, email) VALUES ('Ani', 'ani@contoh.id') RETURNING id`);
    const { rows: reports } = await client.query<{ id: string }>(`INSERT INTO reports (kind, status, submission) VALUES ('baru', 'menunggu', '{}') RETURNING id`);
    await expect(insert(null, null)).rejects.toThrow(/photos_report_or_uploader/);
    await expect(insert(reports[0]!.id, users[0]!.id)).rejects.toThrow(/photos_report_or_uploader/);
    await insert(null, users[0]!.id);
    await insert(reports[0]!.id, null);
  });
});
