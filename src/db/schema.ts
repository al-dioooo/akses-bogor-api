// Skema Drizzle untuk model data PRD bagian 9. Nama tabel dan kolom dalam bahasa Inggris; nilai enum
// memakai istilah produk (ADR di akses-bogor-docs) supaya sama dengan yang dibaca tim dan pengguna.
import { sql } from "drizzle-orm";
import { check, customType, geometry, index, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

// ADR-0004
export const placeCategory = pgEnum("place_category", ["kampus", "masjid", "halte", "rumah_sakit"]);
// ADR-0018
export const placeStatus = pgEnum("place_status", ["aksesibel", "sebagian", "tidak_aksesibel", "belum_diketahui"]);
// ADR-0017
export const facilityKind = pgEnum("facility_kind", ["ramp", "toilet_difabel", "guiding_block", "lift"]);
export const facilityAnswer = pgEnum("facility_answer", ["tersedia", "tidak_tersedia", "tidak_perlu", "belum_tahu"]);
// ADR-0022
export const unavailableReason = pgEnum("unavailable_reason", ["tidak_ada", "rusak", "terhalang", "terbatas", "tidak_sesuai"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

// Batas wilayah dibaca dan ditulis lewat fungsi PostGIS, bukan lewat Drizzle.
const multiPolygon = customType<{ data: string; driverData: string }>({
  dataType: () => "geometry(MultiPolygon, 4326)",
});

/** Kecamatan di Kota Bogor (ADR-0010). Batas diimpor terpisah; selama kosong, kecamatan diisi saat verifikasi. */
export const districts = pgTable("districts", {
  slug: varchar("slug", { length: 40 }).primaryKey(),
  name: varchar("name", { length: 60 }).notNull().unique(),
  city: varchar("city", { length: 60 }).notNull().default("Kota Bogor"),
  boundary: multiPolygon("boundary"),
});

/** Lokasi yang sudah terbit. Status dan ringkasan disimpan untuk filter dan dihitung ulang setiap jawaban berubah. */
export const places = pgTable(
  "places",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 120 }).notNull(),
    category: placeCategory("category").notNull(),
    districtSlug: varchar("district_slug", { length: 40 }).notNull().references(() => districts.slug),
    location: geometry("location", { type: "point", mode: "xy", srid: 4326 }).notNull(),
    landmark: varchar("landmark", { length: 140 }),
    description: text("description"),
    status: placeStatus("status").notNull(),
    facilitiesAvailable: smallint("facilities_available").notNull(),
    facilitiesRelevant: smallint("facilities_relevant").notNull(),
    facilitiesUnknown: smallint("facilities_unknown").notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("places_location_idx").using("gist", t.location),
    index("places_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    index("places_category_idx").on(t.category),
    index("places_status_idx").on(t.status),
    index("places_district_idx").on(t.districtSlug),
  ],
);

/** Satu baris per fasilitas per lokasi (ADR-0017), dengan alasan dan catatan (ADR-0022). */
export const placeFacilities = pgTable(
  "place_facilities",
  {
    placeId: uuid("place_id").notNull().references(() => places.id, { onDelete: "cascade" }),
    facility: facilityKind("facility").notNull(),
    answer: facilityAnswer("answer").notNull(),
    reason: unavailableReason("reason"),
    note: varchar("note", { length: 200 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.placeId, t.facility] }),
    check("place_facilities_reason_only_when_unavailable", sql`${t.reason} IS NULL OR ${t.answer} = 'tidak_tersedia'`),
  ],
);
