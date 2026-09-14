import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCommand } from '../../agent/Gate';
import { K1_FILE_CHANGE, K11_FOR_THE_SESSION, K2_COMMANDS, K4_WITH_REASON, type CalibrationRequest } from '../../test/fakes/calibrationRequests';
import { exampleNamed, fixture } from '../../test/fakes/relayContract';
import { failureFromResponse, type RelayOutcome } from '../relay/relayFailure';
import type { DecisionKind, RequestView, SessionMode } from '../relay/relayTypes';
import {
  autoAnswer,
  capturePaths,
  CodexApprovals,
  commandLayers,
  gateVerdictFor,
  insideProject,
  promptsFor,
  readReply,
  shownCommand,
  type RequestPrompt,
  type SitesDecided,
} from './approvals';
import { CODEX_LINES } from './translate';

/**
 * Codex's requests in the chat (plan.md M15, C2b; design §5.2): each kind drawn with only RAVIS's decisions, a reply
 * read back into one, Unattended's narrow answers, and the asking itself — one at a time, checked again before
 * anything is sent, and RAVIS's refusals each handled as `CLARVIS.md` §5.5 says. The requests are the contract's
 * examples and Codex's own from calibration (`calibrationRequests.ts`).
 */

const ANSWER = 'POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer';
const examples = fixture('agent-sessions.json').request_view_examples as RequestView[];
const example = (kind: string) => structuredClone(examples.find((request) => request.kind === kind) as RequestView);

let counter = 0;

function fromCalibration(asked: CalibrationRequest, patch: Partial<RequestView> = {}): RequestView {
  counter++;
  return {
    id: `rq_cal_${counter}`,
    kind: asked.kind,
    turn_id: 'turn-1',
    item_id: asked.itemId,
    opened_at: '2026-09-14T14:02:00Z',
    payload: structuredClone(asked.payload),
    allowed_decisions: [...asked.allowed_decisions],
    ...patch,
  };
}

function commandRequest(command: string, patch: Record<string, unknown> = {}, allowed: DecisionKind[] = ['once', 'skip', 'stop']): RequestView {
  counter++;
  const payload = { command, cwd: '.', reason: null, network: null, escalation: null, gate_hint: null, ...patch };
  return { id: `rq_cmd_${counter}`, kind: 'command', turn_id: 'turn-1', item_id: `call_${counter}`, opened_at: '2026-09-14T14:02:00Z', payload, allowed_decisions: allowed };
}

const labels = (prompt: RequestPrompt) => prompt.options.map((option) => option.label);

function refusedWith(name: string): RelayOutcome<unknown> {
  const { status, body } = exampleNamed(ANSWER, name).response;
  return { ok: false, failure: failureFromResponse(status, body, null) };
}

// ── Drawing a request ────────────────────────────────────────────────────────

test('a command is drawn with its script, where it runs, why, what the gate says of it — and only the decisions RAVIS allows', () => {
  const [command] = promptsFor(example('command'));

  assert.equal(command.line, 'Codex wants to run a command.');
  assert.equal(command.detail[0], '`npm install left-pad` in `./web`');
  assert.ok(command.detail.includes('Why: The build needs this package.'));
  assert.ok(command.detail.includes('What it does: installs a package and its dependencies'), 'the gate explains an install');
  assert.deepEqual(labels(command), ['Run it', 'Skip it', 'Stop the run']);
  assert.deepEqual(command.options.map((option) => option.decision), [{ kind: 'once' }, { kind: 'skip' }, { kind: 'stop' }]);

  const narrowed = promptsFor({ ...example('command'), allowed_decisions: ['skip', 'stop'] })[0];
  assert.deepEqual(labels(narrowed), ['Skip it', 'Stop the run']);
});

test('a file change lists each file; one reaching outside the project says Clarvis never lets an engine do that, and offers no Apply', () => {
  const [outside] = promptsFor(example('fileChange'));
  assert.equal(outside.line, 'Codex wants to write outside this project (/Users/owner/.zshrc). Clarvis never lets an engine do that.');
  assert.deepEqual(outside.detail, [
    'update src/app.ts (+12 −3)',
    'rename README.md → docs/README.md',
    'update /Users/owner/.zshrc (+1 −0)',
    'Why: Add the --utc flag and document it.',
  ]);
  assert.deepEqual(labels(outside), ["Don't apply", 'Stop the run']);

  const [inside] = promptsFor(fromCalibration(K1_FILE_CHANGE));
  assert.equal(inside.line, 'Codex wants to change 1 file.');
  assert.deepEqual(inside.detail, ['add ravis-cal-k1-cal_5a1d6ecc33b4-untrusted.txt (+1 −0)']);
  assert.deepEqual(labels(inside), ['Apply', "Don't apply", 'Stop the run']);
});

test('more access and a question are each drawn in their own words; a blocked site is drawn with its group', () => {
  const [access] = promptsFor(example('permissions'));
  assert.equal(access.line, 'Codex asks for more access.');
  assert.deepEqual(access.detail, ['read: /Users/owner/.ssh/config (outside this project, denied)', 'Why: Read the SSH configuration.']);
  assert.deepEqual(labels(access), ["Don't allow", 'Stop the run']);
  assert.equal(labels(promptsFor({ ...example('permissions'), allowed_decisions: ['once', 'skip', 'stop'] })[0])[0], 'Allow for this step');

  const [question] = promptsFor(example('question'));
  assert.equal(question.line, 'Codex asks: Log timestamps');
  assert.deepEqual(question.detail, ['Should --utc also change the log timestamps?']);
  assert.deepEqual(labels(question), ['Yes', 'No', 'Stop the run']);
  assert.deepEqual(question.options[0].decision, { kind: 'answer', answers: { q1: 'Yes' } });
  assert.equal(question.typedAnswer, 'q1', 'it takes typed answers');

  assert.deepEqual(promptsFor(example('site')), [], 'a site ask is drawn with the rest of its group, as one card');
});

test('nothing is ever offered as "don\'t ask again", and a decision this Clarvis does not know is never drawn', () => {
  const requests = [...examples, ...[K1_FILE_CHANGE, ...K2_COMMANDS, K4_WITH_REASON, K11_FOR_THE_SESSION].map((asked) => fromCalibration(asked))];
  for (const prompt of requests.flatMap((request) => promptsFor({ ...request, allowed_decisions: ['once', 'skip', 'stop', 'answer', 'allow_site', 'keep_blocked'] }))) {
    for (const label of labels(prompt)) assert.doesNotMatch(label, /session|always|don.t ask|again|remember|every time/i, label);
  }
  const offeredMore = commandRequest('npm test', {}, ['once', 'acceptForSession' as DecisionKind, 'skip']);
  assert.deepEqual(labels(promptsFor(offeredMore)[0]), ['Run it', 'Skip it']);
});

test("Codex's calibration commands are shown as the script inside their shell wrapper — the words Codex's own commandActions use", () => {
  for (const asked of [...K2_COMMANDS, K4_WITH_REASON, K11_FOR_THE_SESSION]) {
    const command = asked.payload.command as string;
    assert.equal(shownCommand(command), asked.script);
    assert.deepEqual(commandLayers(command), [command, asked.script]);
    assert.equal(promptsFor(fromCalibration(asked))[0].detail[0], `\`${asked.script}\``);
  }
  assert.ok(
    promptsFor(fromCalibration(K4_WITH_REASON))[0].detail.includes('Why: May I run the exact K4 command to write the specified file outside the writable workspace?')
  );
  assert.equal(shownCommand('/bin/zsh -lc "npm test"; rm -rf build'), '/bin/zsh -lc "npm test"; rm -rf build', 'anything after the script: shown whole');
});

test('a dangerous command inside a shell wrapper is still one the gate stops', () => {
  const wrappedDd = '/bin/zsh -lc "dd if=/dev/zero of=/dev/disk4 bs=1m"';
  assert.equal(classifyCommand(wrappedDd), undefined, "the gate alone doesn't see a disk tool inside the quotes");
  assert.equal(gateVerdictFor(wrappedDd)?.category, 'destructive');
  assert.equal(gateVerdictFor("bash -c 'mkfs.ext4 /dev/sdb1'")?.category, 'destructive');
  assert.equal(gateVerdictFor(`sh -c "bash -c 'diskutil eraseDisk JHFS+ Blank disk4'"`)?.category, 'destructive', 'two wrappers deep');
  assert.equal(gateVerdictFor('/usr/bin/env bash --login -c "dd if=a of=b"')?.category, 'destructive');
  assert.deepEqual(gateVerdictFor('/bin/zsh -lc "dd if=/dev/zero of=/dev/disk4'), gateVerdictFor('dd if=/dev/zero of=/dev/disk4'), 'a quote that never closes');
  assert.equal(gateVerdictFor('/bin/zsh -lc "npm test"; dd if=a of=b')?.category, 'destructive', 'after the script');
  assert.equal(gateVerdictFor(K2_COMMANDS[3].payload.command as string), undefined, "calibration's own commands have no category");
});

test('a path is inside the project only when it is relative and never climbs above the root', () => {
  for (const inside of ['a.txt', 'src/app.ts', './src/../README.md', 'docs/']) assert.equal(insideProject(inside), true, inside);
  for (const outside of ['', '/etc/hosts', '~/x', '../x', 'src/../../x', 'C:\\x', 42, undefined]) assert.equal(insideProject(outside), false, String(outside));
  assert.deepEqual(
    capturePaths({
      files: [
        { path: 'src/app.ts', change: 'update' },
        { path: 'README.md', change: 'rename', moved_to: 'docs/README.md' },
        { path: 'new.txt', change: 'add' },
        { path: '/Users/owner/.zshrc', change: 'update' },
      ],
    }),
    ['src/app.ts', 'README.md', 'docs/README.md', 'new.txt'],
    'what undo copies first: every file touched inside the project, and where renames go'
  );
});

test("a reply is a button's label in any case or its number; typed words answer a question that takes them, and are otherwise for Codex", () => {
  const [command] = promptsFor(commandRequest('npm test'));
  assert.deepEqual(readReply(command, 'Run it'), { decision: { kind: 'once' } });
  assert.deepEqual(readReply(command, 'skip IT'), { decision: { kind: 'skip' } });
  assert.deepEqual(readReply(command, '3'), { decision: { kind: 'stop' } });
  assert.deepEqual(readReply(command, 'use yarn instead'), { typed: 'use yarn instead' });
  assert.equal(readReply(command, undefined), undefined);
  assert.equal(readReply(command, '   '), undefined);

  const [question] = promptsFor(example('question'));
  assert.deepEqual(readReply(question, 'Only in UTC'), { decision: { kind: 'answer', answers: { q1: 'Only in UTC' } } });
});

// ── Unattended ───────────────────────────────────────────────────────────────

test('Unattended answers once only a quiet command or a change inside the project, only while attached, only when RAVIS offers once', () => {
  const unattended = { mode: 'unattended' as SessionMode, attached: true };
  for (const asked of K2_COMMANDS) assert.deepEqual(autoAnswer(fromCalibration(asked), unattended), { kind: 'once' }, String(asked.script));
  assert.deepEqual(autoAnswer(fromCalibration(K1_FILE_CHANGE), unattended), { kind: 'once' });

  const quiet = fromCalibration(K11_FOR_THE_SESSION);
  assert.equal(autoAnswer(quiet, { mode: 'agent', attached: true }), undefined, 'Agent asks');
  assert.equal(autoAnswer(quiet, { mode: 'auto', attached: true }), undefined, 'Auto asks');
  assert.equal(autoAnswer(quiet, { mode: 'unattended', attached: false }), undefined, 'no panel there, nothing answered here');
  assert.equal(autoAnswer({ ...quiet, allowed_decisions: ['skip', 'stop'] }, unattended), undefined, "not when RAVIS doesn't offer once");

  const refusals: [string, RequestView][] = [
    ['a gate category', commandRequest('npm install left-pad')],
    ['a gate category inside the wrapper', commandRequest('/bin/zsh -lc "dd if=/dev/zero of=/dev/disk4"')],
    ['the internet', commandRequest('curl https://pypi.org/simple/', { network: { host: 'pypi.org', protocol: 'https' } })],
    ['an escalation', commandRequest('ls', { escalation: { fileSystem: { write: ['/tmp/x'] } } })],
    ["RAVIS's gate hint", commandRequest('ls', { gate_hint: 'destructive' })],
    ['run above the project', commandRequest('ls', { cwd: '../other' })],
    ['run outside the project', commandRequest('ls', { cwd: '/Users/owner' })],
    ['an empty command', commandRequest('')],
  ];
  for (const [why, request] of refusals) assert.equal(autoAnswer(request, unattended), undefined, why);

  const change = fromCalibration(K1_FILE_CHANGE);
  const changed = (payload: Record<string, unknown>) => ({ ...change, payload: { ...change.payload, ...payload } });
  assert.equal(autoAnswer(changed({ outside_workspace: ['/Users/owner/.zshrc'] }), unattended), undefined, 'outside the project');
  assert.equal(autoAnswer(changed({ files: [] }), unattended), undefined, 'no files named');
  assert.equal(autoAnswer(changed({ grant_root: '/Users/owner' }), unattended), undefined, 'a grant root');
  assert.equal(autoAnswer(changed({ files: [{ path: 'a.txt', change: 'rename', moved_to: '../b.txt', added: 0, removed: 0 }] }), unattended), undefined, 'moved out');
  for (const kind of ['permissions', 'question', 'site']) {
    const offered: DecisionKind[] = ['once', 'skip', 'stop', 'answer', 'allow_site', 'keep_blocked'];
    assert.equal(autoAnswer({ ...example(kind), allowed_decisions: offered }, unattended), undefined, `${kind} always asks`);
  }
});

// ── The asking ───────────────────────────────────────────────────────────────

interface Shown {
  prompt: RequestPrompt;
  signal: AbortSignal;
  again: boolean;
  reply(text: string | undefined): void;
}

/** CodexApprovals with everything around it recorded: what was shown, sent, said, steered, copied and stopped. */
function desk(options: { mode?: SessionMode; attached?: boolean; capture?: (paths: string[]) => Promise<void>; holdAnswers?: boolean } = {}) {
  const state: { mode: SessionMode; attached: boolean; stopping: boolean } = { mode: options.mode ?? 'agent', attached: options.attached ?? true, stopping: false };
  const shown: Shown[] = [];
  const events: string[] = [];
  const said: string[] = [];
  const steered: string[] = [];
  const outcomes: RelayOutcome<unknown>[] = [];
  const stops: number[] = [];
  const decided: SitesDecided[] = [];
  /** Answers on their way, let through one at a time by the test when `holdAnswers` is set. */
  const held: (() => void)[] = [];
  const approvals: CodexApprovals = new CodexApprovals({
    answer: async (requestId, decision) => {
      events.push(`answer ${requestId} ${JSON.stringify(decision)}`);
      if (options.holdAnswers) await new Promise<void>((resolve) => held.push(resolve));
      return outcomes.shift() ?? { ok: true, status: 200, value: { resolved: true, decision_kind: decision.kind } };
    },
    show: (prompt, signal, again) =>
      new Promise((resolve) => {
        events.push(`show ${prompt.requestId}${again ? ' again' : ''}`);
        shown.push({ prompt, signal, again, reply: resolve });
      }),
    steer: (text) => steered.push(text),
    stopRun: () => {
      stops.push(1);
      approvals.releaseAll();
    },
    stopping: () => state.stopping,
    mode: () => state.mode,
    attached: () => state.attached,
    capture: options.capture ?? (async (paths) => void events.push(`capture ${paths.join(' ')}`)),
    say: (line) => said.push(line),
    log: () => undefined,
    sitesDecided: (entry) => decided.push(entry),
  });
  return { approvals, state, shown, events, said, steered, outcomes, stops, decided, held };
}

/** Lets every promise the asking started run to its next wait. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
}

const sent = (events: string[]) => events.filter((line) => line.startsWith('answer '));

test('overlapping requests are shown one at a time, in the order they came, each answer sent before the next is shown', async () => {
  const d = desk();
  const [first, second] = [fromCalibration(K2_COMMANDS[0]), fromCalibration(K2_COMMANDS[1])];
  d.approvals.open(first);
  d.approvals.open(second);
  d.approvals.open(first); // a replay
  await settle();
  assert.equal(d.shown.length, 1);

  d.shown[0].reply('Run it');
  await settle();
  assert.deepEqual(d.events, [`show ${first.id}`, `answer ${first.id} {"kind":"once"}`, `show ${second.id}`]);
});

test("a site ask waits behind a request of Codex's that came after it", async () => {
  const d = desk();
  const command = fromCalibration(K2_COMMANDS[0]);
  const site = { ...example('site'), id: 'rq_site' };
  const later = fromCalibration(K11_FOR_THE_SESSION);
  for (const request of [command, site, later]) d.approvals.open(request);
  await settle();
  d.shown[0].reply('Run it');
  await settle();
  d.shown[1].reply('Skip it');
  await settle();

  assert.deepEqual(d.shown.map((entry) => entry.prompt.requestId), [command.id, later.id, site.id]);
});

test('the answer is checked again right before it is sent: a stop meanwhile, or another window answering first, sends nothing', async () => {
  const d = desk();
  d.approvals.open(fromCalibration(K11_FOR_THE_SESSION));
  await settle();
  d.state.stopping = true;
  d.shown[0].reply('Run it');
  await settle();
  assert.deepEqual(sent(d.events), []);

  const e = desk();
  const request = fromCalibration(K11_FOR_THE_SESSION);
  e.approvals.open(request);
  await settle();
  e.approvals.resolved({ request_id: request.id, by: 'window', decision_kind: 'once' });
  assert.equal(e.shown[0].signal.aborted, true, 'its buttons go in the same tick');
  assert.deepEqual(e.said, [CODEX_LINES.answeredElsewhere]);
  e.shown[0].reply('Run it'); // a click that raced the other window
  await settle();
  assert.deepEqual(sent(e.events), []);
});

test('an approved file change is copied for undo before its answer — only when applied — and a stop during the copy sends nothing', async () => {
  const d = desk();
  const change = fromCalibration(K1_FILE_CHANGE);
  d.approvals.open(change);
  await settle();
  d.shown[0].reply('Apply');
  await settle();
  assert.deepEqual(d.events.slice(1), ['capture ravis-cal-k1-cal_5a1d6ecc33b4-untrusted.txt', `answer ${change.id} {"kind":"once"}`]);

  const skipped = desk();
  skipped.approvals.open(fromCalibration(K1_FILE_CHANGE));
  await settle();
  skipped.shown[0].reply("Don't apply");
  await settle();
  assert.equal(skipped.events.some((line) => line.startsWith('capture')), false);
  assert.equal(sent(skipped.events).length, 1);

  let copied: () => void = () => undefined;
  const slow = desk({ capture: () => new Promise((resolve) => (copied = () => resolve())) });
  slow.approvals.open(fromCalibration(K1_FILE_CHANGE));
  await settle();
  slow.shown[0].reply('Apply');
  await settle();
  slow.state.stopping = true;
  copied();
  await settle();
  assert.deepEqual(sent(slow.events), [], 'checked again once the copy is made');

  let copiedToo: () => void = () => undefined;
  const elsewhere = desk({ capture: () => new Promise((resolve) => (copiedToo = () => resolve())) });
  const answeredElsewhere = fromCalibration(K1_FILE_CHANGE);
  elsewhere.approvals.open(answeredElsewhere);
  await settle();
  elsewhere.shown[0].reply('Apply');
  await settle();
  elsewhere.approvals.resolved({ request_id: answeredElsewhere.id, by: 'window', decision_kind: 'skip' });
  copiedToo();
  await settle();
  assert.deepEqual(sent(elsewhere.events), [], 'another window answered while the files were copied');
});

test('"Stop the run" is the task\'s Stop, never an answer: the queue goes with it', async () => {
  const d = desk();
  d.approvals.open(fromCalibration(K11_FOR_THE_SESSION));
  d.approvals.open(fromCalibration(K2_COMMANDS[0]));
  await settle();
  d.shown[0].reply('Stop the run');
  await settle();

  assert.equal(d.stops.length, 1);
  assert.deepEqual(sent(d.events), []);
  assert.equal(d.shown.length, 1, 'the queued request went with the stop');
});

test("RAVIS's refusals: already resolved says who, stopping is silent, a narrowed list is drawn again, a site not added is asked again", async () => {
  const other = desk();
  other.outcomes.push(refusedWith('the other window answered first'));
  other.approvals.open(fromCalibration(K11_FOR_THE_SESSION));
  await settle();
  other.shown[0].reply('Run it');
  await settle();
  assert.deepEqual(other.said, [CODEX_LINES.answeredElsewhere]);

  const policy = desk();
  const byPolicy = refusedWith('the other window answered first');
  if (!byPolicy.ok && byPolicy.failure.kind === 'refused') byPolicy.failure.details = { by: 'policy_timeout' };
  policy.outcomes.push(byPolicy);
  policy.approvals.open(fromCalibration(K11_FOR_THE_SESSION));
  await settle();
  policy.shown[0].reply('Run it');
  await settle();
  assert.deepEqual(policy.said, [CODEX_LINES.pausedUnanswered], 'resolved by the unanswered policy, said so');

  const stopping = desk();
  stopping.outcomes.push(refusedWith('stopping: a late answer never starts a step'));
  stopping.approvals.open(fromCalibration(K11_FOR_THE_SESSION));
  await settle();
  stopping.shown[0].reply('Run it');
  await settle();
  assert.deepEqual([stopping.said, stopping.shown.length], [[], 1], 'the stop says everything there is to say');

  const narrowed = desk();
  narrowed.outcomes.push(refusedWith('once on a change outside the project'));
  narrowed.approvals.open({ ...example('fileChange'), id: 'rq_narrowed', allowed_decisions: ['once', 'skip', 'stop'] });
  await settle();
  narrowed.shown[0].reply('Apply');
  await settle();
  assert.deepEqual(narrowed.said, [CODEX_LINES.decisionNarrowed]);
  assert.deepEqual(labels(narrowed.shown[1].prompt), ["Don't apply", 'Stop the run'], 'drawn again from the returned list');

  const site = desk();
  site.outcomes.push(refusedWith("allow a site Codex didn't add"));
  site.approvals.open({ ...example('site'), id: 'rq_site' });
  await settle();
  site.shown[0].reply('Allow pypi.org');
  await settle();
  assert.deepEqual(site.said, ["Codex didn't add pypi.org, so it stays blocked."]);
  assert.deepEqual(site.shown.map((entry) => entry.prompt.requestId), ['rq_site', 'rq_site'], 'asked again: RAVIS keeps the ask open');
  site.shown[1].reply('Keep pypi.org blocked');
  await settle();
  assert.ok(site.events.includes('answer rq_site {"kind":"keep_blocked"}'));
});

// ── Site asks, a group at a time (R5) ────────────────────────────────────────

function siteRequest(id: string, host: string, groupId = 'sg_1'): RequestView {
  return { ...example('site'), id, group_id: groupId, payload: { host, protocol: 'https' } };
}

test("a group's asks opened together are one card drawn once; a host opening later joins it; Allow all sends each host's allow, and this window is told it decided", async () => {
  const d = desk();
  d.approvals.open(siteRequest('rq_a', 'a.com'));
  d.approvals.open(siteRequest('rq_b', 'b.org'));
  await settle();
  assert.equal(d.shown.length, 1, 'drawn once, with both hosts');
  assert.equal(d.shown[0].prompt.line, 'Codex was blocked from reaching a.com and b.org.');
  assert.equal(d.approvals.decidingSites, true);
  assert.deepEqual(d.approvals.held.map((request) => request.id), ['rq_a', 'rq_b'], 'a switch records every host still open');

  d.approvals.open(siteRequest('rq_c', 'c.net'));
  await settle();
  assert.equal(d.shown[0].signal.aborted, true, 'the card on screen is withdrawn');
  assert.equal(d.shown[1].prompt.line, 'Codex was blocked from reaching a.com, b.org and c.net.');
  assert.equal(d.shown[1].again, false, 'drawn with its new line');

  d.shown[1].reply('Allow all');
  await settle();
  assert.deepEqual(sent(d.events), ['answer rq_a {"kind":"allow_site"}', 'answer rq_b {"kind":"allow_site"}', 'answer rq_c {"kind":"allow_site"}']);
  assert.deepEqual(d.decided, [{ groupId: 'sg_1', allowed: ['a.com', 'b.org', 'c.net'], kept: [], here: true }]);
  assert.equal(d.approvals.decidingSites, false);
  assert.equal(d.shown.length, 2, 'nothing more is asked');
});

test('a host decided in another window leaves the card; the last one decided there withdraws it, says so, and this window does not carry on', async () => {
  const d = desk();
  d.approvals.open(siteRequest('rq_a', 'a.com'));
  d.approvals.open(siteRequest('rq_b', 'b.org'));
  await settle();
  d.approvals.resolved({ request_id: 'rq_a', by: 'window', decision_kind: 'keep_blocked' });
  await settle();
  assert.equal(d.shown[0].signal.aborted, true);
  assert.equal(d.shown[1].prompt.line, 'Codex was blocked from reaching b.org (https).');

  d.approvals.resolved({ request_id: 'rq_b', by: 'window', decision_kind: 'allow_site' });
  await settle();
  assert.equal(d.shown[1].signal.aborted, true);
  assert.deepEqual(d.said, [CODEX_LINES.answeredElsewhere]);
  assert.deepEqual(d.decided, [{ groupId: 'sg_1', allowed: ['b.org'], kept: ['a.com'], here: false }]);
  assert.deepEqual(sent(d.events), []);
  assert.equal(d.shown.length, 2);
});

test("a decision RAVIS reports while this window's own answer is on its way is this window's; one another window made first is theirs", async () => {
  const own = desk({ holdAnswers: true });
  own.approvals.open(siteRequest('rq_a', 'a.com'));
  await settle();
  own.shown[0].reply('Allow a.com');
  await settle();
  own.approvals.resolved({ request_id: 'rq_a', by: 'window', decision_kind: 'allow_site' });
  own.held.shift()?.();
  await settle();
  assert.deepEqual(own.decided, [{ groupId: 'sg_1', allowed: ['a.com'], kept: [], here: true }]);
  assert.deepEqual(own.said, []);

  const other = desk({ holdAnswers: true });
  other.outcomes.push(refusedWith('the other window answered first'));
  other.approvals.open(siteRequest('rq_a', 'a.com'));
  await settle();
  other.shown[0].reply('Allow a.com');
  await settle();
  other.approvals.resolved({ request_id: 'rq_a', by: 'window', decision_kind: 'keep_blocked' });
  other.held.shift()?.();
  await settle();
  assert.deepEqual(other.decided, [{ groupId: 'sg_1', allowed: [], kept: ['a.com'], here: false }]);
  assert.deepEqual(other.said, [CODEX_LINES.answeredElsewhere]);
});

test("the task's end closing a group's asks withdraws its card and says so; an ask ended without a decision ends its group; nothing carries on", async () => {
  const ended = desk();
  ended.approvals.open(siteRequest('rq_a', 'a.com'));
  ended.approvals.open(siteRequest('rq_b', 'b.org'));
  await settle();
  // RAVIS's `end`: every open site ask resolved as kept blocked, by `turn_ended`.
  ended.approvals.resolved({ request_id: 'rq_a', by: 'turn_ended', decision_kind: 'keep_blocked' });
  ended.approvals.resolved({ request_id: 'rq_b', by: 'turn_ended', decision_kind: 'keep_blocked' });
  await settle();
  assert.equal(ended.shown.every((entry) => entry.signal.aborted), true);
  assert.deepEqual(ended.said, ["That ask closed when Codex's task ended."]);
  assert.equal(ended.decided.every((entry) => !entry.here), true);
  assert.equal(ended.approvals.decidingSites, false);

  const stopped = desk();
  stopped.approvals.open(siteRequest('rq_a', 'a.com'));
  stopped.approvals.open(siteRequest('rq_b', 'b.org'));
  await settle();
  stopped.approvals.resolved({ request_id: 'rq_a', by: 'stop', decision_kind: 'stop' });
  await settle();
  assert.equal(stopped.shown[0].signal.aborted, true);
  assert.deepEqual([stopped.decided, stopped.approvals.decidingSites, stopped.said], [[], false, []]);
});

test('typed words at a card go to Codex and the card comes back with its buttons; a decision that never reached RAVIS waits, with the rest of Allow all, until RAVIS is back', async () => {
  const d = desk();
  d.approvals.open(siteRequest('rq_a', 'a.com'));
  d.approvals.open(siteRequest('rq_b', 'b.org'));
  await settle();
  d.shown[0].reply('use the mirror at files.example.com');
  await settle();
  assert.deepEqual(d.steered, ['use the mirror at files.example.com']);
  assert.equal(d.shown[1].again, true);

  d.outcomes.push({ ok: false, failure: { kind: 'unreachable', detail: 'ECONNREFUSED' } });
  d.shown[1].reply('Allow all');
  await settle();
  assert.deepEqual(d.said, [CODEX_LINES.answerUnsent]);
  assert.deepEqual(sent(d.events), ['answer rq_a {"kind":"allow_site"}'], 'the rest of Allow all waits too');
  assert.equal(d.shown.length, 2, 'not asked again while RAVIS is away');
  assert.equal(d.approvals.decidingSites, true);

  d.approvals.reconnected();
  await settle();
  assert.equal(d.shown[2].prompt.line, 'Codex was blocked from reaching a.com and b.org.');
  d.shown[2].reply('Keep b.org blocked');
  await settle();
  d.shown[3].reply('Allow a.com');
  await settle();
  assert.deepEqual(d.decided, [{ groupId: 'sg_1', allowed: ['a.com'], kept: ['b.org'], here: true }]);
});

test('Allow all skips a host another window decides while the first allow is on its way', async () => {
  const d = desk({ holdAnswers: true });
  d.approvals.open(siteRequest('rq_a', 'a.com'));
  d.approvals.open(siteRequest('rq_b', 'b.org'));
  await settle();
  d.shown[0].reply('Allow all');
  await settle();
  d.approvals.resolved({ request_id: 'rq_b', by: 'window', decision_kind: 'keep_blocked' });
  d.held.shift()?.();
  await settle();
  assert.deepEqual(sent(d.events), ['answer rq_a {"kind":"allow_site"}'], 'b.org, decided elsewhere meanwhile, is not sent');
  assert.deepEqual(d.decided, [{ groupId: 'sg_1', allowed: ['a.com'], kept: ['b.org'], here: true }]);
});

test('Stop lets a group go at once: its card is withdrawn, a late click sends nothing, and the task no longer waits on it', async () => {
  const d = desk();
  d.approvals.open(siteRequest('rq_a', 'a.com'));
  await settle();
  assert.equal(d.approvals.releaseAll(), 1);
  assert.equal(d.shown[0].signal.aborted, true);
  assert.equal(d.approvals.decidingSites, false);
  d.shown[0].reply('Allow a.com');
  await settle();
  assert.deepEqual(sent(d.events), []);
});

test('a host the same turn was blocked from after its group was decided is asked afresh; a decided ask replayed is never asked again', async () => {
  const d = desk();
  d.approvals.open(siteRequest('rq_a', 'a.com'));
  await settle();
  d.shown[0].reply('Allow a.com');
  await settle();
  d.approvals.open(siteRequest('rq_b', 'b.org'));
  await settle();
  assert.equal(d.shown[1].prompt.line, 'Codex was blocked from reaching b.org (https).');
  d.shown[1].reply('Keep b.org blocked');
  await settle();
  assert.deepEqual(
    d.decided.map((entry) => [entry.allowed, entry.kept, entry.here]),
    [
      [['a.com'], [], true],
      [[], ['b.org'], true],
    ]
  );

  d.approvals.open(siteRequest('rq_a', 'a.com'));
  await settle();
  assert.equal(d.shown.length, 2, 'a replay is never asked again');
});

test('an answer that never reached RAVIS is asked again once RAVIS is back — unless RAVIS resolved it meanwhile', async () => {
  const unreachable: RelayOutcome<unknown> = { ok: false, failure: { kind: 'unreachable', detail: 'ECONNREFUSED' } };
  const d = desk();
  const request = fromCalibration(K11_FOR_THE_SESSION);
  d.outcomes.push(unreachable);
  d.approvals.open(request);
  await settle();
  d.shown[0].reply('Run it');
  await settle();
  assert.deepEqual(d.said, [CODEX_LINES.answerUnsent]);
  assert.equal(d.shown.length, 1, 'not asked again while RAVIS is away');

  d.approvals.reconnected();
  await settle();
  assert.equal(d.shown.length, 2);
  d.shown[1].reply('Run it');
  await settle();
  assert.equal(sent(d.events).length, 2);

  const resolved = desk();
  const gone = fromCalibration(K11_FOR_THE_SESSION);
  resolved.outcomes.push(unreachable);
  resolved.approvals.open(gone);
  await settle();
  resolved.shown[0].reply('Run it');
  await settle();
  resolved.approvals.resolved({ request_id: gone.id, by: 'policy_timeout' });
  resolved.approvals.reconnected();
  await settle();
  assert.equal(resolved.shown.length, 1);
});

test('typed words that are not an answer go to Codex and the question stays; a question takes them as its answer, one question at a time', async () => {
  const d = desk();
  const command = fromCalibration(K2_COMMANDS[3]);
  d.approvals.open(command);
  await settle();
  d.shown[0].reply('put it in build/ instead');
  await settle();
  assert.deepEqual(d.steered, ['put it in build/ instead']);
  assert.deepEqual(d.events, [`show ${command.id}`, `show ${command.id} again`]);
  d.shown[1].reply('Skip it');
  await settle();
  assert.deepEqual(sent(d.events), [`answer ${command.id} {"kind":"skip"}`]);

  const q = desk();
  const questions = [
    { id: 'q1', header: 'Log timestamps', question: 'Should --utc also change the log timestamps?', options: ['Yes', 'No'], allow_other: true },
    { id: 'q2', header: 'Flag name', question: 'Keep the name --utc?', options: ['Keep it'], allow_other: false },
  ];
  q.approvals.open({ ...example('question'), id: 'rq_q', payload: { questions } });
  await settle();
  q.shown[0].reply('Only the file ones');
  await settle();
  assert.deepEqual(labels(q.shown[1].prompt), ['Keep it', 'Stop the run']);
  q.shown[1].reply('Keep it');
  await settle();
  assert.deepEqual(sent(q.events), ['answer rq_q {"kind":"answer","answers":{"q1":"Only the file ones","q2":"Keep it"}}']);
  assert.deepEqual(q.steered, []);
});

test('in Unattended, with the panel there, calibration\'s commands and file change are answered without asking; a gate category asks', async () => {
  const d = desk({ mode: 'unattended' });
  const commands = K2_COMMANDS.map((asked) => fromCalibration(asked));
  const change = fromCalibration(K1_FILE_CHANGE);
  for (const request of [...commands, change]) d.approvals.open(request);
  await settle();

  assert.equal(d.shown.length, 0, 'nobody was asked');
  assert.deepEqual(d.events, [
    ...commands.map((request) => `answer ${request.id} {"kind":"once"}`),
    'capture ravis-cal-k1-cal_5a1d6ecc33b4-untrusted.txt',
    `answer ${change.id} {"kind":"once"}`,
  ]);

  d.approvals.open(commandRequest('/bin/zsh -lc "dd if=/dev/zero of=/dev/disk4"'));
  await settle();
  assert.equal(d.shown.length, 1, 'a gate category is put to the owner');
  assert.ok(d.shown[0].prompt.detail.includes('CANNOT BE UNDONE.'));
  assert.equal(labels(d.shown[0].prompt)[0], 'Run it anyway');

  const detached = desk({ mode: 'unattended', attached: false });
  detached.approvals.open(fromCalibration(K11_FOR_THE_SESSION));
  await settle();
  assert.equal(detached.shown.length, 1, 'with no panel there, nothing is answered here');
  assert.deepEqual(sent(detached.events), []);
});

test('a switch to Unattended answers the quiet command on screen and withdraws its buttons; a command that needs the owner stays', async () => {
  const d = desk();
  const quiet = fromCalibration(K11_FOR_THE_SESSION);
  d.approvals.open(quiet);
  await settle();
  d.approvals.modeChanged();
  assert.equal(d.shown[0].signal.aborted, false, 'Agent still asks');

  d.state.mode = 'unattended';
  d.approvals.modeChanged();
  assert.equal(d.shown[0].signal.aborted, true, 'its buttons go at once');
  await settle();
  assert.deepEqual(sent(d.events), [`answer ${quiet.id} {"kind":"once"}`]);

  d.approvals.open(commandRequest('npm install left-pad'));
  await settle();
  d.approvals.modeChanged();
  assert.equal(d.shown[1].signal.aborted, false);
  assert.equal(sent(d.events).length, 1);
});
