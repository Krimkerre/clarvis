import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptCodexChoice, choiceSummary, effectiveCodexChoice, type CodexChoice } from './codexChoice';

/**
 * Which Codex model a new task runs, and how hard it thinks (plan.md M15, C2b+): the plan's default model at its
 * default effort unless the owner chose, and a choice only ever stored as RAVIS lists it.
 */

const astra = { id: 'gpt-6-astra', display_name: 'gpt-6-astra', is_default: true, default_effort: 'low', efforts: ['low', 'medium', 'high'] };
const nova = { id: 'gpt-6-nova', display_name: 'GPT-6 Nova', is_default: false, default_effort: 'medium', efforts: ['medium', 'high'] };
const pair = (choice: CodexChoice | undefined) => choice && [choice.model.id, choice.effort];

test('a new task runs the default model at its default effort, unless the owner chose something RAVIS still offers', () => {
  assert.deepEqual(pair(effectiveCodexChoice([nova, astra], {})), ['gpt-6-astra', 'low']);
  assert.deepEqual(pair(effectiveCodexChoice([nova, astra], { model: 'gpt-6-nova', effort: 'high' })), ['gpt-6-nova', 'high']);
  assert.deepEqual(pair(effectiveCodexChoice([nova, astra], { model: 'gpt-6-nova', effort: 'low' })), ['gpt-6-nova', 'medium'], "an effort the model doesn't offer is its default");
  assert.deepEqual(
    pair(effectiveCodexChoice([nova, astra], { model: 'gpt-5-retired', effort: 'high' })),
    ['gpt-6-astra', 'low'],
    'a model RAVIS no longer lists falls back to the default, at its own default effort'
  );
  assert.deepEqual(pair(effectiveCodexChoice([nova], {})), ['gpt-6-nova', 'medium'], 'with no default marked, the first listed');
  assert.equal(effectiveCodexChoice([], { model: 'gpt-6-nova' }), undefined, 'nothing listed, nothing to run');
});

test("the owner's pick is stored only as RAVIS lists it: a model it lists, and an effort that model offers", () => {
  assert.deepEqual(acceptCodexChoice([astra, nova], {}, { model: 'gpt-6-nova', effort: 'high' }), { model: 'gpt-6-nova', effort: 'high' });
  assert.deepEqual(
    acceptCodexChoice([astra, nova], { model: 'gpt-6-astra', effort: 'high' }, { model: 'gpt-6-nova' }),
    { model: 'gpt-6-nova', effort: 'high' },
    'picking a model keeps the effort when the new model offers it'
  );
  assert.deepEqual(
    acceptCodexChoice([astra, nova], { model: 'gpt-6-astra', effort: 'low' }, { model: 'gpt-6-nova' }),
    { model: 'gpt-6-nova', effort: 'medium' },
    "and takes the new model's default when it doesn't"
  );
  assert.equal(acceptCodexChoice([astra, nova], {}, { model: 'gpt-6-nova', effort: 'low' }), undefined, "an effort that model doesn't offer");
  assert.equal(acceptCodexChoice([astra, nova], {}, { model: 'gpt-7-unlisted', effort: 'low' }), undefined, 'a model RAVIS does not list');
  assert.equal(acceptCodexChoice([astra, nova], {}, { model: 42, effort: 'low' }), undefined);
  assert.equal(acceptCodexChoice([astra, nova], {}, { model: 'gpt-6-nova', effort: 7 }), undefined);
  assert.equal(acceptCodexChoice([], {}, { model: 'gpt-6-nova' }), undefined, 'nothing listed, nothing stored');
});

test("the bowtie's tooltip names the stored choice, or the defaults", () => {
  assert.equal(choiceSummary({}), "the plan's default model, at its default effort");
  assert.equal(choiceSummary({ model: 'gpt-6-nova', effort: 'high' }), 'gpt-6-nova, at high effort');
});
