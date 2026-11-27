// Mencatat permintaan hak subjek data yang masuk lewat email kontak, menutupnya, dan menampilkan yang masih terbuka
// beserta tenggat 3 × 24 jamnya. Runbook: operations/permintaan-subjek-data.md di akses-bogor-docs.
//
//   pnpm hak-subjek:catat --jenis <jenis> [--akun <email|id>] [--diterima "2026-11-27 09:15"] --oleh <email admin>
//   pnpm hak-subjek:catat --selesai <nomor> --oleh <email admin>
//   pnpm hak-subjek:catat --tolak <nomor> --alasan "<alasan>" --oleh <email admin>
//   pnpm hak-subjek:catat --daftar
//
// `--diterima` tanpa zona waktu dibaca sebagai WIB; bawaannya sekarang. Tanpa `--akun` bila pengirim tidak punya akun.
import { parseArgs } from "node:util";
import { usage, requestNumber, runScript } from "../../src/data-subject/cli.js";
import { closeRequest, findAccount, findHandler, listOpenRequests, parseReceivedAt, recordRequest, type RequestKind } from "../../src/data-subject/requests.js";
import { dataSubjectRequestKind } from "../../src/db/schema.js";
import { formatDeadline } from "../../src/email/report-status.js";

const KINDS = dataSubjectRequestKind.enumValues;
const USAGE = `  pnpm hak-subjek:catat --jenis <${KINDS.join("|")}> [--akun <email|id>] [--diterima "YYYY-MM-DD HH:MM"] --oleh <email admin>
  pnpm hak-subjek:catat --selesai <nomor> --oleh <email admin>
  pnpm hak-subjek:catat --tolak <nomor> --alasan "<alasan>" --oleh <email admin>
  pnpm hak-subjek:catat --daftar`;

const { values } = parseArgs({
  options: {
    jenis: { type: "string" },
    akun: { type: "string" },
    diterima: { type: "string" },
    oleh: { type: "string" },
    selesai: { type: "string" },
    tolak: { type: "string" },
    alasan: { type: "string" },
    daftar: { type: "boolean" },
  },
});

const closing = values.selesai ?? values.tolak;
const id = closing === undefined ? undefined : requestNumber(closing, USAGE);
const kind = KINDS.find((k) => k === values.jenis) as RequestKind | undefined;
if (!values.daftar && (!values.oleh || (id === undefined && !kind))) usage(USAGE);

await runScript(async (db, now) => {
  if (values.daftar) {
    const open = await listOpenRequests(db);
    if (open.length === 0) return console.log("Tidak ada permintaan terbuka.");
    for (const r of open) {
      const hours = Math.round((r.dueAt.getTime() - now.getTime()) / 3_600_000);
      const left = hours >= 0 ? `sisa ${hours} jam` : `LEWAT ${-hours} jam`;
      console.log(`#${r.id}\t${r.kind}\tditerima ${formatDeadline(r.receivedAt)}\ttenggat ${formatDeadline(r.dueAt)} (${left})\t${r.userId ? `akun ${r.userId}` : "tanpa akun"}`);
    }
    return;
  }
  const handler = await findHandler(db, values.oleh!);

  if (id !== undefined) {
    const outcome = values.selesai ? "selesai" : "ditolak";
    const { kind: closed, late } = await closeRequest(db, id, { outcome, note: values.alasan ?? null, handler, now });
    console.log(`Permintaan #${id} (${closed}) ${outcome}.${late ? " Melewati tenggat 3 × 24 jam." : ""}`);
    return;
  }

  const account = values.akun ? await findAccount(db, values.akun) : null;
  const receivedAt = values.diterima ? parseReceivedAt(values.diterima, now) : now;
  const recorded = await recordRequest(db, { kind: kind!, userId: account?.id ?? null, receivedAt, handler, now });
  console.log(`Permintaan #${recorded.id} (${kind}) dicatat${account ? ` untuk akun ${account.id}` : " tanpa akun"}. Tenggat: ${formatDeadline(recorded.dueAt)}.`);
});
