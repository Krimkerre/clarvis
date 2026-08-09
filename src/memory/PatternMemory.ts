import * as vscode from 'vscode';
import { BusyTracker, Outcome } from '../watch/BusyTracker';
import { fingerprint } from './fingerprint';
import { PatternStore } from './PatternStore';
import { recordOccurrence, recordResolution, topPattern, THRESHOLD, Pattern } from './patterns';
import { PendingFix, beginPending, noteOutcome } from './resolution';

/**
 * Notices errors that keep coming back, and remembers what fixed them last time (§4.2).
 *
 * Two independent sources, per M1's findings: finished commands that exited nonzero,
 * and compiler/linter diagnostics that never touch a terminal at all.
 */
/**
 * How long after activation diagnostics are treated as pre-existing.
 *
 * Language servers don't report anything at activation — they take a second or two to
 * analyse the project, so errors that were already in your files arrive *after*
 * startup and are indistinguishable from fresh ones by timing alone. Anything inside
 * this window is remembered but not counted.
 */
const DIAGNOSTIC_GRACE_MS = 12_000;

export class PatternMemory {
  private pending: PendingFix | undefined;
  private startedAt = 0;
  /** Diagnostics seen this session, so a redraw doesn't count as a fresh occurrence. */
  private readonly seenDiagnostics = new Set<string>();

  constructor(
    private readonly store: PatternStore,
    private readonly log: (message: string) => void,
    private readonly surface: (message: string) => void
  ) {}

  /** Every error pattern seen so far, for chat's "have we seen this?" question. */
  get known(): Pattern[] {
    return Object.values(this.store.current.patterns);
  }

  async start(tracker: BusyTracker, context: vscode.ExtensionContext): Promise<void> {
    await this.store.load();
    this.startedAt = Date.now();

    tracker.onOutcome((outcome) => void this.onOutcome(outcome));

    context.subscriptions.push(
      vscode.languages.onDidChangeDiagnostics((event) => void this.onDiagnostics(event))
    );
  }

  /** The briefing's fourth line (§4.3), or nothing if no pattern has recurred. */
  briefingLine(now = Date.now()): string | undefined {
    const top = topPattern(this.store.current, now);
    if (!top) return undefined;

    const fix = top.pattern.resolvedBy;
    const seen = `Seen "${excerpt(top.pattern.sample)}" ${top.count}× this week`;
    return fix ? `${seen}; last time \`${fix}\` sorted it.` : `${seen}.`;
  }

  /**
   * A command finished.
   *
   * Failures count toward the pattern and open fix attribution; successes may close it.
   */
  private async onOutcome(outcome: Outcome): Promise<void> {
    const succeeded = outcome.exitCode === 0;

    // Captured before folding, because a successful close clears `pending` and takes
    // the fingerprint with it.
    const pendingKey = this.pending?.key;

    // Does this close an open attribution? (Only a red→green on the same command does.)
    const { pending, resolvedBy } = noteOutcome(this.pending, outcome.label, succeeded);
    this.pending = pending;

    if (resolvedBy && pendingKey) {
      await this.store.save(recordResolution(this.store.current, pendingKey, resolvedBy));
      this.log(`pattern: "${resolvedBy}" credited as the fix for ${pendingKey}`);
    }

    if (succeeded) return;

    // A failure: count it, and start watching for whatever fixes it.
    const key = fingerprint(outcome.label);
    await this.count(key, outcome.label);
    this.pending = beginPending(key, outcome.label);
  }

  /**
   * New compiler/linter errors. Only *newly appeared* ones count — diagnostics
   * re-fire constantly as you type, and counting redraws would hit the threshold in
   * seconds and say something absurd.
   */
  private async onDiagnostics(event: vscode.DiagnosticChangeEvent): Promise<void> {
    for (const uri of event.uris) {
      for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
        if (diagnostic.severity !== vscode.DiagnosticSeverity.Error) continue;

        const identity = `${uri.fsPath}::${diagnostic.message}`;
        if (this.seenDiagnostics.has(identity)) continue;
        this.seenDiagnostics.add(identity);

        // Errors surfacing right after startup were already in the file — the language
        // server is just catching up. Remembered, so a later genuine recurrence still
        // registers, but not counted as an occurrence now.
        if (Date.now() - this.startedAt < DIAGNOSTIC_GRACE_MS) {
          this.log(`pattern: ignoring pre-existing diagnostic (${excerpt(diagnostic.message)})`);
          continue;
        }

        await this.count(fingerprint(diagnostic.message), diagnostic.message);
      }
    }
  }

  /** Records one occurrence and speaks up if it just hit the threshold. */
  private async count(key: string, sample: string): Promise<void> {
    const result = recordOccurrence(this.store.current, key, sample, Date.now());
    await this.store.save(result.state);

    if (!result.shouldSurface) return;

    const fix = result.pattern.resolvedBy;
    this.surface(
      fix
        ? `That's ${THRESHOLD} times this week. Last time, \`${fix}\` sorted it. I make no promises, but I do keep records.`
        : `That's ${THRESHOLD} times this week. No fix on record yet — I'm watching.`
    );
    this.log(`pattern: surfaced ${key} (${THRESHOLD}×)`);
  }

}

/** Errors can be enormous; a notification needs a phrase, not a stack trace. */
function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 48 ? `${collapsed.slice(0, 47)}…` : collapsed;
}
