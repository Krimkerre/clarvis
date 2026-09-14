/**
 * Which Codex model a new task runs, and how hard it thinks (plan.md M15, C2b+; the ecosystem's build notes, "Owner
 * requirement added 14 Sep 2026 — choose Codex's model and effort per task").
 *
 * **What the owner chooses from.** RAVIS lists the models Codex offers this ChatGPT account in `GET /api/v1/codex` →
 * `models`: each with its levels of effort (`low`, `medium`, `high`, …) and the one it uses by default. The owner
 * picks a model and one of that model's efforts in the bowtie's fold-out; the choice is kept in the owner's own
 * settings (`clarvis.codex.model`, `clarvis.codex.effort`), never a repository's.
 *
 * **The default** is the plan's default model at its `default_effort` — which is also what a stored choice falls back
 * to when RAVIS no longer lists it, so a model retired upstream never leaves a task unable to start.
 *
 * **Fixed while a task runs.** RAVIS keeps a task's model and effort for its whole life, so a change applies to the
 * next task, and the fold-out says so while one runs.
 *
 * Pure.
 */

import type { CodexModel } from './relay/relayTypes';

/** What the owner's settings hold: empty means "the default". */
export interface StoredCodexChoice {
  model?: string;
  effort?: string;
}

export interface CodexChoice {
  model: CodexModel;
  effort: string;
}

export const CODEX_CHOICE_LINES = {
  allowance: "A bigger model or higher effort uses the ChatGPT plan's allowance faster.",
  running: 'A Codex task is running: it keeps the model and effort it started with, and a change applies to the next task.',
} as const;

/**
 * The model and effort a new task uses: the owner's choice while RAVIS still offers it, otherwise the default model at
 * its default effort — a stored effort goes with the model it was chosen for, not onto whatever replaced it.
 */
export function effectiveCodexChoice(models: readonly CodexModel[], stored: StoredCodexChoice): CodexChoice | undefined {
  const chosen = models.find((candidate) => candidate.id === stored.model);
  const model = chosen ?? models.find((candidate) => candidate.is_default) ?? models[0];
  if (!model) return undefined;
  const effortStands = chosen !== undefined || stored.model === undefined;
  return { model, effort: offeredEffort(model, effortStands ? stored.effort : undefined) };
}

/** The stored choice in a few words, for the bowtie's tooltip. */
export function choiceSummary(stored: StoredCodexChoice): string {
  return `${stored.model ?? "the plan's default model"}, at ${stored.effort ? `${stored.effort} effort` : 'its default effort'}`;
}

/**
 * What to store for the owner's pick: a model RAVIS lists, and an effort that model offers. Picking only a model keeps
 * the effort already chosen when the new model offers it too, and takes the model's default otherwise. Undefined —
 * nothing stored — for a model RAVIS doesn't list or an effort that model doesn't offer.
 */
export function acceptCodexChoice(
  models: readonly CodexModel[],
  stored: StoredCodexChoice,
  picked: { model?: unknown; effort?: unknown }
): Required<StoredCodexChoice> | undefined {
  const model = models.find((candidate) => candidate.id === picked.model);
  if (!model) return undefined;
  if (picked.effort === undefined) return { model: model.id, effort: offeredEffort(model, stored.effort) };
  return typeof picked.effort === 'string' && model.efforts.includes(picked.effort) ? { model: model.id, effort: picked.effort } : undefined;
}

function offeredEffort(model: CodexModel, effort: string | undefined): string {
  return effort !== undefined && model.efforts.includes(effort) ? effort : model.default_effort;
}
