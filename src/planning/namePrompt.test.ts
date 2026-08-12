import test from 'node:test';
import assert from 'node:assert/strict';
import { namePrompt, parseNameResult } from './namePrompt';

test('the prompt includes the seed verbatim', () => {
  assert.match(namePrompt('a CLI that renames photos by EXIF date'), /a CLI that renames photos by EXIF date/);
});

test('the prompt asks for the NAMED: shape and the shortlist shape', () => {
  const prompt = namePrompt('LoreGen, a lore generator');
  assert.match(prompt, /NAMED:/);
  assert.match(prompt, /Name \| one clause/);
});

test('parses an already-named response', () => {
  const result = parseNameResult('NAMED: LoreGen');
  assert.deepEqual(result, { named: 'LoreGen' });
});

test('parses a shortlist of suggestions', () => {
  const text = ['Snapshot | short and describes what it does', 'Datestamp | plain, says exactly what it does', 'Chrono | evokes time without being literal'].join(
    '\n'
  );
  const result = parseNameResult(text);
  assert.deepEqual(result, {
    suggestions: [
      { name: 'Snapshot', reason: 'short and describes what it does' },
      { name: 'Datestamp', reason: 'plain, says exactly what it does' },
      { name: 'Chrono', reason: 'evokes time without being literal' },
    ],
  });
});

test('drops a malformed suggestion line instead of throwing', () => {
  const result = parseNameResult('just some prose with no pipe in it');
  assert.deepEqual(result, { suggestions: [] });
});
