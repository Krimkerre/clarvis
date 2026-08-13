import test from 'node:test';
import assert from 'node:assert/strict';
import { ideaPrompt, parseIdeaResult } from './ideaPrompt';

test('the prompt asks for buildable ideas and requires humor in at least two', () => {
  const prompt = ideaPrompt();
  assert.match(prompt, /genuinely buildable/i);
  assert.match(prompt, /funny/i);
  assert.match(prompt, /Name \| one-sentence description/);
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
