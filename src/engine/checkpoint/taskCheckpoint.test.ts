import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  capCheckpoint,
  CHECKPOINT_MAX_BYTES,
  encodeCheckpoint,
  newCheckpoint,
  parseCheckpoint,
  redactSecrets,
  undeliveredFeedback,
  withFeedback,
  withFeedbackDelivered,
  type FeedbackNote,
  type TaskCheckpoint,
} from './taskCheckpoint';

/**
 * The checkpoint as a record (design §6.1): one task in one folder, what the owner said kept until an engine has
 * taken it in, never another project's, never a secret, never over 64 KB.
 */

const ROOT = '/Users/owner/Documents/coding/add-utc-demo';
const NOW = new Date('2026-09-13T02:00:00Z');

function checkpoint(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return { ...newCheckpoint({ taskId: '8b1c2d3e', workspaceRoot: ROOT, host: 'desktop', engine: 'codex', task: 'Build milestone 2.', now: NOW }), ...overrides };
}

test('a new checkpoint is one task in one folder, starts empty, and holds nothing that grants anything', () => {
  const fresh = checkpoint();

  assert.deepEqual(
    [fresh.version, fresh.taskId, fresh.workspaceRoot, fresh.engine, fresh.status, fresh.savedAt],
    [3, '8b1c2d3e', ROOT, 'codex', 'running', NOW.toISOString()]
  );
  assert.deepEqual([fresh.changedFiles, fresh.latestFeedback, fresh.unresolvedQuestions, fresh.uncertainOperations], [[], [], [], []]);
  assert.doesNotMatch(JSON.stringify(fresh), /token|lease|credential|password/i);
});

test('what the owner typed is kept once while it waits, and becomes history once an engine took it in', () => {
  let current = withFeedback(checkpoint(), ['Use the other library.', '  Use the other library.  ', ''], 'desktop', NOW);
  assert.deepEqual(undeliveredFeedback(current), ['Use the other library.'], 'the same words waiting are one note');

  current = withFeedbackDelivered(current);
  assert.deepEqual(undeliveredFeedback(current), []);
  current = withFeedback(current, ['Use the other library.'], 'code-server', NOW);

  assert.deepEqual(
    current.latestFeedback.map((note) => [note.text, note.host, note.delivered]),
    [
      ['Use the other library.', 'desktop', true],
      ['Use the other library.', 'code-server', false],
    ],
    'said again after it was delivered, it is new'
  );
});

test("another folder's checkpoint is never read as this one's; anything malformed is no checkpoint at all", () => {
  const text = JSON.stringify(checkpoint());

  assert.equal(parseCheckpoint(text, ROOT).ok, true);
  assert.deepEqual(parseCheckpoint(text, `${ROOT}-v2`), { ok: false, reason: 'other_project' });
  assert.deepEqual(parseCheckpoint('{not json', ROOT), { ok: false, reason: 'not_a_checkpoint' });
  assert.deepEqual(parseCheckpoint(JSON.stringify({ ...checkpoint(), version: 2 }), ROOT), { ok: false, reason: 'not_a_checkpoint' });
  const withoutLists = { ...checkpoint(), uncertainOperations: undefined };
  assert.deepEqual(parseCheckpoint(JSON.stringify(withoutLists), ROOT), { ok: false, reason: 'not_a_checkpoint' });
});

test('secrets in command output and summaries are removed; ordinary text is left as it is', () => {
  const cases: [string, string][] = [
    ['Authorization: Bearer abc.def.ghi', 'Authorization: Bearer [secret removed]'],
    ['curl -H "bearer eyJhbGciOi"', 'curl -H "bearer [secret removed]'],
    ['password=hunter2 and more', 'password=[secret removed] and more'],
    ['OPENAI key sk-proj-abcdefghijklmnopqrst', 'OPENAI key [secret removed]'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'token [secret removed]'],
    ['session ast_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'session [secret removed]'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----', '[private key removed]'],
    ['3 passed in 0.41s', '3 passed in 0.41s'],
  ];
  for (const [text, expected] of cases) assert.equal(redactSecrets(text), expected, text);

  const capped = capCheckpoint(
    checkpoint({
      checks: [{ command: 'npm test', exitCode: 1, engine: 'codex', ranAt: NOW.toISOString(), outputTail: 'API_KEY=sk-live-0123456789abcdefghij failed' }],
      unresolvedQuestions: [{ engine: 'codex', summary: 'Codex asked to run `export TOKEN=abc123`' }],
    })
  );
  assert.equal(capped.checks[0].outputTail, 'API_KEY=[secret removed] failed');
  assert.equal(capped.unresolvedQuestions[0].summary, 'Codex asked to run `export TOKEN=[secret removed]');
});

test('every list is capped: what the owner said and has not been delivered is kept before delivered history', () => {
  const note = (index: number, delivered: boolean): FeedbackNote => ({ text: `note ${index}`, typedAt: NOW.toISOString(), host: 'desktop', delivered });
  const notes = [...Array.from({ length: 20 }, (_, index) => note(index, true)), ...Array.from({ length: 25 }, (_, index) => note(100 + index, false))];
  const checks = Array.from({ length: 50 }, (_, index) => ({ command: `check ${index}`, exitCode: 0, engine: 'clarvis' as const, ranAt: NOW.toISOString(), outputTail: 'x'.repeat(5_000) }));

  const capped = capCheckpoint(checkpoint({ latestFeedback: notes, checks }));

  assert.equal(capped.latestFeedback.length, 30);
  assert.equal(capped.latestFeedback.filter((kept) => !kept.delivered).length, 25, 'every waiting note is kept');
  assert.deepEqual(capped.latestFeedback.slice(0, 5).map((kept) => kept.text), ['note 15', 'note 16', 'note 17', 'note 18', 'note 19'], 'the newest delivered history fills the rest, in order');
  assert.deepEqual([capped.checks.length, capped.checks[0].command, capped.checks[0].outputTail.length], [20, 'check 30', 1_500]);
});

test('a checkpoint stays under 64 KB: bulky history is halved, and feedback, questions and uncertain operations are never cut', () => {
  const long = (index: number) => `src/${'deeply/nested/'.repeat(25)}file-${index}.ts`;
  const huge = checkpoint({
    task: 't'.repeat(8_000),
    changedFiles: Array.from({ length: 300 }, (_, index) => long(index)),
    git: { dirty: Array.from({ length: 300 }, (_, index) => long(index)), diffStat: Array.from({ length: 300 }, (_, index) => ({ path: long(index), added: 1, removed: 2 })) },
    latestFeedback: [{ text: 'Keep the old flag.', typedAt: NOW.toISOString(), host: 'desktop', delivered: false }],
    unresolvedQuestions: [{ engine: 'codex', summary: 'Run `npm install`?' }],
    uncertainOperations: [{ kind: 'command', summary: 'npm install left-pad', state: 'unknown' }],
  });

  const { text, bytes } = encodeCheckpoint(huge);
  const back = JSON.parse(text) as TaskCheckpoint;

  assert.ok(bytes <= CHECKPOINT_MAX_BYTES, `${bytes} bytes`);
  assert.equal(Buffer.byteLength(text), bytes);
  assert.deepEqual([back.latestFeedback.length, back.unresolvedQuestions.length, back.uncertainOperations.length], [1, 1, 1]);
  assert.ok(back.changedFiles.length < 300, 'the file list gave way instead');
});
