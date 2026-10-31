import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { placeFacilities, places } from "../db/schema.js";
import { computeStatus, type StatusResult } from "./status.js";

/** Menghitung ulang status dan ringkasan yang disimpan di `places` dari jawaban fasilitasnya (ADR-0018). */
export async function refreshPlaceStatus(db: Db, placeId: string): Promise<StatusResult> {
  const answers = await db
    .select({ facility: placeFacilities.facility, answer: placeFacilities.answer, reason: placeFacilities.reason })
    .from(placeFacilities)
    .where(eq(placeFacilities.placeId, placeId));
  const result = computeStatus(answers);
  await db
    .update(places)
    .set({
      status: result.status,
      facilitiesAvailable: result.available,
      facilitiesRelevant: result.relevant,
      facilitiesUnknown: result.unknown,
      updatedAt: new Date(),
    })
    .where(eq(places.id, placeId));
  return result;
}
