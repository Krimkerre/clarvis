/**
 * The editor's problem counts, for §6.4's `clarvis.diagnostic.changed` and §6.3's
 * "aggregate diagnostic counts".
 *
 * `vscode`-free: the host hands over `vscode.languages.getDiagnostics()` as it is,
 * and this counts it. **Counts only** — which file has a problem, and what the
 * problem says, are a path and source text, both forbidden payload.
 *
 * **Paced, because the counts move with every keystroke.** A half-typed line is an
 * error until the next character, and NERVIS's hub allows a service twelve events a
 * minute once its first 120 are spent (`eventForwarding.ts`). So a change is
 * published once the editor has been quiet for `settleMs`, never sooner than
 * `gapMs` after the last one, and only when the counts differ from what was last
 * said — at most two a minute, and always, in the end, the counts as they stand.
 */

/** `vscode.DiagnosticSeverity`, by value, so this file needs no `vscode`. */
const ERROR = 0;
const WARNING = 1;
const INFORMATION = 2;

export interface ProblemCounts {
  readonly errors: number;
  readonly warnings: number;
  readonly information: number;
  readonly hints: number;
  readonly files: number;
}

/** Counted from `getDiagnostics()`'s shape: each file with its problems. */
export function countProblems(
  byFile: ReadonlyArray<readonly [unknown, ReadonlyArray<{ readonly severity: number }>]>
): ProblemCounts {
  const counts = { errors: 0, warnings: 0, information: 0, hints: 0, files: 0 };
  for (const [, problems] of byFile) {
    if (problems.length > 0) counts.files += 1;
    for (const { severity } of problems) {
      if (severity === ERROR) counts.errors += 1;
      else if (severity === WARNING) counts.warnings += 1;
      else if (severity === INFORMATION) counts.information += 1;
      else counts.hints += 1;
    }
  }
  return counts;
}

/** One checker's share of the problems, by severity. */
export interface SourceCounts {
  errors: number;
  warnings: number;
  information: number;
  hints: number;
}

/** §6.2's `clarvis.diagnostics.summary@1`: the counts, and the same counts per checker. */
export interface ProblemSummary extends ProblemCounts {
  readonly by_source: Readonly<Record<string, SourceCounts>>;
}

/** Past this many checkers the rest are counted under `other`, so the document stays small. */
export const MAX_SOURCES = 20;

/**
 * A checker's name as the editor reports it — `ts`, `eslint`, `Pylance` — or `other`.
 *
 * A diagnostic's `source` is set by whichever extension produced it, so it is text this code
 * does not control. Only a short name made of letters, digits, spaces, dots, underscores and
 * dashes is kept: no slash, so it cannot be a path, and no room for a sentence from the file.
 */
export function sourceName(source: unknown): string {
  return typeof source === 'string' && /^[A-Za-z0-9 ._-]{1,40}$/.test(source) ? source : 'other';
}

/**
 * The counts `countProblems` gives, plus each checker's share of them. Read when asked
 * rather than paced: a read is one call, and pacing exists for what is pushed.
 */
export function summariseProblems(
  byFile: ReadonlyArray<
    readonly [unknown, ReadonlyArray<{ readonly severity: number; readonly source?: unknown }>]
  >
): ProblemSummary {
  const bySource: Record<string, SourceCounts> = {};
  for (const [, problems] of byFile) {
    for (const { severity, source } of problems) {
      let name = sourceName(source);
      if (!(name in bySource) && Object.keys(bySource).length >= MAX_SOURCES) name = 'other';
      const counts = (bySource[name] ??= { errors: 0, warnings: 0, information: 0, hints: 0 });
      if (severity === ERROR) counts.errors += 1;
      else if (severity === WARNING) counts.warnings += 1;
      else if (severity === INFORMATION) counts.information += 1;
      else counts.hints += 1;
    }
  }
  return { ...countProblems(byFile), by_source: bySource };
}

function same(a: ProblemCounts | undefined, b: ProblemCounts): boolean {
  return a !== undefined && a.errors === b.errors && a.warnings === b.warnings
    && a.information === b.information && a.hints === b.hints && a.files === b.files;
}

export interface Pacing {
  readonly settleMs: number;
  readonly gapMs: number;
  readonly now: () => number;
  readonly schedule: (run: () => void, ms: number) => unknown;
  readonly cancel: (timer: unknown) => void;
}

export const PACING: Pacing = {
  settleMs: 2_000,
  gapMs: 30_000,
  now: Date.now,
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Reads the counts when they may have changed, and tells when they have. */
export class ProblemWatch {
  private said?: ProblemCounts;
  private saidAt = Number.NEGATIVE_INFINITY;
  private timer?: unknown;

  constructor(
    private readonly read: () => ProblemCounts,
    private readonly tell: (counts: ProblemCounts) => void,
    private readonly pacing: Pacing = PACING
  ) {}

  /** The counts as they stand when the watch begins, so a reader has a starting point. */
  start(): void {
    this.publish();
  }

  /** The editor says something changed. Waits for it to settle, and for the gap. */
  changed(): void {
    if (this.timer !== undefined) this.pacing.cancel(this.timer);
    const due = Math.max(this.pacing.settleMs, this.saidAt + this.pacing.gapMs - this.pacing.now());
    this.timer = this.pacing.schedule(() => {
      this.timer = undefined;
      this.publish();
    }, due);
  }

  dispose(): void {
    if (this.timer !== undefined) this.pacing.cancel(this.timer);
    this.timer = undefined;
  }

  private publish(): void {
    const counts = this.read();
    if (same(this.said, counts)) return;
    this.said = counts;
    this.saidAt = this.pacing.now();
    this.tell(counts);
  }
}
