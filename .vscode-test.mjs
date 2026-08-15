import { defineConfig } from '@vscode/test-cli';

// Host-level smoke tests — the small set that must run inside the real extension
// host because they check things a pure function can't: does the extension
// activate without throwing, does it register the commands package.json promises,
// does the webview's CSP actually get set. Everything else stays in `npm test`
// (node's test runner, no VS Code needed) because that's faster and most behavior
// doesn't require a real host.
export default defineConfig({
  files: 'out/test/**/*.spec.js',
  version: 'stable',
  workspaceFolder: 'src/test/fixture-workspace',
});
