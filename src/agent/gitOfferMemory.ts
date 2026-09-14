/**
 * The answer to Clarvis's own `git init` offer, remembered per workspace.
 *
 * Split out of `gitOffer.ts`, which imports `vscode`, so the rules about when the answer changes are tested without
 * an extension host. `workspaceState` is handed in; anything with `get` and `update` does.
 *
 * **Who changes it, and nobody else:**
 * - declining Clarvis's own offer, in the modal before a run or in the chat during planning, remembers the "no";
 * - **Clarvis: Ask About Git Setup Again** (`clarvis.forgetGitOfferAnswer`) forgets it, so the offer asks again;
 * - git actually set up through Codex's **Set up git here** forgets it too (plan.md M15, "Codex offers to set git
 *   up"): the owner has since said yes to git in this workspace, and the old "no" no longer describes what they want
 *   here. Choosing **Not now**, ignoring the offer, or a setup that failed leaves it exactly as it was.
 *
 * **Codex's offer never reads it.** The "no" was about an optional nicety for Clarvis's own engine, which works
 * without git; Codex can't work without git at all, so an earlier decline must not hide the one way forward.
 */

export const GIT_OFFER_DECLINED_KEY = 'clarvis.agent.gitOfferDeclined';

/** The slice of `vscode.Memento` this needs. */
export interface OfferMemory {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Whether Clarvis's own offer was declined in this workspace. */
export function gitOfferDeclined(memory: OfferMemory): boolean {
  return Boolean(memory.get(GIT_OFFER_DECLINED_KEY));
}

export async function rememberGitOfferDeclined(memory: OfferMemory): Promise<void> {
  await memory.update(GIT_OFFER_DECLINED_KEY, true);
}

export async function forgetGitOfferDeclined(memory: OfferMemory): Promise<void> {
  await memory.update(GIT_OFFER_DECLINED_KEY, undefined);
}
