// Menghapus akun atas permintaan penghapusan atau penarikan persetujuan lewat email kontak. Sama dengan Hapus akun di
// Akun Saya, tanpa email konfirmasi otomatis. Runbook: operations/permintaan-subjek-data.md di akses-bogor-docs.
//
//   pnpm hak-subjek:hapus --akun <email|id> --permintaan <nomor> --oleh <email admin>
import { parseArgs } from "node:util";
import { requestNumber, runScript, usage } from "../../src/data-subject/cli.js";
import { deleteAccountOnRequest } from "../../src/data-subject/delete.js";
import { findAccount, findHandler, openRequestFor } from "../../src/data-subject/requests.js";

const USAGE = "  pnpm hak-subjek:hapus --akun <email|id> --permintaan <nomor> --oleh <email admin>";
const { values } = parseArgs({ options: { akun: { type: "string" }, permintaan: { type: "string" }, oleh: { type: "string" } } });
if (!values.akun || !values.oleh) usage(USAGE);
const requestId = requestNumber(values.permintaan, USAGE);

await runScript(async (db, now) => {
  const handler = await findHandler(db, values.oleh!);
  const account = await findAccount(db, values.akun!);
  await openRequestFor(db, requestId, account.id, ["penghapusan"]);
  await deleteAccountOnRequest(db, { userId: account.id, requestId, handler, now });
  console.log(`Akun ${account.id} sudah dihapus untuk permintaan #${requestId}. Berkas fotonya dihapus dari R2 oleh pembersihan berkala dalam satu jam.`);
  console.log("Kirim balasan \"akun dihapus\" dari kotak kontak sebagai konfirmasi, lalu tutup permintaannya.");
});
