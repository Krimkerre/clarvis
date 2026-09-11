import * as vscode from 'vscode';
import { existsSync, readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { activeBlocker, BLOCKER_KEY } from '../agent/missingDependency';
import { plannedStack, projectEntries } from './projectFacts';
import { BusyTracker, Outcome } from '../watch/BusyTracker';
import type { Pattern } from '../memory/patterns';
import { activeFailure, parseRecord, FailureRecord, FAILURE_KEY } from '../briefing/lastFailure';
import { readGitSummary } from '../briefing/gitSummary';
import { WorkspaceFacts } from './localAnswer';
import { LAST_RUN_KEY } from '../agent/runLedger';
import { summariseProblems } from './openProblems';

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
      ...activeFileProblems(),
      lastRun: this.context.workspaceState.get(LAST_RUN_KEY),
      files: projectFiles(),
      stack: planStack(),
      blocker: activeBlocker(this.context.workspaceState.get(BLOCKER_KEY), now),
    };
  }
}

/** The project's files two levels deep, read from the workspace folder. */
function projectFiles(): string[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return [];
  return projectEntries((relative) =>
    readdirSync(path.join(root, relative), { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
  );
}

/** What plan.md says the project is built with, when there is a plan that says. */
function planStack(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  try {
    return plannedStack(readFileSync(path.join(root, 'plan.md'), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The current linter and compiler complaints, counted.
 *
 * The file with the most problems is named because it is the one worth mentioning, and
 * because naming a real file is what stops a plausible-sounding invented one.
 */
/**
 * What is wrong in the file on screen, rather than how much is wrong overall.
 *
 * **The active editor, not the workspace**, because "anything wrong in here?" means
 * *here*. A project can carry forty problems in files nobody has open, and answering
 * with those would be answering a different question.
 *
 * The file is reported even when it is clean: "nothing wrong in nanocode.py" needs the
 * name to be worth anything, and it is the answer that stops silence being ambiguous.
 */
function activeFileProblems(): Pick<WorkspaceFacts, 'openProblems' | 'activeFile'> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return {};

  const file = vscode.workspace.asRelativePath(editor.document.uri);
  const problems = vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter(
      (diagnostic) =>
        diagnostic.severity === vscode.DiagnosticSeverity.Error ||
        diagnostic.severity === vscode.DiagnosticSeverity.Warning
    )
    .map((diagnostic) => ({
      // The editor counts lines from zero and shows them from one. The number said out
      // loud has to be the one in the gutter, or it is a number that sends someone to
      // the wrong line.
      line: diagnostic.range.start.line + 1,
      message: diagnostic.message,
      severity:
        diagnostic.severity === vscode.DiagnosticSeverity.Error ? ('error' as const) : ('warning' as const),
    }));

  return { activeFile: file, openProblems: summariseProblems(file, problems) };
}

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
