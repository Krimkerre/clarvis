/**
 * Where a coding run is built, and which engine builds it (plan.md M15, C2a; design §5.1, §5.8).
 *
 * **Three places construct runners, and each gets its decision here**, so none of them can quietly
 * drift from the others:
 * - **the chat's run** (`RunSession.run`): either engine, as `chooseEngine` decides — including a refusal,
 *   with its reason, when something names Codex but may not use it;
 * - **the command palette** (`clarvis.runTask`): Clarvis's own engine only. Codex asks questions and
 *   approvals that need the chat panel to answer them, and the palette has nowhere to show them, so a Codex
 *   choice is refused there with a pointer to the panel;
 * - **the read-only answer path** (`Replier`): never an engine run and never Codex. A chat model that names
 *   Codex is refused with a line before any request, because RAVIS refuses Codex as a chat model anyway.
 *
 * vscode-free: the builders are handed in, so the decision is testable without an extension host.
 */

import type { CodingRun, EngineKind } from '../engine/CodingRun';
import { namesCodex, type EngineChoice } from '../engine/engineChoice';

export const PALETTE_CODEX_LINE = 'Codex runs from the Clarvis panel, where its questions can be answered.';
export const CHAT_MODEL_CODEX_LINE =
  'Codex is a coding engine, not a chat model. Choose a chat model under Models; Codex can stay the coding model.';

export type SiteDecision = { run: EngineKind } | { run: 'refused'; line: string };

export interface CodingRunBuilders {
  clarvis(): CodingRun;
  codex(): CodingRun;
}

/** The chat's run: whichever engine was chosen, or the refusal. */
export function chatRunDecision(choice: EngineChoice): SiteDecision {
  return choice.engine === 'refused' ? { run: 'refused', line: choice.line } : { run: choice.engine };
}

/**
 * Whether Clarvis's own `git init` offer (`gitOffer.offerGitFix`) is asked before this run: only for Clarvis's own
 * engine (plan.md M15, "Codex offers to set git up"). That offer says declining is fine, which is untrue of Codex, and
 * it comes before anything else is checked, so in a Restricted Mode folder it would offer git for a Codex task that is
 * about to be refused. A Codex task offers **Set up git here** in the chat instead, once every refusal has had its say.
 */
export function asksGitOfferBeforeRun(decision: SiteDecision): boolean {
  return decision.run === 'clarvis';
}

/** The command palette's run: never Codex. */
export function paletteRunDecision(choice: EngineChoice): SiteDecision {
  if (choice.engine === 'codex') return { run: 'refused', line: PALETTE_CODEX_LINE };
  return chatRunDecision(choice);
}

/** The read-only answer path: a line when the chat model is Codex, which can't answer questions. */
export function chatModelRefusal(chatModel: string): string | undefined {
  return namesCodex(chatModel) ? CHAT_MODEL_CODEX_LINE : undefined;
}

/**
 * Said when a run ends holding things typed to it that it never took in (review H8): nothing typed to a
 * run vanishes without the chat saying so.
 */
export function undeliveredLine(texts: readonly string[]): string | undefined {
  if (texts.length === 0) return undefined;
  const quoted = texts.map((text) => `"${text}"`).join(', ');
  return `The run ended before it could take in ${quoted}. Say it again with the next task if it still applies.`;
}

/** Builds the runner for the engine decided on. */
export function createCodingRun(engine: EngineKind, builders: CodingRunBuilders): CodingRun {
  return engine === 'codex' ? builders.codex() : builders.clarvis();
}
