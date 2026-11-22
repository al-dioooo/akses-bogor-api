import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { knowledgePassages, knowledgeSources } from "../src/db/schema.js";
import { queryTerms, searchKnowledge } from "../src/knowledge/search.js";
import { insertPassages, replaceSource } from "../src/knowledge/store.js";
import { createTestDb } from "./helpers/db.js";

let db: Db;
let close: () => Promise<void>;

const retrievedAt = new Date("2026-11-16T03:00:00.000Z");
const uu = {
  id: "uu-8-2016",
  kind: "regulasi" as const,
  title: "UU No. 8 Tahun 2016 tentang Penyandang Disabilitas",
  url: "https://peraturan.go.id/files/uu8-2016bt.pdf",
  license: "Teks peraturan perundang-undangan, tidak dilindungi hak cipta (UU No. 28 Tahun 2014 Pasal 42)",
  retrievedAt,
};
const guide = {
  id: "aksesbogor-panduan-verifikasi",
  kind: "dokumen_aksesbogor" as const,
  title: "Panduan Verifikasi AksesBogor",
  url: "https://github.com/al-dioooo/akses-bogor-docs/blob/main/operations/panduan-verifikasi.md",
  license: "Dokumen tim AksesBogor",
  retrievedAt,
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await replaceSource(db, uu, (tx) =>
    insertPassages(tx, uu.id, [
      { citation: "UU No. 8 Tahun 2016, Pasal 18", heading: "Hak Aksesibilitas", body: "Hak Aksesibilitas untuk Penyandang Disabilitas meliputi hak mendapatkan Aksesibilitas untuk memanfaatkan fasilitas publik." },
      { citation: "UU No. 8 Tahun 2016, Pasal 98", heading: "Bangunan Gedung", body: "Bangunan gedung yang mudah diakses oleh Penyandang Disabilitas wajib menyediakan fasilitas dan Aksesibilitas." },
    ]),
  );
  await replaceSource(db, guide, (tx) =>
    insertPassages(tx, guide.id, [
      { citation: "Panduan Verifikasi, bagian 5.2", heading: "Foto ramp", body: "Foto ramp memperlihatkan seluruh ramp dari bawah, termasuk pegangan tangan dan kemiringan." },
      { citation: "Panduan Verifikasi, bagian 5.3", heading: "Guiding block", body: "Guiding block dinilai tersedia bila jalurnya menyambung dari trotoar sampai pintu masuk." },
    ]),
  );
}, 60_000);

afterAll(async () => {
  await close();
});

describe("queryTerms", () => {
  it("drops common words, punctuation, and duplicates", () => {
    expect(queryTerms("Bagaimana ramp yang baik untuk kursi roda? Ramp!")).toEqual(["ramp", "baik", "kursi", "roda"]);
  });

  it("keeps numbers so article numbers can match", () => {
    expect(queryTerms("pasal 18 UU 8/2016")).toEqual(["pasal", "18", "uu", "8", "2016"]);
  });

  it("returns nothing for a question made only of common words", () => {
    expect(queryTerms("apa itu yang di sana?")).toEqual(["sana"]);
    expect(queryTerms("apa itu yang")).toEqual([]);
  });
});

describe("searchKnowledge", () => {
  it("returns matching passages with source, licence, citation and retrieval date", async () => {
    const hits = await searchKnowledge(db, "hak aksesibilitas fasilitas publik");
    expect(hits[0]).toMatchObject({
      citation: "UU No. 8 Tahun 2016, Pasal 18",
      heading: "Hak Aksesibilitas",
      source: {
        id: "uu-8-2016",
        kind: "regulasi",
        title: uu.title,
        url: uu.url,
        license: uu.license,
        attribution: null,
        retrievedAt: "2026-11-16T03:00:00.000Z",
      },
    });
    expect(hits[0]!.text).toContain("memanfaatkan fasilitas publik");
  });

  it("matches word prefixes, so a short word finds longer Indonesian forms", async () => {
    const hits = await searchKnowledge(db, "akses gedung");
    expect(hits.map((h) => h.citation)).toContain("UU No. 8 Tahun 2016, Pasal 98");
  });

  it("ranks passages that match more of the question first", async () => {
    const hits = await searchKnowledge(db, "guiding block pintu masuk");
    expect(hits[0]!.citation).toBe("Panduan Verifikasi, bagian 5.3");
  });

  it("ranks a short passage matching more words above a long passage repeating fewer words", async () => {
    const source = { ...uu, id: "uji-peringkat", title: "Uji peringkat" };
    await replaceSource(db, source, (tx) =>
      insertPassages(tx, source.id, [
        { citation: "Uji peringkat, panjang", body: "Kanstin dan bordes. ".repeat(40) },
        { citation: "Uji peringkat, pendek", body: "Selasar dengan kanstin dan bordes." },
      ]),
    );
    const hits = await searchKnowledge(db, "selasar kanstin bordes");
    expect(hits.map((h) => h.citation).slice(0, 2)).toEqual(["Uji peringkat, pendek", "Uji peringkat, panjang"]);
    expect(hits[0]!.score - hits[1]!.score).toBeGreaterThan(0.5);
  });

  it("filters by source kind", async () => {
    const hits = await searchKnowledge(db, "aksesibilitas ramp", { kinds: ["dokumen_aksesbogor"] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source.kind === "dokumen_aksesbogor")).toBe(true);
  });

  it("limits the number of passages to between one and eight", async () => {
    expect(await searchKnowledge(db, "aksesibilitas ramp guiding gedung", { limit: 1 })).toHaveLength(1);
    expect((await searchKnowledge(db, "aksesibilitas ramp guiding gedung", { limit: 50 })).length).toBeLessThanOrEqual(8);
  });

  it("falls back to trigram similarity for a misspelled word", async () => {
    const hits = await searchKnowledge(db, "pegangn");
    expect(hits[0]?.citation).toBe("Panduan Verifikasi, bagian 5.2");
  });

  it("returns nothing when the question has no searchable words", async () => {
    expect(await searchKnowledge(db, "apa itu yang")).toEqual([]);
    expect(await searchKnowledge(db, "zzqxv")).toEqual([]);
  });

  it("treats tsquery syntax in the question as plain words", async () => {
    await expect(searchKnowledge(db, "ramp & !(gedung) | :* <-> '")).resolves.toBeInstanceOf(Array);
  });
});

describe("replaceSource", () => {
  it("replaces a source and its passages without leaving old rows", async () => {
    await replaceSource(db, { ...guide, retrievedAt: new Date("2026-11-17T00:00:00.000Z") }, (tx) =>
      insertPassages(tx, guide.id, [{ citation: "Panduan Verifikasi, bagian 1", body: "Isi baru." }]),
    );
    const rows = await db.select().from(knowledgePassages).where(sql`${knowledgePassages.sourceId} = ${guide.id}`);
    expect(rows.map((r) => r.citation)).toEqual(["Panduan Verifikasi, bagian 1"]);
    const [source] = await db.select().from(knowledgeSources).where(sql`${knowledgeSources.id} = ${guide.id}`);
    expect(source!.retrievedAt.toISOString()).toBe("2026-11-17T00:00:00.000Z");
  });

  it("keeps the old data when filling the new data fails", async () => {
    await expect(
      replaceSource(db, uu, async (tx) => {
        await insertPassages(tx, uu.id, [{ citation: "baru", body: "baru" }]);
        throw new Error("unduhan rusak");
      }),
    ).rejects.toThrow("unduhan rusak");
    const rows = await db.select().from(knowledgePassages).where(sql`${knowledgePassages.sourceId} = ${uu.id}`);
    expect(rows).toHaveLength(2);
  });
});
