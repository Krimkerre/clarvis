import tseslint from 'typescript-eslint';

/**
 * What the linter is here for, and what it deliberately is not.
 *
 * Added after someone reported the project had "too much cyclomatic complexity" with no
 * number attached. Measuring it found five functions at or near the threshold in 8,500
 * lines — a handful of outliers, not a sick codebase. The lesson was that the claim was
 * unanswerable, not that it was wrong, so complexity is a number the build enforces now
 * rather than an opinion anyone has to relitigate.
 *
 * **Not a style linter.** No formatting rules, no naming rules, no import ordering. This
 * project already has a written style (§ clean-code rules in plan.md) and a reviewer who
 * follows it; a second opinion delivered as 400 warnings would be noise that trains
 * everyone to ignore the output. Every rule below marks something that has actually gone
 * wrong here, or that would.
 */
export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', '**/*.mjs', '**/*.js'] },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      /**
       * The reason this file exists. 15 rather than ESLint's default of 20: the two
       * worst functions here sit at 20, so a threshold of 20 would have declared the
       * problem solved without changing anything.
       */
      complexity: ['error', 15],

      /**
       * Length is the other half of the same story, and the one the metric missed —
       * `ChatService` was 640 lines doing routing, modes, runs, history and facts.
       * Generous, because a long function of straight-line setup is fine and this is
       * meant to catch the ones that are long *and* branchy.
       */
      'max-lines-per-function': ['error', { max: 120, skipComments: true, skipBlankLines: true }],

      /** Nesting is where the real unreadability lives, more than raw branch count. */
      'max-depth': ['error', 4],

      /**
       * Both caught real bugs in this project: a silent `str.replace` no-op left a
       * function without its return, and an unawaited promise let a run report success
       * before its commit had happened.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /** Deliberate escape hatches, used at the git-extension boundary where the API is untyped. */
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Tests describe *why* a rule exists, at length, and set up deliberately awkward
    // states. Holding them to the production thresholds would mean shortening the
    // explanations, which are the point of them.
    files: ['**/*.test.ts'],
    rules: {
      'max-lines-per-function': 'off',
      complexity: 'off',
      // `test()` from node:test returns a promise nobody is meant to await. Left on, it
      // produced 400 identical errors — the exact wall of noise that teaches a team to
      // stop reading lint output, which would defeat the point of adding it.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  }
);
