import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { realpath } from 'fs/promises';
import { execFile } from 'child_process';
import { macProfile, Sandbox, sandboxArgv } from './sandboxProfile';
import { installCommand, packageManagers } from './bwrapInstall';

/**
 * Finding a sandbox, writing its profile, and asking once when there isn't one.
 *
 * The profile itself is pure and lives next door; this is the part that touches the
 * machine — what is installed, where the caches are, and what the user said the one
 * time they were asked.
 */

/** Answered once per workspace, like the `git init` offer. */
const UNCONFINED_KEY = 'clarvis.agent.allowUnconfinedCommands';

/** Cached per session: `which` on every command would be silly. */
let detected: Sandbox | undefined | null = null;

/**
 * Which sandbox this machine has, if any.
 *
 * macOS ships `sandbox-exec` and has since forever. It is formally deprecated, and
 * has been since 10.14 while continuing to ship in every release since — Chrome and
 * Homebrew both depend on it. If it ever goes, this returns undefined and the
 * unconfined path takes over, which is the same as any Linux box without bubblewrap.
 */
export async function availableSandbox(log?: (message: string) => void): Promise<Sandbox | undefined> {
  if (detected !== null) return detected;

  const candidate: Sandbox | undefined =
    process.platform === 'darwin' ? 'sandbox-exec' : process.platform === 'linux' ? 'bwrap' : undefined;

  detected = candidate && (await canRun(candidate)) ? candidate : undefined;
  // Said once per session, because "no sandbox on macOS" means `which` did not
  // resolve in the extension host rather than the machine lacking one, and that is
  // worth being able to see rather than deduce.
  log?.(
    detected
      ? `sandbox: using ${detected} on ${process.platform}`
      : `sandbox: none available on ${process.platform}${candidate ? ` — \`${candidate}\` did not resolve` : ''}`
  );
  return detected;
}

function canRun(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [binary], (error) => resolve(!error));
  });
}

/**
 * Paths a build writes to that are not the project.
 *
 * Package managers keep their caches in the home directory and fail loudly without
 * them — a confined `npm install` that cannot write `~/.npm` is a confined install
 * that does not work. These are places tools keep things; nowhere a person does.
 */
function buildCaches(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.npm'),
    path.join(home, '.cache'),
    path.join(home, '.cargo'),
    path.join(home, '.rustup'),
    path.join(home, '.gradle'),
    path.join(home, '.m2'),
    path.join(home, 'Library', 'Caches'),
    os.tmpdir(),
  ];
}

/**
 * Resolves symlinks, because the kernel matches on the real path.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS, so a rule written against the
 * symlink matches nothing — found by writing one, watching it deny a write it had
 * explicitly allowed, and being unable to tell that from the sandbox simply working.
 * Paths that do not exist are dropped rather than guessed at.
 */
async function resolveAll(paths: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(paths.map((entry) => realpath(entry).catch(() => undefined)));
  return resolved.filter((entry): entry is string => Boolean(entry));
}

/** How a command should be spawned: confined where possible, plainly where not. */
export interface Spawn {
  file: string;
  args: string[];
  confined: boolean;
  /** Which mechanism, for the log — "confined" alone does not say by what. */
  via?: Sandbox;
}

/**
 * Builds the spawn for one command.
 *
 * Returns an unconfined spawn when there is no sandbox on this machine — the caller
 * has already asked whether that is acceptable, and refusing outright would make
 * Clarvis useless on Windows while pushing people to run the same command in a
 * terminal, with no gate, no snapshot and no log.
 */
export async function spawnFor(
  command: string,
  root: string,
  storageDir: string,
  log?: (message: string) => void
): Promise<Spawn> {
  const sandbox = await availableSandbox(log);
  if (!sandbox) return { file: command, args: [], confined: false };
  

  const [workspace] = await resolveAll([root]);
  const caches = await resolveAll(buildCaches());

  if (!workspace) return { file: command, args: [], confined: false };

  let profilePath = '';
  if (sandbox === 'sandbox-exec') {
    await fs.mkdir(storageDir, { recursive: true });
    profilePath = path.join(storageDir, 'commands.sb');
    await fs.writeFile(profilePath, macProfile(workspace, caches), 'utf8');
  }

  const { file, args } = sandboxArgv(sandbox, profilePath, workspace, caches, command);
  return { file, args, confined: true, via: sandbox };
}

/**
 * Offers to install bubblewrap, on a Linux box that has a package manager but no
 * sandbox.
 *
 * **The command is handed over, not run.** Installing it needs root, and an extension
 * that runs `sudo` on your behalf has quietly become the thing the sandbox exists to
 * prevent — quite apart from having nowhere to type a password. So it opens a terminal
 * with the line already in it, unexecuted: the user reads it, presses Enter, and their
 * own shell asks for the password, exactly as it would have if they had typed it.
 *
 * Returns true when they went to install, which means the answer to "may I run
 * unconfined" is neither yes nor no — it is "ask me again in a minute", so nothing is
 * remembered and the next command re-probes.
 */
async function offerSandboxInstall(log: (message: string) => void): Promise<boolean> {
  const manager = await firstAvailable(packageManagers());
  const command = installCommand(manager);
  if (!command) {
    log('sandbox: no known package manager here — cannot offer to install bubblewrap');
    return false;
  }

  const answer = await vscode.window.showWarningMessage('I can\'t confine commands on this machine — yet.', {
    modal: true,
    detail:
      'Everywhere else, a command I run can only change files inside this project. ' +
      'On Linux that needs bubblewrap, which is a small standard package and is not installed here.\n\n' +
      `I can open a terminal with the install line ready:\n    ${command}\n\n` +
      'You press Enter and give your password — I never run it myself. ' +
      'Then ask me again and commands will be confined.',
  }, 'Open a terminal with it ready');

  if (answer !== 'Open a terminal with it ready') return false;

  const terminal = vscode.window.createTerminal('Install bubblewrap');
  terminal.show();
  // `false`: no newline, so it sits at the prompt waiting to be read and run rather
  // than executing a sudo command nobody had the chance to look at.
  terminal.sendText(command, false);
  log(`sandbox: offered \`${command}\` in a terminal`);

  // The probe is cached for the session, and the whole point is that the answer has
  // just changed.
  detected = null;
  return true;
}

/** The first of these binaries that resolves, or undefined if none do. */
async function firstAvailable(binaries: string[]): Promise<string | undefined> {
  for (const binary of binaries) {
    if (await canRun(binary)) return binary;
  }
  return undefined;
}

/**
 * Whether running commands unconfined is acceptable here.
 *
 * **Asked once per workspace and remembered**, the same shape as the `git init`
 * offer: a question that returns every time is one people learn to dismiss, and this
 * one has a real answer that does not change. Declining leaves commands refused,
 * which still leaves reading, answering, planning and editing files.
 */
export type UnconfinedAnswer = 'allowed' | 'refused' | 'installing';

export async function mayRunUnconfined(
  context: vscode.ExtensionContext,
  log: (message: string) => void
): Promise<UnconfinedAnswer> {
  const remembered = context.workspaceState.get<boolean>(UNCONFINED_KEY);
  if (remembered !== undefined) return remembered ? 'allowed' : 'refused';

  // **Offer the fix before asking them to live without it.** Asking "shall I run
  // unconfined?" on a machine where one apt-get away is a working sandbox is a
  // security question with a better answer that was never mentioned. Nothing is
  // remembered either way: they either install it, or they get asked properly below.
  if (process.platform === 'linux' && (await offerSandboxInstall(log))) return 'installing';

  const answer = await vscode.window.showWarningMessage(
    'I can\'t confine commands on this machine.',
    {
      modal: true,
      detail:
        'Everywhere else, a command I run can only change files inside this project. ' +
        'This machine has no sandbox I can use, so anything I run has the same access you do — ' +
        'including files outside this folder.\n\n' +
        'Run commands anyway? Everything else works either way, and I still ask before each one ' +
        'and snapshot your files first.',
    },
    'Run them anyway',
    'No, refuse commands'
  );

  const allowed = answer === 'Run them anyway';
  await context.workspaceState.update(UNCONFINED_KEY, allowed);
  log(`sandbox: none available, unconfined commands ${allowed ? 'allowed' : 'refused'} for this workspace`);
  return allowed ? 'allowed' : 'refused';
}

/** Forgets the answer, for the command that lets someone change their mind. */
export async function forgetUnconfinedAnswer(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(UNCONFINED_KEY, undefined);
}
