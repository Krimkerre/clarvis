import test from 'node:test';
import assert from 'node:assert/strict';
import { Entry, plannedStack, projectEntries } from './projectFacts';

const TREE: Record<string, Entry[]> = {
  '': [
    { name: 'src', isDirectory: true },
    { name: 'plan.md', isDirectory: false },
    { name: '.git', isDirectory: true },
    { name: 'node_modules', isDirectory: true },
  ],
  src: [
    { name: 'main.py', isDirectory: false },
    { name: 'widgets', isDirectory: true },
  ],
  'src/widgets': [{ name: 'clock.py', isDirectory: false }],
  node_modules: [{ name: 'left-pad', isDirectory: true }],
};

test('the folder is listed two levels deep, so src/main.py is a fact and not a guess', () => {
  // Found live, 11 September 2026: told only "plan.md, src/", chat said the project had a
  // src/main.go. It had src/main.py.
  assert.deepEqual(projectEntries((relative) => TREE[relative] ?? []), [
    'node_modules/',
    'plan.md',
    'src/',
    'src/main.py',
    'src/widgets/',
  ]);
});

test('the list is capped, and a folder that cannot be read is simply left out', () => {
  assert.equal(projectEntries((relative) => TREE[relative] ?? [], 2).length, 2);
  const unreadable = projectEntries((relative) => {
    if (relative === 'src') throw new Error('EACCES');
    return TREE[relative] ?? [];
  });
  assert.ok(unreadable.includes('src/') && !unreadable.includes('src/main.py'), unreadable.join(', '));
});

test("the plan's language is read from its own section", () => {
  const plan = [
    '# Distraction Tax',
    '',
    '## 3. Language',
    '',
    '**Asked:** Which language should this be built in?',
    '',
    "**Python with tkinter** — The timer logic writes itself, and you'll see it working.",
    '',
    '## 4. Scope',
  ].join('\n');

  assert.equal(plannedStack(plan), 'Python with tkinter');
  assert.equal(plannedStack('# A plan\n\n## 4. Scope\n\n**Small**'), undefined);
  assert.equal(plannedStack('## 3. Language\n\n**Asked:** Which?\n\n## 4. Scope'), undefined);
});
