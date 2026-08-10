import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allConcepts, lessonFor, renderLesson } from './gitLessons';

test('a concept is taught once and then never again', () => {
  // A tutor who explains branches every time you make one has stopped teaching and
  // started nagging. §4.10 is explicit that the mode is meant to be outgrown.
  assert.ok(lessonFor('branch', []));
  assert.equal(lessonFor('branch', ['branch']), undefined);
});

test('every concept has a lesson, and every lesson stays short', () => {
  // Three sentences: longer is a tutorial nobody reads, shorter is a definition
  // rather than an explanation.
  for (const concept of allConcepts()) {
    const lesson = lessonFor(concept, [])!;

    assert.ok(lesson.because.length > 0, concept);
    const sentences = lesson.text.split(/(?<=\.)\s+/).filter(Boolean);
    assert.ok(sentences.length <= 3, `${concept} runs to ${sentences.length} sentences`);
    assert.ok(lesson.text.length < 420, `${concept} is ${lesson.text.length} characters`);
  }
});

test('a lesson says what just happened before explaining it', () => {
  // Context first: "I just made a branch" is what makes the explanation land, rather
  // than arriving as a paragraph of theory from nowhere.
  const rendered = renderLesson(lessonFor('branch', [])!);

  assert.match(rendered, /^I just made a branch\./);
  assert.match(rendered, /separate copy/);
});

test('lessons explain the reassurance, not just the mechanism', () => {
  // A beginner's real question is "is my work safe", and a definition does not answer
  // it. Each of these names the consequence for them.
  assert.match(lessonFor('discard', [])!.text, /perfectly safe|gone/);
  assert.match(lessonFor('conflict', [])!.text, /Nothing is broken/);
  assert.match(lessonFor('uncommitted', [])!.text, /cannot get (it )?back/);
});

test('no lesson uses the jargon the plain-language layer avoids', () => {
  // Teaching the concept is not a licence to teach the vocabulary that hides it.
  const everything = allConcepts().map((c) => lessonFor(c, [])!.text).join(' ');

  for (const jargon of ['HEAD', 'index', 'working tree', 'unstaged', 'rebase', 'stash']) {
    assert.doesNotMatch(everything, new RegExp(`\\b${jargon}\\b`), `leaked: ${jargon}`);
  }
});
