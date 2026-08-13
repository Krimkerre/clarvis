/**
 * Whether the seed already names the project, and if not, what it could be called.
 *
 * Same split as the rest of M9: prompt and parser are pure and testable without a
 * model; `Interview.ts` is the thin `vscode` glue that shows the result.
 */

export interface NameSuggestion {
  name: string;
  reason: string;
}

export type NameResult = { named: string } | { suggestions: NameSuggestion[] } | { suggestions: [] };

/** The instruction for one detect-or-suggest round. */
export function namePrompt(seed: string): string {
  return [
    'Here is a one-sentence description of a project:',
    '',
    seed,
    '',
    'Does it already give the project an actual name — a proper name for the thing',
    'itself, not just a description of what it does?',
    '',
    'If yes, output exactly one line: NAMED: <the name>',
    'If no, suggest 5 short candidate names that fit what is described, one per line,',
    'in exactly this format: Name | one clause on why it fits',
    'Two of the five should carry your own dry sense of humour — a name that is',
    'genuinely funny about what this project is, not just a pun on the topic. The',
    'other three are straightforward good fits, no joke required.',
    'Output nothing else — no intro, no numbering, no markdown.',
  ].join('\n');
}

/** Parses the model's `NAMED: ...` line or its `Name | reason` shortlist. */
export function parseNameResult(text: string): NameResult {
  const trimmed = text.trim();
  const namedMatch = /^NAMED:\s*(.+)$/im.exec(trimmed);
  if (namedMatch) return { named: namedMatch[1].trim() };

  const suggestions = trimmed
    .split('\n')
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts.every(Boolean))
    .map(([name, reason]) => ({ name, reason }));

  return { suggestions };
}
