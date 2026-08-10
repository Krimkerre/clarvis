import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptRewrite, rewritePrompt, soundsWritten, DEAD_PHRASES } from './say';
import { QUIPS } from './quipBank';

test('a rewrite that drops a fact is rejected', () => {
  // The character lives in the framing, never in the facts. A rewrite that lost the
  // branch name changed what the sentence means.
  const line = { purpose: 'report' as const, fallback: 'Merged into testing.', keep: ['testing'] };

  assert.equal(acceptRewrite(line, 'All done, the work has landed.'), undefined);
  assert.equal(acceptRewrite(line, "It's part of testing now."), "It's part of testing now.");
});

test('a statement must not become a question', () => {
  // A question changes what the user is expected to do next.
  const line = { purpose: 'report' as const, fallback: 'Done.' };

  assert.equal(acceptRewrite(line, 'Shall I carry on?'), undefined);
});

test('enthusiasm and emoji are not this character', () => {
  const line = { purpose: 'report' as const, fallback: 'Done.' };

  assert.equal(acceptRewrite(line, 'All done!'), undefined);
  assert.equal(acceptRewrite(line, 'Done 🎉'), undefined);
});

test('quotes and second lines are stripped, not rejected', () => {
  const line = { purpose: 'report' as const, fallback: 'Done.' };

  assert.equal(acceptRewrite(line, '"There. Finished."\n\nI hope that helps.'), 'There. Finished.');
});

test('a warning is told to state the risk first and never joke about it', () => {
  // The constraint that stops a personality layer becoming a hazard.
  const prompt = rewritePrompt({ purpose: 'warn', fallback: 'This deletes work that exists nowhere else.' });

  assert.match(prompt, /risk must be unmistakable/);
  assert.match(prompt, /Never joke about what could be lost/);
});

test('a choice keeps its consequence exactly', () => {
  const prompt = rewritePrompt({ purpose: 'ask', fallback: 'Delete the branch?' });

  assert.match(prompt, /consequence of the choice must survive exactly/);
  assert.match(prompt, /No jokes/);
});

test('dead phrases are what a form says, not a person', () => {
  // The tell that a string was typed by a developer filling in a dialog.
  for (const dead of ['Operation completed successfully', 'Please note: invalid input', 'An error occurred']) {
    assert.equal(soundsWritten(dead), false, dead);
  }

  assert.equal(soundsWritten("There. Don't say I never do anything."), true);
});

test('no written line in the quip bank sounds like a form', () => {
  // The bank is the fallback for every surface, so a dead line there is a dead line
  // wherever the model is unavailable.
  for (const quip of QUIPS) {
    assert.ok(soundsWritten(quip.text), `dead phrasing: ${quip.text}`);
  }
  assert.ok(DEAD_PHRASES.length > 0);
});

import * as fsSync from 'fs';
import * as pathSync from 'path';

/** Every source file, so the check cannot be dodged by adding a new one. */
function sourceFiles(directory: string): string[] {
  return fsSync.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = pathSync.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

test('no user-facing string uses the phrasing of a form', () => {
  // §2.2: the character is the medium, not a feature. This catches the tell — a line
  // typed by someone filling in a dialog rather than written by someone speaking —
  // wherever it appears, including in files that do not exist yet.
  const root = pathSync.resolve(__dirname, '..');

  for (const file of sourceFiles(root)) {
    const contents = fsSync.readFileSync(file, 'utf8');

    for (const dead of DEAD_PHRASES) {
      // The declaration of the list itself is the one legitimate mention.
      if (file.endsWith(`personality${pathSync.sep}say.ts`)) continue;
      assert.doesNotMatch(contents, dead, `${pathSync.relative(root, file)} says it like a form`);
    }
  }
});
