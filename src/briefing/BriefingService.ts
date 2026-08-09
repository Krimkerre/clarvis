import * as vscode from 'vscode';
import { BusyTracker, Outcome } from '../watch/BusyTracker';
import { RecentFiles } from './recentFiles';
import { buildBriefingLines } from './briefingLines';
import { readGitSummary } from './gitSummary';
import { activeFailure, foldOutcome, parseRecord, FailureRecord } from './lastFailure';

/** Key under which the last failing job is persisted for the next session. */
const FAILURE_KEY = 'clarvis.lastFailure';

/** Recently-saved files, persisted so the briefing has something to report at launch. */
const RECENT_FILES_KEY = 'clarvis.recentFiles';

/**
 * Long enough for the window to finish painting. §4.3: nobody wants a briefing
 * delivered over the top of a progress bar.
 */
const STARTUP_DELAY_MS = 1500;

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

    this.startupTimer = setTimeout(async () => {
      const lines = await this.build();
      if (lines.length > 0) deliver(lines);
      this.log(`briefing: ${lines.length} line(s)`);
    }, STARTUP_DELAY_MS);
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

  /** Gathers what's known and composes the lines. Missing facts are simply omitted. */
  private async build(): Promise<string[]> {
    const stored = parseRecord(this.context.workspaceState.get(FAILURE_KEY));
    const failure: FailureRecord | undefined = activeFailure(stored, Date.now());

    return buildBriefingLines({
      git: await readGitSummary(),
      failure,
      recentFiles: this.recentFiles.list(),
      patternHint: this.patternHint?.(),
    });
  }
}
