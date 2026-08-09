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
