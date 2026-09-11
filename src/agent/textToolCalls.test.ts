import test from 'node:test';
import assert from 'node:assert/strict';
import { toolCallsInText } from './textToolCalls';

test('the reply that ended a run after 0 steps is read as a call', () => {
  // The shape from the 11 September log, where this went to the screen instead.
  const said =
    "I'll help you update the plan.md file. First, let me check if it exists and what its current content is.\n\n" +
    '<function=listFiles>\n</function>\n</tool_call>';

  const { calls, rest } = toolCallsInText(said);

  assert.deepEqual(calls.map((call) => call.name), ['listFiles']);
  assert.deepEqual(calls[0].args, {});
  assert.ok(!rest.includes('<function') && !rest.includes('tool_call'), rest);
  assert.match(rest, /update the plan\.md file/);
});

test('parameters arrive as arguments, and a number as a number', () => {
  const { calls } = toolCallsInText(
    '<tool_call>\n<function=readFile>\n<parameter=path>\ntimer.py\n</parameter>\n' +
      '<parameter=startLine>\n10\n</parameter>\n</function>\n</tool_call>'
  );

  assert.deepEqual(calls, [{ id: 'text-call-1', name: 'readFile', args: { path: 'timer.py', startLine: 10 } }]);
});

test('a Hermes-style call is read too', () => {
  const { calls } = toolCallsInText(
    '<tool_call>{"name": "runCommand", "arguments": {"command": "python timer.py --help"}}</tool_call>'
  );

  assert.deepEqual(calls[0].args, { command: 'python timer.py --help' });
});

test('a reply that only mentions a tool is left alone', () => {
  const said = 'I used listFiles and readFile to check, and timer.py looks right.';

  assert.deepEqual(toolCallsInText(said), { calls: [], rest: said });
});
