// Email status laporan (FR-40, FR-41, ADR-0039): teks biasa dan HTML sederhana, tanpa nama verifikator, nama pelapor,
// atau catatan internal. Pesan penolakan sama dengan pesan baku di Panduan Verifikasi bagian 6.3.
import type { rejectionReason } from "../db/schema.js";
import { email } from "./mailer.js";

type Reason = (typeof rejectionReason.enumValues)[number];

export const REJECTION: Record<Reason, { label: string; message: string }> = {
  di_luar_kota_bogor: {
    label: "Di luar Kota Bogor",
    message: "Saat ini AksesBogor hanya mencakup Kota Bogor, jadi laporan ini belum bisa kami terbitkan. Terima kasih sudah berkontribusi.",
  },
  duplikat: {
    label: "Duplikat",
    message: "Tempat ini sudah ada di AksesBogor. Bila ada informasi baru, gunakan \"Laporkan kekurangan\" di halaman tempat tersebut.",
  },
  bukti_tidak_cukup: {
    label: "Bukti tidak cukup",
    message: "Kami belum bisa memastikan kondisi tempat ini dari foto yang ada. Anda bisa mengirim ulang dengan foto pintu masuk dan fasilitasnya.",
  },
  bukan_fasilitas_publik: {
    label: "Bukan fasilitas publik",
    message: "Untuk saat ini AksesBogor hanya mencatat kampus, masjid, halte, dan rumah sakit.",
  },
  konten_tidak_pantas: {
    label: "Konten tidak pantas",
    message: "Laporan ini tidak sesuai dengan ketentuan AksesBogor.",
  },
  tidak_ada_klarifikasi: {
    label: "Tidak ada klarifikasi",
    message: "Kami belum menerima jawaban atas pertanyaan kami, jadi laporan ini ditutup. Anda bisa mengirim laporan baru kapan saja.",
  },
};

const deadline = new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Jakarta" });
/** Tenggat dalam WIB, mis. "15 November 2026 pukul 10.00 WIB". */
export const formatDeadline = (date: Date) => `${deadline.format(date)} WIB`;

const base = (webUrl: string) => webUrl.replace(/\/+$/, "");

export const reportPublishedEmail = (to: string, input: { placeName: string; placeId: string; webUrl: string }) =>
  email(to, `Laporan Anda sudah terbit: ${input.placeName}`, [
    `Terima kasih. Laporan Anda tentang ${input.placeName} sudah diperiksa verifikator dan sekarang tampil di AksesBogor.`,
    `Lihat halamannya: ${base(input.webUrl)}/lokasi/${input.placeId}`,
    `Status laporan Anda yang lain ada di Akun saya: ${base(input.webUrl)}/akun`,
  ]);

export const reportRejectedEmail = (to: string, input: { placeName: string; reason: Reason; webUrl: string }) =>
  email(to, `Laporan Anda belum bisa diterbitkan: ${input.placeName}`, [
    `Laporan Anda tentang ${input.placeName} sudah diperiksa dan belum bisa diterbitkan.`,
    `Alasan: ${REJECTION[input.reason].label}. ${REJECTION[input.reason].message}`,
    `Laporan ini tetap tercatat di Akun saya: ${base(input.webUrl)}/akun`,
  ]);

export const clarificationEmail = (to: string, input: { placeName: string; reportId: string; question: string; dueAt: Date; webUrl: string }) =>
  email(to, `Pertanyaan tentang laporan Anda: ${input.placeName}`, [
    `Verifikator AksesBogor punya pertanyaan tentang laporan Anda untuk ${input.placeName}:`,
    input.question,
    `Jawab paling lambat ${formatDeadline(input.dueAt)} di ${base(input.webUrl)}/akun/laporan/${input.reportId}. Anda juga bisa menambahkan foto di sana.`,
    "Bila belum dijawab sampai batas itu, laporan ini ditutup. Anda tetap bisa mengirim laporan baru kapan saja.",
  ]);
