import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { forgetGitOfferDeclined, gitOfferDeclined, GIT_OFFER_DECLINED_KEY, rememberGitOfferDeclined, type OfferMemory } from '../agent/gitOfferMemory';
import { setUpGit, type GitSetupResult } from '../agent/gitSetup';
import { chooseEngine } from '../engine/engineChoice';
import { asksGitOfferBeforeRun, chatRunDecision } from './codingRunFactory';
import {
  CODEX_GIT_LINES,
  gitSetupChoice,
  gitSetupChoices,
  NOT_NOW,
  offerCodexGitSetup,
  SET_UP_GIT,
  type CodexGitSetupHost,
} from './codexGitSetup';
import { PendingChoice } from './PendingChoice';

/**
 * **Set up git here**, from Codex's refusal to the task carried on (plan.md M15, "Codex offers to set git up"; the
 * owner's decision of 14 Sep 2026). Driven through the real `PendingChoice` the chat panel answers, and real git in
 * temporary folders, never this repository.
 *
 * The loop this ends, found live that day: the owner had declined Clarvis's own `git init` offer, Codex refused the
 * task for want of git, and "git init then" went to Codex as a new task and was refused again. So the guards, in the
 * order someone would notice them missing: the offer hidden by that old decline; "git init" typed and sent to Codex
 * instead of answering; git set up but the task not carried on; a failure said nowhere; a machine without git offered
 * a button that can only fail; the old decline wiped by a "not now"; and a mode switch saying "yes" on the owner's behalf.
 */

// ── A chat, a folder and a memory ────────────────────────────────────────────

interface Harness {
  root: string;
  host: CodexGitSetupHost;
  pending: PendingChoice;
  /** The buttons each time the panel was given some, and `[]` each time they were cleared. */
  offered: string[][];
  said: string[];
  logged: string[];
  memory: Map<string, unknown>;
  carriedOn: number;
  setUps: number;
}

/** A memory like `workspaceState`, over a map. */
function memoryOver(values: Map<string, unknown>): OfferMemory {
  return {
    get: (key) => values.get(key),
    update: async (key, value) => void (value === undefined ? values.delete(key) : values.set(key, value)),
  };
}

function project(t: TestContext): { root: string; home: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-codex-git-')));
  const root = path.join(base, 'codex test b');
  const home = path.join(base, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'notes.md'), '# a folder without git\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { root, home };
}

/** Git with none of this machine's settings: a name and email to commit with, or none, so git refuses. */
function gitEnv(home: string, identity: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && key !== 'EMAIL') env[key] = value;
  }
  const config = path.join(home, identity ? 'with-identity' : 'without-identity');
  const user = identity ? '[user]\n\tname = Clarvis test\n\temail = clarvis-test@example.invalid\n' : '[user]\n\tuseConfigOnly = true\n';
  fs.writeFileSync(config, `${user}[commit]\n\tgpgsign = false\n`);
  return { ...env, HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
}

function harness(
  t: TestContext,
  options: { declined?: boolean; setUp?: (root: string, home: string, attempt: number) => Promise<GitSetupResult> } = {}
): Harness {
  const { root, home } = project(t);
  const offered: string[][] = [];
  const pending = new PendingChoice((items) => offered.push(items.map((item) => item.label)));
  const memory = new Map<string, unknown>(options.declined ? [[GIT_OFFER_DECLINED_KEY, true]] : []);
  const setUp = options.setUp ?? ((where, gitHome) => setUpGit(where, { log: () => undefined, env: gitEnv(gitHome, true) }));
  const h: Harness = { root, host: undefined as unknown as CodexGitSetupHost, pending, offered, said: [], logged: [], memory, carriedOn: 0, setUps: 0 };
  // As `RunSession.offerGitSetup` wires it: its own buttons only, with the offer's typed answers.
  h.host = {
    ask: () => pending.ask(gitSetupChoices(), 'setting git up for Codex', true, gitSetupChoice),
    note: async (line) => void h.said.push(line),
    setUp: () => setUp(root, home, ++h.setUps),
    memory: memoryOver(memory),
    carryOn: async () => void h.carriedOn++,
    log: (line) => void h.logged.push(line),
  };
  return h;
}

/**
 * The offer running, once its buttons are on screen. Wrapped in an object on purpose: an async function returning
 * the offer's promise itself would wait for the offer to end, which it never does without an answer.
 */
async function offered(h: Harness): Promise<{ flow: Promise<void> }> {
  const flow = offerCodexGitSetup(h.host);
  await until(() => h.pending.isWaiting);
  return { flow };
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the offer');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function commits(root: string, home: string): string {
  return execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { env: gitEnv(home, true), encoding: 'utf8' }).trim();
}

function hasGit(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'));
}

// ── The offer ─────────────────────────────────────────────────────────────────

test('the offer appears after an earlier decline of Clarvis’s own git offer: one plain line, and Set up git here as a button', async (t) => {
  const h = harness(t, { declined: true });

  const { flow } = await offered(h);

  assert.deepEqual(h.said, [CODEX_GIT_LINES.offer]);
  assert.match(CODEX_GIT_LINES.offer, /runs `git init` and makes a first commit in this folder/);
  assert.deepEqual(h.offered.at(-1), [SET_UP_GIT, NOT_NOW]);
  h.pending.cancel();
  await flow;
});

test('clicking Set up git here sets git up, then carries the Codex task on, and the old decline is forgotten', async (t) => {
  const h = harness(t, { declined: true });
  const { flow } = await offered(h);

  assert.equal(h.pending.supply(SET_UP_GIT), true);
  await flow;

  assert.equal(hasGit(h.root), true);
  assert.equal(commits(h.root, path.join(path.dirname(h.root), 'home')), '1');
  assert.equal(h.carriedOn, 1, 'the task carries on without being typed again');
  assert.equal(gitOfferDeclined(memoryOver(h.memory)), false, 'the owner has since said yes to git here');
  assert.deepEqual(h.offered.at(-1), [], 'the buttons are gone');
});

test('typing "git init", the owner’s own "git init then", "set it up" or "yes" does what the button does', async (t) => {
  for (const typed of ['git init', 'git init then', 'set it up', 'yes', 'Set up git here']) {
    const h = harness(t, { declined: true });
    const { flow } = await offered(h);

    // Consumed: `ChatService.runTook` stops routing here, so it never reaches Codex as a new task.
    assert.equal(h.pending.supply(typed), true, typed);
    await flow;

    assert.equal(hasGit(h.root), true, typed);
    assert.equal(h.carriedOn, 1, typed);
  }
});

test('anything else typed is the message it is: the offer goes, nothing is set up, and nothing is carried on', async (t) => {
  for (const typed of ['build me a todo app', 'why does Codex need git?', 'do the other thing first']) {
    const h = harness(t, { declined: true });
    const { flow } = await offered(h);

    assert.equal(h.pending.supply(typed), false, `${typed} goes on to be read as a message`);
    await flow;

    assert.deepEqual([h.setUps, h.carriedOn, hasGit(h.root)], [0, 0, false], typed);
  }
});

test('Not now, typed or clicked, sets nothing up and leaves the remembered answer exactly as it was', async (t) => {
  for (const [typed, declined] of [
    [NOT_NOW, true],
    ['no', true],
    ['not now', false],
  ] as const) {
    const h = harness(t, { declined });
    const { flow } = await offered(h);

    assert.equal(h.pending.supply(typed), true);
    await flow;

    assert.deepEqual([h.setUps, h.carriedOn, hasGit(h.root)], [0, 0, false], typed);
    assert.equal(gitOfferDeclined(memoryOver(h.memory)), declined, `${typed}: the decline is neither cleared nor recorded`);
  }
});

test('a switch to Unattended pressing "Do it" is not a yes to git: the offer goes and nothing is set up', async (t) => {
  const h = harness(t);
  const { flow } = await offered(h);

  // `RunSession.modeStoppedAsking` supplies "Do it" as not typed.
  assert.equal(h.pending.supply('Do it', false), false);
  await flow;

  assert.deepEqual([h.setUps, h.carriedOn, hasGit(h.root)], [0, 0, false]);
});

test('a question’s own words answer only with a button it offered', async () => {
  const pending = new PendingChoice(() => undefined);
  const answer = pending.ask([{ label: 'Carry on' }, { label: 'Not now' }], undefined, true, () => 'Set up git here');

  assert.equal(pending.supply('whatever'), false, 'a matcher naming a button that is not there answers nothing');
  assert.equal(await answer, undefined);
});

// ── When setting git up fails ─────────────────────────────────────────────────

test('a failed first commit is said in plain words, leaves no half-set-up folder or changed decline, and offers the button again', async (t) => {
  // The first attempt meets a git with no name and email; by the second the owner has set them.
  const h = harness(t, { declined: true, setUp: (root, home, attempt) => setUpGit(root, { log: () => undefined, env: gitEnv(home, attempt > 1) }) });
  const { flow } = await offered(h);

  h.pending.supply(SET_UP_GIT);
  await until(() => h.said.length === 2 && h.pending.isWaiting);

  assert.match(h.said[1], /^Git doesn't know your name and email yet, so it couldn't make the first commit\. I took the half-made git setup back out/);
  assert.equal(hasGit(h.root), false);
  assert.equal(h.carriedOn, 0);
  assert.equal(gitOfferDeclined(memoryOver(h.memory)), true, 'a setup that failed forgets nothing');
  assert.deepEqual(h.offered.at(-1), [SET_UP_GIT, NOT_NOW], 'worth another click once name and email are set');

  h.pending.supply('git init');
  await flow;

  assert.deepEqual([h.setUps, h.carriedOn, hasGit(h.root)], [2, 1, true]);
  assert.equal(gitOfferDeclined(memoryOver(h.memory)), false);
});

test('no git on the machine says how to get it, offers no second click, and carries nothing on', async (t) => {
  const h = harness(t, {
    declined: true,
    setUp: (root, home) => setUpGit(root, { log: () => undefined, env: gitEnv(home, true), git: path.join(home, 'no-such-git'), platform: 'darwin' }),
  });
  const { flow } = await offered(h);

  h.pending.supply(SET_UP_GIT);
  await flow;

  assert.match(h.said[1], /^Git isn't installed on this machine.*xcode-select --install/);
  assert.equal(h.pending.isWaiting, false, 'no button that can only fail');
  assert.deepEqual([h.setUps, h.carriedOn, hasGit(h.root)], [1, 0, false]);
  assert.equal(gitOfferDeclined(memoryOver(h.memory)), true);
});

test('git set up but not yet seen by the editor says so and does not carry on into the same refusal', async (t) => {
  const h = harness(t, {
    declined: true,
    setUp: async (root, home) => {
      const result = await setUpGit(root, { log: () => undefined, env: gitEnv(home, true) });
      return result.ok ? { ...result, editorCaughtUp: false } : result;
    },
  });
  const { flow } = await offered(h);

  h.pending.supply(SET_UP_GIT);
  await flow;

  assert.deepEqual(h.said, [CODEX_GIT_LINES.offer, CODEX_GIT_LINES.notCaughtUp]);
  assert.equal(h.carriedOn, 0);
  assert.equal(gitOfferDeclined(memoryOver(h.memory)), false, 'git is set up all the same');
});

// ── Where the offer can come from at all ─────────────────────────────────────

test('an untrusted folder gets no offer: Codex is refused before any run, and Clarvis’s own git offer is not asked for it', () => {
  const inputs = { model: 'ravis/clarvis-codex', source: 'user' as const, baseUrl: 'http://127.0.0.1:8731' };
  const untrusted = chatRunDecision(chooseEngine({ ...inputs, trusted: false }));
  const codex = chatRunDecision(chooseEngine({ ...inputs, trusted: true }));
  const clarvis = chatRunDecision(chooseEngine({ ...inputs, model: 'qwen3-coder', trusted: true }));

  // Refused before a runner exists, so there is no git refusal for the chat to offer anything under.
  assert.equal(untrusted.run, 'refused');
  assert.equal(asksGitOfferBeforeRun(untrusted), false);
  // Codex offers in the chat after its own checks, never through the modal that says declining is fine.
  assert.equal(asksGitOfferBeforeRun(codex), false);
  assert.equal(asksGitOfferBeforeRun(clarvis), true, "Clarvis's own engine still asks before its run, as it did");
});

test('Ask About Git Setup Again still resets Clarvis’s own offer, and a decline is still remembered for it', async () => {
  const values = new Map<string, unknown>();
  const memory = memoryOver(values);

  await rememberGitOfferDeclined(memory);
  assert.equal(gitOfferDeclined(memory), true, "declining Clarvis's own offer means it doesn't ask again");
  assert.equal(values.get('clarvis.agent.gitOfferDeclined'), true, 'under the key earlier versions stored it at');

  await forgetGitOfferDeclined(memory);
  assert.equal(gitOfferDeclined(memory), false, 'the command makes it ask again');
});

test('typed answers: the offer’s own words and the shared yes and no; questions and sentences are not answers', () => {
  for (const yes of ['git init', 'Git init then', 'run git init', 'init', 'set it up', 'set up git', 'setup', 'initialise it', 'go ahead', 'yes', 'ok', 'do it']) {
    assert.equal(gitSetupChoice(yes), SET_UP_GIT, yes);
  }
  for (const no of ['no', 'not now', 'nope', 'later']) assert.equal(gitSetupChoice(no), NOT_NOW, no);
  for (const other of ['git init?', 'what does git init do', 'build me a todo app', 'make the button blue']) {
    assert.equal(gitSetupChoice(other), undefined, other);
  }
});
