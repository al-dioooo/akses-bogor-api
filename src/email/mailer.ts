import { CODE_TTL_MINUTES } from "../auth/rules.js";

export type Email = { to: string; subject: string; text: string; html: string };

/** Mengirim satu email. Melempar galat bila gagal, supaya route bisa menjawab 502. */
export type Mailer = (email: Email) => Promise<void>;

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

/** Teks biasa menjadi HTML sederhana: satu paragraf per blok, tanpa gambar atau tautan pelacak (ADR-0030). */
function html(paragraphs: string[]) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escape(p)}</p>`).join("");
  return `<!doctype html><html lang="id"><body style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#12131a">${body}</body></html>`;
}

export function email(to: string, subject: string, paragraphs: string[]): Email {
  return { to, subject, text: paragraphs.join("\n\n"), html: html(paragraphs) };
}

/** Kode masuk 6 digit. Kode ada di subjek supaya terbaca dari notifikasi (ADR-0030). */
export const codeEmail = (to: string, code: string) =>
  email(to, `Kode masuk AksesBogor: ${code}`, [
    `Kode masuk AksesBogor Anda: ${code}`,
    `Kode ini berlaku ${CODE_TTL_MINUTES} menit dan hanya bisa dipakai sekali. Jangan berikan kode ini kepada siapa pun.`,
    "Bila Anda tidak sedang masuk ke AksesBogor, abaikan email ini. Akun Anda tetap aman.",
  ]);

/** Konfirmasi terakhir setelah akun dihapus (ADR-0024). */
export const accountDeletedEmail = (to: string) =>
  email(to, "Akun AksesBogor Anda sudah dihapus", [
    "Akun AksesBogor Anda sudah dihapus. Nama, email, dan laporan yang belum terbit sudah kami hapus, dan semua sesi masuk sudah berakhir.",
    "Informasi tempat dan foto yang sudah terbit tetap tayang tanpa nama Anda. Salinan di cadangan database hilang paling lama 30 hari lagi.",
    "Email ini yang terakhir dari kami. Bila Anda ingin melapor lagi, masuk dengan email ini akan membuat akun baru yang kosong.",
  ]);

/** Resend lewat HTTP API, tanpa SDK (ADR-0030). */
export function resendMailer({ apiKey, from, fetch = globalThis.fetch }: { apiKey: string; from: string; fetch?: typeof globalThis.fetch }): Mailer {
  return async ({ to, subject, text, html }) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Resend menjawab ${response.status}`);
  };
}

/** Pengembangan lokal: email tidak dikirim, isinya dicetak ke log supaya kode bisa dipakai (ADR-0030). */
export function logMailer(log: (message: string) => void): Mailer {
  return async ({ to, subject, text }) => {
    log(`[email pengembangan, tidak dikirim] ke ${to}\n${subject}\n\n${text}`);
  };
}
