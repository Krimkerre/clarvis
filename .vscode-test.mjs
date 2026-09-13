import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Host-level smoke tests — the small set that must run inside the real extension
// host because they check things a pure function can't: does the extension
// activate without throwing, does it register the commands package.json promises,
// does the webview's CSP actually get set. Everything else stays in `npm test`
// (node's test runner, no VS Code needed) because that's faster and most behavior
// doesn't require a real host.

// **A fresh user-data folder for every run.** Without one, `@vscode/test-electron`
// uses the shared `.vscode-test/user-data`, and that remembers windows between
// runs: a spec that adds a workspace folder turns the test window into an untitled
// multi-root workspace, VS Code reopens it at the next launch, and each reopened
// window runs the whole suite in its own extension host. Found 13 Sep: one more
// host with every local run (1, 2, 3, then 4), all writing the same settings.json
// and failing on "the content of the file is newer". CI starts from a clean
// machine; this makes a local run start clean too, and removes the folder after.
const userData = mkdtempSync(join(tmpdir(), 'clarvis-host-user-data-'));
process.on('exit', () => rmSync(userData, { recursive: true, force: true }));

export default defineConfig({
  files: 'out/test/**/*.spec.js',
  version: 'stable',
  workspaceFolder: 'src/test/fixture-workspace',
  launchArgs: [`--user-data-dir=${userData}`],
});
