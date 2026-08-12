import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_QUESTIONS, actionPrompt, parseAction, worthInferring } from './actionIntent';
import { chatAction } from './chatCommands';

test('an invented action is discarded rather than dispatched', () => {
  // The trust boundary. A model cannot name a command that does not exist, and an
  // instruction injected through a pasted error message has nowhere to land.
  assert.equal(parseAction('runShell'), undefined);
  assert.equal(parseAction('rm -rf /'), undefined);
  assert.equal(parseAction('chooseVoice'), 'chooseVoice');
});

test('"none" and silence both mean do nothing', () => {
  assert.equal(parseAction('none'), undefined);
  assert.equal(parseAction(''), undefined);
  assert.equal(parseAction(undefined), undefined);
});

test('a model that explains itself is still understood', () => {
  // Only the first word is read: a reply that names something and then justifies it
  // has still named it.
  assert.equal(parseAction('toggleMute — they said you were too loud'), 'toggleMute');
});

test('the phrasings this exists for are the ones the matcher misses', () => {
  // Both are in the plan as examples. If the deterministic matcher ever starts catching
  // one, the inference for it stops being needed — and if this test fails that way,
  // that is the news.
  for (const missed of ["i can't stand this voice", "you're too loud"]) {
    assert.equal(chatAction(missed), null, missed);
    assert.equal(worthInferring(missed), true, missed);
  }
});

test('a plain question never buys a classification request', () => {
  // The M8 exit checklist calls this out as a cost bug that is invisible until the
  // bill arrives. Most questions are short, so length alone did not catch them.
  for (const question of [
    'why is the build failing?',
    'what branch am I on',
    'how do I change the voice',
    'is the test suite green?',
  ]) {
    assert.equal(worthInferring(question), false, question);
  }
});

test('the price of that is one plan example, knowingly', () => {
  // "where do I put my key" is a question, and gets answered rather than offered. An
  // answer to a question is never the wrong shape of reply.
  assert.equal(worthInferring('where do i put my key'), false);
});

test('long messages are not worth a request', () => {
  // Commands are short. Tasks and pasted stack traces are not, and spending a
  // classification on every one of those is money for nothing.
  assert.equal(worthInferring('a'.repeat(10)), true);
  assert.equal(
    worthInferring('please refactor the authentication middleware so that it stops rejecting valid tokens on Sundays'),
    false
  );
});

test('a slash form is never inferred', () => {
  // It either matched exactly or it was a typo. Guessing at "/voic" would act on a
  // command the user did not finish typing.
  assert.equal(worthInferring('/voic'), false);
});

test('every action has a question naming what it does, not what it is called', () => {
  // The person answering has never heard of a ChatAction and should not need to.
  for (const [action, question] of Object.entries(ACTION_QUESTIONS)) {
    assert.ok(question.endsWith('?'), action);
    assert.doesNotMatch(question, /[A-Z][a-z]+[A-Z]/, `${action} names the internal action`);
  }
});

test('the prompt offers only the known actions, plus none', () => {
  const prompt = actionPrompt('you are too loud');

  assert.match(prompt, /toggleMute/);
  assert.match(prompt, /reply: none/);
  assert.match(prompt, /requesting code changes/); // a task is not a command
});
