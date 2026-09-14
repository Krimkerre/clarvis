import test from 'node:test';
import assert from 'node:assert/strict';
import { IDEA_TIMEOUT_MS, runInterview } from './Interview';
import { PlanningIO, PlanningPaused } from './PlanningIO';
import { ModelService } from '../model/ModelService';
import { InterviewState } from './interviewTopics';
import { WorkspaceSignals } from './workspaceSignals';

/**
 * The first tests this file has ever had.
 *
 * `Interview.ts` is 879 lines and produced six of the twenty findings the verification
 * runbook turned up (F2, F5, F8, F9, F11, F12). It had no tests for one reason: it
 * imported `researchWorkspace`, which needs `vscode`, so `node --test` could not load
 * it at all. The workspace facts are handed in now and the file loads, so the paths
 * below are reachable for the first time.
 *
 * **Every test here runs with no model configured**, which is not a shortcut — it is
 * the only deterministic way to drive the interview, and it is a real configuration
 * (Clarvis ships without a key). With `isReady()` false, `phraseQuestion` returns the
 * written question, `challengeAnswer` returns the answer untouched, `resolveProjectName`
 * skips, and `Voice` is unwired so `opening()`/`phrase()` return their fallbacks. What
 * is left is the state machine, which is the part that had the defects.
 */

/** A model service that is configured but has nothing behind it. */
function noModel(): ModelService {
  return {
    isReady: async () => false,
    stream: () => {
      throw new Error('no test here should reach the model');
    },
  } as unknown as ModelService;
}

/** What the interview asked, and what it was told, in order. */
interface Sitting {
  io: PlanningIO;
  /** Every prompt passed to `askText`, in the order they were asked. */
  asked: string[];
  /** What each `askText` put in the answer box beforehand, in the same order. */
  prefilled: (string | undefined)[];
  /** Everything said back through `io.say` — remarks, not questions. */
  said: string[];
}

/**
 * A scripted user.
 *
 * Answers are consumed in order; running out means the next question is cancelled,
 * which is how these tests stop the interview at a chosen point rather than having to
 * script all eight topics every time. `undefined` in the script is an explicit Escape.
 */
function sitting(answers: (string | undefined)[]): Sitting {
  const asked: string[] = [];
  const prefilled: (string | undefined)[] = [];
  const said: string[] = [];
  let next = 0;

  const io: PlanningIO = {
    askText: async (prompt: string, ...rest: (string | undefined)[]) => {
      asked.push(prompt);
      prefilled.push(rest[1]);
      return next < answers.length ? answers[next++] : undefined;
    },
    askChoice: async () => undefined,
    confirm: async () => undefined,
    say: async (text: string) => {
      said.push(text);
    },
    showDocument: async () => {},
    closeDocument: async () => {},
    readDocument: async () => undefined,
  };

  return { io, asked, prefilled, said };
}

/** The answers recorded for a topic, as plain text. */
function answerFor(state: InterviewState, topic: string): string | undefined {
  return state.answers.find((answer) => answer.topic === topic)?.text;
}

test('the workspace facts handed in become the context the questions are grounded in', async () => {
  // The seam that replaced the `vscode` import. If this stops working the interview
  // silently goes back to asking from a blank slate, which is exactly the failure
  // `workspaceContext` exists to prevent and is invisible from the outside.
  const workspace: WorkspaceSignals = {
    hasGit: true,
    manifestFile: 'package.json',
    topLevelEntries: ['src', 'package.json'],
    readmeFirstLine: 'Photo renamer',
    planMdExists: false,
  };

  const { io } = sitting(['renames photos by EXIF date']);
  const result = await runInterview(noModel(), io, () => {}, { workspace });

  assert.ok(result, 'the interview should hand back what it gathered when it pauses');
  assert.match(result.state.workspaceContext ?? '', /package\.json/);
});

test('no workspace facts means no invented context', async () => {
  // `researchWorkspace` returns undefined when there is no folder open. The interview
  // has to be able to run from nothing at all — a brand new project is the case it was
  // built for, and it has no files by definition.
  const { io } = sitting(['renames photos by EXIF date']);
  const result = await runInterview(noModel(), io, () => {}, {});

  assert.ok(result);
  assert.equal(result.state.workspaceContext, undefined);
});

test('a language named in the first sentence is never asked about again (F11)', async () => {
  // F11: the interview asked which language to use one line after the user had already
  // said it in prose. The fix checks before the question is composed, so the topic is
  // settled without ever reaching `askText`.
  const { io, asked } = sitting(['a CLI in Python that renames photos', 'me, in a terminal']);
  const result = await runInterview(noModel(), io, () => {}, {});

  assert.ok(result);
  assert.equal(result.state.languageDetected, 'Python');
  assert.equal(answerFor(result.state, 'language'), 'Python');
  assert.equal(
    asked.some((prompt) => /language/i.test(prompt)),
    false,
    'nothing should have asked about a language the user already named'
  );
});

test('the settled language is said out loud, not just recorded (F1)', async () => {
  // F1: a language that resolved without being asked about reached the log and never
  // the conversation, so the user learned what had been chosen for them by reading the
  // generated plan. Deciding quietly is the behaviour, saying nothing about it is the bug.
  const { io, said } = sitting(['a CLI in Python that renames photos', 'me, in a terminal']);
  await runInterview(noModel(), io, () => {}, {});

  assert.ok(
    said.some((line) => /python/i.test(line)),
    'the language settled without asking should be named in the conversation'
  );
});

test('cancelling the very first question records nothing at all', async () => {
  // Escape at "what are you building" is someone changing their mind before they
  // started, not an interview with one empty answer in it.
  const { io } = sitting([undefined]);
  const result = await runInterview(noModel(), io, () => {}, {});

  assert.equal(result, undefined);
});

test('cancelling later keeps what was already answered', async () => {
  // The other half of the same rule, and the one that matters: pausing partway is
  // resumable, so the answers already given have to survive it. F7 was a version of
  // this going wrong one level up.
  const { io } = sitting(['renames photos by EXIF date', undefined]);
  const result = await runInterview(noModel(), io, () => {}, {});

  assert.ok(result);
  assert.equal(answerFor(result.state, 'what-it-does'), 'renames photos by EXIF date');
});

test('a handed-over brief waits in the first answer box and is not taken as the answer', async () => {
  // E-C8: a task from NERVIS came from another program, so the person sends it
  // themselves. Cancelling that first question records nothing — the brief is a
  // suggestion for the answer, never the answer.
  const { io, prefilled } = sitting([undefined]);
  const result = await runInterview(noModel(), io, () => {}, { brief: 'make me a pomodoro timer' });

  assert.equal(prefilled[0], 'make me a pomodoro timer');
  assert.equal(result, undefined);
});

test('what the person sends is the answer, even with a brief waiting', async () => {
  const { io } = sitting(['a pomodoro timer for the terminal', undefined]);
  const result = await runInterview(noModel(), io, () => {}, { brief: 'make me a pomodoro timer' });

  assert.ok(result);
  assert.equal(answerFor(result.state, 'what-it-does'), 'a pomodoro timer for the terminal');
});

test('resuming carries on rather than asking what you are building again', async () => {
  // A resumed interview that took a different path from a fresh one would drift, and
  // the difference would only show in the half of the product nobody walks twice.
  const state: InterviewState = {
    answers: [{ topic: 'what-it-does', text: 'renames photos', question: 'What are you building?' }],
  };

  const { io, asked } = sitting([undefined]);
  await runInterview(noModel(), io, () => {}, { resume: { state, seed: 'renames photos' } });

  assert.equal(
    asked.some((prompt) => /what are you building/i.test(prompt)),
    false,
    'the seed question belongs to starting an interview, not continuing one'
  );
});

test('every answer is saved as it lands, not once at the end', async () => {
  // The end is exactly what a reload does not reach. F7: the saved snapshot was cleared
  // before the analysis existed anywhere else, and reloading at the approve gate threw
  // away everything the user had ruled on.
  const saved: number[] = [];
  const { io } = sitting(['renames photos by EXIF date', 'me, in a terminal', 'Python', 'no web interface', undefined]);

  await runInterview(noModel(), io, () => {}, {
    remember: async (state) => {
      saved.push(state.answers.length);
    },
  });

  assert.ok(saved.length >= 3, `expected a save per answer, got ${saved.length}`);
  assert.deepEqual(
    [...saved].sort((a, b) => a - b),
    saved,
    'each save should hold at least as much as the one before it'
  );
});

/**
 * A model that streams whatever it is told to, one fragment at a time.
 *
 * `isReady` is true here, which is what puts `promptModel` — the collector the eight
 * hand-written ones collapsed into — on the path at all. The tests above deliberately
 * run without a model and never reach it.
 */
function streamingModel(fragments: Iterable<string>): ModelService {
  return {
    isReady: async () => true,
    // A model that answers at once: its deadlines are the written ones.
    deadline: (ms: number) => ms,
    stream: async function* () {
      for (const fragment of fragments) yield fragment;
    },
  } as unknown as ModelService;
}

test('a question the model phrases is the one that gets asked', async () => {
  // The written fallback is what appears when anything goes wrong, so a test that only
  // ever sees the fallback cannot tell a working phrasing call from a broken one.
  const { io, asked } = sitting([undefined]);
  const models = streamingModel(['So. ', 'What does this thing ', 'actually do?']);

  await runInterview(models, io, () => {}, {
    resume: { state: { answers: [] }, seed: 'renames photos' },
  });

  assert.deepEqual(asked.slice(0, 1), ['So. What does this thing actually do?']);
});

test('a model that will not stop talking is cut off at the cap', async () => {
  // The cap is the reason `collect` takes a limit at all. If it stops working this test
  // does not fail with a wrong answer — it never finishes, which is the honest failure
  // for "reads the stream forever".
  function* forever(): Generator<string> {
    for (;;) yield 'and another thing ';
  }

  const { io, asked } = sitting([undefined]);
  await runInterview(streamingModel(forever()), io, () => {}, {
    resume: { state: { answers: [] }, seed: 'renames photos' },
  });

  assert.ok(asked[0].length > 0);
  // 400 for every topic but language, plus whatever fragment tipped it over.
  assert.ok(asked[0].length < 500, `expected the reply capped near 400, got ${asked[0].length}`);
});

test('a stop at the name picker pauses planning rather than skipping the name (M9i)', async () => {
  // The picker sits inside a catch-all that turns any failure into "name left unresolved" and
  // carries on. A stop is not a failure — swallowed there, it went straight on to the next question.
  const { io, asked } = sitting(['renames photos by EXIF date']);
  io.askChoice = async () => {
    throw new PlanningPaused();
  };
  const models = streamingModel(['Snapshot | short and plain\nPhotoname | says what it does']);

  await assert.rejects(runInterview(models, io, () => {}, {}), PlanningPaused);
  assert.equal(asked.length, 1, 'nothing after the first question was asked');
});

test('ideas that cannot be had ask what you are building, instead of ending the interview', async () => {
  // Found live on 14 Sep 2026: the idea request came back with nothing that parsed, the interview
  // returned as though its first question had been cancelled, and the next "I don't know" went to
  // ordinary chat.
  const { io, asked } = sitting(["I don't know", 'a houseplant that texts you when it is thirsty']);
  const logged: string[] = [];
  const models = streamingModel(['Here are a few thoughts, though not in any particular format.']);

  const result = await runInterview(models, io, (message) => logged.push(message), {});

  assert.equal(
    asked[1],
    'No ideas are coming to me just now, which is a first. What are you building? One sentence is plenty.'
  );
  assert.equal(result?.state.answers[0]?.text, 'a houseplant that texts you when it is thirsty');
  assert.ok(
    logged.some((line) => line.includes('planning: seed — idea response did not parse')),
    logged.join('\n')
  );
});

test('the idea list waits longer than a phrased question does', async () => {
  // Four ideas a sentence each is the longest reply the interview asks for; under the phrasing
  // deadline it was cut off before a single complete idea arrived.
  const requested: number[] = [];
  const models = {
    ...streamingModel([
      'Plant Diplomat | negotiates watering between housemates\nCommute Critic | reviews your journey home like a restaurant',
    ]),
    deadline: (ms: number) => {
      requested.push(ms);
      return ms;
    },
  } as unknown as ModelService;
  const { io } = sitting(["I don't know"]);

  await runInterview(models, io, () => {}, {});

  assert.ok(requested.includes(IDEA_TIMEOUT_MS), `deadlines asked for: ${requested.join(', ')}`);
});
