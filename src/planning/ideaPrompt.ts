/**
 * A few project ideas, for the seed question's "I don't know" answer.
 *
 * Same split as the rest of M9: prompt and parser are pure and testable without a
 * model; `Interview.ts` is the thin `vscode` glue that shows the result. Unlike the
 * name shortlist, this one leans into the joke — the ask is specifically for a few
 * of Clarvis's own funny ideas, not a neutral list of buildable projects.
 */

export interface AppIdea {
  name: string;
  description: string;
}

/** The instruction for one round of ideas. */
export function ideaPrompt(): string {
  return [
    "They don't know what to build yet and asked you to suggest something.",
    '',
    'Suggest 4 small, genuinely buildable project ideas — a solo developer could',
    'realistically finish one of these. At least 2 of the 4 should be funny: an',
    'absurd premise, executed completely straight, in your own dry register — not a',
    'jokey name pinned to an ordinary idea. The rest can be straightforward.',
    '',
    'Output exactly 4 lines, nothing else, in this format:',
    'Name | one-sentence description of what it actually does',
    'No markdown, no numbering, no intro or closing line.',
  ].join('\n');
}

/** Parses the model's `Name | description` lines. Malformed lines are dropped. */
export function parseIdeaResult(text: string): AppIdea[] {
  return text
    .trim()
    .split('\n')
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts.every(Boolean))
    .map(([name, description]) => ({ name, description }));
}
