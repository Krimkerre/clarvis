import * as vscode from 'vscode';
import { BusyTracker, Outcome } from '../watch/BusyTracker';
import { fingerprint } from './fingerprint';
import { LINGER_MS, lingeringLine } from './lingering';
import { PatternStore } from './PatternStore';
import { forgetMatching, recordOccurrence, recordResolution, topPattern, THRESHOLD, Pattern } from './patterns';
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

/**
 * How long an error has to persist before it counts as having happened.
 *
 * The startup grace covers the first few seconds of a session and nothing after it, so
 * an error that appeared and vanished at any later moment was still recorded as real.
 * That is most of what a language server does while you type: a half-written line is an
 * error for as long as it takes to finish writing it, and reopening a project after an
 * `npm install` produces a burst of "Cannot find name 'process'" that resolves itself
 * the moment types load.
 *
 * Observed rather than theorised: a briefing opened with "Type 'string' is not
 * assignable to type 'number', seen twice this week" about an error that never survived
 * long enough for anyone to read it.
 */
const DIAGNOSTIC_CONFIRM_MS = 6_000;

export class PatternMemory {
  private pending: PendingFix | undefined;
  private startedAt = 0;
  /** Diagnostics seen this session, so a redraw doesn't count as a fresh occurrence. */
  private readonly seenDiagnostics = new Set<string>();

  /**
   * Errors waiting to prove they are real.
   *
   * Held so a window closing mid-wait does not leave timers running against a disposed
   * extension host — the same reason every other timer in this project is tracked.
   */
  private readonly pendingDiagnostics = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Errors already mentioned for lingering, so each is said once and never again.
   *
   * Keyed the same way as `seenDiagnostics` — file plus message — so the same mistake
   * in two files is two mentions, and the same mistake fixed and reintroduced is one.
   * A second mention twenty minutes on would be nagging about a decision rather than
   * reporting a fact.
   */
  private readonly mentionedLingering = new Set<string>();

  /** Linger timers in flight, cleared on dispose like every other timer here. */
  private readonly lingerTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
      vscode.languages.onDidChangeDiagnostics((event) => void this.onDiagnostics(event)),
      { dispose: () => this.dispose() }
    );
  }

  /** Cancels anything still waiting to be confirmed. */
  dispose(): void {
    for (const timer of this.pendingDiagnostics.values()) clearTimeout(timer);
    this.pendingDiagnostics.clear();
    for (const timer of this.lingerTimers.values()) clearTimeout(timer);
    this.lingerTimers.clear();
  }

  /**
   * Forgets everything remembered about a job.
   *
   * Paired with clearing the failure record: the two stores answer different questions —
   * "what broke last" and "what keeps breaking" — and a user asking him to let something
   * go means both.
   */
  async forget(needle: string): Promise<number> {
    const { state, removed } = forgetMatching(this.store.current, needle);
    if (removed > 0) await this.store.save(state);

    this.log(`memory: forgot ${removed} pattern(s) matching "${needle}"`);
    return removed;
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

        this.confirmLater(uri, diagnostic.message, identity);
      }
    }
  }

  /**
   * Counts an error only if it is still there in a few seconds.
   *
   * Nothing is recorded on sight. A language server reports a half-written line as an
   * error and withdraws it a keystroke later, and counting those means remembering
   * things that never happened — then repeating them in a briefing days afterwards.
   *
   * Re-read from the editor rather than trusted from the event: the question is whether
   * the error is still there *now*, and the editor is the only thing that knows.
   */
  private confirmLater(uri: vscode.Uri, message: string, identity: string): void {
    const timer = setTimeout(() => {
      this.pendingDiagnostics.delete(identity);

      const stillThere = vscode.languages
        .getDiagnostics(uri)
        .some((current) => current.message === message && current.severity === vscode.DiagnosticSeverity.Error);

      if (!stillThere) {
        // Not a failure worth mentioning: it is the ordinary case, and logging every
        // withdrawn squiggle would bury the ones that mattered.
        this.seenDiagnostics.delete(identity);
        return;
      }

      void this.count(fingerprint(message), message);
      // Confirmed present. Whether it is still present in three minutes is a different
      // question, and the one that decides whether it is worth saying anything about.
      this.watchForLingering(uri, message, identity);
    }, DIAGNOSTIC_CONFIRM_MS);

    this.pendingDiagnostics.set(identity, timer);
  }

  /**
   * Mentions an error that is still there several minutes later. Once.
   *
   * **The third occurrence is the wrong trigger for a first mistake.** §4.2's threshold
   * answers "is this a pattern"; it cannot answer "this file is broken right now", and
   * the second question is the one someone staring past a missing colon needs answered.
   *
   * What keeps it from being a linter is entirely in the timing and the once: three
   * minutes means anything fixed while working never surfaces, and one mention means a
   * problem left deliberately is left alone. It goes through `surface`, so §6's
   * one-a-minute budget applies exactly as it does to everything else unsolicited.
   */
  private watchForLingering(uri: vscode.Uri, message: string, identity: string): void {
    if (this.mentionedLingering.has(identity) || this.lingerTimers.has(identity)) return;

    const timer = setTimeout(() => {
      this.lingerTimers.delete(identity);

      // Re-read rather than trusted: the only question is whether it is *still* there,
      // and the editor is the only thing that knows. Fixed in the meantime is the
      // ordinary case and says nothing.
      const current = vscode.languages
        .getDiagnostics(uri)
        .find((entry) => entry.message === message && entry.severity === vscode.DiagnosticSeverity.Error);

      if (!current) {
        this.log(`pattern: lingering error cleared before it was worth mentioning — ${excerpt(message)}`);
        return;
      }

      this.mentionedLingering.add(identity);
      const file = vscode.workspace.asRelativePath(uri);
      // 1-based, to match the gutter rather than the array index.
      this.surface(lingeringLine(file, current.range.start.line + 1, excerpt(message)));
      this.log(`pattern: mentioned a lingering error in ${file} — ${excerpt(message)}`);
    }, LINGER_MS);

    this.lingerTimers.set(identity, timer);
  }

  /** Records one occurrence and speaks up if it just hit the threshold. */
  private async count(key: string, sample: string): Promise<void> {
    const result = recordOccurrence(this.store.current, key, sample, Date.now());
    await this.store.save(result.state);

    // **Every occurrence, not only the third.** Counting silently meant a log with no
    // `pattern:` lines could equally mean "seen twice, waiting" or "diagnostics never
    // arrived" — and the first live test of this feature could not tell them apart.
    // Same mistake the sandbox made, fixed there a day earlier for the same reason.
    const seen = result.pattern.occurrences.length;
    this.log(`pattern: ${key} seen ${seen}× (surfaces at ${THRESHOLD}) — ${excerpt(sample)}`);

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
