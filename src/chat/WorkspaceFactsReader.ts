import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { BusyTracker, Outcome } from '../watch/BusyTracker';
import type { Pattern } from '../memory/patterns';
import { activeFailure, parseRecord, FailureRecord, FAILURE_KEY } from '../briefing/lastFailure';
import { readGitSummary } from '../briefing/gitSummary';
import { WorkspaceFacts } from './localAnswer';

/**
 * Everything Clarvis knows about the project right now, gathered in one place.
 *
 * **Why this is its own file.** Facts are what stop him inventing things — the answer to
 * "your linter has been complaining for the past six minutes" was never a stricter
 * prompt, it was giving him the real count. That makes this the load-bearing input to
 * the personality, and it had been a private method on a 1,000-line chat class, gathered
 * from six sources with no name of its own.
 *
 * **Read fresh, never cached.** M3, M4, M5 and VS Code itself already hold this state
 * authoritatively. A second copy here would only be a chance to disagree with them, and
 * a fact that disagrees with the editor is worse than no fact.
 */
export class WorkspaceFactsReader {
  /**
   * The last job to finish, kept only for this session.
   *
   * Duration is not stored anywhere persistent — M4 keeps the failure, not the timing —
   * so "how long did that take" can only be answered about the window you are in.
   */
  private lastOutcome?: { label: string; exitCode: number | undefined; durationMs: number };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tracker: BusyTracker,
    // Suppliers rather than the owning services: two facts are needed, and taking
    // BriefingService and PatternMemory wholesale would couple this to everything else
    // those two happen to do.
    private readonly recentFiles: () => string[],
    private readonly patterns: () => Pattern[]
  ) {
    this.tracker.onOutcome((outcome: Outcome) => {
      this.lastOutcome = {
        label: outcome.label,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
      };
    });
  }

  /** What finished most recently, for "how long did that take". */
  get outcome(): { label: string; exitCode: number | undefined; durationMs: number } | undefined {
    return this.lastOutcome;
  }

  async read(): Promise<WorkspaceFacts> {
    const now = Date.now();
    const stored = parseRecord(this.context.workspaceState.get<FailureRecord>(FAILURE_KEY));

    return {
      now,
      running: this.tracker.running,
      lastOutcome: this.lastOutcome,
      lastFailure: activeFailure(stored, now),
      // Same filter as the briefing: a file deleted since it was recorded is not a
      // fact about the project any more.
      recentFiles: this.recentFiles().filter((file) => existsSync(file)),
      git: await readGitSummary(),
      patterns: this.patterns(),
      problems: countProblems(),
    };
  }
}

/**
 * The current linter and compiler complaints, counted.
 *
 * The file with the most problems is named because it is the one worth mentioning, and
 * because naming a real file is what stops a plausible-sounding invented one.
 */
function countProblems(): WorkspaceFacts['problems'] {
  let errors = 0;
  let warnings = 0;
  let worstFile: string | undefined;
  let worstCount = 0;

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    const here = diagnostics.filter((diagnostic) => {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings++;
      else return false; // hints and information are not complaints
      return true;
    }).length;

    if (here > worstCount) {
      worstCount = here;
      worstFile = vscode.workspace.asRelativePath(uri);
    }
  }

  return { errors, warnings, worstFile };
}
