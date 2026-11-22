// Ukuran mutu retrieval untuk `pnpm pengetahuan:evaluasi`: recall@k dan reciprocal rank per pertanyaan.

/** Satu potongan yang harus ditemukan. Larik berarti salah satu sitasinya sudah cukup. */
export type Target = string | string[];

export type QuestionScore = {
  /** Bagian dari target yang ada di k hasil teratas, 0–1. */
  recall: Record<number, number>;
  /** 1 / peringkat hasil relevan pertama, 0 bila tidak ada di hasil. */
  reciprocalRank: number;
  /** Peringkat (mulai 1) hasil relevan pertama. */
  firstRank: number | null;
};

const PART = / \(bagian \d+ dari \d+\)$/;

/**
 * Sitasi hasil cocok dengan sitasi target bila sama persis. Target tanpa "(bagian N dari M)" juga cocok dengan semua
 * bagian dari potongan itu, mis. "…, B.2 Ram" cocok dengan "…, B.2 Ram (bagian 2 dari 2)".
 */
export function citationMatches(citation: string, wanted: string): boolean {
  return citation === wanted || (!PART.test(wanted) && citation.replace(PART, "") === wanted);
}

const matchesTarget = (citation: string, target: Target) =>
  (Array.isArray(target) ? target : [target]).some((wanted) => citationMatches(citation, wanted));

/** Nilai satu pertanyaan dari urutan sitasi hasil retrieval. */
export function scoreQuestion(citations: readonly string[], targets: readonly Target[], ks: readonly number[]): QuestionScore {
  const recall: Record<number, number> = {};
  for (const k of ks) {
    const top = citations.slice(0, k);
    recall[k] = targets.length === 0 ? 0 : targets.filter((t) => top.some((c) => matchesTarget(c, t))).length / targets.length;
  }
  const index = citations.findIndex((c) => targets.some((t) => matchesTarget(c, t)));
  return { recall, reciprocalRank: index === -1 ? 0 : 1 / (index + 1), firstRank: index === -1 ? null : index + 1 };
}

/** Rata-rata recall@k dan MRR untuk semua pertanyaan. */
export function averageScores(scores: readonly QuestionScore[], ks: readonly number[]) {
  const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
  const recall: Record<number, number> = {};
  for (const k of ks) recall[k] = mean(scores.map((s) => s.recall[k] ?? 0));
  return { recall, mrr: mean(scores.map((s) => s.reciprocalRank)) };
}
