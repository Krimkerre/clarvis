/**
 * The fence, where Clarvis's own engine writes (plan.md M15, C2a; design §5.1 item 4, §6.3).
 *
 * **What it guards.** Another window can take a project over — its owner confirmed a takeover of a run that
 * stopped answering. The run that lost the lock may still be going, and it must not write another byte:
 * no edit, no command, no commit, no tidying of its branch. It ends saying so, and leaves everything as it
 * was for the window that has the project now.
 *
 * **Pure, beside `AgentRunner`.** `AgentRunner` imports `vscode` and cannot be loaded by `node --test`, and
 * this repository has shipped a fix inside it that was verified by reading and did not work (docs, 20 Aug).
 * So the decisions live here, where a test reaches them, and `AgentRunner` only calls them.
 */

import type { RunFence } from '../engine/CodingRun';

/** What the chat says when a run ends because another window took the project. */
export const TAKEN_OVER_LINE = "Another window took over this task; I've left everything as it was.";

/** What the model is told when a tool call is refused by the fence. */
export const TAKEN_OVER_TOOL_RESULT =
  'Another window has taken over this project, so this run has stopped and nothing more will be written. Do not retry.';

/**
 * Whether a tool call may change the project now. Reads are never fenced; a writing tool — an edit, a new
 * file, a command (which can write anything) — goes ahead only while the run still holds its lock. A run
 * with no fence has no lock to lose.
 */
export async function mayWriteNow(fence: RunFence | undefined, writes: boolean): Promise<boolean> {
  if (!writes || fence === undefined) return true;
  return fence.stillHolds('tool');
}

/** Whether the run may commit its work, or tidy its branch, now. The fence sends a heartbeat first. */
export async function mayCommitNow(fence: RunFence | undefined): Promise<boolean> {
  return fence === undefined || fence.stillHolds('commit');
}
