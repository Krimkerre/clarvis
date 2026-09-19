/**
 * M13: a copy of this window's extension-host log, for troubleshooting (§6.8 of CLARVIS.md —
 * an approved raw aid, never status). Rebuilt 19 September 2026 (0.17.21):
 *
 * - **Read from the right place** — `logSource.hostLogFor`, beside `context.logUri`, so the
 *   right window's log on desktop VS Code and code-server alike.
 * - **Written outside the project**, to `context.storageUri` (this workspace's own storage,
 *   which the editor keeps elsewhere). It used to be `.clarvis/vscode.log` in the workspace,
 *   where Clarvis's agent or a Codex task could read it and git could commit it — and the log
 *   holds whole commands and paths.
 * - **Approved once per workspace**, remembered in `workspaceState` until revoked with
 *   "Clarvis: Revoke Log Copying", which also stops the copy. Copying resumes when the window
 *   starts only where it is approved and was left on — Stop holds until Start.
 * - **Appended, never truncated**, resuming at the byte it reached (`startOffset`), and set
 *   aside once as `vscode.log.1` past `ROTATE_BYTES`.
 * - **Ends with the extension host**: the `tail` process is a disposable, so a reload does not
 *   orphan it. Spawned, not `execFile`d: `execFile` also keeps all output in memory for its
 *   callback and kills the process past a megabyte, which a followed log reaches.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { ClarvisLog } from '../ClarvisLog';
import { ROTATE_BYTES, hostLogFor, startOffset, tailArguments, type Progress } from './logSource';

const APPROVED = 'clarvis.logCopy.approvedAt';
const PROGRESS = 'clarvis.logCopy.progress';
/** Whether the owner left it on: Stop holds across a reload until Start, not only until one. */
const ON = 'clarvis.logCopy.on';

interface Copying {
  readonly process: ChildProcess;
  readonly stream: fs.WriteStream;
  readonly source: string;
  offset: number;
}

let copying: Copying | undefined;

/** The copy's file in this workspace's storage, or undefined with no folder open. */
function copyUri(context: vscode.ExtensionContext): vscode.Uri | undefined {
  return context.storageUri ? vscode.Uri.joinPath(context.storageUri, 'vscode.log') : undefined;
}

async function approve(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.workspaceState.get<string>(APPROVED)) return true;
  const answer = await vscode.window.showWarningMessage(
    "Copy this window's extension-host log for troubleshooting? It may contain commands, file " +
      "paths and tool details. The copy is kept in Clarvis's own storage for this workspace, " +
      'outside the project, so the agent cannot read it and git cannot commit it. Your approval ' +
      'is remembered for this workspace until you run "Clarvis: Revoke Log Copying".',
    { modal: true },
    'Approve'
  );
  if (answer !== 'Approve') return false;
  await context.workspaceState.update(APPROVED, new Date().toISOString());
  return true;
}

function setAside(file: string): void {
  try {
    if (fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // No copy yet: nothing to set aside.
  }
}

/** Start copying. `quiet` for the resume at startup, which should not pop a message. */
async function begin(context: vscode.ExtensionContext, log: ClarvisLog, quiet: boolean): Promise<void> {
  if (copying) {
    if (!quiet) void offerToOpen(context, 'Clarvis is already copying the log.');
    return;
  }
  const target = copyUri(context);
  if (!target) {
    if (!quiet) void vscode.window.showErrorMessage('Clarvis: open a folder first — the copy is kept per workspace.');
    return;
  }
  const source = hostLogFor(context.logUri.fsPath, fs.existsSync);
  if (!source) {
    log.write(`log copy: no extension-host log beside ${context.logUri.fsPath}`);
    if (!quiet) void vscode.window.showErrorMessage("Clarvis: this window's extension-host log was not found.");
    return;
  }

  fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
  setAside(target.fsPath);
  const saved = context.workspaceState.get<Progress>(PROGRESS);
  const offset = startOffset(saved, source, fs.statSync(source).size);

  const stream = fs.createWriteStream(target.fsPath, { flags: 'a' });
  stream.on('error', (e) => log.write(`log copy: writing failed: ${e.message}`));
  stream.write(`--- Clarvis log copy from ${path.basename(source)}, ${new Date().toISOString()} ---\n`);
  const proc = spawn('tail', tailArguments(source, offset), { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.on('error', (e) => log.write(`log copy: tail failed: ${e.message}`));
  const state: Copying = { process: proc, stream, source, offset };
  proc.stdout?.on('data', (chunk: Buffer) => {
    stream.write(chunk);
    state.offset += chunk.length;
  });
  copying = state;
  log.write(`log copy: from ${source} at byte ${offset} to ${target.fsPath}`);

  if (!quiet) void announce(context);
}

async function announce(context: vscode.ExtensionContext): Promise<void> {
  // The copy the old version left inside the project, readable by the agent: said once.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const old = folder && vscode.Uri.joinPath(folder, '.clarvis', 'vscode.log');
  const oldExists = old !== undefined && fs.existsSync(old.fsPath);
  const choice = await vscode.window.showInformationMessage(
    'Clarvis is copying this window\'s log, outside the project.' +
      (oldExists ? ' An older copy is still in this project at .clarvis/vscode.log, where the agent can read it.' : ''),
    'Open the copy',
    ...(oldExists ? ['Move the old copy to the Trash'] : [])
  );
  if (choice === 'Open the copy') {
    await openCopy(context);
  } else if (choice && old) {
    await vscode.workspace.fs.delete(old, { useTrash: true });
  }
}

/** A message with an "Open the copy" button, for when the first one has already hidden. */
async function offerToOpen(context: vscode.ExtensionContext, message: string): Promise<void> {
  if ((await vscode.window.showInformationMessage(message, 'Open the copy')) === 'Open the copy') {
    await openCopy(context);
  }
}

/**
 * "Clarvis: Open Log Copy". Added 19 September 2026 (0.17.22): the only way to the copy was the
 * button on the start message, and that notification hides after a few seconds.
 */
async function openCopy(context: vscode.ExtensionContext): Promise<void> {
  const target = copyUri(context);
  if (!target || !fs.existsSync(target.fsPath)) {
    void vscode.window.showInformationMessage(
      'Clarvis has no log copy for this workspace yet. Run "Clarvis: Start Copying This Window\'s Log" first.'
    );
    return;
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  // Read-only for this session, so nobody types into a file `tail` is appending to. A workbench
  // command rather than an API (there is none for a file on disk); an editor without it still opens.
  await Promise.resolve(
    vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession')
  ).catch(() => undefined);
}

/** Stop copying and remember how far it got. True if something was stopped. */
async function end(context: vscode.ExtensionContext, log: ClarvisLog): Promise<boolean> {
  const was = copying;
  if (!was) return false;
  copying = undefined;
  was.process.kill();
  was.stream.end();
  await context.workspaceState.update(PROGRESS, { source: was.source, offset: was.offset });
  log.write(`log copy: stopped at byte ${was.offset}`);
  return true;
}

/** The four commands, the stop on shutdown, and the resume where approved. */
export function registerLogTailing(context: vscode.ExtensionContext, log: ClarvisLog): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.startLogTailing', async () => {
      if (!(await approve(context))) return;
      await context.workspaceState.update(ON, true);
      await begin(context, log, false);
    }),
    vscode.commands.registerCommand('clarvis.stopLogTailing', async () => {
      await context.workspaceState.update(ON, false);
      const stopped = await end(context, log);
      void vscode.window.showInformationMessage(
        stopped ? 'Clarvis stopped copying the log. It resumes when you start it again.'
          : 'Clarvis is not copying the log.'
      );
    }),
    vscode.commands.registerCommand('clarvis.openLogCopy', () => openCopy(context)),
    vscode.commands.registerCommand('clarvis.revokeLogCopying', async () => {
      await end(context, log);
      await context.workspaceState.update(APPROVED, undefined);
      await context.workspaceState.update(PROGRESS, undefined);
      await context.workspaceState.update(ON, undefined);
      const target = copyUri(context);
      const kept = target !== undefined && fs.existsSync(target.fsPath);
      const choice = await vscode.window.showInformationMessage(
        'Log copying is revoked for this workspace; Clarvis will ask again before copying.',
        ...(kept ? ['Move the copy to the Trash'] : [])
      );
      if (choice && target) await vscode.workspace.fs.delete(target, { useTrash: true });
    }),
    { dispose: () => void end(context, log) }
  );
  if (context.workspaceState.get<string>(APPROVED) && context.workspaceState.get<boolean>(ON)) {
    void begin(context, log, true);
  }
}
