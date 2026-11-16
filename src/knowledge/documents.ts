// Dokumen AksesBogor untuk basis pengetahuan agen rute (ADR-0042): halaman edukasi dari `messages/id.json` di
// akses-bogor-web, serta Panduan Verifikasi dan ADR dari akses-bogor-docs. Tidak ada pengunduhan atau database di sini.
import type { Passage } from "./store.js";

export const MAX_SECTION = 1500;

/** Teks Markdown menjadi teks biasa: tautan, gambar, penekanan, dan kode menjadi isinya; tabel menjadi baris "a — b". */
export function plainMarkdown(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !/^\s*\|?\s*:?-{3,}/.test(line))
    .map((line) =>
      line
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^\s*\|(.*)\|\s*$/, (_, cells: string) =>
          cells
            .split("|")
            .map((c) => c.trim())
            .filter(Boolean)
            .join(" — "),
        )
        .trimEnd(),
    )
    .filter((line) => !/^\[[^\]]+\]:\s/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Memotong teks panjang di batas paragraf; paragraf yang sendirinya terlalu panjang dibiarkan utuh. */
function parts(text: string): string[] {
  if (text.length <= MAX_SECTION) return [text];
  const out: string[] = [];
  for (const paragraph of text.split(/\n\n+/)) {
    const last = out.at(-1);
    if (last !== undefined && last.length + paragraph.length + 2 <= MAX_SECTION) out[out.length - 1] = `${last}\n\n${paragraph}`;
    else out.push(paragraph);
  }
  return out;
}

const withParts = (citation: string, heading: string | null, text: string): Passage[] => {
  const pieces = parts(text);
  return pieces.map((body, i) => ({ citation: pieces.length > 1 ? `${citation} (bagian ${i + 1} dari ${pieces.length})` : citation, heading, body }));
};

/**
 * Potongan per heading dari dokumen Markdown. Teks sebelum heading kedua (judul dan metadata ADR) dilewati, begitu pula
 * bagian yang judulnya cocok dengan `skip` beserta subbagiannya, mis. "Referensi" atau opsi yang tidak dipilih.
 */
export function splitMarkdown(markdown: string, citationPrefix: string, skip: RegExp = /^Referensi$/): Passage[] {
  const passages: Passage[] = [];
  const path: string[] = [];
  let skipping = 0;
  let lines: string[] = [];
  const flush = () => {
    const text = plainMarkdown(lines.join("\n"));
    lines = [];
    const heading = path.filter(Boolean).join(" › ");
    if (!text || !heading || skipping) return;
    passages.push(...withParts(`${citationPrefix}, ${heading}`, heading, text));
  };
  for (const line of markdown.split("\n")) {
    const match = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    flush();
    const level = match[1]!.length - 1;
    path.splice(level - 1);
    path[level - 1] = plainMarkdown(match[2]!);
    if (skipping && level <= skipping) skipping = 0;
    if (!skipping && skip.test(path[level - 1]!)) skipping = level;
  }
  flush();
  return passages;
}

type Messages = Record<string, unknown>;
const SKIPPED_KEYS = new Set(["href", "link", "needsLink", "whoLabel", "metaTitle", "title", "accent", "related"]);
const stripTags = (text: string) => text.replace(/<\/?[a-z]+>/g, "");

/** Isi satu bagian halaman edukasi sebagai baris teks, dengan kode (mis. `ramp`) diganti labelnya (mis. "Ramp / Jalur Landai"). */
function render(value: unknown, labels: ReadonlyMap<string, string>, whoLabel?: string): string[] {
  if (typeof value === "string") return [stripTags(value)];
  if (Array.isArray(value)) return value.flatMap((item) => render(item, labels, whoLabel));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.what === "string") return [`${stripTags(record.what)}${typeof record.who === "string" ? ` ${whoLabel ?? ""} ${stripTags(record.who)}` : ""}`.replace(/\s+/g, " ").trim()];
  const pair = (["term", "title"] as const).find((key) => typeof record[key] === "string" && typeof record.body === "string");
  if (pair) return [`${stripTags(record[pair] as string)}: ${stripTags(record.body as string)}`];
  const label = typeof record.whoLabel === "string" ? record.whoLabel : whoLabel;
  return Object.entries(record).flatMap(([key, item]) => {
    if (SKIPPED_KEYS.has(key)) return [];
    const name = labels.get(key);
    if (name && typeof item === "string") return [`${name}: ${stripTags(item)}`];
    if (name) return render(item, labels, label).map((line) => `${name}: ${line}`);
    return render(item, labels, label);
  });
}

/**
 * Potongan dari satu halaman edukasi (ADR-0041): pembuka halaman, lalu satu potongan per bagian yang punya `title`.
 * Daftar sumber di akhir halaman ikut sebagai potongan sendiri.
 */
export function educationPassages(messages: Messages, namespace: string): Passage[] {
  const page = messages[namespace] as Record<string, unknown> | undefined;
  if (!page) throw new Error(`Namespace ${namespace} tidak ada di messages/id.json`);
  const labels = new Map<string, string>();
  for (const group of ["Fasilitas", "Jawaban", "Alasan", "Status"]) {
    for (const [code, label] of Object.entries((messages[group] ?? {}) as Record<string, unknown>)) if (typeof label === "string") labels.set(code, label);
  }
  const pageTitle = String(page.metaTitle ?? namespace);
  const prefix = `Halaman "${pageTitle}" (draf)`;
  const passages: Passage[] = [];
  if (typeof page.intro === "string") passages.push({ citation: `${prefix}, pembuka`, heading: pageTitle, body: stripTags(page.intro) });
  for (const [key, section] of Object.entries(page)) {
    if (!section || typeof section !== "object") continue;
    const record = section as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : key === "sources" ? "Sumber" : null;
    if (!title) continue;
    const text = render(section, labels).filter(Boolean).join("\n");
    if (text) passages.push(...withParts(`${prefix}, ${title}`, `${pageTitle} › ${title}`, text));
  }
  return passages;
}
