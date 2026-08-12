import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { BusyTracker, Outcome } from '../watch/BusyTracker';
import { RecentFiles } from './recentFiles';
import { BriefingFacts, briefingPrompt, buildBriefingLines } from './briefingLines';
import { readGitSummary } from './gitSummary';
import { activeFailure, foldOutcome, parseRecord, FailureRecord, FAILURE_KEY } from './lastFailure';

/** Key under which the last failing job is persisted for the next session. */

/** Recently-saved files, persisted so the briefing has something to report at launch. */
const RECENT_FILES_KEY = 'clarvis.recentFiles';

/**
 * Long enough for the window to finish painting. §4.3: nobody wants a briefing
 * delivered over the top of a progress bar.
 */
const STARTUP_DELAY_MS = 1500;

/**
 * How long the model gets before the canned briefing wins.
 *
 * Short enough that the briefing still belongs to the moment the window opened, long
 * enough for the providers people actually use. **Raised from 8s** after two briefings
 * in three fell back to the bank on an OpenRouter routing model — the written lines are
 * correct and audibly flatter, and losing the voice two mornings out of three is a worse
 * trade than four extra seconds.
 */
const PHRASE_TIMEOUT_MS = 12_000;

/**
 * Assembles and delivers the "where you left off" briefing (§4.3), and owns the
 * cross-session memory it needs.
 *
 * Two jobs that belong together: it *records* the failing job as it happens, and
 * *reports* it at next launch. Splitting them would mean two things sharing one
 * storage key and having to agree about its shape.
 */
export class BriefingService {
  private readonly recentFiles: RecentFiles;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  /** Supplied by M5's pattern memory; absent until then. */
  private patternHint: (() => string | undefined) | undefined;

  /**
   * Phrases the briefing with a model, when one is available.
   *
   * Injected rather than imported so this class keeps knowing nothing about providers,
   * and so the canned path stays testable on its own.
   */
  private phraser: ((prompt: string) => Promise<string | undefined>) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void
  ) {
    // Restored from the previous session — the briefing reads this before the user has
    // saved anything, so an empty start would mean the line never appears.
    const stored = context.workspaceState.get<unknown>(RECENT_FILES_KEY);
    const restored = Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : [];
    this.recentFiles = new RecentFiles(5, restored);
  }

  /**
   * The recent-file list, for callers that want it outside a briefing.
   *
   * M4 owns the persistence for this, so chat reads it through here rather than
   * opening the same storage key from a second place and having to agree about its
   * shape forever.
   */
  get recent(): string[] {
    return this.recentFiles.list();
  }

  /** Lets the composition root supply a model to do the phrasing. */
  setPhraser(phraser: (prompt: string) => Promise<string | undefined>): void {
    this.phraser = phraser;
  }

  /** Lets pattern memory (M5) contribute the fourth line without M4 knowing about it. */
  setPatternHint(hint: () => string | undefined): void {
    this.patternHint = hint;
  }

  /**
   * Starts collecting the facts a briefing needs, and schedules delivery.
   *
   * Collection begins immediately; only the *speaking* is delayed. A file saved in
   * the first second still counts.
   */
  start(tracker: BusyTracker, deliver: (lines: string[]) => void): void {
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.recentFiles.record(doc.uri.fsPath);
        // Written per save rather than at deactivate(), which isn't guaranteed to run.
        void this.context.workspaceState.update(RECENT_FILES_KEY, this.recentFiles.list());
      })
    );

    tracker.onOutcome((outcome) => this.recordOutcome(outcome));

    // Wrapped rather than passed as an async callback: setTimeout drops the promise,
    // so a rejection inside would be unhandled and silent.
    this.startupTimer = setTimeout(() => void (async () => {
      const facts = await this.facts();
      const spoken = await this.phrase(facts);

      if (spoken) {
        deliver([spoken]);
        this.log('briefing: phrased by the model');
        return;
      }

      const lines = buildBriefingLines(facts);
      if (lines.length > 0) deliver(lines);
      this.log(`briefing: ${lines.length} line(s), from the bank`);
    })(), STARTUP_DELAY_MS);
  }

  /** Cancels a pending briefing so a fast window close can't fire one into the void. */
  dispose(): void {
    clearTimeout(this.startupTimer);
  }

  /**
   * Persists (or clears) the last-failure record as jobs finish.
   *
   * Written on every outcome rather than batched at `deactivate()`, because
   * `deactivate()` is not guaranteed to complete — M0 established the extension host
   * can be torn down before an async write lands, which is exactly the force-quit case
   * the M4 checklist asks about.
   */
  private recordOutcome(outcome: Outcome): void {
    const current = parseRecord(this.context.workspaceState.get(FAILURE_KEY));
    const next = foldOutcome(current, outcome, Date.now());

    if (next === current) return; // nothing changed; don't churn storage
    void this.context.workspaceState.update(FAILURE_KEY, next);
  }

  /**
   * Asks the model to phrase it, within a deadline.
   *
   * A briefing is the first thing the user hears, and one that arrives thirty seconds
   * after the window opened has missed its own moment — so a slow model loses to the
   * canned lines rather than delaying them.
   */
  private async phrase(facts: BriefingFacts): Promise<string | undefined> {
    const prompt = briefingPrompt(facts);
    if (!prompt || !this.phraser) return undefined;

    // Distinguishable outcomes. "From the bank" was logged for all of them — no model,
    // too slow, and nothing returned read identically, so a briefing losing its voice
    // two mornings in three looked the same as one on a machine with no key at all.
    const TIMED_OUT = Symbol('timed out');

    try {
      const started = Date.now();
      const text = await Promise.race([
        this.phraser(prompt),
        new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), PHRASE_TIMEOUT_MS)),
      ]);

      if (text === TIMED_OUT) {
        this.log(`briefing: model did not answer within ${PHRASE_TIMEOUT_MS}ms — using the written lines`);
        return undefined;
      }

      const phrased = text?.trim();
      if (!phrased) {
        this.log(`briefing: model returned nothing after ${Date.now() - started}ms`);
        return undefined;
      }

      return phrased;
    } catch (error) {
      this.log(`briefing: model phrasing failed (${String(error)})`);
      return undefined;
    }
  }

  /**
   * Gathers what's known. Missing facts are simply omitted.
   *
   * Split from composing the lines so both paths — the model and the bank — work from
   * exactly the same facts, and neither can drift into knowing something the other
   * doesn't.
   */
  private async facts(): Promise<BriefingFacts> {
    const stored = parseRecord(this.context.workspaceState.get(FAILURE_KEY));
    const failure: FailureRecord | undefined = activeFailure(stored, Date.now());

    return {
      git: await readGitSummary(),
      failure,
      // Only files that still exist. The list is persisted across sessions, so a file
      // deleted since is still in it — and naming a file the user has thrown away is the
      // same class of wrongness as calling an untracked file uncommitted: small, but it
      // is his own account of their project being wrong to their face.
      recentFiles: this.recentFiles.list().filter((file) => existsSync(file)),
      patternHint: this.patternHint?.(),
    };
  }
}
