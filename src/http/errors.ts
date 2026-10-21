import { z } from "zod";

/** Galat yang sengaja dikirim ke klien: kode snake_case yang stabil dan pesan untuk pengguna. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Bentuk semua respons galat, dipakai di skema response setiap route. */
export const errorSchema = z
  .object({
    galat: z.string().describe("Kode galat snake_case yang stabil"),
    pesan: z.string().describe("Pesan singkat untuk pengguna, dalam bahasa Indonesia"),
  })
  .describe("Galat");
