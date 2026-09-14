/**
 * The Codex section of the bowtie's fold-out, wired to VS Code (plan.md M15, C2b+; the owner's decisions of 14 Sep).
 *
 * **Glue only.** When the menu opens it reads RAVIS once — `GET /api/v1/codex`, which answers from memory within its
 * 1.5-second limit — and posts the section `codexMenu.ts` decides. When the owner picks a model or an effort it holds
 * the pick to what RAVIS listed a moment ago (`acceptCodexChoice`) and keeps it in the owner's own settings, never a
 * workspace's: a project's settings don't choose what a task on the owner's ChatGPT plan runs.
 *
 * (Named apart from `codexMenu.ts` by more than case: this Mac's file system treats `CodexMenu.ts` as the same file.)
 */

import * as vscode from 'vscode';
import { acceptCodexChoice, type StoredCodexChoice } from '../engine/codexChoice';
import { CODEX_MODEL_ID } from '../engine/engineChoice';
import { ravisAccess } from '../engine/engineHost';
import type { CodexModel } from '../engine/relay/relayTypes';
import type { ModelService } from '../model/ModelService';
import { codexMenuState, type RavisReach } from './codexMenu';

export interface CodexMenuDeps {
  models: ModelService;
  post(message: unknown): void;
  log(line: string): void;
  /** A Codex task is running in this window. */
  taskRunning(): boolean;
}

export class CodexMenu {
  /** What RAVIS listed when the menu last opened: a pick is held to it. */
  private listed: CodexModel[] = [];

  constructor(private readonly deps: CodexMenuDeps) {}

  /** The menu opened: RAVIS read now, and the section drawn from what it said. */
  async opened(): Promise<void> {
    const ravis = await this.reach();
    this.listed = ravis.kind === 'ready' && ravis.state.ok ? (ravis.state.value.models ?? []) : [];
    const state = codexMenuState({
      codingModel: this.deps.models.model('agent'),
      ravis,
      stored: storedCodexChoice(),
      taskRunning: this.deps.taskRunning(),
    });
    this.deps.post({ type: 'codex-menu', state });
  }

  /** The owner picked a model or an effort: kept in their own settings, if RAVIS listed it. */
  async chose(picked: { model: unknown; effort: unknown }): Promise<void> {
    if (this.deps.models.model('agent').trim() !== CODEX_MODEL_ID) return;
    const accepted = acceptCodexChoice(this.listed, storedCodexChoice(), picked);
    if (!accepted) return this.deps.log('codex: a model or effort RAVIS did not list was not kept');
    const config = vscode.workspace.getConfiguration('clarvis');
    await config.update('codex.model', accepted.model, vscode.ConfigurationTarget.Global);
    await config.update('codex.effort', accepted.effort, vscode.ConfigurationTarget.Global);
    this.deps.log(`codex: new tasks use ${accepted.model} at ${accepted.effort} effort`);
  }

  private async reach(): Promise<RavisReach> {
    const lookup = ravisAccess(this.deps.models);
    if (lookup.kind !== 'ready') return lookup;
    return { kind: 'ready', state: await lookup.access.relay.codexState() };
  }
}

/** The Codex model and effort in the owner's own settings. A value a workspace or folder set is never read. */
export function storedCodexChoice(): StoredCodexChoice {
  const config = vscode.workspace.getConfiguration('clarvis');
  return { model: userValue(config.inspect<string>('codex.model')), effort: userValue(config.inspect<string>('codex.effort')) };
}

function userValue(inspected: { globalValue?: string } | undefined): string | undefined {
  const value = typeof inspected?.globalValue === 'string' ? inspected.globalValue.trim() : '';
  return value === '' ? undefined : value;
}
