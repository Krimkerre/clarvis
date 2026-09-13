/**
 * Which engine runs a coding task: Clarvis's own, or Codex through RAVIS (plan.md M15, C2a; design §5.1).
 *
 * **Codex is chosen, never drifted into.** It spends the owner's ChatGPT plan and runs inside RAVIS
 * with its own safety box, so every one of these must hold before a task goes to it:
 * - the coding model is exactly `ravis/codex` — RAVIS's id for it, confirmed by the `X-Clarvis-Engines`
 *   listing — and nothing that merely starts with it;
 * - the owner chose it in their own settings. A repository's `.vscode/settings.json` is written by
 *   whoever wrote the repository, and a project that could switch its reader onto a paid remote agent
 *   by committing a settings file would be choosing on the owner's behalf;
 * - the model's address is this Mac, because RAVIS runs Codex here and the credential goes nowhere else;
 * - the folder is trusted. Restricted Mode means nothing edits and nothing runs, whichever engine.
 *
 * Anything else that names Codex is refused with a sentence saying why, rather than falling back to
 * Clarvis's own engine: that would send `ravis/codex` to RAVIS as a chat model, which RAVIS refuses
 * anyway, after a branch had already been made for nothing.
 *
 * The per-task override (`clarvis.engine.override`) belongs to switching, which is C3.
 *
 * Pure: the caller reads the settings, the base URL and Workspace Trust.
 */

import { isLoopbackUrl } from './relay/relayHttp';
import type { SessionMode } from './relay/relayTypes';

/** RAVIS's model id for Codex (`codex-state.json` capabilities: `backend_id`). */
export const CODEX_MODEL_ID = 'ravis/codex';

/** Where the effective coding model's setting came from. */
export type SettingSource = 'user' | 'workspace' | 'folder' | 'default';

export interface EngineInputs {
  /** The coding model id in effect, after the agent role inherits from chat. */
  model: string;
  source: SettingSource;
  /** The coding role's base URL. */
  baseUrl: string;
  trusted: boolean;
}

export type EngineRefusal = 'codex_variant' | 'repository_setting' | 'not_loopback' | 'untrusted';

export type EngineChoice =
  | { engine: 'clarvis' }
  | { engine: 'codex' }
  | { engine: 'refused'; reason: EngineRefusal; line: string };

/** What the chat says for each refusal. Plain, and each one says what to do about it. */
export const ENGINE_REFUSAL_LINES: Readonly<Record<EngineRefusal, string>> = {
  codex_variant: 'Clarvis knows Codex only as ravis/codex, so nothing runs under that name. Choose Codex under Models.',
  repository_setting:
    "This project's own settings chose Codex, and only you can make that choice. Choose it yourself under Models.",
  not_loopback: "Codex runs only through RAVIS on this Mac, and the coding model's address isn't this Mac.",
  untrusted: "This folder is in Restricted Mode, so Codex won't start here. Trust the folder first.",
};

const CLARVIS: EngineChoice = { engine: 'clarvis' };
const CODEX: EngineChoice = { engine: 'codex' };

/**
 * The header that lets RAVIS list `ravis/codex` (`conventions.json` headers: sent on the model listing,
 * to a loopback base URL only). Other servers ignore a header they don't know.
 */
export function codexListingHeaders(baseUrl: string): Record<string, string> {
  return isLoopbackUrl(baseUrl) ? { 'X-Clarvis-Engines': 'codex' } : {};
}

/**
 * The mode RAVIS is told for a Codex task (design §5.6): Clarvis's own mode where RAVIS has one, Agent —
 * which asks before each step — otherwise. Chat and Plan never reach a run, so they never get here.
 */
export function codexModeFor(chatMode: string): SessionMode {
  return chatMode === 'auto' || chatMode === 'unattended' ? chatMode : 'agent';
}

/** A model picker's list for a role: Codex is a coding model only, so the chat role never offers it. */
export function modelsForRole<T extends { id: string }>(models: readonly T[], role: 'chat' | 'agent'): T[] {
  return role === 'agent' ? [...models] : models.filter((model) => !namesCodex(model.id));
}

/** Whether a model id names Codex at all: exactly, or as something under it. */
export function namesCodex(model: string): boolean {
  const id = model.trim();
  return id === CODEX_MODEL_ID || id.startsWith(`${CODEX_MODEL_ID}/`);
}

export function chooseEngine(inputs: EngineInputs): EngineChoice {
  if (!namesCodex(inputs.model)) return CLARVIS;
  const reason = codexRefusal(inputs);
  return reason ? { engine: 'refused', reason, line: ENGINE_REFUSAL_LINES[reason] } : CODEX;
}

/** The first rule a Codex choice breaks, in the order the owner can fix them. */
function codexRefusal(inputs: EngineInputs): EngineRefusal | undefined {
  if (inputs.model.trim() !== CODEX_MODEL_ID) return 'codex_variant';
  // Only the owner's own settings choose Codex; `default` can never be `ravis/codex`, and is refused too.
  if (inputs.source !== 'user') return 'repository_setting';
  if (!isLoopbackUrl(inputs.baseUrl)) return 'not_loopback';
  return inputs.trusted ? undefined : 'untrusted';
}
