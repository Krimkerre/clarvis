import test from 'node:test';
import assert from 'node:assert/strict';
import { ideaPrompt, parseIdeaResult } from './ideaPrompt';

test('the joke has to be the premise, not the name', () => {
  // Live, this produced Commit Roulette, Git Blame Yourself and Bookmark Mortality —
  // four puns pinned to ordinary tools. A pun is the cheapest thing a model reaches
  // for and the first thing to get boring.
  const prompt = ideaPrompt();
  assert.match(prompt, /The joke is what the thing DOES/);
  assert.match(prompt, /Not a pun in the\s*name/);
});

test('each idea has to survive an interview', () => {
  // "Small and buildable" was quietly pulling everything toward one-function toys,
  // which is the opposite of what a planning interview needs.
  const prompt = ideaPrompt();
  assert.match(prompt, /enough substance to plan/);
  assert.match(prompt, /five\s*questions about it and get five interesting answers/);
});

test('the domains have to vary, and the usual suspects are banned', () => {
  // Left alone the model writes four developer tools about its own workflow.
  const prompt = ideaPrompt();
  assert.match(prompt, /Not four developer tools/);
  assert.match(prompt, /At most one of\s*the four may be about programming/);
  assert.match(prompt, /commit messages, git\s*history, bookmarks, inboxes/);
});

test('the output format is still one parseable line per idea', () => {
  assert.match(ideaPrompt(), /Name \| one sentence on what it actually does/);
});

test('parses four well-formed ideas', () => {
  const text = [
    'Doomscroll Detox | tracks how long you stared before you noticed',
    'Plant Whisperer | texts you as your houseplant, guilt-tripping you into watering it',
    'Habit Tracker | logs daily habits and streaks',
    'Recipe Box | saves and organizes recipes',
  ].join('\n');
  const ideas = parseIdeaResult(text);
  assert.equal(ideas.length, 4);
  assert.equal(ideas[0].name, 'Doomscroll Detox');
  assert.equal(ideas[1].description, 'texts you as your houseplant, guilt-tripping you into watering it');
});

test('drops a malformed line instead of throwing', () => {
  const ideas = parseIdeaResult('just some prose with no pipe');
  assert.equal(ideas.length, 0);
});
