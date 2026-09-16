import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentBranch } from '../agent/AgentBranch';
import { AgentRunner, type AgentEvent } from '../agent/AgentRunner';
import { placedRunOptions, type LeftRunTask } from '../agent/leftRuns';
import type { AgentTerminal } from '../agent/tools/commandTools';
import { GitFacts } from '../engine/checkpoint/gitFacts';
import type { LeftRun } from '../engine/checkpoint/leftWorkFile';
import { CodexGitGlue } from '../engine/codex/codexGit';
import { RelayClient } from '../engine/relay/relayClient';
import { Activity, type NoteChange } from '../bridge/activity';
import { eventForNote } from '../bridge/publish';
import type { ModelMessage } from '../model/ModelProvider';
import type { ModelService } from '../model/ModelService';
import { fakeHttp, FakeRavisRelay } from './fakes/FakeRavisRelay';
import { invokedSkillLog, invokedSkillSection, loadInvokedSkill } from '../agent/tools/skillTools';
import { exampleNamed, SKILL_READ_ROUTE } from './fakes/relayContract';

/**
 * Branch continuation against the real Git extension (plan.md M15 C3; review B2). After Codex commits on `clarvis/x`,
 * Clarvis's own engine continues on `clarvis/x` — the commit present, the base still `main` — and a branch moved away
 * from the saved commit is refused. The decision is unit-tested (`branchNames.test.ts`, `gitFacts.test.ts`); this checks
 * `AgentBranch.continueOn` drives the Git extension the way those tests assume.
 *
 * The fixture repository is made in a temporary folder and put first among the workspace folders, because
 * `AgentBranch` works in the first folder only; it is removed again afterwards.
 */
suite('branch continuation in the extension host (M15 C3)', () => {
  let root = '';

  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();

  suiteSetup(async function () {
    this.timeout(30_000);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-continue-')));
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Clarvis test');
    git('config', 'user.email', 'clarvis-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello")\n');
    git('add', 'hello.py');
    git('commit', '--quiet', '-m', 'first');
    vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.file(root) });
    const gitApi = (await vscode.extensions.getExtension('vscode.git')?.activate())?.getAPI(1);
    await gitApi?.openRepository(vscode.Uri.file(root));
  });

  suiteTeardown(() => {
    const index = vscode.workspace.workspaceFolders?.findIndex((folder) => folder.uri.fsPath === root) ?? -1;
    if (index >= 0) vscode.workspace.updateWorkspaceFolders(index, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("after Codex commits on clarvis/x, Clarvis's own engine continues on clarvis/x with the commit present and the base still main", async function () {
    this.timeout(30_000);
    git('checkout', '--quiet', '-b', 'clarvis/x');
    fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello, UTC")\n');
    git('commit', '--quiet', '-am', "Codex's work on the task (stopped for a switch)");
    const saved = git('rev-parse', 'HEAD');
    git('checkout', '--quiet', 'main');
    const memory = new Map<string, string>([['clarvis.agent.baseBranch', 'main']]);
    const branch = new AgentBranch(() => undefined, { get: (key) => memory.get(key), update: async (key, value) => void memory.set(key, value) });

    const isolation = await branch.continueOn({ branch: 'clarvis/x', headCommit: saved, theirs: [] });

    assert.deepStrictEqual([isolation.isolated, isolation.refused, branch.current, branch.previous], [true, undefined, 'clarvis/x', 'main']);
    assert.strictEqual(git('rev-parse', 'HEAD'), saved, 'the commit Codex saved is where the run carries on');
    assert.strictEqual(memory.get('clarvis.agent.baseBranch'), 'main', 'the base stays main');
  });

  test('a branch moved away from the saved commit is refused, and nothing is checked out', async function () {
    this.timeout(30_000);
    const saved = git('rev-parse', 'clarvis/x');
    git('checkout', '--quiet', 'main');
    git('branch', '--force', 'clarvis/x', 'main');
    const branch = new AgentBranch(() => undefined);

    const isolation = await branch.continueOn({ branch: 'clarvis/x', headCommit: saved, theirs: [] });

    assert.deepStrictEqual([isolation.isolated, isolation.refused], [false, true]);
    assert.match(isolation.advice ?? '', /no longer contains the saved work/);
    assert.strictEqual(git('symbolic-ref', '--short', 'HEAD'), 'main');
  });

  /**
   * **Build on** Codex's earlier work (plan.md M15, "Build on Codex's earlier work"; the owner's decision of 15 Sep 2026).
   * Which tasks are offered, the question and the turn are tested with real git and the fake RAVIS (`leftTasks.test.ts`,
   * `codexLeftWork.test.ts`, `runCore.test.ts`); this checks what only an extension host has: `CodexGitGlue.continueOn`
   * moves the window from the trunk to the branch Codex left, makes no new branch, says the work started from the trunk,
   * and commits Codex's next change there under the new request. In this suite, on its repository, because a run can
   * change the first workspace folder only once: a second spec doing so had its changes refused.
   */
  test('Build on: the window moves from main to the branch Codex left, with no new branch, and Codex’s next change is committed there under the new request', async function () {
    this.timeout(30_000);
    const greeter = 'clarvis/build-the-greeter';
    const shout = 'Also add a --shout option to greet.py that prints the greeting in capitals, with a test for it.';
    git('checkout', '--quiet', '-b', greeter, 'main');
    fs.writeFileSync(path.join(root, 'greet.py'), 'print("hello")\n');
    git('add', 'greet.py');
    git('commit', '--quiet', '-m', 'Codex: build the greeter');
    git('checkout', '--quiet', 'main');
    const tip = git('rev-parse', greeter);
    const branchesBefore = git('for-each-ref', '--format=%(refname:short)', 'refs/heads');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-build-on-storage-'));
    await gitCaughtUp(root, () => true);
    const glue = new CodexGitGlue(standInContext(storage), root, () => undefined);

    try {
      const continued = await glue.continueOn(greeter, tip, shout);

      assert.deepStrictEqual(continued, { ok: true, branch: greeter, headCommit: tip });
      assert.strictEqual(git('symbolic-ref', '--short', 'HEAD'), greeter, 'the checkout is on the branch Codex left');
      assert.strictEqual(git('for-each-ref', '--format=%(refname:short)', 'refs/heads'), branchesBefore, 'no new branch');
      assert.deepStrictEqual(glue.branches, { working: greeter, startedFrom: 'main' }, 'the landing question offers the trunk');

      fs.writeFileSync(path.join(root, 'greet.py'), 'import sys\nprint("HELLO" if "--shout" in sys.argv else "hello")\n');
      await gitCaughtUp(root, (state) => state.workingTreeChanges.some((change) => change.uri.fsPath === path.join(root, 'greet.py')));
      const saved = await glue.save({ summary: 'Added --shout.', stopped: false, files: ['greet.py'], branch: greeter });

      assert.ok(saved.ok && saved.committed, JSON.stringify(saved));
      assert.strictEqual(git('rev-parse', `${greeter}~1`), tip, "the new commit sits on Codex's earlier work");
      assert.ok(git('log', '-1', '--format=%B', greeter).includes(`Task: ${shout}`), 'the commit names the new request');
    } finally {
      git('checkout', '--quiet', 'main');
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  // Clarvis's own engine building on its earlier run, and Start fresh never stacking (plan.md M15, "Build on Clarvis's own
  // earlier work"): in this suite, on its repository, for the same reason as the Codex test above. The bodies are below.
  test("Build on (Clarvis's own engine): the run moves from main to the branch its earlier run left, with no new branch, is told that run's task and summary, and commits on top; the remembered base stays main", async function () {
    this.timeout(60_000);
    await ownEngineBuildsOn(root, git);
  });

  test("Start fresh from a clarvis branch never stacks on it: when the branch can't be made at main, nothing is done; without Start fresh the fallback stacks as before", async function () {
    this.timeout(30_000);
    await freshStartNeverStacks(root, git);
  });

  // Skills for Clarvis's own engine (plan.md §4.6, "Skills"): a run in this suite, on its repository, for the reason above.
  test("Skills (Clarvis's own engine): a run is told the skills the owner switched on and reads them through RAVIS without spending a step, a skill switched off since comes back as a result, and an answer gets no skills", async function () {
    this.timeout(60_000);
    await ownEngineReadsSkills(root, git);
  });

  // A skill the owner invoked with a slash command (15 Sep 2026): loaded up front, in a run and in an answer.
  test("Skills (Clarvis's own engine): a skill the owner invoked is in a run's and an answer's instructions before the first model call, a run is offered readSkill for the rest of it, and each logs what it costs", async function () {
    this.timeout(60_000);
    await ownEngineLoadsAnInvokedSkill(root, git);
  });
});

/**
 * **Build on Clarvis's own earlier work** (plan.md M15, "Build on Clarvis's own earlier work"; the owner's decision of 15 Sep
 * 2026). The question, the record and the save of the earlier run's files are tested with real git (`leftRuns.test.ts`,
 * `clarvisLeftWork.test.ts`). This checks what only an extension host has: the real `AgentRunner`, started with the options
 * the question produces (`placedRunOptions`), moves the window from main to the branch its earlier run left through the
 * real Git extension, makes no new branch, gives the model that run's task and summary, and commits the model's change on
 * top of that work under the new request. No model is called: a stand-in writes one file and says it is done.
 */
async function ownEngineBuildsOn(root: string, git: (...args: string[]) => string): Promise<void> {
  const left = 'clarvis/add-a-farewell-script';
  const request = 'Also add a --shout option to farewell.py';
  git('checkout', '--quiet', '-b', left, 'main');
  fs.writeFileSync(path.join(root, 'farewell.py'), 'print("bye")\n');
  git('add', 'farewell.py');
  git('commit', '--quiet', '-m', 'Added farewell.py, which prints bye.\n\nTask: Add a farewell script');
  git('checkout', '--quiet', 'main');
  const tip = git('rev-parse', left);
  const branchesBefore = git('for-each-ref', '--format=%(refname:short)', 'refs/heads');
  const run: LeftRun = {
    branch: left,
    taskId: 'task-farewell',
    task: 'Add a farewell script',
    summary: 'Added farewell.py, which prints bye.',
    startedFrom: 'main',
    headCommit: tip,
    files: ['farewell.py'],
    inFlightAtStart: [],
    uncommitted: [],
    endedAt: '2026-09-15T18:00:00.000Z',
    host: 'desktop',
  };
  const found: LeftRunTask = { branch: left, tip, updatedAt: run.endedAt, onBranch: false, run };
  await gitCaughtUp(root, () => true);
  const { engine } = await placedRunOptions(new GitFacts(root), { kind: 'build_on', task: found }, 'main');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-own-build-on-storage-'));
  const workspaceState = memento();
  await workspaceState.update('clarvis.agent.baseBranch', 'main');
  const context = { workspaceState, globalState: memento(), globalStorageUri: vscode.Uri.file(storage) } as unknown as vscode.ExtensionContext;
  const model = standInModel('farewell.py', 'import sys\nprint("BYE" if "--shout" in sys.argv else "bye")\n', 'Added --shout to farewell.py.');
  const runner = new AgentRunner(context, root, model.models, standInTerminal(), () => undefined, undefined, undefined, undefined, engine);
  const events: AgentEvent[] = [];

  try {
    for await (const event of runner.run(request, new AbortController().signal)) events.push(event);

    assert.strictEqual(git('symbolic-ref', '--short', 'HEAD'), left, `the checkout is on the branch the earlier run left: ${JSON.stringify(events)}`);
    assert.strictEqual(git('for-each-ref', '--format=%(refname:short)', 'refs/heads'), branchesBefore, 'no new branch');
    assert.strictEqual(git('rev-parse', `${left}~1`), tip, "the new commit sits on the earlier run's work");
    assert.ok(git('log', '-1', '--format=%B', left).includes(`Task: ${request}`), 'the commit names the new request, not the brief');
    assert.match(model.systems[0] ?? '', /The earlier task, as it was asked: Add a farewell script/);
    assert.match(model.systems[0] ?? '', /What you said when it ended: Added farewell\.py, which prints bye\./);
    assert.deepStrictEqual(runner.branches, { working: left, startedFrom: 'main' }, 'the landing question offers main');
    assert.strictEqual(workspaceState.get('clarvis.agent.baseBranch'), 'main', 'never overwritten with the clarvis branch');
    assert.ok(!events.some((event) => /sits on top of/.test(event.text)), `no stacked-run line: ${JSON.stringify(events)}`);
  } finally {
    git('checkout', '--quiet', 'main');
    fs.rmSync(storage, { recursive: true, force: true });
  }
}

/**
 * **Start fresh means fresh** (plan.md M15, "Build on Clarvis's own earlier work"): once the owner chose it, a task that
 * can't start at main never falls back to stacking on the `clarvis/*` branch the window is on. Provoked for real: a change
 * to a file only that branch has makes git refuse the checkout of main.
 */
async function freshStartNeverStacks(root: string, git: (...args: string[]) => string): Promise<void> {
  const left = 'clarvis/only-here';
  const branches = () => git('for-each-ref', '--format=%(refname:short)', 'refs/heads');
  git('checkout', '--quiet', '-b', left, 'main');
  fs.writeFileSync(path.join(root, 'only-here.py'), 'x = 1\n');
  git('add', 'only-here.py');
  git('commit', '--quiet', '-m', 'A file only this branch has');
  fs.writeFileSync(path.join(root, 'only-here.py'), 'x = 2\n');
  await gitCaughtUp(root, (state) => state.workingTreeChanges.some((change) => change.uri.fsPath === path.join(root, 'only-here.py')));
  const before = branches();
  const memory = new Map<string, string>([['clarvis.agent.baseBranch', 'main']]);
  const remembered = { get: (key: string) => memory.get(key), update: async (key: string, value: string) => void memory.set(key, value) };
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-fresh-storage-'));
  const context = { workspaceState: memento(), globalState: memento(), globalStorageUri: vscode.Uri.file(storage) } as unknown as vscode.ExtensionContext;

  try {
    const fresh = await new AgentBranch(() => undefined, remembered).begin('Start something new', { fresh: true });

    assert.deepStrictEqual([fresh.isolated, fresh.refused], [false, true]);
    assert.match(fresh.advice ?? '', /^I couldn't start fresh from `main`, and starting on `clarvis\/only-here` instead would build on that work/);
    assert.strictEqual(git('symbolic-ref', '--short', 'HEAD'), left, 'still where it was');
    assert.strictEqual(branches(), before, 'no branch made');

    // The run the question starts after Start fresh (`placedRunOptions` → `startFresh`) is refused the same way, before the model is asked anything.
    const model = standInModel('never.py', 'x = 0\n', 'This should never be said.');
    const events: AgentEvent[] = [];
    const run = new AgentRunner(context, root, model.models, standInTerminal(), () => undefined, undefined, undefined, undefined, { startFresh: true });
    for await (const event of run.run('Start something new', new AbortController().signal)) events.push(event);
    assert.ok(events.some((event) => /^I couldn't start fresh from `main`/.test(event.text)), JSON.stringify(events));
    assert.deepStrictEqual([model.systems.length, git('symbolic-ref', '--short', 'HEAD'), branches()], [0, left, before], 'the run did nothing');

    const stacked = await new AgentBranch(() => undefined, remembered).begin('Start something new');
    assert.strictEqual(stacked.isolated, true, "without Start fresh, today's fallback");
    assert.match(stacked.advice ?? '', /sits on top of `clarvis\/only-here`/);
  } finally {
    git('checkout', '--quiet', '--force', 'main');
    fs.rmSync(storage, { recursive: true, force: true });
    for (const branch of branches().split('\n').filter((name) => name.startsWith('clarvis/start-something-new'))) git('branch', '-D', branch);
  }
}

/**
 * **Skills for Clarvis's own engine** (plan.md §4.6, "Skills"; RAVIS 0.27.0's `skills.json`). The list, the section, the reads
 * and every refusal are tested against the fake RAVIS in the fast suite (`skillTools.test.ts`, `agentPrompt.test.ts`). This
 * checks what only the real `AgentRunner` decides: a run's instructions carry the section after Clarvis's own rules and its
 * tools carry `readSkill`; the list is read once; a skill's text reaches the model as a tool result; a skill switched off
 * since the list comes back as a plain result; three reads spend none of a one-step cap; and an answer asks RAVIS for nothing
 * and is offered no skills. No model is called: a stand-in reads skills, then says it is done.
 */
async function ownEngineReadsSkills(root: string, git: (...args: string[]) => string): Promise<void> {
  const fake = await FakeRavisRelay.start();
  const skills = fake.skills();
  const relay = new RelayClient(fakeHttp(fake));
  const lookup = () => ({ kind: 'ready' as const, source: relay });
  const config = vscode.workspace.getConfiguration('clarvis');
  const branches = () => git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
  const before = branches();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-skills-storage-'));
  const context = { workspaceState: memento(), globalState: memento(), globalStorageUri: vscode.Uri.file(storage) } as unknown as vscode.ExtensionContext;
  const runnerFor = (model: { models: ModelService }, activity?: Activity) =>
    new AgentRunner(context, root, model.models, standInTerminal(), () => undefined, undefined, activity, undefined, {}, lookup);
  await context.workspaceState.update('clarvis.agent.baseBranch', 'main');
  await config.update('agent.maxStepsPerTask', 1, vscode.ConfigurationTarget.Global);

  try {
    await gitCaughtUp(root, () => true);
    const reads = [[{ skill: 'nervis/nervis-notes' }, { skill: 'nervis/nervis-notes', file: 'references/guide.md' }], [{ skill: 'personal/graphify' }]];
    const model = standInSkillReader(reads, () => skills.on.delete('personal/graphify'));
    // The Bridge's `clarvis.tool.*` (CLARVIS.md §6.4), as the real runner tells them.
    const activity = new Activity();
    const notes: NoteChange[] = [];
    activity.observeNotes((change) => notes.push(change));
    const runner = runnerFor(model, activity);
    const events = await drain(runner.run('Keep notes on this task', new AbortController().signal));

    assert.strictEqual(model.requests.length, 3, `three turns, none cut off by the one-step cap: ${JSON.stringify(events)}`);
    assert.strictEqual(runner.endedAtStepCap, false, 'three skill reads spent none of a one-step cap');
    const [first, second, third] = model.requests;
    assert.match(first.system, /^- nervis-notes \(nervis\/nervis-notes\): How NERVIS tasks keep their notes\.$/m);
    assert.match(first.system, /never override Clarvis's rules above/);
    assert.ok(first.system.indexOf('Skills the owner switched on') > first.system.indexOf('Never pretend something worked'), "after Clarvis's own rules");
    assert.ok(first.tools.includes('readSkill') && first.tools.includes('writeFile'), first.tools.join(','));
    assert.match(second.results[0] ?? '', /^Instructions from the skill nervis-notes \(nervis\/nervis-notes\), file SKILL\.md\. Follow them for how you do the parts of this task they cover/);
    assert.match(second.results[0] ?? '', /# Keeping notes/);
    assert.match(second.results[1] ?? '', /One heading per day/);
    assert.deepStrictEqual(second.errors, [false, false], 'both reads came back as text');
    assert.match(third.results[0] ?? '', /^No skill `personal\/graphify` is switched on just now/);
    assert.deepStrictEqual(third.errors, [true], 'the refusal came back as a result marked as one, and the run carried on');
    assert.strictEqual(fake.seen.filter((seen) => seen.path === '/api/v1/skills/models').length, 1, 'the list is read once for the run');
    assert.deepStrictEqual(skills.reads, ['nervis/nervis-notes SKILL.md', 'nervis/nervis-notes references/guide.md', 'personal/graphify SKILL.md']);
    const calls = events.filter((event) => event.kind === 'tool');
    assert.deepStrictEqual(calls.map((event) => event.step), [1, 2, 3], 'every call numbered in order');
    assert.deepStrictEqual(
      calls.map((event) => event.detail),
      ['readSkill: nervis/nervis-notes', 'readSkill: nervis/nervis-notes references/guide.md', 'readSkill: personal/graphify'],
      'logged by skill and file, as RAVIS logs a read'
    );
    assert.deepStrictEqual(fake.violations, []);
    const told = notes.map((change) => eventForNote(change.note));
    assert.deepStrictEqual(
      told.map((event) => [event.name, event.data.tool, event.data.call, event.data.writes]),
      [
        ['clarvis.tool.started', 'readSkill', 1, false], ['clarvis.tool.completed', 'readSkill', 1, false],
        ['clarvis.tool.started', 'readSkill', 2, false], ['clarvis.tool.completed', 'readSkill', 2, false],
        ['clarvis.tool.started', 'readSkill', 3, false], ['clarvis.tool.failed', 'readSkill', 3, false],
      ],
      'each call told as it starts and as it ends; the switched-off skill as failed, since nobody was asked'
    );
    assert.ok(told.every((event) => !/nervis-notes|graphify|guide\.md/.test(JSON.stringify(event))), 'no argument travels');

    // An answer: no list read, no section, no readSkill.
    const answering = standInSkillReader([], () => undefined);
    fake.seen.length = 0;
    await drain(runnerFor(answering).answer('What does hello.py print?', new AbortController().signal));

    assert.strictEqual(answering.requests.length, 1);
    assert.doesNotMatch(answering.requests[0].system, /readSkill|Skills the owner switched on/);
    assert.ok(!answering.requests[0].tools.includes('readSkill'), answering.requests[0].tools.join(','));
    assert.deepStrictEqual(fake.seen, [], 'an answer asks RAVIS for no skills');

    // RAVIS gone at the next run's start: that run goes on without skills, and the chat hears it once.
    await fake.stopListening();
    const without = standInSkillReader([], () => undefined);
    const later = await drain(runnerFor(without).run('Keep more notes', new AbortController().signal));

    assert.strictEqual(without.requests.length, 1, JSON.stringify(later));
    assert.doesNotMatch(without.requests[0].system, /Skills the owner switched on/);
    assert.ok(!without.requests[0].tools.includes('readSkill'), without.requests[0].tools.join(','));
    assert.deepStrictEqual(
      later.filter((event) => event.toChat && /skills/.test(event.text)).map((event) => event.text),
      ["I couldn't read your skills from RAVIS, so this run goes without them."]
    );
  } finally {
    await config.update('agent.maxStepsPerTask', undefined, vscode.ConfigurationTarget.Global);
    await fake.close();
    git('checkout', '--quiet', '--force', 'main');
    for (const branch of branches()) if (branch && !before.includes(branch)) git('branch', '-D', branch);
    fs.rmSync(storage, { recursive: true, force: true });
  }
}

/**
 * **A skill the owner invoked** (the owner's decisions, 15 Sep 2026). Reading it, framing it, the cap and the log line are
 * tested in the fast suite (`skillTools.test.ts`). This checks what only the real `AgentRunner` decides: the invoked
 * skill's SKILL.md is in the first model call's instructions, after Clarvis's own rules; a run is offered `readSkill` even
 * when no skill was listed at its start; an answer carries the skill too, framed for an answer, with no `readSkill` and no
 * list read; and each writes its one log line. No model is called.
 */
async function ownEngineLoadsAnInvokedSkill(root: string, git: (...args: string[]) => string): Promise<void> {
  const fake = await FakeRavisRelay.start();
  const skills = fake.skills();
  const relay = new RelayClient(fakeHttp(fake));
  const lookup = () => ({ kind: 'ready' as const, source: relay });
  const branches = () => git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
  const before = branches();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-invoked-storage-'));
  const context = { workspaceState: memento(), globalState: memento(), globalStorageUri: vscode.Uri.file(storage) } as unknown as vscode.ExtensionContext;
  const logs: string[] = [];
  const runnerFor = (model: { models: ModelService }) =>
    new AgentRunner(context, root, model.models, standInTerminal(), (line) => void logs.push(line), undefined, undefined, undefined, {}, lookup);
  await context.workspaceState.update('clarvis.agent.baseBranch', 'main');

  try {
    await gitCaughtUp(root, () => true);
    const text = (exampleNamed(SKILL_READ_ROUTE, "a skill's SKILL.md").response.body as { text: string }).text;
    const loaded = await loadInvokedSkill(lookup(), { id: 'nervis/nervis-notes', name: 'nervis-notes', description: 'How NERVIS tasks keep their notes.' }, new AbortController().signal);
    if (!loaded.ok) throw new Error(loaded.line);
    // Switched off for the list the run reads at its start: the invoked skill is loaded all the same, with readSkill.
    skills.on.clear();
    fake.seen.length = 0;

    const model = standInSkillReader([], () => undefined);
    const runner = runnerFor(model);
    runner.invokeSkill(loaded.invoked);
    const events = await drain(runner.run('Keep notes on this task', new AbortController().signal));

    assert.strictEqual(model.requests.length, 1, JSON.stringify(events));
    const [first] = model.requests;
    const framed = 'The owner invoked this skill for this task. Follow them for how you do the parts of this task they cover';
    assert.ok(first.system.includes(`Instructions from the skill nervis-notes (nervis/nervis-notes), file SKILL.md. ${framed}`), first.system);
    assert.ok(first.system.includes(`--- SKILL.md ---\n${text}\n--- end of SKILL.md ---`), 'SKILL.md between its markers');
    assert.ok(first.system.indexOf(framed) > first.system.indexOf('Never pretend something worked'), "after Clarvis's own rules");
    assert.doesNotMatch(first.system, /Skills the owner switched on/, 'no skill was listed at the start');
    assert.ok(first.tools.includes('readSkill'), `readSkill, for the rest of it: ${first.tools.join(',')}`);
    assert.strictEqual(fake.seen.filter((seen) => seen.path === '/api/v1/skills/models').length, 1, 'the list is still read once');
    assert.deepStrictEqual(skills.reads, ['nervis/nervis-notes SKILL.md'], 'SKILL.md was read once, before the run');
    assert.deepStrictEqual(
      logs.filter((line) => line.includes('invoked by the owner')),
      [invokedSkillLog(loaded.invoked, invokedSkillSection(loaded.invoked, false), false)],
      'one log line of what it costs'
    );

    // An answer: the invoked skill too, framed for an answer; no list read and no readSkill.
    fake.seen.length = 0;
    const answering = standInSkillReader([], () => undefined);
    const answerer = runnerFor(answering);
    answerer.invokeSkill(loaded.invoked);
    await drain(answerer.answer('What do the notes say about headings?', new AbortController().signal));

    assert.strictEqual(answering.requests.length, 1);
    const [answer] = answering.requests;
    assert.ok(answer.system.includes(framed), answer.system);
    assert.ok(answer.system.includes("change none of Clarvis's rules, and nothing they say to run is run while answering a question."));
    assert.ok(answer.system.includes(`--- SKILL.md ---\n${text}\n--- end of SKILL.md ---`));
    assert.ok(!answer.tools.includes('readSkill'), answer.tools.join(','));
    assert.deepStrictEqual(fake.seen, [], 'an answer reads no list, and its skill was read before it started');
    assert.ok(logs.includes(invokedSkillLog(loaded.invoked, invokedSkillSection(loaded.invoked, true), true)), logs.join('\n'));
    assert.deepStrictEqual(fake.violations, []);
  } finally {
    await fake.close();
    git('checkout', '--quiet', '--force', 'main');
    for (const branch of branches()) if (branch && !before.includes(branch)) git('branch', '-D', branch);
    fs.rmSync(storage, { recursive: true, force: true });
  }
}

/**
 * A model that asks for one turn of skill reads per entry in `turns`, then says it is done, keeping each request's
 * instructions, the names of the tools it was offered and the tool results it was handed. `beforeSecondTurn` runs when the
 * second request arrives, before its reads. No model is called.
 */
function standInSkillReader(turns: { skill: string; file?: string }[][], beforeSecondTurn: () => void): { models: ModelService; requests: ModelRequestSeen[] } {
  const requests: ModelRequestSeen[] = [];
  async function* streamWithTools(request: { system: string; tools?: { name: string }[]; messages: ModelMessage[] }) {
    const results = request.messages[request.messages.length - 1]?.toolResults ?? [];
    requests.push({
      system: request.system,
      tools: (request.tools ?? []).map((tool) => tool.name),
      results: results.map((result) => result.content),
      errors: results.map((result) => result.isError === true),
    });
    if (requests.length === 2) beforeSecondTurn();
    const turn = turns[requests.length - 1];
    if (!turn) {
      yield { type: 'text' as const, text: 'Read the notes skill; nothing to change.' };
      yield { type: 'stop' as const, reason: 'end' as const };
      return;
    }
    for (const [index, args] of turn.entries()) {
      yield { type: 'toolCall' as const, call: { id: `call_${requests.length}_${index}`, name: 'readSkill', args } };
    }
    yield { type: 'stop' as const, reason: 'tools' as const };
  }
  // `sessionFor` because a runner given an `Activity` names the run's session on it.
  const models = { isReady: async () => true, spec: () => ({ label: 'a stand-in model' }), sessionFor: () => 'stand-in-session', streamWithTools };
  return { models: models as unknown as ModelService, requests };
}

/** What the stand-in kept of one request: its instructions, its tools' names, and the tool results it was handed. */
type ModelRequestSeen = { system: string; tools: string[]; results: string[]; errors: boolean[] };

/** Every event a run or an answer gives, once it has ended. */
async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** A coding model that writes one file, then says it is done, keeping each turn's instructions. No model is called. */
function standInModel(file: string, contents: string, summary: string): { models: ModelService; systems: string[] } {
  const systems: string[] = [];
  async function* streamWithTools(request: { system: string }) {
    systems.push(request.system);
    if (systems.length === 1) {
      yield { type: 'toolCall' as const, call: { id: 'call_write', name: 'writeFile', args: { path: file, contents } } };
      yield { type: 'stop' as const, reason: 'tools' as const };
      return;
    }
    yield { type: 'text' as const, text: summary };
    yield { type: 'stop' as const, reason: 'end' as const };
  }
  const models = { isReady: async () => true, spec: () => ({ label: 'a stand-in model' }), streamWithTools };
  return { models: models as unknown as ModelService, systems };
}

/** The Clarvis terminal, with nothing to show. */
function standInTerminal(): AgentTerminal {
  return { write: () => undefined, announce: () => undefined } as unknown as AgentTerminal;
}

/** Only what `CodexGitGlue` reads of the extension's context: the two mementos and a storage folder for undo copies. */
function standInContext(storage: string): vscode.ExtensionContext {
  return { workspaceState: memento(), globalState: memento(), globalStorageUri: vscode.Uri.file(storage) } as unknown as vscode.ExtensionContext;
}

function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
  } as vscode.Memento;
}

type RepositoryState = { HEAD?: { name?: string }; workingTreeChanges: { uri: vscode.Uri }[] };

/**
 * Refreshes the Git extension's view of the repository, waiting up to 10 s until `ready` holds, since the glue reads that
 * view and the commands above changed the repository behind its back.
 */
async function gitCaughtUp(root: string, ready: (state: RepositoryState) => boolean): Promise<void> {
  const api = (await vscode.extensions.getExtension('vscode.git')?.activate())?.getAPI(1);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const repository = api?.repositories.find((candidate: { rootUri: vscode.Uri }) => candidate.rootUri.fsPath === root);
    await repository?.status();
    const state = repository?.state as RepositoryState | undefined;
    const head = execFileSync('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    if ((state && state.HEAD?.name === head && ready(state)) || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
