// Mengganti peran akun dari server, mis. membuat admin pertama (ADR-0035). Tidak ada route API yang bisa membuat admin.
//
//   pnpm peran --email <email> --peran <admin|verifikator|pengguna>
//
// Di Evergarden dijalankan sebagai user aksesbogor dengan berkas environment produksi; lihat README bagian Peran.
import { parseArgs } from "node:util";
import { setRoleByEmail, type Role } from "../src/admin/roles.js";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { HttpError } from "../src/http/errors.js";

const ROLES = ["admin", "verifikator", "pengguna"] as const satisfies readonly Role[];

const { values } = parseArgs({ options: { email: { type: "string" }, peran: { type: "string" } } });
const role = ROLES.find((r) => r === values.peran);
if (!values.email || !role) {
  console.error("Pakai: pnpm peran --email <email> --peran <admin|verifikator|pengguna>");
  process.exit(2);
}

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
try {
  const { member, before } = await setRoleByEmail(db, values.email, role, { label: "skrip" }, new Date());
  console.log(before === role ? `${member.displayName} sudah ${role}; tidak ada yang diubah.` : `${member.displayName}: ${before} → ${role}.`);
} catch (error) {
  console.error(error instanceof HttpError ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
