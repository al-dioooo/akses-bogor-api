// Mengganti email akun atas permintaan perbaikan data. Tautan Google dilepas, semua sesi diakhiri, dan pemilik masuk lagi
// dengan kode ke email baru. Runbook: operations/permintaan-subjek-data.md di akses-bogor-docs.
//
//   pnpm hak-subjek:ganti-email --akun <email lama|id> --email-baru <email> --permintaan <nomor> --oleh <email admin>
import { parseArgs } from "node:util";
import { changeEmail } from "../../src/data-subject/change-email.js";
import { requestNumber, runScript, usage } from "../../src/data-subject/cli.js";
import { findAccount, findHandler, openRequestFor } from "../../src/data-subject/requests.js";

const USAGE = "  pnpm hak-subjek:ganti-email --akun <email lama|id> --email-baru <email> --permintaan <nomor> --oleh <email admin>";
const { values } = parseArgs({ options: { akun: { type: "string" }, "email-baru": { type: "string" }, permintaan: { type: "string" }, oleh: { type: "string" } } });
if (!values.akun || !values["email-baru"] || !values.oleh) usage(USAGE);
const requestId = requestNumber(values.permintaan, USAGE);

await runScript(async (db, now) => {
  const handler = await findHandler(db, values.oleh!);
  const account = await findAccount(db, values.akun!);
  await openRequestFor(db, requestId, account.id, ["perbaikan"]);
  const { sessions, links } = await changeEmail(db, { userId: account.id, newEmail: values["email-baru"]!, requestId, handler, now });
  console.log(`Email akun ${account.id} sudah diganti untuk permintaan #${requestId}: ${sessions} sesi diakhiri, ${links} tautan Google dilepas.`);
  console.log("Pemilik akun perlu masuk lagi dengan kode yang dikirim ke email baru.");
});
