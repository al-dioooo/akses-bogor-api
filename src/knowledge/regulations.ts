// Memotong teks resmi peraturan menjadi potongan yang menyimpan rujukan pasal atau bagian lampirannya (ADR-0042).
// Masukannya teks per halaman dari berkas PDF resmi; tidak ada pengunduhan atau database di sini.
import type { Passage } from "./store.js";

/** Panjang potongan paling banyak, dalam karakter. Pasal yang lebih panjang dipotong per ayat atau per angka. */
export const MAX_PASSAGE = 1500;

/** Kepala dan kaki halaman peraturan.go.id dan JDIH Kementerian PUPR yang tidak termasuk isi peraturan. */
const PAGE_NOISE = [
  /^=====PAGE \d+$/,
  /^\d{4}, No\.\s?\d+(\s+-\s?\d+\s?-)?$/, // "2016, No.69 -2-"
  /^-\s*(?:[IVX]+\.\s?)?\d+\s*-$/, // "-57-", "- 2 -", "-II.2-"
  /^JDIH Kementerian PUPR$/,
];

/** Baris isi dari teks per halaman, tanpa kepala dan kaki halaman dan tanpa baris kosong. */
export function cleanLines(pages: readonly string[]): string[] {
  return pages
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/www\.peraturan\.go\.id/g, "").replace(/\s+/g, " ").trim())
    .filter((line) => line && !PAGE_NOISE.some((pattern) => pattern.test(line)));
}

/** Penanda awal butir: ayat "(1)", angka "1." atau "1)", huruf "a.", "a)", atau "A." di lampiran. */
const ITEM = /^(\(\d+[a-z]?\)|\d+[.)]|[a-z][.)]|[A-Z]\.)\s/;

/** Menggabungkan baris yang terpotong lebar halaman. Butir baru tetap di baris baru. */
export function reflow(lines: readonly string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out.at(-1);
    if (previous === undefined || ITEM.test(line)) out.push(line);
    // "Undang-" di akhir baris: sambung tanpa spasi supaya menjadi "Undang-Undang".
    else out[out.length - 1] = previous.endsWith("-") ? `${previous}${line}` : `${previous} ${line}`;
  }
  return out.join("\n");
}

type Unit = { label: string; text: string };

/** Membagi isi pasal per ayat atau per angka. Kalimat pembuka sebelum butir pertama dikembalikan terpisah. */
function units(body: string): { kind: "ayat" | "angka"; lead: string; items: Unit[] } | null {
  const lines = body.split("\n");
  const kind = lines.some((l) => /^\(\d+[a-z]?\)\s/.test(l)) ? "ayat" : lines.some((l) => /^\d+\.\s/.test(l)) ? "angka" : null;
  if (!kind) return null;
  const marker = kind === "ayat" ? /^\((\d+[a-z]?)\)\s/ : /^(\d+)\.\s/;
  const lead: string[] = [];
  const items: Unit[] = [];
  for (const line of lines) {
    const match = marker.exec(line);
    if (match) items.push({ label: kind === "ayat" ? `(${match[1]})` : match[1]!, text: line });
    else if (items.length === 0) lead.push(line);
    else items[items.length - 1]!.text += `\n${line}`;
  }
  return { kind, lead: lead.join("\n"), items };
}

/**
 * Mengelompokkan butir berurutan sampai `MAX_PASSAGE`, dengan rujukan rentang, mis. "ayat (1)–(3)". Kalimat pembuka
 * pasal (mis. "Dalam Undang-Undang ini yang dimaksud dengan:") diulang di setiap kelompok supaya potongannya bisa
 * dibaca sendiri. Pasal tanpa ayat atau angka tidak dipotong.
 */
function group(citation: string, body: string): { citation: string; body: string }[] {
  const split = body.length > MAX_PASSAGE ? units(body) : null;
  if (!split) return [{ citation, body }];
  const groups: Unit[][] = [];
  for (const item of split.items) {
    const current = groups.at(-1);
    const size = split.lead.length + (current?.reduce((n, u) => n + u.text.length + 1, 0) ?? 0);
    if (current && size + item.text.length <= MAX_PASSAGE) current.push(item);
    else groups.push([item]);
  }
  return groups.map((g) => {
    const first = g[0]!.label;
    const last = g.at(-1)!.label;
    const text = g.map((u) => u.text).join("\n");
    return { citation: `${citation} ${split.kind} ${first === last ? first : `${first}–${last}`}`, body: split.lead ? `${split.lead}\n${text}` : text };
  });
}

const STRUCTURE = /^(BAB [IVXLC]+|Bagian [A-Z][a-z]+( [A-Z][a-z]+)*|Paragraf \d+|Pasal \d+[A-Z]?)$/;
const CLOSING = /^(Disahkan di|Ditetapkan di|MENTERI PEKERJAAN UMUM DAN)\b/;

/**
 * Potongan dari batang tubuh peraturan: "Menimbang" lalu setiap pasal, dengan judul bab, bagian, dan paragraf sebagai
 * heading. Baris "Pasal N" hanya dianggap judul pasal bila nomornya urut, supaya rujukan "Pasal 17" yang kebetulan
 * jatuh di awal baris tidak memotong pasal.
 */
export function splitArticles(lines: readonly string[], short: string): Passage[] {
  const passages: Passage[] = [];
  const titles = { bab: "", bagian: "", paragraf: "" };
  let level: keyof typeof titles | null = null;
  let article: { number: string; heading: string; lines: string[] } | null = null;
  let preamble: string[] | null = null;
  let expected = 1;

  const flushArticle = () => {
    if (!article) return;
    for (const part of group(`${short}, Pasal ${article.number}`, reflow(article.lines))) passages.push({ ...part, heading: article.heading || null });
    article = null;
  };

  for (const line of lines) {
    // Nama jabatan penanda tangan juga muncul di pembukaan, jadi penutup baru dicari setelah pasal pertama.
    if (expected > 1 && CLOSING.test(line)) break;
    if (line.startsWith("Menimbang")) {
      preamble = [line.replace(/^Menimbang\s*:\s*/, "")];
      continue;
    }
    if (preamble) {
      if (!line.startsWith("Mengingat")) {
        preamble.push(line);
        continue;
      }
      passages.push({ citation: `${short}, Menimbang`, heading: "Menimbang", body: reflow(preamble) });
      preamble = null;
      continue;
    }
    const pasal = /^Pasal (\d+)([A-Z]?)$/.exec(line);
    if (pasal && (Number(pasal[1]) === expected || (pasal[2] && Number(pasal[1]) === expected - 1))) {
      flushArticle();
      if (!pasal[2]) expected += 1;
      level = null;
      article = { number: `${pasal[1]}${pasal[2]}`, heading: [titles.bab, titles.bagian, titles.paragraf].filter(Boolean).join(" › "), lines: [] };
      continue;
    }
    if (STRUCTURE.test(line) && !pasal) {
      flushArticle();
      level = line.startsWith("BAB") ? "bab" : line.startsWith("Bagian") ? "bagian" : "paragraf";
      // Bab baru mengosongkan judul bagian dan paragraf; bagian baru mengosongkan judul paragraf.
      if (level === "bab") Object.assign(titles, { bab: "", bagian: "", paragraf: "" });
      if (level === "bagian") Object.assign(titles, { bagian: "", paragraf: "" });
      titles[level] = "";
      continue;
    }
    if (level) {
      titles[level] = titles[level] ? `${titles[level]} ${line}` : line;
      continue;
    }
    article?.lines.push(line);
  }
  flushArticle();
  return passages;
}

const isUpper = (line: string) => /\p{L}/u.test(line) && line === line.toUpperCase();
const endsLikeSentence = (text: string) => /[;,:.]$|\b(dan|atau|yang)$/.test(text);

/**
 * Potongan dari satu lampiran: dikelompokkan per huruf (A., B.) dan per angka (1. Pintu, 2. Selasar), lalu dipotong
 * sampai `MAX_PASSAGE` di batas baris. Judul huruf dan angka hanya diterima bila urut dan pendek, karena daftar biasa di
 * dalam lampiran memakai penanda yang sama.
 */
export function splitAppendix(lines: readonly string[], short: string, roman: string): Passage[] {
  // Blok judul huruf kapital di awal: "LAMPIRAN II", nama peraturan, lalu topik lampiran.
  let start = 0;
  while (start < lines.length && isUpper(lines[start]!) && !/^[A-Z]\.\s/.test(lines[start]!)) start += 1;
  const titleBlock = lines.slice(0, start).join(" ");
  const topic = titleBlock.split(/KEMUDAHAN BANGUNAN GEDUNG/).at(-1)!.trim();
  const toTitle = (text: string) => (isUpper(text) ? text.charAt(0) + text.slice(1).toLowerCase() : text);

  const sections: { letter: string; l1: string; number: string; l2: string; lines: string[] }[] = [];
  let letter = "";
  let l1 = "";
  let number = "";
  let l2 = "";
  let nextNumber = 1;
  for (const line of lines.slice(start)) {
    if (CLOSING.test(line)) break;
    const heading1 = /^([A-Z])\.\s(.{1,90})$/.exec(line);
    const expectedLetter = letter ? String.fromCharCode(letter.charCodeAt(0) + 1) : "A";
    if (heading1 && heading1[1] === expectedLetter && !endsLikeSentence(heading1[2]!)) {
      [letter, l1, number, l2, nextNumber] = [heading1[1]!, toTitle(heading1[2]!), "", "", 1];
      continue;
    }
    const heading2 = /^(\d+)\.\s(.{1,70})$/.exec(line);
    if (heading2 && Number(heading2[1]) === nextNumber && !endsLikeSentence(heading2[2]!)) {
      [number, l2, nextNumber] = [heading2[1]!, toTitle(heading2[2]!), nextNumber + 1];
      continue;
    }
    const last = sections.at(-1);
    if (last && last.letter === letter && last.number === number) last.lines.push(line);
    else sections.push({ letter, l1, number, l2, lines: [line] });
  }

  const passages: Passage[] = [];
  for (const section of sections) {
    const place = [section.letter, section.number].filter(Boolean).join(".");
    const citation = `${short}, Lampiran ${roman}${place ? `, ${place}` : ""}${section.l2 ? ` ${section.l2}` : section.l1 ? ` ${section.l1}` : ""}`;
    const heading = [topic && toTitle(topic), section.l1, section.l2].filter(Boolean).join(" › ").slice(0, 300) || null;
    const parts: string[][] = [[]];
    for (const line of reflow(section.lines).split("\n")) {
      const current = parts.at(-1)!;
      if (current.length && current.join("\n").length + line.length > MAX_PASSAGE) parts.push([line]);
      else current.push(line);
    }
    parts.forEach((part, i) =>
      passages.push({ citation: parts.length > 1 ? `${citation} (bagian ${i + 1} dari ${parts.length})` : citation, heading, body: part.join("\n") }),
    );
  }
  return passages;
}
