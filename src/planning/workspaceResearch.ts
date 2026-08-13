import * as vscode from 'vscode';
import { WorkspaceSignals } from './workspaceSignals';

/**
 * A few real facts about the workspace, gathered once before the interview starts.
 *
 * Grounds questions in what's actually there rather than only what the user says —
 * "existing package.json with X" beats asking about a language from nothing when the
 * workspace already answers it. `vscode`-touching, verified live like the rest of
 * M9's glue modules; `describeWorkspaceSignals` (in `workspaceSignals.ts`) is the
 * pure, tested part.
 */

const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt'];
const IGNORED_ENTRIES = new Set(['node_modules', '.git', 'dist', 'out', '.venv', '__pycache__']);

/** Reads the workspace root, one directory listing deep. `undefined` if there is no workspace open. */
export async function researchWorkspace(): Promise<WorkspaceSignals | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;

  const entries = await vscode.workspace.fs.readDirectory(folder.uri).then(
    (result) => result,
    () => []
  );
  const names = entries.map(([name]) => name).filter((name) => !IGNORED_ENTRIES.has(name));

  let readmeFirstLine: string | undefined;
  const readmeName = names.find((name) => /^readme(\.md)?$/i.test(name));
  if (readmeName) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, readmeName));
      readmeFirstLine = Buffer.from(bytes).toString('utf8').split('\n').find((line) => line.trim())?.trim();
    } catch {
      // An unreadable README isn't worth failing the interview over.
    }
  }

  return {
    hasGit: names.includes('.git'),
    manifestFile: MANIFEST_FILES.find((file) => names.includes(file)),
    topLevelEntries: names.slice(0, 15),
    readmeFirstLine,
    planMdExists: names.includes('plan.md'),
  };
}
