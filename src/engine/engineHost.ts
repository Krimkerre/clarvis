/**
 * What the engine seam needs from VS Code, in one place (plan.md M15, C2a; design §5.1, §5.7).
 *
 * Which engine the settings choose, this window's identity, where RAVIS is and with which credential,
 * and the project lock a run of Clarvis's own engine takes. **Glue only**: each decision is made by a
 * vscode-free module — `engineChoice.ts`, `projectLock.ts`, `credentialFile.ts`, `ravisCredential.ts` —
 * which is where the tests are. This file reads settings and the environment and hands them over.
 */

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { ModelService } from '../model/ModelService';
import { launcherCredential } from '../model/ravisCredential';
import { chooseEngine, CODEX_MODEL_ID, type EngineChoice, type SettingSource } from './engineChoice';
import { findGitDir } from './lock/gitDir';
import { LockClient } from './lock/lockClient';
import { ownStart } from './lock/processProbe';
import { takeProjectLock, type LockOutcome } from './lock/projectLock';
import { readCredentialFile } from './relay/credentialFile';
import { RelayClient } from './relay/relayClient';
import { RelayHttp, relayEndpoint } from './relay/relayHttp';
import type { Host } from './relay/relayTypes';
import { skillsLookupFor, type SkillsLookup } from '../agent/tools/skillTools';

export interface RavisAccess {
  relay: RelayClient;
  locks: LockClient;
}

export type RavisLookup =
  | { kind: 'ready'; access: RavisAccess }
  /** No role in this window talks to RAVIS. */
  | { kind: 'not_used' }
  /** RAVIS is configured, and this editor has no Clarvis credential for it. */
  | { kind: 'no_credential' }
  | { kind: 'unusable'; reason: string };

let identity: { id: string; host: Host } | undefined;

/** This window, as RAVIS knows it: `win-<host>-<6 hex>`, the fixtures' form, made once per extension host. */
export function windowIdentity(): { id: string; host: Host } {
  if (!identity) {
    const host: Host = vscode.env.uiKind === vscode.UIKind.Web ? 'code-server' : 'desktop';
    identity = { id: `win-${host}-${randomBytes(3).toString('hex')}`, host };
  }
  return identity;
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The engine the settings choose right now (`engineChoice.ts` decides). */
export function currentEngineChoice(models: ModelService): EngineChoice {
  return chooseEngine({
    model: models.model('agent'),
    source: codingModelSource(),
    baseUrl: models.baseUrl('agent'),
    trusted: vscode.workspace.isTrusted,
  });
}

/** The mode setting, for the mode RAVIS is told. */
export function chatModeSetting(): string {
  return vscode.workspace.getConfiguration('clarvis').get<string>('chat.mode', 'auto');
}

export function maxStepsSetting(): number {
  return vscode.workspace.getConfiguration('clarvis').get<number>('agent.maxStepsPerTask', 25);
}

/** RAVIS for this window: the loopback address of a role that uses a RAVIS model, and the Clarvis credential. */
export function ravisAccess(models: ModelService): RavisLookup {
  const baseUrl = ravisBaseUrl(models);
  if (!baseUrl) return { kind: 'not_used' };
  const endpoint = relayEndpoint(baseUrl, credentialFor(baseUrl));
  if (!endpoint.ok) return endpoint.reason === 'no_credential' ? { kind: 'no_credential' } : { kind: 'unusable', reason: endpoint.reason };
  const http = new RelayHttp(endpoint.endpoint);
  return { kind: 'ready', access: { relay: new RelayClient(http), locks: new LockClient(http) } };
}

/**
 * Where a run of Clarvis's own engine reads the owner's skills: RAVIS, when the coding model goes through it (plan.md
 * §4.6, "Skills"; `skillsLookupFor` decides). Asked at each run's start, so a settings change counts from the next run.
 */
export function runSkillsLookup(models: ModelService): SkillsLookup {
  return skillsLookupFor(models.model('agent'), () => ravisAccess(models));
}

/**
 * The lock a run of Clarvis's own engine takes before it starts (design §5.1, §6.3). None in a window with
 * no folder, where the run refuses anyway, and none in Restricted Mode, where nothing may be written.
 */
export async function takeRunLock(
  models: ModelService,
  taskId: string,
  log: (line: string) => void,
  waitingOnYou: () => boolean
): Promise<LockOutcome | undefined> {
  const root = workspaceRoot();
  if (!root || !vscode.workspace.isTrusted) return undefined;
  const ravis = ravisAccess(models);
  return takeProjectLock({
    root,
    gitDir: findGitDir(root),
    taskId,
    window: windowIdentity(),
    pid: process.pid,
    pidStart: (await ownStart()) ?? '',
    locks: ravis.kind === 'ready' ? ravis.access.locks : undefined,
    waitingOnYou,
    log,
  });
}

/** Where the coding model's value was set: its own setting, or the chat setting it inherits. */
function codingModelSource(): SettingSource {
  const config = vscode.workspace.getConfiguration('clarvis');
  const agent = sourceOf(config.inspect<string>('agent.model'));
  return agent === 'default' ? sourceOf(config.inspect<string>('chat.model')) : agent;
}

type Inspected = { globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string } | undefined;

const filled = (value: string | undefined): boolean => Boolean(value?.trim());

/** The most specific scope that set the value, the one VS Code gives the effective value from. */
function sourceOf(inspected: Inspected): SettingSource {
  if (!inspected) return 'default';
  if (filled(inspected.workspaceFolderValue)) return 'folder';
  if (filled(inspected.workspaceValue)) return 'workspace';
  return filled(inspected.globalValue) ? 'user' : 'default';
}

function ravisBaseUrl(models: ModelService): string | undefined {
  for (const role of ['agent', 'chat'] as const) {
    if (models.model(role).startsWith('ravis/')) return models.baseUrl(role);
  }
  return undefined;
}

/** code-server's launcher credential first; desktop reads the file the owner named once. */
function credentialFor(baseUrl: string): string | undefined {
  const launched = launcherCredential(process.env, baseUrl, CODEX_MODEL_ID);
  if (launched) return launched;
  const file = readCredentialFile(vscode.workspace.getConfiguration('clarvis').get<string>('ravis.credentialFile'));
  return file.ok ? file.credential : undefined;
}
