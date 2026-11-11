/**
 * The comparability rule, and the reason this package is not a thin wrapper.
 *
 * THE RULE. Two benchmark runs may be put side by side only when all three of
 * benchmark, metric and task subset match. ModelRefs records those as
 * benchmark, scoreUnit and benchmarkSubset, and the contract they come from
 * (src/content/contracts/benchmarkRunContract.ts) states the case that forced
 * the field: Anthropic reports tau-bench Retail and Airline separately and the
 * same model differs by roughly twenty points between them, while OpenAI
 * reports tau2-bench telecom. Putting 96.7 on telecom beside 81.4 on Retail
 * reads as a capability gap and is mostly a domain difference.
 *
 * An ABSENT subset compares with another ABSENT subset. The field is set only
 * where a benchmark ships several task sets that are not comparable, so
 * absence means "this benchmark has one task set", not "unknown".
 *
 * WHY THREE BUCKETS AND NOT ONE LIST. A comparison tool that silently drops
 * what it cannot compare teaches the caller that the comparison was complete.
 * So every benchmark lands in `comparable` with a gap, in `incomparable` with
 * the reason the runs do not pair, or in `oneSided` because only one of the
 * models has a run on it at all. The third is not a defect — coverage is a
 * deliberate subset — but it is the difference between "A beats B" and "we
 * only measured A".
 */

export interface RunLike {
  benchmark?: string;
  benchmarkName?: string;
  score?: number;
  scoreUnit?: string;
  benchmarkSubset?: string;
  higherIsBetter?: boolean;
  modelVersion?: string;
  publicationDate?: string;
  publisher?: string;
  sourceUrl?: string;
  sourceClass?: string;
  claimScope?: string;
  methodologyLimitations?: string;
}

export interface ModelRuns {
  slug: string;
  name: string;
  runs: readonly RunLike[];
}

export interface ComparableScore {
  model: string;
  score: number;
  modelVersion: string | null;
  publisher: string | null;
  sourceUrl: string | null;
  publicationDate: string | null;
  /** Further runs held for this model on the same benchmark, metric and subset. */
  otherRunsHeld: number;
  methodologyLimitations: string | null;
}

export interface ComparableEntry {
  benchmark: string;
  benchmarkName: string;
  metric: string | null;
  subset: string | null;
  higherIsBetter: boolean;
  scores: ComparableScore[];
  leader: string;
  /**
   * Best minus worst, in the published unit. Never normalised: a normalised
   * gap hides which unit it is in and invites someone to add two of them.
   */
  spread: number;
}

export interface IncomparableEntry {
  benchmark: string;
  benchmarkName: string;
  reason: string;
  perModel: Array<{
    model: string;
    metric: string | null;
    subset: string | null;
    score: number | null;
  }>;
}

export interface OneSidedEntry {
  benchmark: string;
  benchmarkName: string;
  model: string;
  score: number | null;
  metric: string | null;
  subset: string | null;
  note: string;
}

export interface ComparisonResult {
  models: Array<{ slug: string; name: string; runsHeld: number }>;
  comparable: ComparableEntry[];
  incomparable: IncomparableEntry[];
  oneSided: OneSidedEntry[];
  summary: string;
}

/** benchmark + metric + subset. A shared benchmark slug alone is not it. */
export function comparabilityKey(run: RunLike): string {
  return [run.benchmark ?? "", run.scoreUnit ?? "", run.benchmarkSubset ?? ""].join("|");
}

function usable(run: RunLike): boolean {
  return (
    typeof run.benchmark === "string" &&
    typeof run.score === "number" &&
    Number.isFinite(run.score)
  );
}

/** Newest first, undated last: a dated run is a better witness than an undated one. */
function byPublication(a: RunLike, b: RunLike): number {
  return (b.publicationDate ?? "").localeCompare(a.publicationDate ?? "");
}

export function compareModels(models: readonly ModelRuns[]): ComparisonResult {
  const comparable: ComparableEntry[] = [];
  const incomparable: IncomparableEntry[] = [];
  const oneSided: OneSidedEntry[] = [];

  /* benchmark -> comparability key -> model slug -> the runs held under it */
  const byBenchmark = new Map<string, Map<string, Map<string, RunLike[]>>>();
  const names = new Map<string, string>();

  for (const model of models) {
    for (const run of model.runs) {
      if (!usable(run)) continue;
      const benchmark = run.benchmark as string;
      names.set(benchmark, run.benchmarkName ?? benchmark);
      const keys = byBenchmark.get(benchmark) ?? new Map<string, Map<string, RunLike[]>>();
      const key = comparabilityKey(run);
      const perModel = keys.get(key) ?? new Map<string, RunLike[]>();
      perModel.set(model.slug, [...(perModel.get(model.slug) ?? []), run]);
      keys.set(key, perModel);
      byBenchmark.set(benchmark, keys);
    }
  }

  for (const benchmark of [...byBenchmark.keys()].sort()) {
    const keys = byBenchmark.get(benchmark)!;
    const benchmarkName = names.get(benchmark) ?? benchmark;

    const modelsOnBenchmark = new Set<string>();
    for (const perModel of keys.values()) {
      for (const slug of perModel.keys()) modelsOnBenchmark.add(slug);
    }

    const paired = [...keys.entries()].filter(([, perModel]) => perModel.size >= 2);
    const unpaired = [...keys.entries()].filter(([, perModel]) => perModel.size < 2);

    for (const [key, perModel] of paired) {
      const parts = key.split("|");
      const sample = [...perModel.values()][0]![0]!;
      const scores: ComparableScore[] = [...perModel.entries()]
        .map(([slug, runs]) => {
          const sorted = [...runs].sort(byPublication);
          const best = sorted[0]!;
          return {
            model: slug,
            score: best.score as number,
            modelVersion: best.modelVersion ?? null,
            publisher: best.publisher ?? null,
            sourceUrl: best.sourceUrl ?? null,
            publicationDate: best.publicationDate ?? null,
            otherRunsHeld: sorted.length - 1,
            methodologyLimitations: best.methodologyLimitations ?? null,
          };
        })
        .sort((a, b) => b.score - a.score);

      /* higherIsBetter is per run and must come from the data, because latency
         and cost benchmarks exist and ranking them the wrong way round is a
         silent error, not a visible one. */
      const higherIsBetter = sample.higherIsBetter !== false;
      const ordered = higherIsBetter ? scores : [...scores].reverse();

      comparable.push({
        benchmark,
        benchmarkName,
        metric: parts[1] || null,
        subset: parts[2] || null,
        higherIsBetter,
        scores: ordered,
        leader: ordered[0]!.model,
        spread: Math.abs(scores[0]!.score - scores[scores.length - 1]!.score),
      });
    }

    if (modelsOnBenchmark.size === 1) {
      /* Only one model has any run on this benchmark. Not a defect, but the
         difference between a ranking and a single measurement. */
      const [key, perModel] = [...keys.entries()][0]!;
      const parts = key.split("|");
      const [slug, runs] = [...perModel.entries()][0]!;
      oneSided.push({
        benchmark,
        benchmarkName,
        model: slug,
        score: (runs[0]?.score as number | undefined) ?? null,
        metric: parts[1] || null,
        subset: parts[2] || null,
        note:
          "Only this model has a governed run on this benchmark, so there is nothing to " +
          "compare it against. Coverage is a deliberate subset; absence is not a judgement " +
          "about the other models.",
      });
    } else if (unpaired.length && !paired.length) {
      /* THE BUCKET THE WHOLE RULE EXISTS FOR. Two or more models have a run on
         this benchmark and no two of them are the same quantity, so the entry
         names what differs rather than ranking them anyway. */
      const metrics = new Set<string>();
      const subsets = new Set<string>();
      const perModel: IncomparableEntry["perModel"] = [];
      for (const [key, holders] of unpaired) {
        const parts = key.split("|");
        metrics.add(parts[1] ?? "");
        subsets.add(parts[2] ?? "");
        for (const [slug, runs] of holders) {
          perModel.push({
            model: slug,
            metric: parts[1] || null,
            subset: parts[2] || null,
            score: (runs[0]?.score as number | undefined) ?? null,
          });
        }
      }
      const differs: string[] = [];
      if (subsets.size > 1) differs.push("task subset");
      if (metrics.size > 1) differs.push("metric");
      incomparable.push({
        benchmark,
        benchmarkName,
        reason: differs.length
          ? `These models each have a run on ${benchmarkName}, but the runs differ in ` +
            `${differs.join(" and ")}. They are different quantities, so they are reported ` +
            `here rather than ranked.`
          : `Runs exist on ${benchmarkName} but no two models share a comparable run.`,
        perModel,
      });
    }
  }

  const summary = [
    `${comparable.length} benchmark(s) compared across ${models.length} model(s).`,
    incomparable.length
      ? `${incomparable.length} benchmark(s) carry runs that are NOT comparable with each ` +
        `other and were deliberately not ranked.`
      : null,
    oneSided.length
      ? `${oneSided.length} benchmark(s) only one of these models has evidence for.`
      : null,
    comparable.length === 0
      ? "No benchmark produced a comparable pairing, so this comparison supports no ranking at all."
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    models: models.map((m) => ({ slug: m.slug, name: m.name, runsHeld: m.runs.length })),
    comparable,
    incomparable,
    oneSided,
    summary,
  };
}
