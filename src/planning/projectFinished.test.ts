import test from 'node:test';
import assert from 'node:assert/strict';
import { finishedLines, finishedProject } from './projectFinished';

const done = [
  '# Forecast',
  '',
  '### Milestone 1 — Fetch weather',
  '- [x] Call the API',
  '- [x] Print it',
  '',
  '### Milestone 2 — Cache it',
  '- [x] Write the cache',
].join('\n');

test('a plan with every step ticked is a finished project', () => {
  const project = finishedProject(done);

  assert.equal(project?.name, 'Forecast');
  assert.equal(project?.milestones.length, 2);
  assert.equal(project?.steps, 3);
});

test('one unticked step means it is not finished', () => {
  assert.equal(finishedProject(done.replace('- [x] Write the cache', '- [ ] Write the cache')), undefined);
});

test('an empty plan is not a finished project', () => {
  // Congratulating someone on an empty document is exactly the invented claim §2.2
  // exists to prevent.
  assert.equal(finishedProject('# Forecast\n\nNothing here yet.'), undefined);
  assert.equal(finishedProject('# Forecast\n\n### Milestone 1 — Nothing\n'), undefined);
});

test('the summary names the milestones, not just the fact of being done', () => {
  // "It is done" is worth very little on its own; what is done is the useful part.
  const lines = finishedLines(finishedProject(done)!);

  assert.match(lines[0], /Forecast is finished/);
  assert.ok(lines.some((line) => line.includes('Fetch weather')));
  assert.ok(lines.some((line) => line.includes('Cache it')));
  assert.ok(lines.some((line) => /2 milestones, 3 steps/.test(line)));
});

test('nothing in the summary congratulates anybody', () => {
  // Rule 1: he helps, then he is dry about it. An exclamation mark here would be a
  // different character entirely.
  const text = finishedLines(finishedProject(done)!).join(' ');

  assert.doesNotMatch(text, /!|congratulations|well done|great job/i);
});
