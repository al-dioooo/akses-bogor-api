// Skema Drizzle untuk model data PRD bagian 9. Nama tabel dan kolom dalam bahasa Inggris; nilai enum
// memakai istilah produk (ADR di akses-bogor-docs) supaya sama dengan yang dibaca tim dan pengguna.
import { sql } from "drizzle-orm";
import { bigserial, check, customType, geometry, index, integer, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

// ADR-0004
export const placeCategory = pgEnum("place_category", ["kampus", "masjid", "halte", "rumah_sakit"]);
// ADR-0018
export const placeStatus = pgEnum("place_status", ["aksesibel", "sebagian", "tidak_aksesibel", "belum_diketahui"]);
// ADR-0017
export const facilityKind = pgEnum("facility_kind", ["ramp", "toilet_difabel", "guiding_block", "lift"]);
export const facilityAnswer = pgEnum("facility_answer", ["tersedia", "tidak_tersedia", "tidak_perlu", "belum_tahu"]);
// ADR-0022
export const unavailableReason = pgEnum("unavailable_reason", ["tidak_ada", "rusak", "terhalang", "terbatas", "tidak_sesuai"]);
export const userRole = pgEnum("user_role", ["pengguna", "verifikator", "admin"]);
// ADR-0006, ADR-0019
export const reportKind = pgEnum("report_kind", ["baru", "perubahan", "kekurangan"]);
export const reportStatus = pgEnum("report_status", ["menunggu", "klarifikasi", "diterbitkan", "ditolak"]);
// Alasan baku R1 sampai R6 di Panduan Verifikasi
export const rejectionReason = pgEnum("rejection_reason", [
  "di_luar_kota_bogor",
  "duplikat",
  "bukti_tidak_cukup",
  "bukan_fasilitas_publik",
  "konten_tidak_pantas",
  "tidak_ada_klarifikasi",
]);
// ADR-0023
export const photoTag = pgEnum("photo_tag", ["pintu_masuk", "toilet_difabel", "guiding_block", "lift", "lainnya"]);
export const photoModeration = pgEnum("photo_moderation", ["menunggu", "tayang", "disembunyikan"]);

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

/** Akun dibuat saat login pertama (ADR-0014). Email disimpan huruf kecil. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: varchar("display_name", { length: 60 }).notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    role: userRole("role").notNull().default("pengguna"),
    privacyConsentAt: timestamp("privacy_consent_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_idx").on(sql`lower(${t.email})`)],
);

/**
 * Laporan baru, perubahan, atau kekurangan. Isian disimpan apa adanya di `submission`; data lokasi baru berubah
 * saat laporan diterbitkan. Pelapor dikosongkan bila akunnya dihapus (ADR-0024).
 */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: uuid("reporter_id").references(() => users.id, { onDelete: "set null" }),
    kind: reportKind("kind").notNull(),
    placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),
    status: reportStatus("status").notNull().default("menunggu"),
    submission: jsonb("submission").notNull(),
    location: geometry("location", { type: "point", mode: "xy", srid: 4326 }),
    rejectionReason: rejectionReason("rejection_reason"),
    clarificationQuestion: text("clarification_question"),
    clarificationDueAt: timestamp("clarification_due_at", { withTimezone: true }),
    reviewerId: uuid("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("reports_queue_idx").on(t.status, t.submittedAt),
    index("reports_reporter_idx").on(t.reporterId),
    index("reports_place_idx").on(t.placeId),
    check("reports_rejection_reason_matches_status", sql`(${t.status} = 'ditolak') = (${t.rejectionReason} IS NOT NULL)`),
    check("reports_existing_place_for_changes", sql`${t.kind} = 'baru' OR ${t.placeId} IS NOT NULL OR ${t.status} = 'ditolak'`),
  ],
);

/** Foto laporan (ADR-0023). `placeId` diisi saat laporan terbit; hanya foto `tayang` yang tampil di Detail. */
export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),
    storageKey: varchar("storage_key", { length: 200 }).notNull().unique(),
    tag: photoTag("tag").notNull().default("lainnya"),
    altText: varchar("alt_text", { length: 200 }).notNull(),
    caption: varchar("caption", { length: 200 }),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    moderation: photoModeration("moderation").notNull().default("menunggu"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("photos_place_idx").on(t.placeId), index("photos_report_idx").on(t.reportId)],
);

/**
 * Log audit perubahan data (FR-35). `actorId` kosong dengan `actorLabel` "sistem" untuk tindakan otomatis
 * (mis. penolakan R6); kosong tanpa label berarti akunnya sudah dihapus (ADR-0024).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityType: varchar("entity_type", { length: 20 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: varchar("actor_label", { length: 40 }),
    action: varchar("action", { length: 40 }).notNull(),
    changes: jsonb("changes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_entity_idx").on(t.entityType, t.entityId)],
);
