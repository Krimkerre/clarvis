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
    'Four ideas. Every one of them funny, and every one of them a real project they',
    'could spend a fortnight on and end up with something that works.',
    '',
    // **The joke is the premise, not the name.** Live, this produced "Commit
    // Roulette", "Git Blame Yourself", "Bookmark Mortality" — four puns pinned to
    // ordinary tools, in one domain, every session. A pun is the cheapest thing a
    // model reaches for and the first thing to get boring.
    'The joke is what the thing DOES, taken completely seriously. Not a pun in the',
    'name — a premise that is funny on its own and then built properly, as though',
    'nobody noticed. "A budgeting app that phones your mother when you order takeaway',
    'twice in a week" is the shape. "GitFlow Roulette" is not: that is a pun wearing',
    'an ordinary tool.',
    '',
    // Enough substance to survive the interview that follows — which is the actual
    // bar here, and the one "small and buildable" was quietly working against.
    'Each needs enough substance to plan: real behaviour, rules that could go either',
    'way, decisions worth arguing about. It should be possible to ask them five',
    'questions about it and get five interesting answers. A one-function toy is not.',
    '',
    // Left to itself the model writes four developer tools about its own workflow.
    'Vary what they are about. Not four developer tools — a person has a kitchen, a',
    'commute, relatives, a houseplant, money, a hobby they are bad at. At most one of',
    'the four may be about programming at all.',
    'Avoid, because they are what everyone reaches for first: commit messages, git',
    'history, bookmarks, inboxes, standups, todo lists, habit trackers.',
    '',
    'Output exactly 4 lines, nothing else, in this format:',
    'Name | one sentence on what it actually does, said straight',
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
