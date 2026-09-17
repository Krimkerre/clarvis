import * as vscode from 'vscode';
import type { TrustSource } from './afterTrust';

/** VS Code's Workspace Trust, for `whenTrusted` (`afterTrust.ts`). */
export const hostTrust: TrustSource = {
  trusted: () => vscode.workspace.isTrusted,
  onGrant: (listener) => vscode.workspace.onDidGrantWorkspaceTrust(listener),
};
