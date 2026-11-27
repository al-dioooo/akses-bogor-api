// Menahan atau melepas laporan akun yang belum diputuskan, atas permintaan pembatasan pemrosesan. Laporan yang ditahan
// tidak muncul di antrean verifikator dan tidak ditolak otomatis. Runbook: operations/permintaan-subjek-data.md di
// akses-bogor-docs.
//
//   pnpm hak-subjek:tahan --akun <email|id> --permintaan <nomor> --oleh <email admin> --alasan "<alasan tanpa data pribadi>"
//   pnpm hak-subjek:tahan --akun <email|id> --permintaan <nomor> --oleh <email admin> --lepas
import { parseArgs } from "node:util";
import { requestNumber, runScript, usage } from "../../src/data-subject/cli.js";
import { holdReports, releaseReports } from "../../src/data-subject/hold.js";
import { findAccount, findHandler, openRequestFor } from "../../src/data-subject/requests.js";

const USAGE = `  pnpm hak-subjek:tahan --akun <email|id> --permintaan <nomor> --oleh <email admin> --alasan "<alasan>"
  pnpm hak-subjek:tahan --akun <email|id> --permintaan <nomor> --oleh <email admin> --lepas`;
const { values } = parseArgs({ options: { akun: { type: "string" }, permintaan: { type: "string" }, oleh: { type: "string" }, alasan: { type: "string" }, lepas: { type: "boolean" } } });
if (!values.akun || !values.oleh || values.lepas === (values.alasan !== undefined)) usage(USAGE);
const requestId = requestNumber(values.permintaan, USAGE);

await runScript(async (db, now) => {
  const handler = await findHandler(db, values.oleh!);
  const account = await findAccount(db, values.akun!);
  await openRequestFor(db, requestId, account.id, ["pembatasan"]);
  if (values.lepas) {
    const { released } = await releaseReports(db, { userId: account.id, requestId, handler, now });
    console.log(`${released} laporan akun ${account.id} dilepas untuk permintaan #${requestId}; tenggat klarifikasinya diperpanjang selama masa tahan.`);
  } else {
    const { held } = await holdReports(db, { userId: account.id, requestId, handler, now, reason: values.alasan! });
    console.log(`${held} laporan akun ${account.id} ditahan untuk permintaan #${requestId}.`);
    if (held === 0) console.log("Tidak ada laporan yang belum diputuskan dan belum ditahan.");
  }
});
