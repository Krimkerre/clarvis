import * as vscode from 'vscode';
import { isAgentBranch } from './branchNames';
import { explainSwitchFailure, planSwitch } from './gitPlain';
import { workspaceRepository } from './gitExtension';
import { phrase } from '../personality/Voice';

/**
 * Changing branch, from the chat box.
 *
 * A checkout is one deterministic operation with a known answer — there is nothing for
 * a model to work out, and routing it through the agent would create an isolation
 * branch, switch away from it, then tidy that branch up by switching back, undoing the
 * request in the process.
 *
 * Returns what Clarvis should say, so the caller decides where it appears.
 */
export async function switchBranch(
  requested: string | undefined,
  log: (message: string) => void
): Promise<string | undefined> {
  const repository = await workspaceRepository<GitRepository>();
  if (!repository) {
    return phrase('report', "There's no git repository here, so there's nothing to switch to.");
  }

  const branches = (await repository.getBranches({ remote: false }))
    .map((entry) => entry.name ?? '')
    .filter(Boolean);

  const current = repository.state.HEAD?.name;
  const target = requested ?? (await pickBranch(branches, current));
  if (!target) return undefined;

  if (target === current) return phrase('report', `You're already on \`${target}\`.`, [target]);

  if (!branches.includes(target)) {
    // Named something that isn't there. Better to say so than to create it silently —
    // "switch to tesitng3" is a typo, not a request for a new branch.
    const near = branches.filter((name) => name.toLowerCase().includes(target.toLowerCase()));
    return near.length > 0
      ? phrase('ask', `There's no \`${target}\`. Did you mean \`${near[0]}\`?`, [target, near[0]])
      : phrase('report', `There's no branch called \`${target}\` here.`, [target]);
  }

  // What this will do to work in progress, said *before* it happens. Git carries
  // uncommitted changes across a switch when it can and refuses when it can't,
  // explaining neither — which is the moment a beginner loses confidence.
  const dirty = repository.state.workingTreeChanges.length;
  const plan = planSwitch(
    { branch: current, detached: !current, dirty, ahead: 0, behind: 0, onAgentBranch: false, hasRemote: true },
    target
  );

  if (plan.needsConfirmation) {
    const choice = await vscode.window.showWarningMessage(
      plan.explanation,
      { modal: true },
      plan.saferFirst ?? 'Save them here first',
      'Bring them with me'
    );

    if (!choice) return phrase('report', 'Left you where you were.');

    if (choice === plan.saferFirst) {
      const saved = await commitEverything(repository, current, log);
      if (!saved) {
        return phrase(
          'warn',
          "I couldn't save your changes, so I've not moved you. Nothing is lost — they're still here."
        );
      }
    }
  }

  try {
    await repository.checkout(target);
    log(`branch: switched to ${target}`);
    return phrase('report', `You're on \`${target}\` now.`, [target]);
  } catch (error) {
    log(`branch: could not switch to ${target} (${String(error)})`);
    return phrase('warn', explainSwitchFailure(target), [target]);
  }
}

/**
 * Saves everything before moving, when the user asks for that.
 *
 * `all: true` is right *here* and nowhere else in this project: the user explicitly
 * chose "save my changes before switching", and saving only some of them would leave
 * the rest to follow them across anyway — the exact confusion this option exists to
 * prevent.
 */
async function commitEverything(
  repository: GitRepository,
  branch: string | undefined,
  log: (message: string) => void
): Promise<boolean> {
  try {
    await repository.commit(`Work in progress on ${branch ?? 'this branch'}`, { all: true });
    log('branch: saved changes before switching');
    return true;
  } catch (error) {
    log(`branch: could not save before switching (${String(error)})`);
    return false;
  }
}

/** The picker, for "switch branch" with nothing named. */
async function pickBranch(branches: string[], current?: string): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    branches.map((name) => ({
      label: name === current ? `$(check) ${name}` : name,
      // Agent branches are listed but marked: they exist for review, not for working on.
      description: isAgentBranch(name) ? 'an agent run' : '',
      name,
    })),
    { placeHolder: 'Which branch?' }
  );

  return picked?.name;
}

interface GitRepository {
  rootUri?: { fsPath: string };
  state: { HEAD?: { name?: string }; workingTreeChanges: unknown[] };
  getBranches(query: { remote: boolean }): Promise<{ name?: string }[]>;
  checkout(name: string): Promise<void>;
  commit(message: string, options?: { all: boolean }): Promise<void>;
}
