/**
 * Codex work left on its branch: the idle Codex tasks in this project a new request could build on (plan.md M15,
 * "Build on Codex's earlier work"; the owner's decision of 15 Sep 2026, "Ask each time").
 *
 * **What happened without it.** Found live on 15 Sep 2026 in code-server. Codex built a greeter on its own branch, and
 * the owner answered "Leave it there". The follow-up ("Also add a --shout option to greet.py…") then started a new Codex
 * task on a new branch from `master`. `greet.py` wasn't on that branch, so Codex wrote a second greeter from scratch
 * beside the first, and one more idle task was left behind in RAVIS.
 *
 * **What counts as left**, each checked here, in this order:
 * - Codex may run at all (`GET /api/v1/codex`). Readiness comes before any question, so a Codex that can't start meets
 *   its own refusal and is never asked about first;
 * - the checkout has a commit, and a trunk to compare against. That is the project's declared trunk (`plan.md`'s branch
 *   flow, when that branch exists), else the branch a fresh task starts from (`startingBase`). Never a literal `main`;
 * - RAVIS lists the session for this folder as `idle`: settled, its thread kept, able to continue;
 * - this Mac's token file holds the session's key, and RAVIS accepts it. The view read with that key must say `idle`
 *   and name the branch. A session whose key is missing isn't offered: its branch can only be read with a key, and the
 *   only way to get one, a reissue, revokes the old key and is audited. That isn't done for every idle task each time
 *   someone asks for work, before they have chosen anything;
 * - its branch still exists and has commits that are in neither the trunk nor the branch a fresh task starts from. A
 *   branch merged there has nothing left to build on.
 *
 * Only the ten most recent idle sessions are read, and one task is kept per branch, the most recent.
 *
 * vscode-free: the relay, the token file and git are handed in, so all of it runs against `FakeRavisRelay` and real
 * temporary repositories (`leftTasks.test.ts`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseBranchFlow } from '../../agent/branchFlow';
import { startingBase } from '../../agent/branchNames';
import type { GitFacts } from '../checkpoint/gitFacts';
import { codexReadiness } from '../relay/codexReadiness';
import type { RelayClient } from '../relay/relayClient';
import type { SessionSummary } from '../relay/relayTypes';
import type { TokenRead } from '../relay/tokenStore';
import type { BuildOnTask } from './runCore';

/** How many of the most recent idle sessions are read: each costs a request to RAVIS. */
const MOST_READ = 10;
/** How many **Build on** buttons the question offers, at most. */
export const MOST_OFFERED = 3;
/** Scratch space Codex's commands may use: never the owner's work (`codexGit.ts`). */
const SCRATCH = '.clarvis/tmp/';

/** One idle Codex task whose work is still on its own branch. */
export interface LeftTask extends BuildOnTask {
  taskId: string;
  updatedAt: string;
  /** The window's checkout is on this branch. */
  onBranch: boolean;
}

/** What was found, and the branches the question names. Empty `tasks` means nothing is asked. */
export interface LeftWork {
  /** The branch a fresh task starts from: what **Start fresh from …** names. */
  startsFrom?: string;
  /** The trunk the question says the work isn't merged into. */
  trunk?: string;
  /** The branch the checkout is on; undefined when HEAD is detached. */
  headBranch?: string;
  tasks: LeftTask[];
}

export interface LeftWorkDeps {
  relay: Pick<RelayClient, 'codexState' | 'listSessions' | 'getSession'>;
  tokens: { read(workspaceRoot: string, sessionId: string): TokenRead };
  git: Pick<GitFacts, 'head' | 'branches' | 'tip' | 'isAncestor'>;
  root: string;
  /** `clarvis.agent.baseBranch`: the base remembered from an earlier run, as `AgentBranch` keeps it. */
  rememberedBase?: string;
  /** `plan.md`'s text. Read from the root when absent. */
  planText?: string;
  log?: (line: string) => void;
}

/** Where this checkout stands: the branches work counts as merged into, and their tips. */
interface Place {
  startsFrom: string;
  trunk: string;
  headBranch?: string;
  mains: string[];
  mainTips: string[];
}

/** The left Codex work in this folder, most recent first, or none when anything needed to judge it is missing. */
export async function findLeftWork(deps: LeftWorkDeps): Promise<LeftWork> {
  if (!(await codexMayRun(deps))) return { tasks: [] };
  const place = await placeOf(deps);
  if (!place) return { tasks: [] };
  const listed = await deps.relay.listSessions(deps.root);
  if (!listed.ok) {
    deps.log?.(`codex left work: this folder's Codex tasks couldn't be listed (${listed.failure.kind}), so nothing is offered`);
    return { tasks: [] };
  }
  const tasks: LeftTask[] = [];
  for (const session of idleByRecency(listed.value)) {
    const task = await leftTask(deps, place, session);
    if (task && !tasks.some((kept) => kept.branch === task.branch)) tasks.push(task);
  }
  return { startsFrom: place.startsFrom, trunk: place.trunk, headBranch: place.headBranch, tasks };
}

/**
 * The tasks the question offers: the one on the branch the window is on first, then the most recent, at most three.
 */
export function offeredTasks(tasks: readonly LeftTask[]): LeftTask[] {
  const here = tasks.filter((task) => task.onBranch);
  const others = tasks.filter((task) => !task.onBranch).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return [...here, ...others].slice(0, MOST_OFFERED);
}

/**
 * Why building on `branch` is refused, in plain words, or undefined when it isn't.
 *
 * **Refused, not guessed.** Checking out another branch carries uncommitted changes along when git can and refuses when
 * it can't, so switching with the owner's work in flight would either move that work onto Codex's branch or fail
 * part-way. Either way it would be the owner's work moved by a question about Codex's. So any modified, staged or
 * untracked file refuses a switch, and nothing runs. On the branch already there is no switch, and files in flight stay
 * the owner's as they do for any run: never committed as Codex's (`dirtyAtStart.planCommit`).
 */
export function buildOnRefusal(headBranch: string | undefined, branch: string, dirty: readonly string[]): string | undefined {
  if (headBranch === branch) return undefined;
  const theirs = dirty.filter((file) => !file.startsWith(SCRATCH));
  return theirs.length === 0 ? undefined : uncommittedLine(headBranch, branch, theirs);
}

async function codexMayRun(deps: LeftWorkDeps): Promise<boolean> {
  const state = await deps.relay.codexState();
  const failure = state.ok ? codexReadiness(state.value) : state.failure;
  if (failure) deps.log?.(`codex left work: Codex may not run (${failure.kind}), so nothing is asked and the task meets its own refusal`);
  return failure === undefined;
}

/** The trunk and the starting branch with their tips, or undefined when there is no commit or no branch to compare with. */
async function placeOf(deps: LeftWorkDeps): Promise<Place | undefined> {
  const head = await deps.git.head();
  if (!head.commit) return undefined;
  const branches = await deps.git.branches();
  const startsFrom = startingBase(head.branch, false, deps.rememberedBase, branches);
  const declared = parseBranchFlow(deps.planText ?? readPlan(deps.root)).trunk;
  const trunk = declared && branches.includes(declared) ? declared : startsFrom;
  if (!startsFrom || !trunk) return undefined;
  const mains = [...new Set([trunk, startsFrom])];
  const mainTips = await Promise.all(mains.map((name) => deps.git.tip(name)));
  // Not knowing is not "not merged": a tip that can't be read offers nothing.
  if (mainTips.some((tip) => tip === undefined)) return undefined;
  return { startsFrom, trunk, headBranch: head.branch, mains, mainTips: mainTips as string[] };
}

function idleByRecency(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions
    .filter((session) => session.state === 'idle')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, MOST_READ);
}

async function leftTask(deps: LeftWorkDeps, place: Place, session: SessionSummary): Promise<LeftTask | undefined> {
  const opened = await openedWithKey(deps, session);
  if ('skip' in opened) return notOffered(deps, session, opened.skip);
  const { branch, taskId } = opened;
  if (place.mains.includes(branch)) return notOffered(deps, session, `it worked on ${branch} itself`);
  const tip = await deps.git.tip(branch);
  if (!tip) return notOffered(deps, session, `its branch ${branch} is gone`);
  if (await mergedInto(deps, place, tip)) return notOffered(deps, session, `${branch} is merged into ${place.mains.join(' or ')}`);
  return { sessionId: session.id, taskId, branch, tip, updatedAt: session.updated_at, onBranch: branch === place.headBranch };
}

/** The session's branch, read with its stored key; or why it can't be. */
async function openedWithKey(deps: LeftWorkDeps, session: SessionSummary): Promise<{ branch: string; taskId: string } | { skip: string }> {
  const read = deps.tokens.read(deps.root, session.id);
  if (read.kind === 'missing') return { skip: 'this editor has no key to it' };
  if (read.kind === 'refused') return { skip: `the file holding its key isn't safe to use (${read.reason})` };
  const view = await deps.relay.getSession(session.id, read.entry.token);
  if (!view.ok) return { skip: `RAVIS didn't accept its key (${view.failure.kind})` };
  const branch = view.value.branch?.name;
  if (view.value.state !== 'idle' || !branch) return { skip: `RAVIS says it is ${view.value.state}, on ${branch ?? 'no branch'}` };
  return { branch, taskId: read.entry.taskId };
}

async function mergedInto(deps: LeftWorkDeps, place: Place, tip: string): Promise<boolean> {
  for (const main of place.mainTips) {
    if (await deps.git.isAncestor(tip, main)) return true;
  }
  return false;
}

function notOffered(deps: LeftWorkDeps, session: SessionSummary, why: string): undefined {
  deps.log?.(`codex left work: ${session.id} isn't offered: ${why}`);
  return undefined;
}

function uncommittedLine(headBranch: string | undefined, branch: string, files: string[]): string {
  const named = files.slice(0, 3).map((file) => `\`${file}\``).join(', ');
  const more = files.length > 3 ? ` and ${files.length - 3} more` : '';
  const where = headBranch ? ` on \`${headBranch}\`` : '';
  return `You have changes${where} that aren't committed yet (${named}${more}). Switching to \`${branch}\` would carry them along, so Codex didn't start. Commit them or put them aside, then ask again.`;
}

function readPlan(root: string): string {
  try {
    return fs.readFileSync(path.join(root, 'plan.md'), 'utf8');
  } catch {
    // No plan, or unreadable: the starting branch is the trunk, as the review wizard falls back to conventions.
    return '';
  }
}
