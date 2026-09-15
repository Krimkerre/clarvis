import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkingTree } from '../engine/checkpoint/gitFacts';
import { carriedLine, carriedNames, collidingFiles, moveFor, namedFiles, switchRefusal, switchRefusalLine, unreadableTreeLine } from './leftBranches';

/**
 * The switch rule both engines' questions share (plan.md M15; the owner's rule of 15 Sep 2026, found with the peer
 * session): which answers move the checkout, what refuses a move, and what comes along. Real git checks of the same rule
 * are in `leftTasks.test.ts` and `clarvisLeftWork.test.ts`.
 *
 * The guards, in the order someone would notice them missing: a Start fresh from `master` checked as if it switched; an
 * untracked `__pycache__/` refusing every Python project; a modified tracked file or a clashing untracked file carried
 * along silently; the earlier run's own files refusing the very switch that commits them; and 0.17.3's refusal words
 * changed.
 */

const GREETER = 'clarvis/build-the-greeter';

function tree(patch: Partial<WorkingTree>): WorkingTree {
  return { changed: [], untracked: [], shown: [], ...patch };
}

test('a Build on moves the checkout unless the window is on that branch; a Start fresh moves it only from a clarvis branch', () => {
  assert.deepEqual(moveFor(GREETER, 'master', 'master'), { switching: true, target: GREETER, phrase: `Switching to \`${GREETER}\`` });
  assert.equal(moveFor(GREETER, GREETER, 'master').switching, false);
  assert.deepEqual(moveFor(undefined, GREETER, 'master'), { switching: true, target: 'master', phrase: 'Starting fresh from `master`' });
  assert.equal(moveFor(undefined, 'master', 'master').switching, false);
  assert.equal(moveFor(undefined, 'feature', 'master').switching, false, 'from a real branch, a fresh task starts where the window is, as `AgentBranch.begin` does');
  assert.equal(moveFor(undefined, undefined, 'master').switching, false, 'so it does from a detached HEAD');
});

test("the rule: tracked changes and clashing untracked files refuse; other untracked files, scratch space and the earlier run's files being committed don't", () => {
  assert.equal(switchRefusal(tree({ untracked: ['__pycache__/greet.cpython-312.pyc', 'README.md'] }), ['greet.py']), undefined);
  assert.deepEqual(switchRefusal(tree({ changed: ['greet.py'] }), []), { changed: ['greet.py'], colliding: [] });
  assert.deepEqual(switchRefusal(tree({ untracked: ['greet.py', 'notes.txt'] }), ['greet.py']), { changed: [], colliding: ['greet.py'] });
  assert.equal(switchRefusal(tree({ changed: ['.clarvis/tmp/log.txt'], untracked: ['.clarvis/tmp/out.txt'] }), ['.clarvis/tmp/out.txt']), undefined);
  assert.equal(switchRefusal(tree({ changed: ['greet.py'], untracked: ['test_greet.py'] }), ['test_greet.py'], ['greet.py', 'test_greet.py']), undefined, "the earlier run's own files are committed first");
  assert.deepEqual(switchRefusal(tree({ untracked: ['greet.py'] }), [], [], ['greet.py']), { changed: ['greet.py'], colliding: [] }, "an earlier run's file changed since refuses, tracked or not");
});

test('clashes: the same path, a file where the branch has a folder, and a file inside what the branch has as a file', () => {
  assert.deepEqual(collidingFiles(['a.txt', 'docs', 'lib/x.py', 'free.txt', 'src/new.py'], ['a.txt', 'docs/guide.md', 'lib', 'src/old.py']), ['a.txt', 'docs', 'lib/x.py']);
  assert.deepEqual(collidingFiles([], ['a.txt']), []);
});

test('what comes along is named as git shows it, a folder once, without scratch space', () => {
  assert.deepEqual(
    carriedNames(tree({ untracked: ['__pycache__/a.pyc', 'README.md', '.clarvis/tmp/log.txt', '.clarvis/notes.md'], shown: ['.clarvis/', 'README.md', '__pycache__/'] })),
    ['.clarvis/notes.md', 'README.md', '__pycache__/']
  );
  assert.deepEqual(carriedNames(tree({ untracked: ['.clarvis/tmp/log.txt'], shown: ['.clarvis/'] })), []);
  assert.deepEqual(carriedNames(tree({ untracked: ['.clarvis/tmp/log.txt', 'README.md'], shown: ['.clarvis/tmp/log.txt', 'README.md'] })), ['README.md'], 'a scratch file git names on its own');
});

test("the lines: 0.17.3's refusal word for word with tracked changes alone, a clash, both, the files that come along, and git that can't say", () => {
  const toGreeter = moveFor(GREETER, 'master', 'master');
  assert.equal(
    switchRefusalLine('Codex', 'master', toGreeter, { changed: ['README.md', 'notes.txt'], colliding: [] }),
    `You have changes on \`master\` that aren't committed yet (\`README.md\`, \`notes.txt\`). Switching to \`${GREETER}\` would carry them along, so Codex didn't start. Commit them or put them aside, then ask again.`
  );
  assert.equal(
    switchRefusalLine('I', GREETER, moveFor(undefined, GREETER, 'master'), { changed: [], colliding: ['a.txt', 'b.txt'] }),
    "`a.txt`, `b.txt` aren't in git, and `master` has files of the same name. Starting fresh from `master` would clash with them, so I didn't start. Commit them or put them aside, then ask again."
  );
  assert.equal(
    switchRefusalLine('I', 'master', toGreeter, { changed: ['README.md'], colliding: ['greet.py'] }),
    `You have changes on \`master\` that aren't committed yet (\`README.md\`), and \`greet.py\` isn't in git while \`${GREETER}\` has a file of the same name. Switching to \`${GREETER}\` would carry the changes along and clash with the rest, so I didn't start. Commit them or put them aside, then ask again.`
  );
  assert.equal(carriedLine(['README.md']), 'This comes along, not committed anywhere: `README.md`.');
  assert.equal(carriedLine(['__pycache__/', 'README.md', 'a.txt', 'b.txt', 'c.txt']), 'These come along, not committed anywhere: `__pycache__/`, `README.md`, `a.txt` and 2 more.');
  assert.equal(namedFiles(['one']), '`one`');
  assert.equal(unreadableTreeLine('Codex'), "I couldn't tell which files in this folder have changes, so Codex didn't start. Ask again in a moment.");
});
