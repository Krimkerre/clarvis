import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { leftWorkProject } from '../../test/fakes/leftWorkProject';
import { CODEX_STATE_ROUTE } from '../../test/fakes/relayContract';
import { GitFacts } from '../checkpoint/gitFacts';
import { buildOnRefusal, findLeftWork, MOST_OFFERED, offeredTasks } from './leftTasks';

/**
 * Which Codex work counts as left on its branch, so a new request is asked whether to build on it (plan.md M15, "Build
 * on Codex's earlier work"; the owner's decision of 15 Sep 2026). Real git in temporary repositories whose trunk is
 * `master`, as the live test's was, and the fake RAVIS relay.
 *
 * The guards, in the order someone would notice them missing: the owner's own trunk named `main`, or work merged into
 * the trunk offered again; a deleted branch offered, which could only fail; a task without a key offered, or a key
 * reissued behind the owner's back to find out; a running task offered as if it were left; Codex that can't run asked
 * about first; and the owner's uncommitted work carried off by a branch switch.
 */

const GREETER = 'clarvis/build-the-greeter-described-in-readme-md-greet-p';

test('one left Codex task in a master repository: its idle session, its stored key, and its branch not merged into master', async (t) => {
  const p = await leftWorkProject(t);
  const session = p.leaveCodexWork(GREETER, { file: 'greet.py' });

  const found = await findLeftWork(p.deps());

  assert.deepEqual(found.tasks, [
    { sessionId: session.id, taskId: session.taskId, branch: GREETER, tip: p.git('rev-parse', GREETER), updatedAt: session.updatedAt, onBranch: false },
  ]);
  assert.deepEqual([found.startsFrom, found.trunk, found.headBranch], ['master', 'master', 'master'], 'master, as git has it: never a literal main');
  assert.deepEqual(p.fake.violations, []);
});

test('with the window on the left branch, master is still where a fresh task starts and what merged means, and the task is marked as the one the window is on', async (t) => {
  const p = await leftWorkProject(t);
  p.leaveCodexWork(GREETER, { file: 'greet.py' });
  p.git('checkout', '--quiet', GREETER);

  const found = await findLeftWork(p.deps());

  assert.deepEqual([found.startsFrom, found.trunk, found.headBranch], ['master', 'master', GREETER]);
  assert.deepEqual(found.tasks.map((task) => [task.branch, task.onBranch]), [[GREETER, true]]);
});

test('several left tasks: the one the window is on first, then the most recent, at most three', async (t) => {
  const p = await leftWorkProject(t);
  const oldest = p.leaveCodexWork('clarvis/one', { updatedAt: '2026-09-15T10:00:00Z' });
  p.leaveCodexWork('clarvis/two', { updatedAt: '2026-09-15T11:00:00Z' });
  p.leaveCodexWork('clarvis/three', { updatedAt: '2026-09-15T12:00:00Z' });
  p.leaveCodexWork('clarvis/four', { updatedAt: '2026-09-15T13:00:00Z' });
  p.git('checkout', '--quiet', 'clarvis/one');

  const found = await findLeftWork(p.deps());
  const offered = offeredTasks(found.tasks);

  assert.equal(found.tasks.length, 4);
  assert.equal(MOST_OFFERED, 3);
  assert.deepEqual(offered.map((task) => task.branch), ['clarvis/one', 'clarvis/four', 'clarvis/three']);
  assert.equal(offered[0].sessionId, oldest.id);
  assert.equal(found.startsFrom, 'master', 'on a Codex branch with no base remembered, master is found, not main');
});

test('without idle Codex tasks nothing is found: running, stopped, ended and failed tasks are not left work, and are not even read', async (t) => {
  const p = await leftWorkProject(t);
  for (const state of ['running', 'completed_needs_review', 'ended', 'failed'] as const) {
    p.leaveCodexWork(`clarvis/${state.replace(/_/g, '-')}`, { state });
  }

  const found = await findLeftWork(p.deps());

  assert.deepEqual(found.tasks, []);
  assert.equal(p.sent.filter((line) => /^GET \/api\/v1\/agent-sessions\/as_/.test(line)).length, 0);
});

test('a branch merged into master, or deleted, is not offered', async (t) => {
  const p = await leftWorkProject(t);
  p.leaveCodexWork('clarvis/merged');
  p.leaveCodexWork('clarvis/deleted');
  const open = p.leaveCodexWork(GREETER, { file: 'greet.py' });
  p.git('merge', '--quiet', '--no-ff', '-m', 'Merge clarvis/merged', 'clarvis/merged');
  p.git('branch', '-q', '-D', 'clarvis/deleted');
  const logged: string[] = [];

  const found = await findLeftWork(p.deps({ log: (line) => void logged.push(line) }));

  assert.deepEqual(found.tasks.map((task) => task.sessionId), [open.id]);
  assert.ok(logged.some((line) => /clarvis\/merged is merged into master$/.test(line)), logged.join('\n'));
  assert.ok(logged.some((line) => /its branch clarvis\/deleted is gone$/.test(line)), logged.join('\n'));
});

test("the plan's declared trunk counts: work merged into it isn't offered, while a fresh task still starts where it always has", async (t) => {
  const p = await leftWorkProject(t);
  p.git('branch', 'develop');
  fs.writeFileSync(path.join(p.root, 'plan.md'), '# Plan\n\n## Branch flow\n\n- trunk: develop\n- work: clarvis/<task>\n');
  p.leaveCodexWork('clarvis/into-develop');
  const open = p.leaveCodexWork(GREETER, { file: 'greet.py' });
  p.git('checkout', '--quiet', 'develop');
  p.git('merge', '--quiet', '--no-ff', '-m', 'Merge clarvis/into-develop', 'clarvis/into-develop');
  p.git('checkout', '--quiet', 'master');

  const found = await findLeftWork(p.deps());

  assert.deepEqual([found.startsFrom, found.trunk], ['master', 'develop']);
  assert.deepEqual(found.tasks.map((task) => task.sessionId), [open.id]);
});

test('a remembered base is where a fresh task starts from a Codex branch; a repository without a commit offers nothing and asks RAVIS nothing', async (t) => {
  const p = await leftWorkProject(t);
  p.git('branch', 'release');
  p.leaveCodexWork(GREETER, { file: 'greet.py' });
  p.git('checkout', '--quiet', GREETER);

  const remembered = await findLeftWork(p.deps({ rememberedBase: 'release' }));
  assert.deepEqual([remembered.startsFrom, remembered.trunk, remembered.tasks.length], ['release', 'release', 1]);

  const empty = path.join(path.dirname(p.root), 'no-commit-yet');
  fs.mkdirSync(empty);
  execFileSync('git', ['-C', empty, 'init', '--quiet', '--initial-branch=master']);
  const sentBefore = p.sent.length;
  const none = await findLeftWork(p.deps({ git: new GitFacts(empty) }));
  assert.deepEqual(none.tasks, []);
  assert.deepEqual(p.sent.slice(sentBefore), ['GET /api/v1/codex']);
});

test('a task whose key is missing, whose stored key RAVIS refuses, or whose key file is unsafe is not offered, and no key is reissued to find out', async (t) => {
  const p = await leftWorkProject(t);
  const keyless = p.leaveCodexWork('clarvis/keyless', { storeKey: false });
  const refused = p.leaveCodexWork('clarvis/refused', { storeKey: false });
  p.tokens.save(p.root, refused.id, `ast_${'A'.repeat(43)}`, refused.taskId);
  const logged: string[] = [];

  const found = await findLeftWork(p.deps({ log: (line) => void logged.push(line) }));

  assert.deepEqual(found.tasks, []);
  assert.equal(p.sent.some((line) => line.endsWith('/reissue-token')), false, 'no key reissued');
  assert.equal(p.sent.includes(`GET /api/v1/agent-sessions/${keyless.id}`), false, 'a task without a key is not read');
  assert.ok(logged.some((line) => line.includes(keyless.id) && /no key to it$/.test(line)), logged.join('\n'));
  assert.ok(logged.some((line) => line.includes(refused.id) && /didn't accept its key/.test(line)), logged.join('\n'));

  p.leaveCodexWork(GREETER, { file: 'greet.py' });
  fs.chmodSync(p.tokens.fileFor(p.root), 0o644);
  assert.deepEqual((await findLeftWork(p.deps())).tasks, [], "a key file that isn't safe offers nothing from it");
  assert.deepEqual(p.fake.violations, []);
});

test('Codex readiness comes first: when Codex may not run, nothing is listed, read or offered', async (t) => {
  const p = await leftWorkProject(t);
  p.leaveCodexWork(GREETER, { file: 'greet.py' });
  p.fake.reply(CODEX_STATE_ROUTE, 'signed out');

  const found = await findLeftWork(p.deps());

  assert.deepEqual(found.tasks, []);
  assert.deepEqual(p.sent, ['GET /api/v1/codex']);
});

test('one task per branch: two idle tasks on the same branch offer only the most recent', async (t) => {
  const p = await leftWorkProject(t);
  p.leaveCodexWork(GREETER, { file: 'greet.py', updatedAt: '2026-09-15T16:20:00Z' });
  const later = p.fake.sessions().seed({ root: p.root, state: 'idle', holdsLock: false, turnActive: false, updatedAt: '2026-09-15T16:27:00Z' });
  later.stream.patchView({ branch: { name: GREETER, head_commit_at_start: p.git('rev-parse', 'master') } });
  p.tokens.save(p.root, later.id, later.token, later.taskId);

  const found = await findLeftWork(p.deps());

  assert.deepEqual(found.tasks.map((task) => task.sessionId), [later.id]);
});

test("building on another branch is refused, in plain words, while the owner has uncommitted work; on the branch itself, or with a clean tree, it isn't", async (t) => {
  const p = await leftWorkProject(t);
  p.leaveCodexWork(GREETER, { file: 'greet.py' });
  const facts = new GitFacts(p.root);
  assert.equal(buildOnRefusal('master', GREETER, await facts.dirty()), undefined, 'a clean tree switches');

  fs.writeFileSync(path.join(p.root, 'README.md'), '# Greeter, edited by the owner\n');
  fs.writeFileSync(path.join(p.root, 'notes.txt'), 'mine\n');

  assert.equal(
    buildOnRefusal('master', GREETER, await facts.dirty()),
    `You have changes on \`master\` that aren't committed yet (\`README.md\`, \`notes.txt\`). Switching to \`${GREETER}\` would carry them along, so Codex didn't start. Commit them or put them aside, then ask again.`
  );
  assert.equal(buildOnRefusal(GREETER, GREETER, await facts.dirty()), undefined, "no switch on the branch itself: files in flight stay the owner's");
  assert.equal(buildOnRefusal('master', GREETER, ['.clarvis/tmp/scratch.log']), undefined, "Codex's scratch space isn't the owner's work");
  assert.match(buildOnRefusal(undefined, GREETER, ['a', 'b', 'c', 'd', 'e']) ?? '', /^You have changes that aren't committed yet \(`a`, `b`, `c` and 2 more\)\./);
});
