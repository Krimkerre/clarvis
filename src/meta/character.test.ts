import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nobody gets to describe the character a sixth time.
 *
 * The talking-fridge regression was not a bad prompt — it was *five* prompts. Chat said
 * "dry, concise and faintly exasperated", the agent said "be terse and dry", the
 * briefing said "dry, brief, never cheerful", and each was written in isolation by
 * someone (me) filling in a `system:` field while thinking about something else. Every
 * one of them was a reasonable sentence. Together they were a character with no voice,
 * because an adjective is not a voice and five different adjectives are not a character.
 *
 * So the rule is mechanical rather than remembered: a `system:` prompt either comes from
 * `character()`, or it is one of the few listed here that deliberately does not speak as
 * him. Adding a surface that invents its own description now fails the suite.
 */

/** Prompts that legitimately carry no character, and why. */
const NOT_IN_CHARACTER = [
  // A one-word classifier. Nothing it emits is ever shown to anyone.
  'You answer with exactly one word.',
  // Wrappers: the character arrives in the user message, built by character() there.
  'You rewrite one line in character. Nothing else.',
  'You write one short, dry remark. Nothing else.',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * The sources, not the build.
 *
 * Tests run from `out/`, where every file is `.js` — pointed there this scan finds
 * nothing, passes, and guards nothing at all. Verified by breaking it on purpose.
 */
const SRC = join(__dirname, '..', '..', 'src');

test('every system prompt speaks as Clarvis, or is on the list of ones that do not', () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 20, `scanned only ${files.length} sources — wrong directory`);

  const offenders: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');

    for (const [index, line] of source.split('\n').entries()) {
      // `system:` as a field being *assigned*, not the interface declaring it or a
      // provider forwarding one it was handed.
      if (!/\bsystem:\s*\S/.test(line)) continue;
      if (/system:\s*(string|request\.system)/.test(line)) continue;

      const built = /character(With)?\(|systemPrompt\(/.test(line);
      const allowed = NOT_IN_CHARACTER.some((prompt) => line.includes(prompt));

      if (!built && !allowed) offenders.push(`${file}:${index + 1} — ${line.trim()}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These prompts describe the character instead of using character():\n${offenders.join('\n')}`
  );
});
