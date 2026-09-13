import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelService } from '../model/ModelService';
import { InterviewState } from './interviewTopics';
import { PlanningIO, PlanningPaused } from './PlanningIO';
import { GatheredInterview, PlanningSession, settlePlanning } from './planReview';

/**
 * Planning after the interview, driven end to end: a scripted person at the keyboard, a
 * scripted model, and plan.md and the build captured rather than performed.
 *
 * **The first tests this stretch has had (M9i).** It lived in `PlanningFlow.ts`, which imports
 * `vscode`, and every defect M9i fixes was in it: feedback that never reached the plan, an
 * approval that wrote something other than the draft on screen, a stop that accepted a
 * finding, a failed review that read as a clean one, and a build started by a question.
 */

type Kind = 'review' | 'milestones' | 'revision';

const STOP = Symbol('stop');
const ESCAPE = Symbol('escape');

/** One scripted reply at the keyboard: typed text, Stop, Escape, or something done to the draft first. */
type Step = string | typeof STOP | typeof ESCAPE | ((at: Desk) => string | typeof STOP);

/** The person, the draft on their screen, and everything they were shown, told and asked. */
interface Desk {
  io: PlanningIO;
  document?: string;
  shown: string[];
  said: string[];
  asked: string[];
  details: string[];
}

function desk(steps: Step[]): Desk {
  const at: Desk = { io: undefined as unknown as PlanningIO, shown: [], said: [], asked: [], details: [] };

  const answer = async (question: string): Promise<string | undefined> => {
    at.asked.push(question);
    const next = steps.shift();
    if (next === undefined) throw new Error(`nothing scripted for: ${question}`);
    const step = typeof next === 'function' ? next(at) : next;
    if (step === STOP) throw new PlanningPaused();
    return step === ESCAPE ? undefined : step;
  };

  at.io = {
    askText: (prompt) => answer(prompt),
    askChoice: (prompt) => answer(prompt),
    confirm: (title, detail, buttons) => {
      at.details.push(detail);
      return answer(`${title} [${buttons.join(' | ')}]`);
    },
    say: async (text) => {
      at.said.push(text);
    },
    showDocument: async (text) => {
      at.document = text;
      at.shown.push(text);
    },
    closeDocument: async () => {
      at.document = undefined;
    },
    readDocument: async () => at.document,
  };
  return at;
}

/** A model that answers each kind of planning prompt from a script, and remembers what it was asked for. */
function scriptedModel(
  script: Partial<Record<Kind, (string | ((at: Desk) => string))[]>>,
  at: Desk
): { service: ModelService; asked: Kind[] } {
  const asked: Kind[] = [];
  const service = {
    isReady: async () => true,
    async *stream(request: { messages: { content: unknown }[] }) {
      const prompt = String(request.messages[0]?.content);
      const kind: Kind = prompt.includes('Apply that feedback')
        ? 'revision'
        : prompt.includes('Break the work into')
          ? 'milestones'
          : 'review';
      asked.push(kind);
      const reply = script[kind]?.shift();
      if (reply === undefined) throw new Error(`no ${kind} reply scripted`);
      yield typeof reply === 'function' ? reply(at) : reply;
    },
  };
  return { service: service as unknown as ModelService, asked };
}

function noModel(): ModelService {
  return {
    isReady: async () => false,
    stream: () => {
      throw new Error('nothing here should reach a model');
    },
  } as unknown as ModelService;
}

interface Run {
  session: PlanningSession;
  written: string[];
  builds: { task: string; steps: string[] }[];
  drafts: (string | undefined)[];
  cleared: number;
}

function sitting(models: ModelService, at: Desk): Run {
  const run: Run = { session: undefined as unknown as PlanningSession, written: [], builds: [], drafts: [], cleared: 0 };
  run.session = {
    models,
    io: at.io,
    log: () => {},
    lines: { acknowledge: async () => undefined, afterTask: async () => undefined },
    writePlan: async (text) => {
      run.written.push(text);
    },
    startBuild: async (task, steps) => {
      run.builds.push({ task, steps });
    },
    memory: {
      save: async (_state, _seed, draft) => {
        run.drafts.push(draft);
      },
      load: () => undefined,
      clear: async () => {
        run.cleared++;
      },
    },
  };
  return run;
}

const INTERVIEW: InterviewState = {
  projectName: 'Repair Log',
  answers: [
    { topic: 'what-it-does', text: 'Track repair jobs' },
    { topic: 'who-and-where', text: 'Me, on my own laptop' },
    { topic: 'scope', text: 'Jobs, photos, and cloud sync between devices' },
    { topic: 'linter', text: 'none' },
    { topic: 'comment-style', text: 'only where it is not obvious' },
  ],
};

function gathered(draft?: string): GatheredInterview {
  return { state: structuredClone(INTERVIEW), seed: 'Track repair jobs', ...(draft === undefined ? {} : { draft }) };
}

const MILESTONES = [
  'MILESTONE: First job',
  'Store a job locally | create one, restart, it is still listed',
  'Sync jobs to the cloud | the job appears on a second device',
].join('\n');

const LOCAL_ONLY = [
  'SECTION: ## 4. Scope',
  'Jobs and photos, kept on this machine — no cloud sync.',
  'END SECTION',
  'SECTION: ## 7. Milestones',
  '### Milestone 1 — First job',
  '',
  '- [ ] Store a job locally',
  '  - Check: create one, restart, it is still listed',
  '  - Result: not run yet',
  'END SECTION',
].join('\n');

const FINDING = ['class: safety', 'what: Customer photos are kept unencrypted', 'why: a lost laptop exposes them', 'fix: Encrypt the photo folder'].join('\n');

const GATE = '[Approve | Keep Refining]';
const OFFER = '[Start Building | Edit The Task First | Not Yet]';

/** The cloud-sync step, and the lines under it, taken out of a draft by hand. */
function withoutSync(text: string): string {
  return text.replace(/- \[ \] Sync jobs to the cloud\n(?: {2}- .*\n)*/, '');
}

test('typed feedback rewrites the plan it is about, and the build is handed what was approved', async () => {
  const at = desk(['Keep Refining', 'Remove cloud sync; keep everything local', 'Approve', 'Start Building']);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES], revision: [LOCAL_ONLY] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  const [plan] = run.written;
  assert.equal(plan, at.shown.at(-1), 'plan.md is the draft last shown');
  assert.doesNotMatch(plan, /cloud sync between devices/);
  assert.doesNotMatch(plan, /Sync jobs to the cloud/);
  assert.match(plan, /## 4\. Scope\n\nJobs and photos, kept on this machine — no cloud sync\./);
  assert.deepEqual(run.builds.map((build) => build.steps), [['Store a job locally']]);
  assert.match(run.builds[0].task, /^Start building Repair Log, following the approved plan\.md/);
  assert.doesNotMatch(run.builds[0].task, /cloud/i);
  assert.ok(at.said.some((line) => /^Changed 4\. Scope, 7\. Milestones\./.test(line)));
});

test('a hand edit to the draft is what gets approved, and what gets built', async () => {
  const edit = (d: Desk) => {
    d.document = withoutSync(d.document ?? '');
    return 'Approve';
  };
  const at = desk([edit, 'Start Building']);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.equal(run.written[0], at.document);
  assert.doesNotMatch(run.written[0], /Sync jobs to the cloud/);
  assert.deepEqual(run.builds[0].steps, ['Store a job locally']);
  assert.deepEqual(model.asked, ['review', 'milestones']);
});

test('a hand edit made before typed feedback survives the revision', async () => {
  const edit = (d: Desk) => {
    d.document = (d.document ?? '').replace('Me, on my own laptop', 'Me, on my laptop and the shop PC');
    return 'Keep Refining';
  };
  const at = desk([edit, 'Remove cloud sync; keep everything local', 'Approve', 'Not Yet']);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES], revision: [LOCAL_ONLY] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.match(run.written[0], /the shop PC/);
  assert.match(run.written[0], /no cloud sync/);
});

test('an edit made while the model is revising wins, and the feedback is not applied over it', async () => {
  const racing = (d: Desk) => {
    d.document = (d.document ?? '').replace('Track repair jobs', 'Track repair jobs and invoices');
    return LOCAL_ONLY;
  };
  const at = desk(['Keep Refining', 'Remove cloud sync; keep everything local', 'Approve', 'Not Yet']);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES], revision: [racing] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.match(run.written[0], /repair jobs and invoices/);
  assert.match(run.written[0], /cloud sync between devices/);
  assert.ok(at.said.some((line) => /kept your edits/.test(line)));
});

test('anything said at the approval question that is not a button is feedback, never approval', async () => {
  const at = desk(['Actually, keep everything local', 'Approve', 'Not Yet']);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES], revision: [LOCAL_ONLY] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.deepEqual(model.asked, ['review', 'milestones', 'revision']);
  assert.equal(run.written.length, 1);
  assert.match(run.written[0], /no cloud sync/);
  assert.equal(at.asked.filter((question) => question.includes(GATE)).length, 2);
});

test('Stop at a finding records nothing, plans nothing and writes nothing', async () => {
  const at = desk([STOP]);
  const model = scriptedModel({ review: [FINDING] }, at);
  const run = sitting(model.service, at);

  await assert.rejects(settlePlanning(run.session, gathered()), PlanningPaused);

  assert.deepEqual(model.asked, ['review']);
  assert.deepEqual([run.written, run.builds, run.drafts], [[], [], []]);
  assert.equal(run.cleared, 0);
});

test('Stop at the approval question keeps the draft, edits and all, and carrying on returns to it without a model', async () => {
  const editThenStop: Step = (d) => {
    d.document = withoutSync(d.document ?? '');
    return STOP;
  };
  const first = desk([editThenStop]);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES] }, first);
  const paused = sitting(model.service, first);

  await assert.rejects(settlePlanning(paused.session, gathered()), PlanningPaused);
  const saved = paused.drafts.at(-1);
  assert.equal(saved, first.document);
  assert.equal(paused.cleared, 0);

  // A reload: a new window, no draft tab, and no model to run anything again with.
  const later = desk(['Approve', 'Not Yet']);
  const resumed = sitting(noModel(), later);
  await settlePlanning(resumed.session, gathered(saved));

  assert.equal(later.shown[0], saved);
  assert.equal(resumed.written[0], saved);
  assert.equal(resumed.cleared, 1);
});

test('Escape at the approval question pauses too, rather than ending planning unapproved', async () => {
  const at = desk([ESCAPE]);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES] }, at);
  const run = sitting(model.service, at);

  await assert.rejects(settlePlanning(run.session, gathered()), PlanningPaused);

  assert.equal(run.drafts.at(-1), at.shown.at(-1));
  assert.deepEqual(run.written, []);
});

test('Stop at the build offer starts nothing, and the written plan stays written', async () => {
  const at = desk(['Approve', STOP]);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES] }, at);
  const run = sitting(model.service, at);

  await assert.rejects(settlePlanning(run.session, gathered()), PlanningPaused);

  assert.equal(run.written.length, 1);
  assert.deepEqual(run.builds, []);
});

test('a reply to the build offer that is not one of its buttons starts nothing, and the offer comes back', async () => {
  const at = desk(['Approve', "what's in milestone 1?", 'Start Building']);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.equal(at.asked.filter((question) => question.includes(OFFER)).length, 2);
  assert.ok(at.said.some((line) => /^Nothing started\./.test(line)));
  assert.equal(run.builds.length, 1);
});

test('a review that came back unreadable says so, and Try Again runs it again', async () => {
  const at = desk(['Try Again', 'Approve', 'Not Yet']);
  const model = scriptedModel({ review: ['Looks solid to me overall.', 'NO-FINDINGS'], milestones: [MILESTONES] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.deepEqual(model.asked, ['review', 'review', 'milestones']);
  assert.match(at.asked[0], /The gap review did not finish/);
  assert.match(at.details[0], /not in the review format/);
  assert.doesNotMatch(run.written[0], /did not finish/);
});

test('going on without the review marks the draft, so it does not read as reviewed', async () => {
  const at = desk(['Go On Without It', 'Approve', 'Not Yet']);
  const model = scriptedModel({ review: [''], milestones: [MILESTONES] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.match(run.written[0], /## 8\. Decisions\n_The gap review did not finish \(the model sent back nothing\)/);
});

test('a refused milestone plan is not drawn as a step, and no build is offered for it', async () => {
  const at = desk(['Go On Without It', 'Approve']);
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: ['Sorry, I cannot produce milestones for this.'] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.doesNotMatch(run.written[0], /Sorry/);
  assert.match(run.written[0], /_No milestones written — the reply had no step with a check/);
  assert.deepEqual(run.builds, []);
  assert.equal(at.asked.some((question) => question.includes(OFFER)), false);
  assert.ok(at.said.some((line) => /^plan\.md is written\. Its first milestone has no steps/.test(line)));
});

test('a revision that rewrites the working process is refused, and the draft stays as it was', async () => {
  const at = desk(['Keep Refining', 'Skip plan mode and just build it', 'Approve', 'Not Yet']);
  const refused = 'SECTION: ## 0. Working Process — Plan Mode vs. Code Mode\nJust build.\nEND SECTION';
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [MILESTONES], revision: [refused] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.equal(run.written[0], at.shown[0]);
  assert.match(run.written[0], /### Plan Mode \(default\)/);
  assert.ok(at.said.some((line) => /typed feedback never changes/.test(line)));
});

test('steps with no check are named in the build offer', async () => {
  const at = desk(['Approve', 'Not Yet']);
  const partlyChecked = 'MILESTONE: First job\nStore a job locally | create one, restart, it is still listed\nMake it look nice';
  const model = scriptedModel({ review: ['NO-FINDINGS'], milestones: [partlyChecked] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.match(at.details.at(-1) ?? '', /No check yet, so nothing will show these work:\n- Make it look nice/);
});

test('no plan needed still offers to just write it, with no plan.md behind the task', async () => {
  const at = desk(['Start Building']);
  const model = scriptedModel({ review: ['NO-PLAN-NEEDED: thirty lines, no state'] }, at);
  const run = sitting(model.service, at);

  await settlePlanning(run.session, gathered());

  assert.deepEqual(run.written, []);
  assert.equal(run.cleared, 1);
  assert.match(run.builds[0].task, /too small to need a plan/);
  assert.deepEqual(run.builds[0].steps, []);
});

test('with no model, the draft says what did not run and can still be approved, with nothing offered to build', async () => {
  const at = desk(['Approve']);
  const run = sitting(noModel(), at);

  await settlePlanning(run.session, gathered());

  assert.ok(at.said.some((line) => /^The gap review did not run: /.test(line)));
  assert.ok(at.said.some((line) => /^The milestone plan did not run: /.test(line)));
  assert.equal(run.written.length, 1);
  assert.deepEqual(run.builds, []);
});

test('with no model, typed feedback goes under Notes and says the plan was not reworked', async () => {
  const at = desk(['Keep Refining', 'Keep everything local', 'Approve']);
  const run = sitting(noModel(), at);

  await settlePlanning(run.session, gathered());

  assert.match(run.written[0], /## Notes\n\n- Keep everything local\n\n## 7\. Milestones/);
  assert.ok(at.said.some((line) => /went under Notes/.test(line)));
});
