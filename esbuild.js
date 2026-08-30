const esbuild = require('esbuild');

// `npm run watch` passes --watch; `npm run build` (used before vsce package) doesn't.
const watch = process.argv.includes('--watch');

// Stamped into the bundle at build time.
//
// Installing a .vsix replaces the file on disk, but the running extension host keeps
// the old bundle in memory until the window reloads — so "I installed it" and "it is
// running" are different facts. Logging this at activation makes the difference
// visible instead of something to remember: a stale host reports an old stamp.
// The version answers "which build is this", the timestamp answers "is the host
// running it yet" — both are needed, so the stamp carries both. NERVIS treats
// build_version as an opaque display string, so the `+` suffix costs nothing
// there and shows up verbatim in the situation report.
const buildStamp = `${require('./package.json').version}+${new Date().toISOString()}`;

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'], // provided by the VS Code runtime at install time, never bundled
  format: 'cjs', // extension host loads extensions as CommonJS
  platform: 'node',
  sourcemap: true,
  minify: !watch, // keep watch-mode rebuilds fast and readable; minify real builds
  define: { __CLARVIS_BUILD__: JSON.stringify(buildStamp) },
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
