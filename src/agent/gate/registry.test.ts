import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOLS,
  isToolName,
  mutates,
  validateArgs,
  anthropicTools,
  openAiTools,
} from '../toolRegistry';

test('an invented tool name is not a tool', () => {
  // The trust boundary. A model that hallucinates a capability, or one steered by text
  // injected through a pasted error message, has nowhere to land.
  assert.equal(isToolName('deleteEverything'), false);
  assert.equal(isToolName('exec'), false);
  assert.equal(isToolName(''), false);
  assert.equal(isToolName(42), false);
  assert.equal(isToolName('readFile'), true);
});

test('only the workspace-changing tools are marked as mutating', () => {
  // This flag drives checkpointing. Getting it wrong on a write means no snapshot and
  // therefore no undo, which is the one failure the whole safety layer exists to stop.
  assert.equal(mutates('applyEdit'), true);
  assert.equal(mutates('writeFile'), true);
  assert.equal(mutates('runCommand'), true);
  assert.equal(mutates('readFile'), false);
  assert.equal(mutates('gitDiff'), false);
});

test('missing required arguments are refused with a usable message', () => {
  // The model reads this. "Invalid arguments" wastes a step; naming the field fixes it.
  const result = validateArgs('applyEdit', { path: 'a.ts', find: 'x' });

  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /replace/);
});

test('an empty string counts as missing', () => {
  // An empty `find` would match everywhere; an empty path resolves to the root.
  assert.equal(validateArgs('readFile', { path: '' }).ok, false);
});

test('an empty file and a deletion are edits, not missing arguments', () => {
  // Found live, 13 September 2026: `writeFile tests/__init__.py` with empty contents came
  // back "writeFile needs \"contents\"", and the run spent a step on `: > tests/__init__.py`
  // instead. An empty package marker is a real file; replacing text with nothing deletes it.
  assert.equal(validateArgs('writeFile', { path: 'tests/__init__.py', contents: '' }).ok, true);
  assert.equal(validateArgs('applyEdit', { path: 'a.ts', find: 'x', replace: '' }).ok, true);
});

test('text that must say something is still refused when empty', () => {
  assert.equal(validateArgs('applyEdit', { path: 'a.ts', find: '', replace: 'y' }).ok, false);
  assert.equal(validateArgs('writeFile', { path: '', contents: '' }).ok, false);
  assert.equal(validateArgs('runCommand', { command: '' }).ok, false);
  // Missing is still missing, even where empty is allowed.
  assert.equal(validateArgs('writeFile', { path: 'a.ts' }).ok, false);
});

test('wrong primitive types are caught before the tool runs', () => {
  assert.equal(validateArgs('listFiles', { recursive: 'yes' }).ok, false);
  assert.equal(validateArgs('readFile', { path: 42 }).ok, false);
  assert.equal(validateArgs('listFiles', { recursive: true }).ok, true);
});

test('unknown extra arguments are tolerated', () => {
  // Models add stray fields. Failing a call over one wastes a step to no purpose,
  // and the tools ignore what they do not read anyway.
  assert.equal(validateArgs('readFile', { path: 'a.ts', encoding: 'utf8' }).ok, true);
});

test('non-object arguments are refused rather than crashing a tool', () => {
  assert.equal(validateArgs('readFile', 'a.ts').ok, false);
  assert.equal(validateArgs('readFile', null).ok, false);
  assert.equal(validateArgs('readFile', ['a.ts']).ok, false);
});

test('both dialects describe every tool exactly once', () => {
  // Drift between the two shapes is how a tool becomes available to one provider and
  // silently missing from the other.
  assert.equal(anthropicTools().length, TOOLS.length);
  assert.equal(openAiTools().length, TOOLS.length);
});

test('every tool has a description that says what it is for', () => {
  // The description is the only thing telling the model when to reach for it.
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 20, tool.name);
    for (const required of tool.parameters.required) {
      assert.ok(tool.parameters.properties[required], `${tool.name}.${required} has no schema`);
    }
  }
});

test('applyEdit warns about uniqueness in its own description', () => {
  // The single most common agent failure is an ambiguous edit. Saying so in the schema
  // costs nothing and prevents a wasted step.
  const edit = TOOLS.find((tool) => tool.name === 'applyEdit')!;

  assert.match(edit.description, /unique/i);
});

import { readOnlyTools } from '../toolRegistry';

test('the answer path is offered only tools that cannot change anything', () => {
  // A question must never become an edit. Filtering by `mutates` rather than keeping
  // a second list means a new tool has to be *marked* non-mutating to get here — it
  // cannot arrive by being forgotten.
  const names = readOnlyTools().map((tool) => tool.name);

  assert.ok(names.includes('readFile'));
  assert.ok(names.includes('search'));
  assert.ok(names.includes('gitDiff'));
  assert.ok(!names.includes('applyEdit'), names.join(','));
  assert.ok(!names.includes('writeFile'), names.join(','));
  assert.ok(!names.includes('runCommand'), names.join(','));
});

test('every read-only tool really is non-mutating', () => {
  for (const tool of readOnlyTools()) {
    assert.equal(tool.mutates, false, tool.name);
  }
});

import { narrateTool } from '../toolNarration';

test('the transcript gets a sentence, not a log line', () => {
  // "applyEdit: src/app.ts" is a log line that leaked into a conversation.
  assert.equal(narrateTool('readFile', { path: 'app.js' }), 'Reading app.js');
  assert.equal(narrateTool('applyEdit', { path: 'src/a.ts' }), 'Editing src/a.ts');
  assert.equal(narrateTool('runCommand', { command: 'npm test' }), 'Running npm test');
  assert.equal(narrateTool('gitStatus', {}), 'Checking where things stand in git');
});

test('missing arguments still produce a sentence', () => {
  // A malformed call is reported to the model separately; the transcript should not
  // read "Reading undefined" in the meantime.
  assert.equal(narrateTool('readFile', {}), 'Reading a file');
  assert.equal(narrateTool('runCommand', {}), 'Running a command');
});

test('listing the whole project reads differently from listing a folder', () => {
  assert.equal(narrateTool('listFiles', {}), 'Looking through the project');
  assert.equal(narrateTool('listFiles', { directory: '.' }), 'Looking through the project');
  assert.equal(narrateTool('listFiles', { directory: 'src/watch' }), 'Looking through src/watch');
});

import { commitSubject } from '../commitSubject';

test('a useless closing line does not become the commit message', () => {
  // Models close with "Done." constantly. It is fine conversation and a useless line
  // in a history someone reads six months later.
  assert.equal(commitSubject('Done.', 'edit the comment in plan.md'), 'edit the comment in plan.md');
  assert.equal(commitSubject('Fixed it!', 'fix the failing test'), 'fix the failing test');
  assert.equal(commitSubject('  ', 'add a comment'), 'add a comment');
});

test('a descriptive closing line is kept', () => {
  assert.equal(
    commitSubject('Changed the comment to dubbawubbalublub in plan.md.', 'edit it'),
    'Changed the comment to dubbawubbalublub in plan.md.'
  );
});

test('the subject stays short enough to read in a log', () => {
  assert.ok(commitSubject('x'.repeat(200), 'task').length <= 72);
});

test('a leading blank line does not defeat it', () => {
  // Streamed narration often starts with whitespace.
  assert.equal(commitSubject('\n\nRenamed the helper for clarity.', 'task'), 'Renamed the helper for clarity.');
});

import { narrateCommand, isLookingAround } from '../toolNarration';

test('a command with commit hashes is described, not quoted', () => {
  // "git show a1dc402 -- plan.md; echo ---; git show de8ee1f -- plan.md" is fine in a
  // log and alarming in a conversation: §6's audience does not know what a hash is,
  // and four of them make a routine look-up feel like something going wrong.
  assert.equal(
    narrateCommand('git show a1dc402 -- plan.md; echo ---; git show de8ee1f -- plan.md'),
    'Reading the project history'
  );
  assert.equal(narrateCommand('git log --oneline --all -20'), 'Reading the project history');
  assert.equal(narrateCommand('git branch -a'), 'Listing the branches');
  assert.equal(narrateCommand('git branch milestone/1 master'), 'Making a branch');
});

test('short familiar commands are still shown as themselves', () => {
  // A developer reads `npm test` faster than any sentence about it, and hiding it
  // would be its own kind of unclear.
  assert.equal(narrateCommand('npm test'), 'Running npm test');
  assert.equal(narrateCommand('pytest'), 'Running pytest');
});

test('a long or compound command is summarised rather than pasted', () => {
  assert.equal(narrateCommand('npm run build && npm run lint && npm test'), 'Running a few commands');
  assert.equal(narrateCommand('node ' + 'x'.repeat(60)), 'Running a few commands');
});

test('reading steps are marked so they can be collapsed', () => {
  assert.equal(isLookingAround('readFile', { path: 'a.ts' }), true);
  assert.equal(isLookingAround('search', { pattern: 'x' }), true);
  assert.equal(isLookingAround('runCommand', { command: 'git log --oneline' }), true);

  // Anything that changes something is always shown.
  assert.equal(isLookingAround('applyEdit', { path: 'a.ts' }), false);
  assert.equal(isLookingAround('writeFile', { path: 'a.ts' }), false);
  assert.equal(isLookingAround('runCommand', { command: 'npm test' }), false);
  assert.equal(isLookingAround('runCommand', { command: 'git branch new-thing' }), false);
});
