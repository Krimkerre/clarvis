import * as vscode from 'vscode';
import { requireTrust } from './trust';
import { spawn } from 'child_process';

/**
 * Running commands, reading diagnostics, and asking git what it thinks.
 *
 * The §4.6 rule for commands is that they are **never a hidden process**: whatever the
 * agent runs is visible, attributable and killable by the user. Two things follow from
 * that, and neither is optional:
 *   - output is echoed into Clarvis's own terminal, so the user watches it happen
 *   - the run is announced in the transcript before it starts, not after it finishes
 *
 * There is no gate here. Gates are M8d, and they attach *above* this layer — a tool
 * that could decide its own permissions would be a tool a model could argue with.
 */

/** How long a command may run before it is killed. Long enough for a test suite. */
export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Output beyond this is truncated: a model does not need 40MB of webpack logs. */
export const MAX_OUTPUT_CHARS = 30_000;

export interface CommandResult {
  command: string;
  exitCode: number | undefined;
  output: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Runs a command in the workspace and captures what it said.
 *
 * Captured *and* mirrored: `spawn` gives us the output to hand back to the model, and
 * the same text is written to a Clarvis terminal so a human can watch. Using only the
 * terminal would mean no output to reason about; using only spawn would mean an
 * invisible process, which §4.6 forbids outright.
 */
export async function runCommand(
  root: string | undefined,
  command: string,
  echo: (chunk: string) => void,
  signal?: AbortSignal
): Promise<CommandResult> {
  if (!root) throw new Error('There is no folder open, so there is nowhere to run that.');

  // A shell command is the most powerful thing here and the least contained — see the
  // note on `shell: true` below. An untrusted folder does not get one.
  requireTrust('run commands');

  const startedAt = Date.now();
  let output = '';
  let truncated = false;
  let timedOut = false;

  const append = (chunk: string) => {
    echo(chunk);
    if (output.length >= MAX_OUTPUT_CHARS) {
      truncated = true;
      return;
    }
    output += chunk;
  };

  return new Promise<CommandResult>((resolve, reject) => {
    // Through a shell because real commands contain pipes and &&. This is exactly why
    // the deny-list in M8d matters: shell syntax is expressive, and the tool layer
    // does not get to assume anything about what it was handed.
    const child = spawn(command, {
      cwd: root,
      shell: true,
      // A pipe rather than inherit: the extension host has no console to inherit.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, COMMAND_TIMEOUT_MS);

    // Stopping a run must actually stop the process, not just stop listening to it.
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (data: Buffer) => append(data.toString()));
    child.stderr?.on('data', (data: Buffer) => append(data.toString()));

    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);

      resolve({
        command,
        // A killed process reports no exit code; the caller distinguishes that from a
        // clean failure, because "cancelled" and "broken" deserve different reactions.
        exitCode: code ?? undefined,
        output: output.slice(0, MAX_OUTPUT_CHARS),
        truncated,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

/**
 * A terminal the user can see, reused across a run.
 *
 * Reused rather than created per command so a ten-step task leaves one terminal
 * behind instead of ten — and so the whole run reads as one continuous transcript.
 */
export class AgentTerminal {
  private terminal: vscode.Terminal | undefined;
  private readonly writer = new vscode.EventEmitter<string>();

  /**
   * A **pseudoterminal**, not a shell terminal.
   *
   * This is a correctness point, not a preference. `Terminal.sendText()` writes to a
   * shell's *input* — echoing a command's output through it would hand every line of
   * that output to a shell to execute. A pty is display-only: nothing typed into it
   * runs, and nothing written to it is interpreted.
   */
  private ensure(): vscode.Terminal {
    if (!this.terminal || this.terminal.exitStatus !== undefined) {
      this.terminal = vscode.window.createTerminal({
        name: 'Clarvis',
        pty: {
          onDidWrite: this.writer.event,
          open: () => this.writer.fire('Clarvis — command output. Nothing typed here runs.\r\n'),
          close: () => undefined,
          // Deliberately inert: keystrokes are swallowed rather than interpreted.
          handleInput: () => undefined,
        },
      });
    }
    return this.terminal;
  }

  /** Announces a command, then echoes its output as it arrives. */
  announce(command: string): void {
    // `show(true)` preserves focus: stealing the cursor mid-typing is its own small
    // betrayal, and the point is visibility, not attention.
    this.ensure().show(true);
    this.write(`\r\n$ ${command}\r\n`);
  }

  /** Brings the output into view without stealing focus. */
  reveal(): void {
    this.ensure().show(true);
  }

  write(chunk: string): void {
    this.ensure();
    // Terminals want CRLF; a bare \n leaves output stair-stepping down the screen.
    this.writer.fire(chunk.replace(/(?<!\r)\n/g, '\r\n'));
  }

  dispose(): void {
    this.terminal?.dispose();
    this.writer.dispose();
  }
}

/**
 * Problems in the workspace, from the same source §4.2 already watches.
 *
 * Reported per file with the severity name spelled out — "1" means nothing to a model,
 * and getting warnings confused with errors is how an agent decides a broken build is
 * fine.
 */
export function readDiagnostics(root: string | undefined, file?: string): string[] {
  const severity = ['error', 'warning', 'info', 'hint'];

  return vscode.languages
    .getDiagnostics()
    .filter(([uri]) => (root ? uri.fsPath.startsWith(root) : true))
    .filter(([uri]) => (file ? uri.fsPath.endsWith(file) : true))
    .flatMap(([uri, diagnostics]) =>
      diagnostics.map(
        (diagnostic) =>
          `${vscode.workspace.asRelativePath(uri)}:${diagnostic.range.start.line + 1} ` +
          `${severity[diagnostic.severity] ?? 'unknown'}: ${diagnostic.message}`
      )
    );
}

/**
 * Read-only git, through the Git extension's API.
 *
 * Absent on a machine with the extension disabled, and on a folder that is not a
 * repository (§4.0) — both are ordinary states, so they return a plain sentence rather
 * than throwing. An agent told "there is no repository here" can carry on; one handed
 * an exception usually cannot.
 */
export async function gitStatus(): Promise<string> {
  const repository = gitRepository();
  if (!repository) return 'No git repository here (or the Git extension is unavailable).';

  const { state } = repository;
  const lines = [
    `branch: ${state.HEAD?.name ?? 'detached'}`,
    `staged: ${state.indexChanges.length}`,
    `unstaged: ${state.workingTreeChanges.length}`,
    `untracked: ${state.untrackedChanges?.length ?? 0}`,
  ];

  return lines.join('\n');
}

export async function gitDiff(staged = false): Promise<string> {
  const repository = gitRepository();
  if (!repository) return 'No git repository here (or the Git extension is unavailable).';

  const diff: string = await repository.diff(staged);
  return diff.length > MAX_OUTPUT_CHARS
    ? `${diff.slice(0, MAX_OUTPUT_CHARS)}\n… diff truncated`
    : diff;
}

/** The first repository the Git extension knows about, if it is there at all. */
function gitRepository():
  | {
      state: {
        HEAD?: { name?: string };
        indexChanges: unknown[];
        workingTreeChanges: unknown[];
        untrackedChanges?: unknown[];
      };
      diff(staged: boolean): Promise<string>;
    }
  | undefined {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension?.isActive) return undefined;

  const api = extension.exports?.getAPI?.(1);
  return api?.repositories?.[0];
}
