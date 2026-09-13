import test from 'node:test';
import assert from 'node:assert/strict';
import { optionIndex, PlanningChatIO } from './PlanningChatIO';
import { PlanningPaused } from '../planning/PlanningIO';

/**
 * The chat side of planning, driven the way `ChatService` drives it: a question asked, a
 * message supplied, Stop pressed.
 *
 * **It had no tests.** Both defects M9i fixes in it were found by reading it: a reply read as
 * its leading number, and a stop that answered the question on screen or asked it again.
 */

interface Panel {
  io: PlanningChatIO;
  spoken: string[];
  offered: string[][];
  draft: { text?: string };
}

function panel(): Panel {
  const spoken: string[] = [];
  const offered: string[][] = [];
  const draft: { text?: string } = {};
  const io = new PlanningChatIO(
    async (text) => {
      spoken.push(text);
    },
    async () => {},
    (items) => {
      offered.push(items.map((item) => item.label));
    },
    {
      show: async (text) => {
        draft.text = text;
      },
      close: async () => {
        draft.text = undefined;
      },
      text: () => draft.text,
    },
    () => {},
    () => {}
  );
  return { io, spoken, offered, draft };
}

/** Lets a question get as far as waiting for its reply. */
async function waitingFor(io: PlanningChatIO): Promise<void> {
  for (let turn = 0; turn < 100 && !io.isWaiting; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(io.isWaiting, 'a question should be waiting for a reply');
}

/** What a set of buttons makes of one typed reply. */
async function replyTo(buttons: string[], typed: string): Promise<string | undefined> {
  const { io } = panel();
  const answer = io.confirm('title', 'detail', buttons);
  await waitingFor(io);
  io.supply(typed);
  return answer;
}

test('a number on its own picks that button', async () => {
  assert.equal(await replyTo(['Approve', 'Keep Refining'], '2'), 'Keep Refining');
});

test('a number with more said after it is what was said, not the button', async () => {
  // M9i: at the approve gate this was Approve, and plan.md was written without the change.
  assert.equal(await replyTo(['Approve', 'Keep Refining'], '1 but keep offline support'), '1 but keep offline support');
});

test('a number that is not a whole number is not a button', async () => {
  assert.equal(await replyTo(['Hash the passwords', 'Drop accounts', 'Something else'], '1.5'), '1.5');
});

test('a number past the last button is not one, and a label is matched whatever its case', () => {
  assert.equal(optionIndex('4', ['Approve', 'Keep Refining']), undefined);
  assert.equal(optionIndex('keep refining', ['Approve', 'Keep Refining']), 1);
});

test('a qualified reply to a menu is an answer in its own words, not read back for a yes', async () => {
  const { io, offered } = panel();
  const answer = io.askChoice('Which language?', [{ label: 'Python' }, { label: 'Go' }]);
  await waitingFor(io);
  io.supply('1 but with type hints');

  assert.equal(await answer, '1 but with type hints');
  assert.equal(offered.some((labels) => labels.includes('Yes')), false);
});

test('Stop while a question waits pauses planning and takes the buttons away', async () => {
  const { io, offered } = panel();
  const answer = io.askText('What are you building?');
  await waitingFor(io);
  io.cancel();

  await assert.rejects(answer, PlanningPaused);
  assert.equal(io.isWaiting, false);
  assert.deepEqual(offered.at(-1), []);
});

test('Stop while nothing is waiting pauses the next question before it is asked', async () => {
  // M9i: typed while a model was working out the next question, "stop" answered "Nothing to
  // stop" — and the question arrived anyway.
  const { io, spoken } = panel();
  io.cancel();

  await assert.rejects(io.askText('What are you building?'), PlanningPaused);
  await assert.rejects(io.confirm('Approve it?', 'detail', ['Approve']), PlanningPaused);
  assert.deepEqual(spoken, []);
});

test('Stop at "Go with that?" pauses, rather than offering the same options again', async () => {
  const { io, offered } = panel();
  const answer = io.askChoice('Which language?', [{ label: 'Python' }, { label: 'Go' }]);
  await waitingFor(io);
  io.supply('Python');
  await waitingFor(io);
  io.cancel();

  await assert.rejects(answer, PlanningPaused);
  assert.equal(offered.filter((labels) => labels.includes('Python')).length, 1, 'the menu was offered once');
});

test('No at "Go with that?" is an answer, so the options come back', async () => {
  const { io, offered } = panel();
  const answer = io.askChoice('Which language?', [{ label: 'Python' }, { label: 'Go' }]);
  await waitingFor(io);
  io.supply('Python');
  await waitingFor(io);
  io.supply('No');
  await waitingFor(io);
  io.supply('Go');
  await waitingFor(io);
  io.supply('yes');

  assert.equal(await answer, 'Go');
  assert.equal(offered.filter((labels) => labels.includes('Python')).length, 2);
});

test('nothing a model finishes after a stop is said or shown', async () => {
  const { io, spoken, draft } = panel();
  io.cancel();
  await io.say('A remark that arrived late');
  await io.showDocument('# A draft that arrived late');

  assert.deepEqual(spoken, []);
  assert.equal(draft.text, undefined);
});

test('the draft is read back from the editor, after a stop as well', async () => {
  const { io, draft } = panel();
  await io.showDocument('# Plan');
  draft.text = '# Plan, edited by hand';

  assert.equal(await io.readDocument(), '# Plan, edited by hand');
  io.cancel();
  assert.equal(await io.readDocument(), '# Plan, edited by hand');
});
