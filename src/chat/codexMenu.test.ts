import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_LINES } from '../engine/codex/translate';
import { CODEX_CHOICE_LINES } from '../engine/codexChoice';
import type { CodexState, CodexUsage } from '../engine/relay/relayTypes';
import { fixture } from '../test/fakes/relayContract';
import { allowanceView, clock, CODEX_MENU_LINES, codexMenuState, type CodexMenuInputs, type RavisReach } from './codexMenu';

/**
 * The Codex section of the bowtie's fold-out (plan.md M15, C2b+): enabled only for Codex, the default model at its
 * default effort unless the owner chose, RAVIS not answering said instead of an empty list, and the plan's allowance
 * in one line — the tightest window, stale, unknown, used up — with the rest in the tooltip. Read from RAVIS's own
 * `GET /api/v1/codex` examples (`codex-state.json`), in Brussels time.
 */

const TZ = 'Europe/Brussels';
const bodies = fixture('codex-state.json').examples as { name: string; response: { body: CodexState } }[];
const named = (name: string) => structuredClone((bodies.find((example) => example.name === name) as { response: { body: CodexState } }).response.body);
const signedIn = named('signed in, three projects busy, read by a named caller');
const usage = signedIn.usage as CodexUsage;
const ready = (state: CodexState): RavisReach => ({ kind: 'ready', state: { ok: true, status: 200, value: state } });

const models = [
  { id: 'gpt-6-astra', display_name: 'gpt-6-astra', is_default: true, default_effort: 'low', efforts: ['low', 'medium', 'high'] },
  { id: 'gpt-6-nova', display_name: 'GPT-6 Nova', is_default: false, default_effort: 'medium', efforts: ['medium', 'high'] },
];
const inputs = (patch: Partial<CodexMenuInputs> = {}): CodexMenuInputs => ({
  codingModel: 'ravis/clarvis-codex',
  ravis: ready({ ...signedIn, models }),
  stored: {},
  taskRunning: false,
  timeZone: TZ,
  ...patch,
});

test("a figure: the tightest window's percentage left and when it resets, in the owner's time; every window and the reading in the tooltip", () => {
  const view = allowanceView(usage, TZ);
  assert.equal(view?.line, 'Allowance: 62% left · resets Sun 06:30');
  assert.equal(
    view?.tooltip,
    ['5-hour window: 38% used, 62% left, resets Sun 06:30', 'weekly window: 20% used, 80% left, resets Thu 11:00', 'Read Sun 03:54'].join('\n')
  );
});

test('several windows: the tightest one is the line, wherever it is listed', () => {
  const windows = [
    { id: 'primary', label: '5-hour window', duration_minutes: 300, used_percent: 30, remaining_percent: 70, resets_at: '2026-09-14T15:00:00Z' },
    { id: 'secondary', label: 'weekly window', duration_minutes: 10080, used_percent: 75, remaining_percent: 25, resets_at: '2026-09-17T22:43:00Z' },
  ];
  assert.equal(allowanceView({ ...usage, windows }, TZ)?.line, 'Allowance: 25% left · resets Fri 00:43');
});

test('stale keeps the last figure, marked old; unknown says so, never 0', () => {
  const stale = allowanceView({ ...usage, stale: true }, TZ);
  assert.equal(stale?.line, 'Allowance: 62% left (an old reading) · resets Sun 06:30');
  assert.match(stale?.tooltip ?? '', /This reading is old/);

  const unknown = named('signed in, usage unknown: no percentages, never zero').usage;
  assert.deepEqual(allowanceView(unknown, TZ), { line: 'Allowance: not known right now', tooltip: "RAVIS hasn't had a reading from Codex yet." });
  assert.equal(allowanceView({ ...usage, known: false }, TZ)?.line, 'Allowance: not known right now', 'not known is never a figure, whatever windows came with it');
  assert.equal(allowanceView(undefined, TZ), undefined);
});

test('a limit reached says the allowance is used up, as the contract words it, with the reset', () => {
  assert.equal(allowanceView(named('allowance used up').usage, TZ)?.line, 'Allowance: used up · resets Sun 06:30', 'a window at 0% left');
  assert.equal(allowanceView({ ...usage, limit_reached: 'rate_limit_reached' }, TZ)?.line, 'Allowance: used up · resets Sun 06:30');
  const spend = allowanceView({ ...usage, spend_control_reached: true }, TZ);
  assert.equal(spend?.line, 'Allowance: used up · resets Sun 06:30');
  assert.match(spend?.tooltip ?? '', /allowance is used up/);
});

test('RAVIS not answering: the same line for the list and the allowance, never an empty list', () => {
  const unreachable: RavisReach = { kind: 'ready', state: { ok: false, failure: { kind: 'unreachable', detail: 'ECONNREFUSED' } } };
  const down = codexMenuState(inputs({ ravis: unreachable }));
  assert.deepEqual([down.enabled, down.line, down.models, down.allowance], [true, CODEX_MENU_LINES.ravisDown, [], undefined], 'said once');

  const notCodex = codexMenuState(inputs({ ravis: unreachable, codingModel: 'anthropic/claude-sonnet' }));
  assert.equal(notCodex.line, CODEX_MENU_LINES.onlyForCodex);
  assert.deepEqual(notCodex.allowance, { line: CODEX_MENU_LINES.ravisDown, tooltip: '' }, 'the allowance line shows either way');

  const garbled = codexMenuState(inputs({ ravis: { kind: 'ready', state: { ok: false, failure: { kind: 'malformed', status: 200, detail: 'no state' } } } }));
  assert.equal(garbled.line, CODEX_MENU_LINES.malformed);
});

test('with Codex coding: RAVIS’s models, the default at its default effort unless chosen, the note, and the running note during a task', () => {
  const state = codexMenuState(inputs());
  assert.equal(state.enabled, true);
  assert.equal(state.line, undefined);
  assert.deepEqual(state.models, [
    { id: 'gpt-6-astra', label: 'gpt-6-astra', isDefault: true, efforts: [{ id: 'low', isDefault: true }, { id: 'medium', isDefault: false }, { id: 'high', isDefault: false }] },
    { id: 'gpt-6-nova', label: 'GPT-6 Nova', isDefault: false, efforts: [{ id: 'medium', isDefault: true }, { id: 'high', isDefault: false }] },
  ]);
  assert.deepEqual(state.chosen, { model: 'gpt-6-astra', effort: 'low' });
  assert.equal(state.note, CODEX_CHOICE_LINES.allowance);
  assert.equal(state.running, undefined);
  assert.equal(state.allowance?.line, 'Allowance: 62% left · resets Sun 06:30');

  const chosen = codexMenuState(inputs({ stored: { model: 'gpt-6-nova', effort: 'high' }, taskRunning: true }));
  assert.deepEqual(chosen.chosen, { model: 'gpt-6-nova', effort: 'high' });
  assert.equal(chosen.running, CODEX_CHOICE_LINES.running);

  const contract = codexMenuState(inputs({ ravis: ready(signedIn) }));
  assert.deepEqual(contract.chosen, { model: 'gpt-6-astra', effort: 'low' }, "the contract's own example");
});

test('with another coding model the controls are disabled with one short line pointing at API config, and the allowance still shows', () => {
  for (const codingModel of ['anthropic/claude-sonnet', 'ravis/clarvis-codex/other', '']) {
    const state = codexMenuState(inputs({ codingModel }));
    assert.equal(state.enabled, false, codingModel);
    assert.equal(state.line, 'These apply only to Codex: choose ravis/clarvis-codex under API config.');
    assert.equal(state.models.length, 2, 'still drawn, disabled');
    assert.equal(state.allowance?.line, 'Allowance: 62% left · resets Sun 06:30');
  }
});

test('a window without RAVIS, without its key, or with an address it can’t use says so', () => {
  const unused = codexMenuState(inputs({ codingModel: 'anthropic/claude-sonnet', ravis: { kind: 'not_used' } }));
  assert.deepEqual([unused.line, unused.allowance], [CODEX_MENU_LINES.onlyForCodex, undefined]);
  assert.equal(codexMenuState(inputs({ ravis: { kind: 'no_credential' } })).line, CODEX_LINES.noCredential);
  assert.equal(codexMenuState(inputs({ ravis: { kind: 'unusable', reason: 'not_loopback' } })).line, "Clarvis can't use RAVIS from here (not loopback).");
});

test('signed out: Codex lists no models, and the section says why in RAVIS’s words', () => {
  const state = codexMenuState(inputs({ ravis: ready(named('signed out')) }));
  assert.equal(state.line, 'Codex lists no models right now. Codex is signed out.');
  assert.deepEqual([state.models, state.chosen], [[], undefined]);
  assert.equal(state.allowance?.line, 'Allowance: not known right now');
});

test('what RAVIS sends is passed on untouched, as text for the page to show as text', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const state = codexMenuState(inputs({ ravis: ready({ ...signedIn, models: [{ ...models[0], display_name: hostile }] }) }));
  assert.equal(state.models[0].label, hostile);
  const windows = [{ ...usage.windows[0], label: '<b>5-hour</b>' }];
  assert.match(allowanceView({ ...usage, windows }, TZ)?.tooltip ?? '', /^<b>5-hour<\/b>: /);
  assert.equal(clock('not a time', TZ), 'not a time');
});
