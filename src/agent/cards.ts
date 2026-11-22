// Kartu dinamis agen untuk kontributor (ADR-0043). Model memanggil alat kartu dan hanya menerima konfirmasi singkat;
// isi kartu (termasuk lokasi tempat) dikirim ke web lewat jawaban `POST /agent/ask`, tidak pernah ke model. Kartu rute
// hanya berisi tujuan: web menghitung rutenya sendiri dari posisi pengguna lewat `/route/walking`.
import { z } from "zod";
import { getOsmPlace } from "../contribute/facilities.js";
import { placeCategory, placeStatus } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { getPlace } from "../places/queries.js";
import type { ToolContext } from "./tools.js";

const district = z.object({ slug: z.string(), name: z.string() });
const aksesBogorTarget = z.object({ kind: z.literal("aksesbogor"), placeId: z.uuid() });
const osmTarget = z.object({ kind: z.literal("osm"), osmType: z.enum(["node", "way", "relation"]), osmId: z.number().int() });
export const cardTarget = z.discriminatedUnion("kind", [aksesBogorTarget, osmTarget]);
export type CardTarget = z.infer<typeof cardTarget>;

export const placeCardSchema = z.union([
  z.object({
    type: z.literal("tempat"),
    target: aksesBogorTarget,
    name: z.string(),
    category: z.enum(placeCategory.enumValues),
    district,
    status: z.enum(placeStatus.enumValues),
    lastVerifiedAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("tempat"),
    target: osmTarget,
    name: z.string().nullable(),
    category: z.enum(placeCategory.enumValues),
    district,
    location: z.object({ lat: z.number(), lng: z.number() }),
    osmUrl: z.url(),
    attribution: z.string(),
  }),
]);
export const routeCardSchema = z.object({ type: z.literal("rute"), target: cardTarget, name: z.string().nullable() });
export type PlaceCard = z.infer<typeof placeCardSchema>;
export type RouteCard = z.infer<typeof routeCardSchema>;

/** Input alat kartu: tepat salah satu dari `placeId` (lokasi AksesBogor) atau `osmType` + `osmId` (tempat OSM). */
export const cardInput = z
  .object({
    placeId: z.uuid().optional().describe("Id lokasi AksesBogor dari find_place"),
    osmType: z.enum(["node", "way", "relation"]).optional().describe("Dari `osm.osmType` hasil find_places_to_contribute"),
    osmId: z.number().int().optional().describe("Dari `osm.osmId` hasil find_places_to_contribute"),
  })
  .refine((v) => Boolean(v.placeId) !== (v.osmType !== undefined && v.osmId !== undefined), { message: "Isi placeId, atau osmType dan osmId" });

const notFound = () => new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi tidak ditemukan.");

/** Kartu tempat dari input alat kartu; melempar 404 bila tempatnya tidak ada. */
export async function placeCard(ctx: ToolContext, input: z.infer<typeof cardInput>): Promise<PlaceCard> {
  if (input.placeId) {
    const place = await getPlace(ctx.db, input.placeId, ctx.now());
    if (!place) throw notFound();
    return {
      type: "tempat",
      target: { kind: "aksesbogor", placeId: place.id },
      name: place.name,
      category: place.category,
      district: place.district,
      status: place.status,
      lastVerifiedAt: place.lastVerifiedAt,
    };
  }
  const place = await getOsmPlace(ctx.db, { osmType: input.osmType!, osmId: input.osmId! });
  if (!place) throw notFound();
  return {
    type: "tempat",
    target: { kind: "osm", osmType: input.osmType!, osmId: input.osmId! },
    name: place.name,
    category: place.category,
    district: place.district,
    location: place.location,
    osmUrl: place.osmUrl,
    attribution: place.attribution,
  };
}

const label = (card: PlaceCard) => card.name ?? `${card.category.replace("_", " ")} tanpa nama di ${card.district.name}`;

/** show_place_card: kartu tempat untuk web; model hanya menerima `pesan`. */
export async function showPlaceCard(ctx: ToolContext, input: z.infer<typeof cardInput>) {
  const kartu = await placeCard(ctx, input);
  return { pesan: `Kartu tempat ditampilkan untuk ${label(kartu)}.`, kartu };
}

/** show_route_card: kartu rute untuk web; rutenya dihitung web dari posisi pengguna, jadi model tidak menerimanya. */
export async function showRouteCard(ctx: ToolContext, input: z.infer<typeof cardInput>) {
  const place = await placeCard(ctx, input);
  const kartu: RouteCard = { type: "rute", target: place.target, name: place.name };
  return { pesan: `Kartu rute ditampilkan untuk ${label(place)}. Aplikasi menghitung rutenya dari posisi pengguna; Anda tidak menerima rute itu.`, kartu };
}
