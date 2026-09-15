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
 * - the checkout has a commit, and a trunk to compare against (`leftBranches.placeOf`, shared with Clarvis's own
 *   engine). That is the project's declared trunk (`plan.md`'s branch flow, when that branch exists), else the branch a
 *   fresh task starts from (`startingBase`). Never a literal `main`;
 * - RAVIS lists the session for this folder as `idle`: settled, its thread kept, able to continue;
 * - this Mac's token file holds the session's key, and RAVIS accepts it. The view read with that key must say `idle`
 *   and name the branch. A session whose key is missing isn't offered: its branch can only be read with a key, and the
 *   only way to get one, a reissue, revokes the old key and is audited. That isn't done for every idle task each time
 *   someone asks for work, before they have chosen anything;
 * - its branch still exists and has commits that are in neither the trunk nor the branch a fresh task starts from. A
 *   branch merged there has nothing left to build on.
 *
 * Only the ten most recent idle sessions are read, and one task is kept per branch, the most recent. Runs of Clarvis's
 * own engine are never found here, even on a branch Codex also worked on: they are `leftRuns.ts`'s.
 *
 * vscode-free: the relay, the token file and git are handed in, so all of it runs against `FakeRavisRelay` and real
 * temporary repositories (`leftTasks.test.ts`).
 */

import { mergedInto, placeOf, type LeftBranch, type LeftWorkFound, type Place } from '../../agent/leftBranches';
import type { GitFacts } from '../checkpoint/gitFacts';
import { codexReadiness } from '../relay/codexReadiness';
import type { RelayClient } from '../relay/relayClient';
import type { SessionSummary } from '../relay/relayTypes';
import type { TokenRead } from '../relay/tokenStore';
import type { BuildOnTask } from './runCore';

export { MOST_OFFERED, offeredTasks } from '../../agent/leftBranches';

/** How many of the most recent idle sessions are read: each costs a request to RAVIS. */
const MOST_READ = 10;

/** One idle Codex task whose work is still on its own branch. */
export interface LeftTask extends BuildOnTask, LeftBranch {
  taskId: string;
}

/** What was found, and the branches the question names. Empty `tasks` means nothing is asked. */
export type LeftWork = LeftWorkFound<LeftTask>;

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

/** The left Codex work in this folder, most recent first, or none when anything needed to judge it is missing. */
export async function findLeftWork(deps: LeftWorkDeps): Promise<LeftWork> {
  if (!(await codexMayRun(deps))) return { tasks: [] };
  const place = await placeOf(deps.git, deps.root, deps.rememberedBase, deps.planText);
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

async function codexMayRun(deps: LeftWorkDeps): Promise<boolean> {
  const state = await deps.relay.codexState();
  const failure = state.ok ? codexReadiness(state.value) : state.failure;
  if (failure) deps.log?.(`codex left work: Codex may not run (${failure.kind}), so nothing is asked and the task meets its own refusal`);
  return failure === undefined;
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
  if (await mergedInto(deps.git, place, tip)) return notOffered(deps, session, `${branch} is merged into ${place.mains.join(' or ')}`);
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

function notOffered(deps: LeftWorkDeps, session: SessionSummary, why: string): undefined {
  deps.log?.(`codex left work: ${session.id} isn't offered: ${why}`);
  return undefined;
}
