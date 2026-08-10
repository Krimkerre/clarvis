import * as vscode from 'vscode';
import { BranchFlow, flowBranches, matchesWork, parseBranchFlow, writeBranchFlow } from './branchFlow';
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

/**
 * The first check, timed to land just after the launch briefing.
 *
 * Branches that already exist when a window opens are not churn — they were there
 * before Clarvis was, and making someone wait a minute to be told about one is a
 * delay with no purpose. The settle time exists for *changes* during a session, which
 * is a different thing.
 *
 * Behind the briefing (§4.3 fires at 1.5s) so the two never arrive together: a
 * question stacked on top of a briefing gets dismissed along with it.
 */
const STARTUP_MS = 4000;

export class BranchFlowWatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    /** Where to say things. The transcript, rather than a notification that vanishes. */
    private readonly say: (text: string) => void = () => {}
  ) {}

  /**
   * Starts watching.
   *
   * **Asynchronously, and without giving up.** The first version asked the Git
   * extension for a repository during activation and returned a no-op when there
   * wasn't one — which is always, because the Git extension activates *after* us and
   * discovers repositories later still. The watcher silently never ran, and looked
   * exactly like a working feature that had nothing to say.
   */
  start(): vscode.Disposable {
    const subscriptions: vscode.Disposable[] = [];
    void this.attach(subscriptions);

    return new vscode.Disposable(() => {
      clearTimeout(this.timer);
      clearTimeout(this.startupTimer);
      for (const subscription of subscriptions) subscription.dispose();
    });
  }

  private async attach(subscriptions: vscode.Disposable[]): Promise<void> {
    const api = await gitApi();
    if (!api) {
      this.log('branch flow: no Git extension, not watching');
      return;
    }

    // Repositories are discovered asynchronously, so a repository opened after this
    // point still needs wiring — including the common case of none existing yet.
    subscriptions.push(api.onDidOpenRepository((repository) => this.watch(repository, subscriptions)));
    for (const repository of api.repositories) this.watch(repository, subscriptions);

    this.log(`branch flow: watching (${api.repositories.length} repository/ies at start)`);
    this.scheduleStartup();
  }

  private watch(repository: GitRepository, subscriptions: vscode.Disposable[]): void {
    subscriptions.push(repository.state.onDidChange(() => this.schedule()));
    this.scheduleStartup();
  }

  /**
   * The one-off check after launch, on a timer of its own.
   *
   * Deliberately not shared with the debounce below: the git extension fires state
   * changes constantly, and a single shared timer meant every one of them pushed the
   * startup check further away. It never ran at all.
   */
  private scheduleStartup(): void {
    clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => void this.check(), STARTUP_MS);
  }

  /**
   * Debounced, because the git extension fires this event constantly.
   *
   * **Trailing without resetting.** The obvious debounce — clear the timer and set a
   * new one on every event — starves completely against an event source that never
   * goes quiet: each change pushed the deadline out another minute, forever. This
   * runs a minute after the *first* event of a burst instead, which is the behaviour
   * the settle time was meant to have.
   */
  private schedule(): void {
    if (this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, SETTLE_MS);
  }

  private async check(): Promise<void> {
    this.log('branch flow: checking');
    const plan = await readPlan();
    if (!plan) {
      this.log('branch flow: no plan.md, nothing to keep in step');
      return;
    }

    const flow = parseBranchFlow(plan.text);
    // No declared flow means nothing to keep in step. Offering to *create* one here
    // would be Clarvis proposing paperwork nobody asked for.
    if (flowBranches(flow).length === 0) {
      this.log('branch flow: plan.md declares no flow');
      return;
    }

    const repository = (await gitApi())?.repositories?.[0];
    if (!repository) {
      this.log('branch flow: no repository yet');
      return;
    }

    const branches = (await repository.getBranches({ remote: false }))
      .map((entry) => entry.name ?? '')
      .filter(Boolean);

    const seen = this.context.workspaceState.get<string[]>(SEEN_KEY) ?? [];
    const known = new Set([...flowBranches(flow), ...seen]);

    // Agent branches are ephemeral by design, and anything matching a `work:` pattern
    // is a feature branch rather than a step in the flow — without that check, a
    // project with twelve milestone branches gets asked about all twelve.
    const unknown = branches.filter(
      (name) => !known.has(name) && !isAgentBranch(name) && !matchesWork(name, flow.work)
    );

    // Logged either way: "checked and found nothing" and "never ran" look identical
    // from the outside, and telling them apart took a session.
    this.log(
      `branch flow: ${branches.length} branch(es), ${unknown.length} unaccounted for` +
        (unknown.length > 0 ? ` (${unknown.join(', ')})` : '')
    );
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
    this.say(
      picked === "It's the trunk"
        ? `Noted — \`${branch}\` is the trunk now, and \`${flow.trunk}\` stays in the flow as a step. plan.md says so.`
        : `Noted in plan.md: work passes through \`${branch}\`. I'll offer it when a run finishes.`
    );

    await this.offerToCommit(branch);
  }

  /**
   * Offers to commit the change to `plan.md`.
   *
   * Offered, never done quietly: it is the user's document and their history, and a
   * tool that commits on someone's behalf without asking has made a decision about
   * what belongs in their log. Only `plan.md` is staged — never `-A`, for the same
   * reason the agent never sweeps up unrelated work.
   */
  private async offerToCommit(branch: string): Promise<void> {
    const answer = await vscode.window.showInformationMessage(
      'Clarvis: commit that change to plan.md?',
      'Commit it',
      'Leave it'
    );
    if (answer !== 'Commit it') return;

    const repository = (await gitApi())?.repositories?.[0];
    if (!repository) return;

    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;

    try {
      await repository.add([vscode.Uri.joinPath(root, 'plan.md').fsPath]);
      await repository.commit(`Add ${branch} to the branch flow`, { all: false });
      this.log('branch flow: committed plan.md');
      this.say('Committed. Only plan.md — whatever else you have in flight is still yours.');
    } catch (error) {
      this.log(`branch flow: commit failed (${String(error)})`);
      this.say("I couldn't commit it — the change is saved in plan.md, so it's only the commit that's missing.");
    }
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

/**
 * The Git extension's API, activating it if it hasn't started yet.
 *
 * `isActive` is false during our own activation — checking it and giving up is how the
 * watcher came to never run at all.
 */
async function gitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExports>('vscode.git');
  if (!extension) return undefined;

  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports?.getAPI?.(1);
  } catch {
    return undefined;
  }
}

interface GitExports {
  getAPI(version: 1): GitApi;
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitRepository {
  state: { onDidChange: vscode.Event<void> };
  getBranches(query: { remote: boolean }): Promise<{ name?: string }[]>;
  add(paths: string[]): Promise<void>;
  commit(message: string, options?: { all: boolean }): Promise<void>;
}
