import * as vscode from 'vscode';
import {
  describeRun,
  foreignCommits,
  integrationBranch,
  narrateReview,
  reviewOptions,
  reviewWarnings,
  ReviewAction,
  RunSummary,
} from './runReview';
import { isAgentBranch } from './branchNames';
import { parseBranchFlow, BranchFlow } from './branchFlow';

/**
 * The close of an agent run: what happened, what you can do, you decide.
 *
 * A run ends with the user on a branch they did not create, holding work they have not
 * read. Leaving them there with "Done!" is how someone commits their next hour onto an
 * agent branch — which happened during development, to the person who wrote it.
 *
 * Nothing here decides anything. It gathers state, states consequences, and does what
 * it is told.
 */
export async function reviewRun(
  runCommits: string[],
  files: string[],
  log: (message: string) => void,
  /** The branch the run started from, remembered by AgentBranch. */
  origin?: string,
  /** Where to say what happened. The transcript outlives a notification. */
  say: (text: string) => void = () => {},
  /** Teaches the concept behind whatever the user chose, in tutor mode. */
  tutor?: { teach(concept: 'merge' | 'discard' | 'conflict' | 'uncommitted'): Promise<void> }
): Promise<void> {
  const summary = await gather(runCommits, files, origin);
  if (!summary) {
    void vscode.window.showInformationMessage('Clarvis: no git repository here, so there is nothing to review.');
    return;
  }

  const warnings = reviewWarnings(summary);
  const options = reviewOptions(summary);

  const picked = await vscode.window.showQuickPick(
    options.map((option) => ({
      label: option.destructive ? `$(trash) ${option.label}` : option.label,
      detail: option.detail,
      action: option.action,
    })),
    {
      // The warnings ride in the placeholder so they are read before a choice, not
      // after — a warning shown afterwards is an apology.
      placeHolder: warnings.length > 0 ? `⚠ ${warnings[0]}` : describeRun(summary),
      matchOnDetail: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked) return;

  // Every warning, not just the first, before anything irreversible happens.
  if (picked.action === 'discard' && warnings.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `Throw away \`${summary.branch}\`?`,
      { modal: true, detail: warnings.join('\n\n') },
      'Throw it away'
    );
    if (proceed !== 'Throw it away') return;
  }

  // Said before acting when it changes what the choice means, after when it explains
  // what just happened.
  if (summary.uncommitted > 0) await tutor?.teach('uncommitted');

  await act(picked.action, summary, log, say, tutor);

  if (picked.action.startsWith('merge')) await tutor?.teach('merge');
  if (picked.action === 'discard') await tutor?.teach('discard');
}

async function act(
  action: ReviewAction,
  summary: RunSummary,
  log: (message: string) => void,
  say: (text: string) => void,
  tutor?: { teach(concept: 'merge' | 'discard' | 'conflict' | 'uncommitted'): Promise<void> }
): Promise<void> {
  const repository = gitRepository();
  if (!repository) return;

  if (action === 'diff') {
    // The editor's own diff, not a text dump: it is navigable, and it is the view the
    // user already knows how to read.
    await vscode.commands.executeCommand('workbench.view.scm');
    if (summary.base && summary.branch) {
      await vscode.commands.executeCommand(
        'git.viewChanges',
        undefined,
        `${summary.base}...${summary.branch}`
      );
    }
    log('review: showed the diff');
    say(narrateReview('diff', summary));
    return;
  }

  if (action === 'stay') {
    log(`review: staying on ${summary.branch}`);
    say(narrateReview('stay', summary));
    return;
  }

  const home = summary.origin ?? summary.base;

  if (action === 'return' && home) {
    await repository.checkout(home);
    log(`review: returned to ${home}, kept ${summary.branch}`);
    say(narrateReview('return', summary));
    return;
  }

  if (action.startsWith('merge') && summary.branch) {
    const target =
      action === 'merge-origin'
        ? summary.origin
        : action === 'merge-integration'
          ? summary.integration
          : summary.base;
    if (!target) return;

    try {
      await repository.checkout(target);
      await repository.merge(summary.branch);
      log(`review: merged ${summary.branch} into ${target}`);
      say(narrateReview(action, summary, { target, ok: true }));
    } catch (error) {
      // A conflict is a normal outcome, not a failure — and the user is now on the
      // target branch with the merge in progress, which is exactly where they can fix it.
      log(`review: merge into ${target} failed (${String(error)})`);
      say(narrateReview(action, summary, { target, ok: false }));
      void tutor?.teach('conflict');
      // A conflict still warrants a notification: it needs doing something about now,
      // and the transcript is not where someone is looking mid-merge.
      void vscode.window.showWarningMessage(
        `Clarvis: the merge into ${target} didn't apply cleanly — the conflicts are in Source Control.`
      );
    }
    return;
  }

  if (action === 'discard' && summary.branch) {
    if (home) await repository.checkout(home);
    try {
      await repository.deleteBranch(summary.branch, true);
      log(`review: discarded ${summary.branch}`);
      say(narrateReview('discard', summary, { ok: true }));
    } catch (error) {
      log(`review: could not delete ${summary.branch} (${String(error)})`);
      say(narrateReview('discard', summary, { ok: false }));
    }
  }
}

/** Reads the current state of the run from git. */
async function gather(
  runCommits: string[],
  files: string[],
  origin?: string
): Promise<RunSummary | undefined> {
  const repository = gitRepository();
  if (!repository) return undefined;

  const branch = repository.state.HEAD?.name;
  if (!branch || !isAgentBranch(branch)) {
    // Not on an agent branch: the run either had no isolation or the user has already
    // moved. Either way there is no branch to offer options about.
    return {
      files,
      commits: [],
      foreign: [],
      uncommitted: repository.state.workingTreeChanges.length,
    };
  }

  const branches = (await repository.getBranches({ remote: false })).map((entry) => entry.name ?? '');

  // The project's own declared flow wins over convention. A wizard offering `main` to
  // a team whose trunk is `production` is confidently wrong in a way that costs a merge.
  const flow = await declaredFlow();
  const base = pickBase(branches, branch, flow);
  const log = base ? await safeLog(repository, base, branch) : [];

  return {
    branch,
    // Only offered when it still exists: a branch deleted since the run would produce
    // a merge target that fails at the moment the user picks it.
    origin: origin && branches.includes(origin) && !isAgentBranch(origin) ? origin : undefined,
    base,
    integration:
      flow.integration && branches.includes(flow.integration) && flow.integration !== base
        ? flow.integration
        : integrationBranch(branches, base),
    files,
    commits: log,
    foreign: foreignCommits(log, runCommits),
    uncommitted: repository.state.workingTreeChanges.length,
  };
}

/** The trunk: what the project declared, else what most projects call it. */
function pickBase(branches: string[], branch: string, flow: BranchFlow): string | undefined {
  // Only honoured if the branch actually exists — a plan can describe a branch nobody
  // has created yet, and offering to merge into it would fail at the click.
  if (flow.trunk && branches.includes(flow.trunk)) return flow.trunk;

  return (
    ['main', 'master'].find((name) => branches.includes(name)) ??
    branches.find((name) => name && name !== branch && !isAgentBranch(name))
  );
}

/**
 * The branch flow declared in the workspace's `plan.md`, if there is one.
 *
 * Read fresh each time rather than cached: the document is edited by hand, and a
 * cached flow would keep offering the old trunk after someone corrected it.
 */
async function declaredFlow(): Promise<BranchFlow> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return {};

  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'plan.md'));
    return parseBranchFlow(Buffer.from(bytes).toString('utf8'));
  } catch {
    // No plan, or unreadable. Conventions still work.
    return {};
  }
}

async function safeLog(
  repository: GitRepository,
  base: string,
  branch: string
): Promise<{ hash: string; subject: string }[]> {
  try {
    const commits = await repository.log({ range: `${base}..${branch}` });
    return commits.map((commit) => ({
      hash: commit.hash,
      subject: (commit.message ?? '').split('\n')[0],
    }));
  } catch {
    // A missing base, a shallow clone, a rewritten history. Fewer facts, not a failure.
    return [];
  }
}

function gitRepository(): GitRepository | undefined {
  const extension = vscode.extensions.getExtension<GitExports>('vscode.git');
  if (!extension?.isActive) return undefined;

  return extension.exports?.getAPI?.(1)?.repositories?.[0];
}

interface GitExports {
  getAPI(version: 1): { repositories: GitRepository[] };
}

interface GitRepository {
  state: { HEAD?: { name?: string }; workingTreeChanges: unknown[] };
  getBranches(query: { remote: boolean }): Promise<{ name?: string }[]>;
  log(options: { range: string }): Promise<{ hash: string; message?: string }[]>;
  checkout(name: string): Promise<void>;
  merge(ref: string): Promise<void>;
  deleteBranch(name: string, force: boolean): Promise<void>;
}
