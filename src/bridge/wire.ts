/**
 * The one file in `src/bridge/` that knows what `vscode` is.
 *
 * Everything else here is deliberately host-free so the fast suite can reach it,
 * which leaves this: reading three settings, reading a file, and hanging the
 * result on `context.subscriptions`. It is short on purpose — what cannot be
 * tested should be as close to nothing as it can get.
 *
 * **Off is genuinely off.** `clarvis.bridge.enabled` defaulting to false means no
 * socket, no registration, no timer and no listener — not a bound port that
 * refuses. That is Stage 8's own exit criterion, and the reason it is written as
 * an early return rather than as a flag consulted deeper down is that a flag
 * consulted deeper down is a thing somebody stops consulting.
 */

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { Bridge } from './Bridge';
import type { Activity } from './activity';

declare const __CLARVIS_BUILD__: string;

export interface BridgeHandle {
  readonly bridge: Bridge;
  /** Awaited by `deactivate`, which is where the deregistration gets its chance. */
  stop(): Promise<void>;
}

/**
 * Start the Bridge if the user has asked for one.
 *
 * Returns `undefined` when the setting is off, which is the ordinary case and is
 * not logged as a problem: a feature nobody enabled is not a failure.
 */
export async function startBridge(
  context: vscode.ExtensionContext,
  activity: Activity,
  log: (message: string) => void
): Promise<BridgeHandle | undefined> {
  const settings = vscode.workspace.getConfiguration('clarvis.bridge');
  if (!settings.get<boolean>('enabled', false)) return undefined;

  const secret = await readSecret(settings.get<string>('enrollmentSecretPath', ''), log);
  const bridge = new Bridge({
    // **8790, and it must match `package.json`'s default.** The first draft took
    // 8711 from the runbook's port table, which is stale: NERVIS's own
    // `DEFAULT_PORT` is 8790 and its launcher assigns the same, with a comment
    // saying a launcher and a service disagreeing about a port produces a
    // dashboard reporting everything as down. A Bridge pointed at 8711 would
    // have failed to register on every real install, quietly and for ever.
    nervisUrl: (settings.get<string>('nervisUrl', '') || 'http://127.0.0.1:8790').replace(/\/+$/, ''),
    enrollmentSecret: secret,
    // `globalState`, not `workspaceState`: §6.1 calls the service and machine IDs
    // installation-scoped, and putting them per-workspace would make every folder
    // a different installation of Clarvis.
    storage: context.globalState,
    facts: {
      appName: vscode.env.appName,
      workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      buildVersion: typeof __CLARVIS_BUILD__ === 'string' ? __CLARVIS_BUILD__ : '0.0.0',
      apiVersion: '1',
      protocolVersion: '1.0.0',
    },
    activity,
    // Both halves of the voice answer live in `vscode`, so they are resolved
    // here — the one file in `src/bridge/` that is allowed to know.
    voice: {
      enabled: vscode.workspace.getConfiguration('clarvis').get<boolean>('voice.enabled', false),
      remoteName: vscode.env.remoteName,
    },
    log,
  });

  await bridge.start();

  const handle: BridgeHandle = { bridge, stop: () => bridge.stop() };
  // On `subscriptions` rather than a module-scoped variable: a reload that misses
  // `deactivate` still disposes these, and a listening socket surviving a reload
  // is a port held by a window that no longer exists.
  context.subscriptions.push({ dispose: () => void bridge.stop() });
  return handle;
}

/**
 * NERVIS's enrolment secret, or an empty string with a reason logged.
 *
 * **An unreadable secret is not an error to raise at the user.** It means the
 * Bridge binds and never registers, which is a state it is already built to sit
 * in — and the difference between "you have not configured this" and "Clarvis is
 * broken" is exactly what a modal here would erase.
 *
 * The contents are trimmed and never logged. The path is logged, because the
 * usual cause is that it points somewhere else and that is the fact that fixes it.
 */
async function readSecret(path: string, log: (message: string) => void): Promise<string> {
  if (!path.trim()) {
    log('bridge: no enrollment secret path is set, so it will bind but never register');
    return '';
  }
  try {
    return (await fs.readFile(path, 'utf8')).trim();
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    log(`bridge: could not read the enrollment secret at ${path} (${reason})`);
    return '';
  }
}
