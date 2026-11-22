// Stemmer bahasa Indonesia untuk retrieval basis pengetahuan (ADR-0044). PostgreSQL tidak punya stemmer bahasa Indonesia,
// jadi kata diubah ke bentuk dasarnya di sini, saat potongan disimpan dan saat pertanyaan dicari.
//
// Aturannya mengikuti urutan Nazief–Adriani dan aturan awalan Enhanced Confix Stripping: partikel (-lah, -kah, -pun)
// dan "-nya", akhiran (-kan, -an, -i), lalu sampai tiga awalan (di-, ke-, se-, me-, pe-, be-, te-, per-) dengan
// perubahan bunyi awalan nasal, mis. "menyediakan" → "sedia" dan "pengguna" → "guna". Bila salah satu calon ada di
// daftar kata dasar (`kata-dasar.ts`), calon itu dipakai. Bila tidak ada, dipakai calon pertama yang lolos syarat:
// bentuk dasarnya paling sedikit dua suku kata dan diawali bunyi yang mungkin, akhiran -i hanya dibuang bersama
// awalan, dan "-si" kata serapan tidak dipotong. Hasilnya tidak harus kata baku. Yang penting, bentuk-bentuk satu
// kata menjadi sama di teks dan di pertanyaan.
import { ROOT_WORDS } from "./kata-dasar.js";

const VOWEL = "aeiou";
const isVowel = (c: string | undefined) => c !== undefined && VOWEL.includes(c);

/** Jumlah huruf hidup, perkiraan kasar jumlah suku kata ("baik" dan "ruang" dua). */
function syllables(word: string): number {
  return word.match(/[aeiou]/g)?.length ?? 0;
}

/** Bentuk dasar paling sedikit dua suku kata dan tiga huruf, supaya kata seperti "jalan" atau "pegang" tidak terpotong. */
const longEnough = (stem: string) => stem.length >= 3 && syllables(stem) >= 2;

type Prefix = "di" | "ke" | "se" | "me" | "pe" | "be" | "te";

/**
 * Kemungkinan pemotongan satu awalan dari kata, urut dari yang paling sering benar. Setiap hasil membawa jenis
 * awalannya untuk memeriksa pasangan awalan dan akhiran yang tidak mungkin.
 */
function prefixOptions(word: string): { rest: string; prefix: Prefix }[] {
  const out: { rest: string; prefix: Prefix }[] = [];
  const add = (prefix: Prefix, ...rests: string[]) => rests.forEach((rest) => out.push({ rest, prefix }));
  const c = (i: number) => word[i];

  if (/^(di|ke|se)/.test(word)) add(word.slice(0, 2) as Prefix, word.slice(2));

  if (word.startsWith("me")) {
    if (/^meng[ghqk]/.test(word)) add("me", word.slice(4));
    else if (word.startsWith("meng") && isVowel(c(4))) add("me", word.slice(4), `k${word.slice(4)}`, ...(c(4) === "e" ? [word.slice(5)] : []));
    else if (word.startsWith("meny") && isVowel(c(4))) add("me", `s${word.slice(4)}`, word.slice(2));
    else if (/^mem[bfv]/.test(word)) add("me", word.slice(3));
    else if (word.startsWith("mempe")) add("me", word.slice(3));
    else if (word.startsWith("mem") && (isVowel(c(3)) || (c(3) === "r" && isVowel(c(4))))) add("me", `p${word.slice(3)}`, word.slice(2));
    else if (/^men[cdjszt]/.test(word)) add("me", word.slice(3));
    else if (word.startsWith("men") && isVowel(c(3))) add("me", `t${word.slice(3)}`, word.slice(2));
    else if (/^me[lrwy]/.test(word) && isVowel(c(3))) add("me", word.slice(2));
  }

  if (word.startsWith("pe")) {
    if (/^pe[wy]/.test(word) && isVowel(c(3))) add("pe", word.slice(2));
    else if (word.startsWith("per") && isVowel(c(3))) add("pe", word.slice(3), word.slice(2));
    else if (word.startsWith("per")) add("pe", word.slice(3));
    else if (/^pem[bfv]/.test(word)) add("pe", word.slice(3));
    else if (word.startsWith("pem") && (isVowel(c(3)) || (c(3) === "r" && isVowel(c(4))))) add("pe", `p${word.slice(3)}`, word.slice(2));
    else if (/^pen[cdjszt]/.test(word)) add("pe", word.slice(3));
    else if (word.startsWith("pen") && isVowel(c(3))) add("pe", `t${word.slice(3)}`, word.slice(2));
    else if (word.startsWith("peng") && isVowel(c(4))) add("pe", word.slice(4), `k${word.slice(4)}`);
    else if (word.startsWith("peng")) add("pe", word.slice(4));
    else if (word.startsWith("peny") && isVowel(c(4))) add("pe", `s${word.slice(4)}`, word.slice(2));
    else if (word === "pelajar" || word === "pelajaran") add("pe", word.slice(3));
    else if (word.startsWith("pel") && isVowel(c(3))) add("pe", word.slice(2));
    else if (!isVowel(c(2))) add("pe", word.slice(2));
  }

  if (word.startsWith("be")) {
    if (word.startsWith("ber") && isVowel(c(3))) add("be", word.slice(3), word.slice(2));
    else if (word.startsWith("ber")) add("be", word.slice(3));
    else if (word === "belajar") add("be", word.slice(3));
    else if (!isVowel(c(2)) && word.slice(3, 5) === "er") add("be", word.slice(2));
  }

  if (word.startsWith("te")) {
    if (word.startsWith("ter") && isVowel(c(3))) add("te", word.slice(3), word.slice(2));
    else if (word.startsWith("ter")) add("te", word.slice(3));
    else if (!isVowel(c(2)) && word.slice(3, 5) === "er") add("te", word.slice(2));
  }

  return out;
}

type Suffix = "kan" | "an" | "i" | null;

/** Pasangan awalan pertama dan akhiran yang tidak dipakai bahasa Indonesia, mis. "di-…-an" atau "ke-…-i". */
const FORBIDDEN_CONFIX = new Set(["be:i", "di:an", "ke:i", "ke:kan", "me:an", "se:i", "se:kan", "te:an"]);

/**
 * Gugus dua huruf mati yang bisa mengawali kata dasar. Sisa seperti "ksual" (dari "seksual") atau "rtifikat" (dari
 * "sertifikat") berarti huruf awal kata itu bukan awalan.
 */
const ONSETS = new Set(["bl", "br", "dr", "fl", "fr", "gl", "gr", "kh", "kl", "kr", "ny", "pl", "pr", "ps", "sk", "sl", "sm", "sn", "sp", "st", "sw", "sy", "tr"]);
const validOnset = (stem: string) => isVowel(stem[0]) || isVowel(stem[1]) || ONSETS.has(stem.slice(0, 2));

/** Semua calon bentuk dasar setelah awalan dipotong, paling banyak tiga lapis, dengan urutan calon yang lebih mungkin dulu. */
function stripPrefixes(word: string, suffix: Suffix, depth = 0, first: Prefix | null = null): string[] {
  const out: string[] = [];
  if (depth === 3) return out;
  for (const { rest, prefix } of prefixOptions(word)) {
    const outer = first ?? prefix;
    if (suffix && FORBIDDEN_CONFIX.has(`${outer}:${suffix}`)) continue;
    if (!longEnough(rest) || !validOnset(rest)) continue;
    if (ROOT_WORDS.has(rest)) {
      out.push(rest);
      continue;
    }
    const deeper = stripPrefixes(rest, suffix, depth + 1, outer);
    out.push(...deeper, rest);
  }
  return out;
}

const memo = new Map<string, string>();

/** Bentuk dasar satu kata huruf kecil. Kata dengan angka, kata pendek, dan kata dasar dikembalikan apa adanya. */
export function stem(word: string): string {
  const cached = memo.get(word);
  if (cached !== undefined) return cached;
  const result = computeStem(word);
  if (memo.size > 50_000) memo.clear();
  memo.set(word, result);
  return result;
}

function computeStem(word: string): string {
  if (word.length <= 3 || !/^[a-z]+$/.test(word) || ROOT_WORDS.has(word)) return word;
  const whole = analyze(word);
  if (whole.known) return whole.known;

  // Partikel dan "-nya" tidak mengubah arti dasar, jadi dibuang bila sisanya paling sedikit empat huruf, mis.
  // "rampnya" → "ramp". Kata utuh diperiksa dulu supaya "bermasalah" tetap "masalah", bukan "masa". "-ku" dan "-mu"
  // tidak dibuang: jarang di teks resmi, dan sering bagian kata ("temu", "ilmu").
  let base = word;
  for (const ending of [/(lah|kah|pun)$/, /nya$/]) {
    const cut = base.replace(ending, "");
    if (cut !== base && cut.length >= 4) {
      base = cut;
      if (ROOT_WORDS.has(base)) return base;
    }
  }
  if (base === word) return whole.fallback ?? word;
  const stripped = analyze(base);
  return stripped.known ?? stripped.fallback ?? base;
}

/** Calon bentuk dasar sebuah kata: yang ada di daftar kata dasar, atau calon terbaik menurut aturan. */
function analyze(base: string): { known?: string; fallback?: string } {
  // Calon dengan awalan yang terpotong lebih dipercaya daripada calon yang hanya kehilangan akhiran: "menekan" menjadi
  // "tekan", bukan "mene". Akhiran tanpa awalan tetap dipakai untuk kata seperti "bangunan".
  const withPrefix: string[] = [];
  const suffixOnly: string[] = [];
  for (const suffix of ["kan", "an", "i"] as const) {
    if (!base.endsWith(suffix)) continue;
    const rest = base.slice(0, -suffix.length);
    if (!longEnough(rest)) continue;
    if (ROOT_WORDS.has(rest)) return { known: rest };
    // "-i" setelah "s" biasanya bagian kata serapan ("verifikasi", "fungsi"); dibuang hanya bila menghasilkan kata dasar
    // yang dikenal, mis. "membatasi" → "batas".
    const loanword = suffix === "i" && rest.endsWith("s");
    const prefixed = stripPrefixes(rest, suffix);
    const known = prefixed.find((c) => ROOT_WORDS.has(c));
    if (known) return { known };
    if (loanword) continue;
    withPrefix.push(...prefixed);
    // Akhiran -i tanpa awalan biasanya bagian kata dasar, mis. "tinggi" atau "lantai".
    if (suffix !== "i") suffixOnly.push(rest);
  }
  const prefixedOnly = stripPrefixes(base, null);
  const known = prefixedOnly.find((c) => ROOT_WORDS.has(c));
  if (known) return { known };
  withPrefix.push(...prefixedOnly);
  return { fallback: withPrefix[0] ?? suffixOnly[0] };
}

/** Teks menjadi kata-kata yang sudah di-stem, dipisah spasi, untuk disimpan sebagai `tsvector`. */
export function stemText(text: string): string {
  const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map(stem).join(" ");
}
