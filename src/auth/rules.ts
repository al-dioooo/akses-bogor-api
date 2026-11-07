// Aturan akun dari ADR-0014 dan ADR-0029, dipakai Better Auth, route, dan isi email.

/** Masa berlaku kode masuk. */
export const CODE_TTL_MINUTES = 10;
/** Kode gugur setelah percobaan salah sebanyak ini. */
export const CODE_ATTEMPTS = 5;
/** Kode baru untuk email yang sama baru bisa diminta setelah jeda ini. */
export const CODE_RESEND_SECONDS = 60;
/** Paling banyak kode per email per jam. */
export const CODES_PER_EMAIL_PER_HOUR = 5;

/** Sesi berakhir setelah tidak dipakai selama ini. */
export const SESSION_IDLE_DAYS = 30;
/** Sesi berakhir paling lama setelah ini sejak masuk, walaupun terus dipakai. */
export const SESSION_MAX_DAYS = 90;
/** Akun yang tidak dilengkapi (nama dan persetujuan) dihapus setelah ini. */
export const INCOMPLETE_ACCOUNT_HOURS = 24;

/** Versi Kebijakan Privasi saat ini (akses-bogor-docs, product/kebijakan-privasi.md). Naik setiap isinya berubah. */
export const PRIVACY_POLICY_VERSION = "2026-11-07";
