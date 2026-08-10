import * as vscode from 'vscode';
import { BranchFlow, flowBranches, parseBranchFlow, writeBranchFlow } from './branchFlow';
import { isAgentBranch } from './branchNames';

/**
 * Noticing a new branch, and asking where it belongs.
 *
 * A declared flow goes stale the moment someone adds `staging` — and a stale flow is
 * worse than none, because the wizard keeps confidently offering the branches it knows
 * while ignoring the one the work is actually meant to pass through.
 *
 * So: ask, once, and write the answer into `plan.md`. Never guess — a branch could be
 * a release line, a colleague's work, or a stray checkout, and inferring from the name
 * would be wrong often enough to be worse than silence.
 */

/** Branches already asked about — including ones the user said to ignore. */
const SEEN_KEY = 'clarvis.branchFlow.seen';

/**
 * Long enough that a branch created and deleted in a moment is never asked about.
 *
 * Branch churn is normal — a checkout, a rebase, a mistake corrected ten seconds
 * later. Asking about each would be exactly the pestering §6 exists to prevent.
 */
const SETTLE_MS = 60_000;

export class BranchFlowWatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void
  ) {}

  /** Starts watching, if there is a repository and a plan to keep in step. */
  start(): vscode.Disposable {
    const repository = gitRepository();
    if (!repository) return new vscode.Disposable(() => undefined);

    const subscription = repository.state.onDidChange(() => this.schedule());
    this.schedule();

    return new vscode.Disposable(() => {
      clearTimeout(this.timer);
      subscription.dispose();
    });
  }

  /** Debounced, because the git extension fires this event constantly. */
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), SETTLE_MS);
  }

  private async check(): Promise<void> {
    const plan = await readPlan();
    if (!plan) return;

    const flow = parseBranchFlow(plan.text);
    // No declared flow means nothing to keep in step. Offering to *create* one here
    // would be Clarvis proposing paperwork nobody asked for.
    if (flowBranches(flow).length === 0) return;

    const repository = gitRepository();
    if (!repository) return;

    const branches = (await repository.getBranches({ remote: false }))
      .map((entry) => entry.name ?? '')
      .filter(Boolean);

    const seen = this.context.workspaceState.get<string[]>(SEEN_KEY) ?? [];
    const known = new Set([...flowBranches(flow), ...seen]);

    // Agent branches are ephemeral by design and are already described by `work:`.
    const unknown = branches.filter((name) => !known.has(name) && !isAgentBranch(name));
    if (unknown.length === 0) return;

    // One at a time. Three questions at once about three branches is a form, and
    // people close forms.
    await this.ask(unknown[0], flow, plan);
  }

  private async ask(
    branch: string,
    flow: BranchFlow,
    plan: { uri: vscode.Uri; text: string }
  ): Promise<void> {
    this.log(`branch flow: asking about "${branch}"`);

    const picked = await vscode.window.showInformationMessage(
      `Clarvis: there's a branch called \`${branch}\` that isn't in the flow in plan.md. Where does it fit?`,
      'Work passes through it',
      'It\'s the trunk',
      'Not part of the flow'
    );

    // Dismissing is an answer too: it means "not now", and asking again next time
    // would make dismissal useless. Recorded either way.
    await this.remember(branch);
    if (!picked) return;

    if (picked === 'Not part of the flow') {
      this.log(`branch flow: "${branch}" marked as outside the flow`);
      return;
    }

    const updated: BranchFlow =
      picked === "It's the trunk"
        ? // The old trunk becomes a step rather than being discarded — a project moving
          // from `master` to `main` still routes work through the old one for a while.
          { ...flow, trunk: branch, extra: [...(flow.extra ?? []), flow.trunk].filter(isName) }
        : { ...flow, extra: [...(flow.extra ?? []), branch] };

    await this.writePlan(plan, updated);
    void vscode.window.showInformationMessage(
      `Clarvis: noted in plan.md. I'll offer \`${branch}\` when a run finishes.`
    );
  }

  /** Rewrites the section in place, leaving the rest of the document alone. */
  private async writePlan(plan: { uri: vscode.Uri; text: string }, flow: BranchFlow): Promise<void> {
    const next = writeBranchFlow(plan.text, flow);

    // Through a WorkspaceEdit so it joins the editor's undo stack — this is the user's
    // document, and a tool that edits it should be undoable like anything else.
    const edit = new vscode.WorkspaceEdit();
    const document = await vscode.workspace.openTextDocument(plan.uri);
    edit.replace(
      plan.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      next
    );

    await vscode.workspace.applyEdit(edit);
    await document.save();
    this.log('branch flow: plan.md updated');
  }

  private async remember(branch: string): Promise<void> {
    const seen = this.context.workspaceState.get<string[]>(SEEN_KEY) ?? [];
    await this.context.workspaceState.update(SEEN_KEY, [...seen, branch]);
  }
}

function isName(value: string | undefined): value is string {
  return Boolean(value);
}

async function readPlan(): Promise<{ uri: vscode.Uri; text: string } | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return undefined;

  const uri = vscode.Uri.joinPath(root, 'plan.md');

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { uri, text: Buffer.from(bytes).toString('utf8') };
  } catch {
    return undefined;
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
  state: { onDidChange: vscode.Event<void> };
  getBranches(query: { remote: boolean }): Promise<{ name?: string }[]>;
}
