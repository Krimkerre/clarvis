import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReasoningWatch,
  ThinkFilter,
  reasoningFieldError,
  saidNothingButThought,
  unfinishedThinkingError,
} from './reasoning';

/**
 * Built against the wire, not against a guess.
 *
 * Every fragment sequence below is one that `qwen/qwen3-1.7b` actually produced through
 * LM Studio on 20 Aug, or one a different tokenizer would produce from the same text.
 * The live run streamed `'<think>'` as a single frame, then 188 frames of deliberation,
 * then `'</think>'`, then `'\n\n'`, then the answer — 948 of 4103 characters were
 * thinking, and all of it would have been read aloud.
 */

/** Feeds fragments the way the provider does, and returns everything shown. */
function run(filter: ThinkFilter, fragments: string[]): string {
  return fragments.map((fragment) => filter.push(fragment)).join('') + filter.flush();
}

test('the block is removed and the answer arrives whole', () => {
  const filter = new ThinkFilter();
  // The observed shape: tag, deliberation, tag, blank line, answer.
  const shown = run(filter, ['<think>', '\n', 'Okay', ', the user', '.\n', '</think>', '\n\n', 'The', ' reason']);

  assert.equal(shown, '\n\nThe reason');
  assert.equal(filter.suppressed, true);
});

test('a tag split across fragments is still a tag', () => {
  // A GGUF build without `<think>` in its vocabulary emits it a character at a time.
  const filter = new ThinkFilter();
  const shown = run(filter, ['<', 'thi', 'nk>', 'deliberating', '</thi', 'nk>', 'Right.']);

  assert.equal(shown, 'Right.');
  assert.equal(filter.suppressed, true);
});

test('text either side keeps its whitespace exactly', () => {
  // The "the probe-build-fail test has beenfailing" bug: a stripper that trimmed the
  // fragments it touched glued the words either side of it together.
  const filter = new ThinkFilter();
  const shown = run(filter, ['The build ', '<think>hmm</think>', ' has been ', 'failing']);

  assert.equal(shown, 'The build  has been failing');
});

test('a reply with no thinking in it is passed through untouched', () => {
  const filter = new ThinkFilter();
  const shown = run(filter, ['Two sentences.', ' Then a line of my own.']);

  assert.equal(shown, 'Two sentences. Then a line of my own.');
  assert.equal(filter.suppressed, false);
});

test('an unclosed block is dropped entirely, and says so', () => {
  // Observed while reproducing this: a reply cut mid-thought carries an opening tag and
  // no closing one, and every character of it is deliberation. `suppressed` staying true
  // is what lets the caller explain the empty reply instead of reporting silence.
  const filter = new ThinkFilter();
  const shown = run(filter, ['<think>', 'Okay, the user is asking why a build is failing.']);

  assert.equal(shown, '');
  assert.equal(filter.suppressed, true);
});

test('a closing tag on its own is text, not the end of an invisible block', () => {
  // The deliberate limit. A template that prefills `<think>` into the prompt would stream
  // only the closing tag — but LM Studio streamed both in the run this was built from,
  // and reading a lone `</think>` as "everything before this was thinking" would eat any
  // reply that quotes the tag. This project's own documents quote it, and Clarvis reads
  // them aloud.
  const filter = new ThinkFilter();
  const shown = run(filter, ['The plan calls it ', '</think>', ' and I agree.']);

  assert.equal(shown, 'The plan calls it </think> and I agree.');
  assert.equal(filter.suppressed, false);
});

test('an opening tag that never arrives leaves its text alone', () => {
  const filter = new ThinkFilter();
  const shown = run(filter, ['a < b, and ', 'c <thi']);

  assert.equal(shown, 'a < b, and c <thi');
  assert.equal(filter.suppressed, false);
});

test('reasoning in its own field, with nothing else, is a broken pairing', () => {
  // The default LM Studio setting: 199 frames, every one of them reasoning_content.
  assert.equal(
    saidNothingButThought({ text: false, reasoningField: true, thinkingStripped: false, toolCalls: false }),
    true
  );
});

test('an inline block that was the entire reply counts the same', () => {
  assert.equal(
    saidNothingButThought({ text: false, reasoningField: false, thinkingStripped: true, toolCalls: false }),
    true
  );
});

test('a tool call is having said something', () => {
  // The happy path of every agent turn: think, call a tool, write no prose. Reporting
  // that as a broken model would fire on ordinary work.
  assert.equal(
    saidNothingButThought({ text: false, reasoningField: true, thinkingStripped: true, toolCalls: true }),
    false
  );
});

test('thinking followed by an actual answer is fine', () => {
  assert.equal(
    saidNothingButThought({ text: true, reasoningField: true, thinkingStripped: true, toolCalls: false }),
    false
  );
});

test('silence with no reasoning behind it is left to the slow-model notice', () => {
  // F14 owns that case. This one must not claim it, or the wrong cause gets named again.
  assert.equal(
    saidNothingButThought({ text: false, reasoningField: false, thinkingStripped: false, toolCalls: false }),
    false
  );
});

test('the LM Studio user is told which setting to change', () => {
  const error = reasoningFieldError({ id: 'lmstudio', label: 'LM Studio' }, 'qwen/qwen3-1.7b');

  assert.match(error.friendly, /separateReasoningContentInAPI/);
  assert.match(error.friendly, /qwen\/qwen3-1\.7b/);
  assert.match(error.detail, /reasoning only/);
});

test('another OpenAI-compatible server gets advice that applies to it', () => {
  // Naming an LM Studio setting to an Ollama user is a wrong answer stated confidently.
  const error = reasoningFieldError({ id: 'ollama', label: 'Ollama' }, 'deepseek-r1');

  assert.doesNotMatch(error.friendly, /separateReasoningContentInAPI/);
  assert.match(error.friendly, /does not reason/);
});

test('a reply that is only thinking and a blank line is still nothing said', () => {
  // Found by running the agent path against a live reasoning model: the `\n\n` that
  // separates a think block from the answer arrives whether or not an answer does, and
  // counting those two characters as speech would silence the notice entirely.
  const watch = new ReasoningWatch();

  assert.equal(watch.push({ content: '<think>Deliberating.</think>' }), '');
  assert.equal(watch.push({ content: '\n\n' }), '\n\n');
  assert.equal(watch.saidNothing(), true);
});

test('the blank line is still shown, because trimming a stream glues words together', () => {
  const watch = new ReasoningWatch();

  assert.equal(watch.push({ content: 'The build ' }), 'The build ');
  assert.equal(watch.push({ content: 'has been ' }), 'has been ');
  assert.equal(watch.saidNothing(), false);
});

test('a reply that was all thinking is not blamed on a setting that is already off', () => {
  // Caught by replaying both captured streams: the inline branch means the setting is
  // *off* already, so "turn it off" is advice that sounds right and changes nothing.
  const error = unfinishedThinkingError({ id: 'lmstudio', label: 'LM Studio' }, 'qwen/qwen3-1.7b');

  assert.doesNotMatch(error.friendly, /separateReasoningContentInAPI/);
  assert.match(error.friendly, /never got past the thinking/);
  assert.match(error.friendly, /larger context/);
});

test('the shape reported is the one the user can act on', () => {
  const separate = new ReasoningWatch();
  separate.push({ reasoning_content: 'thinking' });
  assert.equal(separate.shape(), 'separate');

  const inline = new ReasoningWatch();
  inline.push({ content: '<think>thinking</think>' });
  assert.equal(inline.shape(), 'inline');
});
