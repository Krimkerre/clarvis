import * as vscode from 'vscode';
import { isAgentBranch } from './branchNames';

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
  const repository = await gitRepository();
  if (!repository) return "There's no git repository here, so there's nothing to switch to.";

  const branches = (await repository.getBranches({ remote: false }))
    .map((entry) => entry.name ?? '')
    .filter(Boolean);

  const current = repository.state.HEAD?.name;
  const target = requested ?? (await pickBranch(branches, current));
  if (!target) return undefined;

  if (target === current) return `You're already on \`${target}\`.`;

  if (!branches.includes(target)) {
    // Named something that isn't there. Better to say so than to create it silently —
    // "switch to tesitng3" is a typo, not a request for a new branch.
    const near = branches.filter((name) => name.toLowerCase().includes(target.toLowerCase()));
    return near.length > 0
      ? `There's no \`${target}\`. Did you mean \`${near[0]}\`?`
      : `There's no branch called \`${target}\` here.`;
  }

  try {
    await repository.checkout(target);
    log(`branch: switched to ${target}`);
    return `You're on \`${target}\` now.`;
  } catch (error) {
    log(`branch: could not switch to ${target} (${String(error)})`);
    // Almost always uncommitted changes that would be overwritten. Saying which is
    // more useful than reporting that git said no.
    return `I couldn't switch to \`${target}\` — usually that means uncommitted changes would be trampled. The Source Control view will say which.`;
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

async function gitRepository(): Promise<GitRepository | undefined> {
  const extension = vscode.extensions.getExtension<GitExports>('vscode.git');
  if (!extension) return undefined;

  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports?.getAPI?.(1)?.repositories?.[0];
}

interface GitExports {
  getAPI(version: 1): { repositories: GitRepository[] };
}

interface GitRepository {
  state: { HEAD?: { name?: string } };
  getBranches(query: { remote: boolean }): Promise<{ name?: string }[]>;
  checkout(name: string): Promise<void>;
}
