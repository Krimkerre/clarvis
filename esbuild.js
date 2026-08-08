const esbuild = require('esbuild');

// `npm run watch` passes --watch; `npm run build` (used before vsce package) doesn't.
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'], // provided by the VS Code runtime at install time, never bundled
  format: 'cjs', // extension host loads extensions as CommonJS
  platform: 'node',
  sourcemap: true,
  minify: !watch, // keep watch-mode rebuilds fast and readable; minify real builds
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
