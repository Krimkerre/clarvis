/**
 * A build or test run's outcome, for `/v1/status` (§6.3's "build and test outcome", Clarvis 0.17.15).
 *
 * **Only what VS Code itself calls a build or a test**: a task in the Build or Test group, which a
 * `tasks.json` or an extension declares. A command typed in a terminal is left out — telling `npm test`
 * from `npm run test-data-generator` would be a guess, and §6.3 forbids inventing one. `vscode`-free:
 * `wire.ts` hands over the group's id and the exit code.
 */

import type { CheckResult } from './activity';

/** `vscode.TaskGroup.Build.id` and `.Test.id`. */
export function checkKind(groupId: string | undefined): 'build' | 'test' | undefined {
  if (groupId === 'build') return 'build';
  if (groupId === 'test') return 'test';
  return undefined;
}

/** Exit 0 passed, any other code failed; no code — a task that was terminated — is not known. */
export function checkResult(exitCode: number | undefined): CheckResult {
  if (exitCode === undefined) return 'unknown';
  return exitCode === 0 ? 'passed' : 'failed';
}
