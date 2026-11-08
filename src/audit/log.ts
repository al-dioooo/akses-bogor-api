// Log audit perubahan data (FR-35, ADR-0038). Baris ditulis di transaksi yang sama dengan perubahannya. `changes` tidak
// boleh berisi email, nama pelapor, teks klarifikasi, atau catatan internal.
import type { Db } from "../db/client.js";
import { auditLog } from "../db/schema.js";

export type AuditEntity = "lokasi" | "laporan" | "foto" | "pengguna";

/** Akun yang bertindak, atau label untuk tindakan tanpa akun (`sistem` untuk tugas berkala, `skrip` untuk `pnpm peran`). */
export type Actor = { userId: string } | { label: "sistem" | "skrip" };

export type AuditEntry = {
  entity: AuditEntity;
  entityId: string;
  actor: Actor;
  action: string;
  changes?: Record<string, unknown> | null;
  at: Date;
};

export async function audit(db: Db, ...entries: AuditEntry[]) {
  if (entries.length === 0) return;
  await db.insert(auditLog).values(
    entries.map((e) => ({
      entityType: e.entity,
      entityId: e.entityId,
      actorId: "userId" in e.actor ? e.actor.userId : null,
      actorLabel: "label" in e.actor ? e.actor.label : null,
      action: e.action,
      changes: e.changes ?? null,
      createdAt: e.at,
    })),
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Kolom yang nilainya berbeda, sebagai `{ kolom: { sebelum, sesudah } }`. Kosong bila tidak ada yang berubah. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown>) {
  const changes: Record<string, { sebelum: unknown; sesudah: unknown }> = {};
  for (const key of Object.keys(after)) {
    const previous = before?.[key] ?? null;
    if (!same(previous, after[key])) changes[key] = { sebelum: previous, sesudah: after[key] ?? null };
  }
  return changes;
}
