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
  // The constraint that stops a personality layer becoming a hazard — kept even though
  // warnings are no longer rewritten, because the licence is what a future caller
  // would rely on if that ever changes.
  const prompt = rewritePrompt({ purpose: 'warn', fallback: 'This deletes work that exists nowhere else.' });

  assert.match(prompt, /State the risk first/);
  assert.match(prompt, /never funny about what could be lost/);
});

test('a choice keeps its consequence exactly', () => {
  const prompt = rewritePrompt({ purpose: 'ask', fallback: 'Delete the branch?' });

  assert.match(prompt, /consequence of the choice must survive exactly/);
  assert.match(prompt, /no jokes/i);
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

import { worthRewriting } from './say';
import { EXAMPLES } from './character';

test('the brief asks for a line that lands, not merely an inoffensive one', () => {
  // The first version was a list of prohibitions with no instruction to be funny. A
  // model given only bans writes the safest sentence available, and the safest
  // sentence is a talking fridge.
  const prompt = rewritePrompt({ purpose: 'report', fallback: 'The tests pass.' });

  assert.match(prompt, /Never neutral/);
  assert.match(prompt, /entirely unimpressed/);
  // Real lines as the anchor: describing a voice produces a description-shaped
  // sentence; examples of the thing produce the thing. Which lines appear rotates, so
  // this asks that some of them do rather than naming one.
  assert.ok(EXAMPLES.some((example) => prompt.includes(example)));
  // A rewrite gets the line and nothing else, so it must be told that is all it has.
  assert.match(prompt, /except what you have been explicitly told/);
});

test('warnings and questions are left alone entirely', () => {
  // They were already plain, exact and fine. Rewriting them bought stiffness.
  assert.equal(worthRewriting('warn'), false);
  assert.equal(worthRewriting('ask'), false);
  assert.equal(worthRewriting('report'), true);
  assert.equal(worthRewriting('aside'), true);
});

// ------------- a line about a moment needs the moment, or one gets invented

test('the situation reaches the rewrite when given', () => {
  // Found live: clicking the bowtie produced "Clearly a compliment from someone who
  // hasn't seen me disagree with you yet" — a reply to praise nobody had paid. The
  // written line was "A second opinion on my own intelligence. Bracing.", and with only
  // that to go on, reading it as a response to a compliment is a fair inference.
  const prompt = rewritePrompt({
    purpose: 'aside',
    fallback: 'Shopping for a second opinion on my own intelligence. Bracing.',
    situation: 'the user has just opened the picker where the model running Clarvis is chosen',
  });

  assert.match(prompt, /What is happening: the user has just opened the picker/);
});

test('a line that carries its own occasion needs no situation', () => {
  // Most do. A briefing about a branch is unmistakably a briefing about a branch, and an
  // empty "What is happening:" line would be noise in every prompt that does not need it.
  const prompt = rewritePrompt({ purpose: 'report', fallback: 'You are on main.' });
  assert.doesNotMatch(prompt, /What is happening/);
});

// ------------- a rewrite may not introduce a number nobody supplied

test('a rewrite that invents a count is rejected', () => {
  // The written line says the build failed. It does not say how often. A model that
  // supplies "the third time" has supplied it from nowhere, and the number is the part a
  // reader will believe.
  assert.equal(
    acceptRewrite(
      { purpose: 'report', fallback: 'That build failed again.' },
      'That build has failed for the third time.'
    ),
    undefined
  );
});

test('a rewrite may repeat a number it was given', () => {
  assert.equal(
    acceptRewrite(
      { purpose: 'report', fallback: 'The build has failed 4 times this week.' },
      'The build has failed 4 times this week, which is a habit now.'
    ),
    'The build has failed 4 times this week, which is a habit now.'
  );
});

test('a rewrite may spell out a number it was given', () => {
  // "Forty minutes" and "40 minutes" are the same fact, and rejecting the rewrite for
  // spelling it out would leave the layer paying for nothing.
  assert.equal(
    acceptRewrite(
      { purpose: 'report', fallback: 'It has been failing for 40 minutes.' },
      'It has been failing for forty minutes.'
    ),
    'It has been failing for forty minutes.'
  );
});

test('a rewrite may not re-file a number under a different noun', () => {
  // The observed failure, in miniature: forty minutes became a fortieth occurrence.
  assert.equal(
    acceptRewrite(
      { purpose: 'report', fallback: 'It has been failing for 40 minutes.' },
      'That is the 40th time it has failed.'
    ),
    undefined
  );
});

test('facts that had to be kept count as given', () => {
  // `keep` is exactly the set of things the rewrite was obliged to carry, so a number
  // among them is one it was entitled to say — even though the written line never
  // mentioned it.
  assert.equal(
    acceptRewrite(
      { purpose: 'report', fallback: 'The tests are unhappy.', keep: ['3 failures'] },
      '3 failures, and the tests are unhappy.'
    ),
    '3 failures, and the tests are unhappy.'
  );
});

test('a kept fact must still be carried verbatim', () => {
  // Unchanged, and worth pinning next to the test above so the two rules are not confused:
  // grounding says a number may be *used*, `keep` says a fact must survive *as written*.
  assert.equal(
    acceptRewrite(
      { purpose: 'report', fallback: 'The tests are unhappy.', keep: ['3 failures'] },
      'Three failures, and the tests are unhappy.'
    ),
    undefined
  );
});

test('a line with no numbers is unaffected', () => {
  assert.equal(
    acceptRewrite({ purpose: 'report', fallback: 'You are on main.' }, 'You are on main, still.'),
    'You are on main, still.'
  );
});

// ------------- a rewrite has to still be the line

test('a lead-in that no longer leads in is rejected', () => {
  // Found live, 13 September 2026: the build offer's lead-in came back finished with an
  // invented thought, and the task it was meant to introduce read as an afterthought.
  const line = { purpose: 'report' as const, fallback: 'This is what I would be handing myself:' };

  assert.equal(
    acceptRewrite(
      line,
      'This is what I would be handing myself: turning this single swallowed exception into something actionable takes precedent over clever silence.'
    ),
    undefined
  );
  assert.equal(acceptRewrite(line, 'Here is the errand I would be sending myself on:'), 'Here is the errand I would be sending myself on:');
});

test('a reply about the instruction is not a line', () => {
  // The other live output from the same lead-in: the model explained the task back.
  assert.equal(
    acceptRewrite(
      { purpose: 'report', fallback: 'This is what I would be handing myself:' },
      'A line rewritten in character requires a line to rewrite.'
    ),
    undefined
  );
  assert.equal(
    acceptRewrite({ purpose: 'report', fallback: 'The tests pass.' }, 'I cannot rewrite this in character.'),
    undefined
  );
});

test('a line that is itself about rewriting may still say so', () => {
  const line = { purpose: 'report' as const, fallback: 'The rewrite of the parser is merged.' };

  assert.equal(acceptRewrite(line, 'The parser rewrite is merged, at last.'), 'The parser rewrite is merged, at last.');
});
