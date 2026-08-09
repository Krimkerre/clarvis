import * as vscode from 'vscode';
import { readFile, listFiles, search } from './fileTools';
import { readDiagnostics, gitStatus, gitDiff, runCommand, AgentTerminal } from './commandTools';
import { PathRefused } from './workspacePaths';
import { classifyCommand, explainGate } from '../Gate';

/**
 * Driving the tool layer by hand, without a model.
 *
 * M8c's whole premise is that the tools are built and proven *before* anything can
 * call them (§7). Unit tests cover the logic against temp directories; this covers the
 * half they cannot — the real workspace, the real Git extension, the real diagnostics,
 * and a symlink on the user's actual disk.
 *
 * A debug command rather than a shipped feature: it exists to answer "does the
 * boundary hold in a real host", and M8e replaces it with the model doing the calling.
 */
export async function probeTools(
  root: string | undefined,
  log: (message: string) => void,
  terminal: AgentTerminal
): Promise<void> {
  const tool = await vscode.window.showQuickPick(
    [
      { label: 'readFile', detail: 'Read a file. Try ../../etc/passwd to watch it refuse.', id: 'read' },
      { label: 'listFiles', detail: 'List the workspace, skipping node_modules and .git', id: 'list' },
      { label: 'search', detail: 'Search file contents for a pattern', id: 'search' },
      { label: 'readDiagnostics', detail: "Whatever the language servers are complaining about", id: 'diagnostics' },
      { label: 'gitStatus', detail: 'Branch and change counts', id: 'status' },
      { label: 'gitDiff', detail: 'Unstaged diff', id: 'diff' },
      { label: 'runCommand', detail: 'Run something, visibly, in the Clarvis terminal', id: 'run' },
    ],
    { placeHolder: 'Which tool? These run directly — no model involved.', matchOnDetail: true }
  );
  if (!tool) return;

  try {
    const result = await invoke(tool.id, root, terminal, log);
    await show(result);
  } catch (error) {
    // A refusal is a *result*, not a crash — it is the thing being tested — so it is
    // reported as plainly as a success would be.
    const refused = error instanceof PathRefused;
    log(`tool probe: ${refused ? 'refused' : 'failed'} — ${String(error)}`);

    await show(
      `${refused ? 'REFUSED' : 'ERROR'}\n\n${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function invoke(
  id: string,
  root: string | undefined,
  terminal: AgentTerminal,
  log: (message: string) => void
): Promise<string> {
  if (id === 'read') {
    const requested = await ask('Path to read', 'package.json');
    if (!requested) return 'cancelled';

    const result = await readFile(root, requested);
    return [
      `${requested} — ${result.bytes} bytes${result.truncated ? ' (truncated)' : ''}`,
      '',
      result.text,
    ].join('\n');
  }

  if (id === 'list') {
    const directory = (await ask('Directory to list', '.')) ?? '.';
    const files = await listFiles(root, { directory, recursive: true, limit: 500 });
    return [`${files.length} files under ${directory}`, '', ...files].join('\n');
  }

  if (id === 'search') {
    const pattern = await ask('Pattern (regular expression)', 'TODO');
    if (!pattern) return 'cancelled';

    const hits = await search(root, new RegExp(pattern));
    return [
      `${hits.length} matches for /${pattern}/`,
      '',
      ...hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`),
    ].join('\n');
  }

  if (id === 'diagnostics') {
    const problems = readDiagnostics(root);
    return [`${problems.length} problems`, '', ...problems].join('\n');
  }

  if (id === 'status') return gitStatus();
  if (id === 'diff') return (await gitDiff()) || 'No unstaged changes.';

  if (id === 'run') {
    const command = await ask('Command to run', 'npm test');
    if (!command) return 'cancelled';

    // Gated (§4.6). This was ungated when the probe first shipped, and a plain `rm`
    // ran from the command palette in a live session — a debug command is still a
    // command, and "don't test destructive things" is not a safety mechanism.
    const verdict = classifyCommand(command);
    if (verdict) {
      const approved = await vscode.window.showWarningMessage(
        explainGate(command, verdict),
        { modal: true },
        'Run it'
      );

      if (approved !== 'Run it') {
        log(`gate: refused "${command}" (${verdict.category}, matched "${verdict.matched}")`);
        return `REFUSED\n\n${explainGate(command, verdict)}\n\nNot run.`;
      }
      log(`gate: approved "${command}" (${verdict.category})`);
    }

    terminal.announce(command);
    const result = await runCommand(root, command, (chunk) => terminal.write(chunk), undefined);
    log(`tool probe: "${command}" exited ${result.exitCode} in ${result.durationMs}ms`);

    return [
      `${command}`,
      `exit ${result.exitCode ?? 'killed'} after ${Math.round(result.durationMs / 1000)}s` +
        `${result.timedOut ? ' (timed out)' : ''}${result.truncated ? ' — output truncated' : ''}`,
      '',
      result.output,
    ].join('\n');
  }

  return 'nothing to do';
}

function ask(prompt: string, value: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
}

/** Results open as a plain document — scrollable, searchable, and closable. */
async function show(content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ content, language: 'text' });
  await vscode.window.showTextDocument(document, { preview: true });
}
