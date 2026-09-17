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

import { audioDestination } from '../voice/audioDestination';
import { promises as fs } from 'fs';
import { Bridge } from './Bridge';
import { locality, summarise } from './config';
import { VERDICT_REASON, verifySecretFile } from './secretFile';
import type { Activity } from './activity';
import { ProblemWatch, countProblems } from './problemCounts';
import { checkKind, checkResult } from './checks';
import { timestamp } from './protocol';

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

  // Belt and suspenders: `clarvis.bridge.*` is machine-scoped in `package.json`,
  // so a workspace cannot set `enabled` at all. This check is what happens if
  // that scope enforcement is ever wrong — a hostile repository still cannot
  // wake the Bridge by any settings path, trusted or not.
  if (!vscode.workspace.isTrusted) {
    log("bridge: this folder isn't trusted yet, so the Bridge stays off whatever the settings say; it starts once the folder is trusted");
    return undefined;
  }

  // **8790, and it must match `package.json`'s default.** The first draft took
  // 8711 from the runbook's port table, which is stale: NERVIS's own
  // `DEFAULT_PORT` is 8790 and its launcher assigns the same, with a comment
  // saying a launcher and a service disagreeing about a port produces a
  // dashboard reporting everything as down. A Bridge pointed at 8711 would
  // have failed to register on every real install, quietly and for ever.
  const nervisUrl = (settings.get<string>('nervisUrl', '') || 'http://127.0.0.1:8790').replace(/\/+$/, '');

  // Loopback only, for now. Remote Bridge is a later, separately-proven patch
  // (§16 item 2) — until it exists, a `nervisUrl` naming anything else is
  // refused here, which is what keeps a bad value from ever reaching the one
  // place that matters: the secret handed to `register()`. `locality` is the
  // same classifier `config.ts` already uses to decide what may travel in the
  // settings summary — reused rather than duplicated, so there is one place
  // that knows what "loopback" means.
  let secret = '';
  if (locality(nervisUrl) !== 'loopback') {
    log(`bridge: nervisUrl "${nervisUrl}" is not loopback, so the enrollment secret is never read or sent`);
  } else {
    secret = await readSecret(settings.get<string>('enrollmentSecretPath', ''), log);
  }

  const bridge = new Bridge({
    nervisUrl,
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
    // **Read per request, not captured at startup.** A person changes a setting
    // and expects the answer to change; a snapshot taken when the window opened
    // would report the configuration Clarvis started with, which is the same
    // class of stale claim §6.3 spends its length on. `getConfiguration` with no
    // section reads the merged value — user, workspace and folder — which is
    // what is actually in force.
    settings: () => summarise((id) => vscode.workspace.getConfiguration().get(id)),
    // Both halves of the voice answer live in `vscode`, so they are resolved
    // here — the one file in `src/bridge/` that is allowed to know.
    voice: {
      enabled: vscode.workspace.getConfiguration('clarvis').get<boolean>('voice.enabled', false),
      remoteName: vscode.env.remoteName,
      // Where speech actually comes out, which is not derivable from
      // `remoteName` alone — a browser workbench is the case it misses.
      playsInWebview:
        audioDestination(vscode.env.uiKind, vscode.env.remoteName) === 'webview',
    },
    log,
  });

  await bridge.start();

  // The editor's problem counts, as `clarvis.diagnostic.changed` (§6.4). Only while the
  // Bridge runs: with nobody to tell, counting every change would be work for no one.
  const problems = new ProblemWatch(
    () => countProblems(vscode.languages.getDiagnostics()),
    (counts) => activity.note({ kind: 'problems', ...counts })
  );
  problems.start();
  const listening = vscode.languages.onDidChangeDiagnostics(() => problems.changed());
  // The last build and test run, for `/v1/status` (§6.3): tasks in VS Code's Build and Test groups only.
  const checking = vscode.tasks.onDidEndTaskProcess((event) => {
    const kind = checkKind(event.execution.task.group?.id);
    if (kind) activity.recordCheck(kind, checkResult(event.exitCode), timestamp(Date.now()));
  });
  const stopWatching = (): void => {
    listening.dispose();
    checking.dispose();
    problems.dispose();
  };
  context.subscriptions.push({ dispose: stopWatching });

  const handle: BridgeHandle = {
    bridge,
    stop: () => {
      stopWatching();
      return bridge.stop();
    },
  };
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
 * broken" is exactly what a modal here would erase. A symlink, a directory or a
 * loosely-permissioned file is refused the same way, for the same reason: none
 * of them is "you have not configured this" either, but a thrown error would
 * make it look like Clarvis is broken rather than like the file needs fixing.
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
    const stats = await fs.lstat(path);
    const verdict = verifySecretFile(stats);
    if (verdict !== 'ok') {
      log(`bridge: the enrollment secret at ${path} ${VERDICT_REASON[verdict]}, refused`);
      return '';
    }
    return (await fs.readFile(path, 'utf8')).trim();
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    log(`bridge: could not read the enrollment secret at ${path} (${reason})`);
    return '';
  }
}
