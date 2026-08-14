import test from 'node:test';
import assert from 'node:assert/strict';
import { collectVerdicts } from './Verdicts';
import { Finding } from './analysisPrompt';
import { PlanningIO } from './PlanningIO';
import { agreedResolution } from './verdictSummary';

const FINDING: Finding = {
  class: 'safety',
  what: 'Passwords are stored as typed',
  whyItMatters: 'One copy of the database is every account',
  fixes: ['Hash the passwords before storing', 'Drop accounts from v1 entirely'],
};

/** Answers each prompt with the next scripted reply, and records what it was asked. */
function fakeIO(replies: (string | undefined)[]): PlanningIO & { buttons: string[][]; prompts: string[] } {
  const buttons: string[][] = [];
  const prompts: string[] = [];
  const next = () => replies.shift();

  return {
    buttons,
    prompts,
    async confirm(_title, _detail, options) {
      buttons.push(options);
      return next();
    },
    async askText(prompt, _placeholder, prefill) {
      prompts.push(prefill ?? prompt);
      return next();
    },
    async askChoice() {
      return undefined;
    },
    async say() {},
    async showDocument() {},
  };
}

test('every suggested fix is its own button, plus an escape hatch and a way out', async () => {
  const io = fakeIO(['Hash the passwords before storing']);

  await collectVerdicts([FINDING], io, () => {});

  assert.deepEqual(io.buttons[0], [
    'Hash the passwords before storing',
    'Drop accounts from v1 entirely',
    'Something else',
    'No, drop this',
  ]);
});

test('picking the second fix records that one, not the first', async () => {
  // The bug this exists to prevent: taking any acceptance to mean the obvious fix,
  // which would quietly turn "drop accounts" into "hash the passwords".
  const io = fakeIO(['Drop accounts from v1 entirely']);

  const [verdict] = await collectVerdicts([FINDING], io, () => {});

  assert.equal(verdict.status, 'accepted');
  assert.equal(agreedResolution(verdict), 'Drop accounts from v1 entirely');
});

test('"Something else" asks for one, prefilled with the obvious fix', async () => {
  const io = fakeIO(['Something else', 'Use a passkey and store nothing']);

  const [verdict] = await collectVerdicts([FINDING], io, () => {});

  assert.equal(io.prompts[0], 'Hash the passwords before storing');
  assert.equal(verdict.status, 'modified');
  assert.equal(agreedResolution(verdict), 'Use a passkey and store nothing');
});

test('an answer typed instead of clicked is taken as it stands, not asked for twice', async () => {
  const io = fakeIO(['Use a passkey and store nothing']);

  const [verdict] = await collectVerdicts([FINDING], io, () => {});

  assert.deepEqual(io.prompts, []);
  assert.equal(agreedResolution(verdict), 'Use a passkey and store nothing');
});

test('no answer at all keeps the finding with its first fix', async () => {
  const [verdict] = await collectVerdicts([FINDING], fakeIO([undefined]), () => {});

  assert.equal(verdict.status, 'accepted');
  assert.equal(agreedResolution(verdict), 'Hash the passwords before storing');
});

test('dropping a finding asks why and keeps the reason', async () => {
  const io = fakeIO(['No, drop this', 'No accounts in this thing at all']);

  const [verdict] = await collectVerdicts([FINDING], io, () => {});

  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.reasoning, 'No accounts in this thing at all');
});
