// Skema Drizzle untuk model data PRD bagian 9. Nama tabel dan kolom dalam bahasa Inggris; nilai enum
// memakai istilah produk (ADR di akses-bogor-docs) supaya sama dengan yang dibaca tim dan pengguna.
import { sql } from "drizzle-orm";
import { bigserial, boolean, check, customType, geometry, index, integer, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

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
// ADR-0039
export const reportEmailKind = pgEnum("report_email_kind", ["diterbitkan", "ditolak", "klarifikasi"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

// Batas wilayah dibaca dan ditulis lewat fungsi PostGIS, bukan lewat Drizzle.
const multiPolygon = customType<{ data: string; driverData: string }>({
  dataType: () => "geometry(MultiPolygon, 4326)",
});

/**
 * Kecamatan di Kota Bogor (ADR-0010). Batasnya dari OpenStreetMap dan diisi migrasi 0004 (ADR-0034); kecamatan laporan
 * dihitung dari batas ini dan titik di luar semua batas ditolak (FR-22).
 */
export const districts = pgTable(
  "districts",
  {
    slug: varchar("slug", { length: 40 }).primaryKey(),
    name: varchar("name", { length: 60 }).notNull().unique(),
    city: varchar("city", { length: 60 }).notNull().default("Kota Bogor"),
    boundary: multiPolygon("boundary"),
  },
  (t) => [index("districts_boundary_idx").using("gist", t.boundary)],
);

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

/**
 * Akun dibuat saat login pertama (ADR-0014) dan juga tabel pengguna Better Auth (ADR-0029). Email disimpan huruf
 * kecil. Nama tampilan kosong dan `privacyConsentAt` null sampai pengguna mengisi Lengkapi Akun. `image` wajib ada
 * untuk Better Auth, tetapi selalu kosong karena foto profil Google tidak disimpan.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: varchar("display_name", { length: 60 }).notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    role: userRole("role").notNull().default("pengguna"),
    privacyConsentAt: timestamp("privacy_consent_at", { withTimezone: true }),
    /** Versi Kebijakan Privasi yang disetujui, mis. "2026-11-07". */
    privacyPolicyVersion: varchar("privacy_policy_version", { length: 20 }),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_idx").on(sql`lower(${t.email})`)],
);

/**
 * Sesi Better Auth. `token` dikirim ke web bersama tanda tangan HMAC; tanpa tanda tangan itu token di tabel ini tidak
 * bisa dipakai (ADR-0029). `ipAddress` dan `userAgent` wajib ada untuk Better Auth, tetapi selalu kosong.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Tautan akun ke penyedia login, mis. Google (`accountId` = `sub` Google). Kolom token dan kata sandi wajib ada untuk
 * Better Auth, tetapi selalu kosong: token Google dibuang sebelum disimpan dan tidak ada login dengan kata sandi.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: varchar("provider_id", { length: 40 }).notNull(),
    accountId: varchar("account_id", { length: 255 }).notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [uniqueIndex("accounts_provider_account_idx").on(t.providerId, t.accountId), index("accounts_user_idx").on(t.userId)],
);

/** Kode email sekali pakai milik Better Auth. `value` berisi HMAC kode dan jumlah percobaan, bukan kodenya. */
export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: varchar("identifier", { length: 320 }).notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
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
    /** Kecamatan yang dihitung API dari `location` saat laporan dikirim (FR-22). */
    districtSlug: varchar("district_slug", { length: 40 }).references(() => districts.slug),
    /** Kunci acak dari draf di browser; kirim ulang dengan kunci yang sama mengembalikan laporan yang sudah ada (ADR-0033). */
    submissionKey: uuid("submission_key"),
    rejectionReason: rejectionReason("rejection_reason"),
    clarificationQuestion: text("clarification_question"),
    clarificationDueAt: timestamp("clarification_due_at", { withTimezone: true }),
    reviewerId: uuid("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    /** Catatan internal verifikator; tidak pernah dikirim ke pelapor atau tayang (ADR-0036). */
    reviewerNote: varchar("reviewer_note", { length: 1000 }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("reports_queue_idx").on(t.status, t.submittedAt),
    index("reports_reporter_idx").on(t.reporterId),
    index("reports_place_idx").on(t.placeId),
    uniqueIndex("reports_submission_key_idx").on(t.reporterId, t.submissionKey),
    check("reports_rejection_reason_matches_status", sql`(${t.status} = 'ditolak') = (${t.rejectionReason} IS NOT NULL)`),
    check("reports_existing_place_for_changes", sql`${t.kind} = 'baru' OR ${t.placeId} IS NOT NULL OR ${t.status} = 'ditolak'`),
  ],
);

/**
 * Pertanyaan klarifikasi verifikator dan jawaban pelapor, berurutan (ADR-0036). Setiap pertanyaan punya tenggat 7 hari
 * sendiri; jawaban hanya bisa dikirim sekali. Ikut terhapus bersama laporannya.
 */
export const reportClarifications = pgTable(
  "report_clarifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    question: varchar("question", { length: 1000 }).notNull(),
    askedBy: uuid("asked_by").references(() => users.id, { onDelete: "set null" }),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    answer: varchar("answer", { length: 1000 }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [
    index("report_clarifications_report_idx").on(t.reportId, t.askedAt),
    check("report_clarifications_answer_with_time", sql`(${t.answer} IS NULL) = (${t.answeredAt} IS NULL)`),
  ],
);

/** Area yang dikaburkan, dalam pecahan 0 sampai 1 dari lebar dan tinggi foto (ADR-0037). */
export type BlurRegion = { x: number; y: number; w: number; h: number };

/**
 * Foto laporan (ADR-0023, ADR-0031). Foto yang baru diunggah belum punya laporan dan dicatat pengunggahnya; saat laporan
 * dikirim, foto dipasang ke laporan dan pengunggahnya dikosongkan, jadi tepat satu dari keduanya terisi. `placeId` diisi
 * saat laporan terbit; hanya foto `tayang` yang tampil di Detail.
 */
export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id").references(() => reports.id, { onDelete: "cascade" }),
    uploaderId: uuid("uploader_id").references(() => users.id, { onDelete: "cascade" }),
    placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),
    storageKey: varchar("storage_key", { length: 200 }).notNull().unique(),
    tag: photoTag("tag").notNull().default("lainnya"),
    altText: varchar("alt_text", { length: 200 }).notNull(),
    caption: varchar("caption", { length: 200 }),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    moderation: photoModeration("moderation").notNull().default("menunggu"),
    /** Area yang dikaburkan API saat terbit (ADR-0037). Kosong berarti tidak ada. */
    blurRegions: jsonb("blur_regions").$type<BlurRegion[]>(),
    /** Klarifikasi yang jawabannya membawa foto ini; kosong untuk foto dari laporan awal (ADR-0036). */
    clarificationId: uuid("clarification_id").references(() => reportClarifications.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("photos_place_idx").on(t.placeId),
    index("photos_report_idx").on(t.reportId),
    index("photos_uploader_idx").on(t.uploaderId),
    check("photos_report_or_uploader", sql`(${t.reportId} IS NULL) = (${t.uploaderId} IS NOT NULL)`),
  ],
);

/**
 * Berkas foto di R2 yang harus dihapus, mis. foto laporan yang belum terbit milik akun yang dihapus (ADR-0024). Baris
 * foto dihapus di transaksi yang sama; berkasnya dihapus dari R2 oleh kode foto (Laporkan), lalu barisnya dibuang.
 */
export const photoDeletions = pgTable("photo_deletions", {
  storageKey: varchar("storage_key", { length: 200 }).primaryKey(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
});

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

/**
 * Email status laporan yang menunggu dikirim (ADR-0039). Hanya id laporan dan jenis email; alamat dan isi dibaca saat
 * mengirim. Baris dihapus setelah terkirim, atau setelah 3 hari gagal.
 */
export const reportEmails = pgTable(
  "report_emails",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    kind: reportEmailKind("kind").notNull(),
    attempts: smallint("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("report_emails_report_kind_idx").on(t.reportId, t.kind), index("report_emails_next_idx").on(t.nextAttemptAt)],
);
