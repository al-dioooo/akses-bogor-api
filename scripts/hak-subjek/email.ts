// Mematikan atau menyalakan email status laporan untuk satu akun, atas permintaan pembatasan pemrosesan. Kode masuk tetap
// dikirim. Runbook: operations/permintaan-subjek-data.md di akses-bogor-docs.
//
//   pnpm hak-subjek:email --akun <email|id> --permintaan <nomor> --oleh <email admin> --mati
//   pnpm hak-subjek:email --akun <email|id> --permintaan <nomor> --oleh <email admin> --nyala
import { parseArgs } from "node:util";
import { requestNumber, runScript, usage } from "../../src/data-subject/cli.js";
import { setReportEmails } from "../../src/data-subject/report-emails.js";
import { findAccount, findHandler, openRequestFor } from "../../src/data-subject/requests.js";

const USAGE = "  pnpm hak-subjek:email --akun <email|id> --permintaan <nomor> --oleh <email admin> (--mati | --nyala)";
const { values } = parseArgs({ options: { akun: { type: "string" }, permintaan: { type: "string" }, oleh: { type: "string" }, mati: { type: "boolean" }, nyala: { type: "boolean" } } });
if (!values.akun || !values.oleh || Boolean(values.mati) === Boolean(values.nyala)) usage(USAGE);
const requestId = requestNumber(values.permintaan, USAGE);
const enabled = Boolean(values.nyala);

await runScript(async (db, now) => {
  const handler = await findHandler(db, values.oleh!);
  const account = await findAccount(db, values.akun!);
  await openRequestFor(db, requestId, account.id, ["pembatasan"]);
  const { changed, dropped } = await setReportEmails(db, { userId: account.id, enabled, requestId, handler, now });
  const state = enabled ? "menyala" : "mati";
  if (!changed) return console.log(`Email status laporan akun ${account.id} sudah ${state}; tidak ada yang diubah.`);
  console.log(`Email status laporan akun ${account.id} sekarang ${state} untuk permintaan #${requestId}.${enabled ? "" : ` ${dropped} email yang antre dibuang.`}`);
  if (!enabled) console.log("Pertanyaan klarifikasi tetap muncul di Akun saya, tetapi pelapor tidak lagi diberi tahu lewat email.");
});
