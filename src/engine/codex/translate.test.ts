import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleNamed, fixture } from '../../test/fakes/relayContract';
import { failureFromResponse, type RelayFailure } from '../relay/relayFailure';
import type { RequestView } from '../relay/relayTypes';
import {
  answerRefusedLine,
  clockTime,
  CODEX_LINES,
  declinedLine,
  failureLine,
  feedbackLine,
  leftoverLine,
  resolvedLine,
  steerRefusedLine,
  stoppedByLine,
  tokenLine,
  turnEndLine,
} from './translate';

/**
 * What the owner reads about a Codex task. The failure lines are held apart because each leads somewhere
 * different; the rest check that RAVIS's own words are passed on rather than replaced.
 */

function refusal(route: string, name: string): RelayFailure {
  const example = exampleNamed(route, name);
  return failureFromResponse(example.response.status, example.response.body, null);
}

test('an exhausted allowance, throttling, signed out, an untested version and RAVIS down each say something different', () => {
  const lines = [
    failureLine({ kind: 'quota_exhausted', reason: "The ChatGPT plan's allowance is used up until 04:30." }, 'start'),
    failureLine({ kind: 'throttled', code: null, retryAfterSeconds: 30 }, 'start'),
    failureLine({ kind: 'signed_out', expired: true, reason: '' }, 'start'),
    failureLine({ kind: 'untested_version', fileRulesUnproven: false, reason: 'Codex changed (now 0.155.0) and needs re-testing before new work.' }, 'start'),
    failureLine({ kind: 'unreachable', detail: 'ECONNREFUSED' }, 'start'),
  ];

  assert.equal(new Set(lines).size, lines.length);
  assert.equal(lines[0], "Codex can't start. The ChatGPT plan's allowance is used up until 04:30.");
  assert.match(lines[1], /too many requests/);
  assert.doesNotMatch(lines[1], /allowance/, 'throttling is never shown as the allowance');
  assert.match(lines[2], /signed Codex out/);
  assert.equal(lines[4], CODEX_LINES.ravisDownAtStart);
});

test('mid-task, the same failures say the work so far is in the project, and RAVIS down says it may be cut off', () => {
  assert.equal(
    failureLine({ kind: 'quota_exhausted', reason: "The ChatGPT plan's allowance is used up until 04:30." }, 'during'),
    "The ChatGPT plan's allowance is used up until 04:30. Its work so far is in the project."
  );
  assert.equal(failureLine({ kind: 'unreachable', detail: 'ECONNRESET' }, 'during'), CODEX_LINES.ravisDownMidTurn);
});

test('unproven file rules name the re-test, and not-ready states each have their own sentence', () => {
  assert.match(failureLine({ kind: 'untested_version', fileRulesUnproven: true, reason: 'strict_file_rules_unproven' }, 'start'), /Re-test the file rules/);
  assert.match(failureLine({ kind: 'codex_not_ready', state: 'account_changed', reason: '' }, 'start'), /different account/);
  assert.match(failureLine({ kind: 'codex_not_ready', state: 'something_new', reason: 'RAVIS says why.' }, 'start'), /RAVIS says why\./);
});

test("RAVIS's refusals from the fixtures: its message where there is no better sentence, a named line where there is", () => {
  assert.equal(
    failureLine(refusal('POST /api/v1/agent-sessions', "the ecosystem's own repository"), 'start'),
    "Codex doesn't work on the ecosystem's own repositories."
  );
  assert.match(failureLine(refusal('POST /api/v1/agent-sessions', "Clarvis's own engine holds the project"), 'start'), /in another window/);
  assert.equal(failureLine(refusal('POST /api/v1/agent-sessions/{sid}/turns', "RAVIS's lock was superseded at a restart"), 'during'), CODEX_LINES.superseded);
});

test('a steer refused because another engine holds the project says so; any other refusal keeps the text quietly', () => {
  assert.equal(steerRefusedLine(refusal('POST /api/v1/agent-sessions/{sid}/steer', 'no active turn and no lock: nothing is queued')), CODEX_LINES.lockedForTurns);
  assert.equal(steerRefusedLine(refusal('POST /api/v1/agent-sessions/{sid}/steer', 'stopping')), CODEX_LINES.keptForLater);
  assert.equal(steerRefusedLine({ kind: 'unreachable', detail: 'ECONNREFUSED' }), CODEX_LINES.keptForLater);
});

test('an answer RAVIS did not take: the other window, stopping (silent), and a choice no longer offered', () => {
  const route = 'POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer';
  assert.equal(answerRefusedLine(refusal(route, 'the other window answered first')), 'Answered in the other editor.');
  assert.equal(answerRefusedLine(refusal(route, 'stopping: a late answer never starts a step')), undefined);
  assert.match(answerRefusedLine(refusal(route, 'once on a change outside the project')) ?? '', /no longer offers/);
});

test('where a stop came from, why a question went, and what feedback means', () => {
  assert.equal(stoppedByLine('dashboard'), 'Stopped from the dashboard.');
  assert.equal(stoppedByLine('menu_bar'), 'Stopped from the menu bar.');
  assert.equal(stoppedByLine('someone'), undefined);
  assert.equal(resolvedLine('window'), 'Answered in the other editor.');
  assert.equal(resolvedLine('stop'), undefined, "a stop's own line covers it");
  assert.equal(feedbackLine('steered'), CODEX_LINES.passedOn);
  assert.equal(feedbackLine('delivered_in_turn'), undefined);
});

test("a turn's end: the step cap in RAVIS's words, a failure in RAVIS's words, nothing for a plain end", () => {
  const capped = (fixture('event-stream.json').events as { event: string; example_data: { status: string; error: unknown } }[]).find(
    (entry) => entry.event === 'turn.completed'
  )?.example_data;
  assert.ok(capped);

  assert.equal(turnEndLine(capped.status, capped.error), 'The step cap of 25 was reached. Codex stopped there; its work so far is kept.');
  assert.equal(turnEndLine('failed', { kind: 'anything', message: 'OpenAI signed Codex out.' }), "Codex's turn failed: OpenAI signed Codex out.");
  assert.equal(turnEndLine('completed', undefined), undefined);
  assert.equal(turnEndLine('interrupted', undefined), undefined, 'a stop reports itself');
});

test('leftover processes are named, and nothing is said to be saved', () => {
  const line = leftoverLine({ confirmed_gone: false, leftover: [{ pid: 51310, comm: 'node', started_at: '2026-09-13T01:12:00Z' }] });
  assert.equal(line, 'Something Codex started is still running: `node` (pid 51310). Nothing is saved until it stops.');
});

test('until approvals arrive, a command is declined and said so; a question waits', () => {
  const [command, , , question] = fixture('agent-sessions.json').request_view_examples as RequestView[];
  assert.match(declinedLine(command), /Codex asked to run `npm install left-pad`\. I declined/);
  assert.match(declinedLine({ ...question, kind: 'question' }), /It waits/);
});

test('a missing or unsafe token file, and times that are not times', () => {
  assert.equal(tokenLine({ kind: 'missing' }), CODEX_LINES.tokenMissing);
  assert.match(tokenLine({ kind: 'refused', reason: 'loose-permissions' }), /loose-permissions/);
  assert.equal(clockTime('not a time'), 'not a time');
  assert.match(clockTime('2026-09-13T01:12:00Z'), /^\d\d:\d\d$/);
});
