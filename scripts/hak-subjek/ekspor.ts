// Salinan semua data akun dalam satu berkas JSON bermode 600, untuk permintaan salinan data (hak akses dan portabilitas).
// Dikirim sebagai lampiran balasan ke email akun itu sendiri, lalu berkasnya dihapus. Runbook:
// operations/permintaan-subjek-data.md di akses-bogor-docs.
//
//   pnpm hak-subjek:ekspor --akun <email|id> --permintaan <nomor> --oleh <email admin> --keluar <berkas.json>
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { requestNumber, runScript, usage } from "../../src/data-subject/cli.js";
import { exportAccount, writeExportFile } from "../../src/data-subject/export.js";
import { findAccount, findHandler, openRequestFor } from "../../src/data-subject/requests.js";

const USAGE = "  pnpm hak-subjek:ekspor --akun <email|id> --permintaan <nomor> --oleh <email admin> --keluar <berkas.json>";
const { values } = parseArgs({ options: { akun: { type: "string" }, permintaan: { type: "string" }, oleh: { type: "string" }, keluar: { type: "string" } } });
if (!values.akun || !values.oleh || !values.keluar) usage(USAGE);
const requestId = requestNumber(values.permintaan, USAGE);
const path = resolve(values.keluar);

await runScript(async (db, now) => {
  const handler = await findHandler(db, values.oleh!);
  const account = await findAccount(db, values.akun!);
  await openRequestFor(db, requestId, account.id, ["salinan"]);
  const data = await writeExportFile(path, () => exportAccount(db, { userId: account.id, requestId, handler, now }));
  const photos = data.laporan.reduce((n, r) => n + r.photos.length, 0) + data.fotoBelumDipasang.length;
  const clarifications = data.laporan.reduce((n, r) => n + r.clarifications.length, 0);
  console.log(`Salinan data akun ${account.id} untuk permintaan #${requestId} ditulis ke ${path} (mode 600).`);
  console.log(`${data.laporan.length} laporan, ${photos} foto, ${clarifications} klarifikasi, ${data.sesi.length} sesi, ${data.logAudit.length} entri log audit.`);
  console.log("Kirim sebagai lampiran balasan ke email akun itu, lalu hapus berkasnya.");
});
