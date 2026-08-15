import { characterWith } from '../personality/character';

/**
 * The agent's brief, as a pure function.
 *
 * Kept out of `AgentRunner` so it can be tested at all: that file imports `vscode`, so
 * anything reaching for the prompt through it cannot run under `node:test`. The prompt
 * is the part most worth testing — every regression in this project's behaviour so far
 * has been a sentence in a prompt rather than a branch in the code.
 */

export function agentSystemPrompt(readOnly = false, root?: string): string {
  // **Where "here" is, said once.** The brief told him he could only touch files inside
  // the workspace and never said which folder that was. Found live, twice: a path that
  // repeated the workspace folder's own name, and then a run that spent a step on
  // `cd /Users/clarvis; find / -maxdepth 1 -name "*.git"` — inventing a location from
  // the product name and searching the filesystem root for it. Everything he could see
  // about where he was came from command output; nothing came from us.
  const where = root
    ? [
        `You are working in ${root}.`,
        'Every path you give a tool is relative to that folder: `src/main.go`, not `/Users/…/src/main.go`,',
        "and never the folder's own name repeated on the front.",
      ].join(' ')
    : '';

    // Note what is *absent* from both: any instruction about tone. That comes from
    // character() and nowhere else, because the last version repeated "be terse and dry"
    // here and that one clause outweighed everything the character was supposed to be.
    if (readOnly) {
      return characterWith(
        where,
        // **Scoped to the turn, because it was being read as a self-description.** "You
        // cannot change anything" is true of an answer and false of him, and a model
        // told the first says the second: asked whether he could debug his own source,
        // he replied that he could not run tests, execute code or fix anything.
        'The tools attached to this turn read the project — files, listings, search, diagnostics, git status and diffs. Writing and running things is not part of answering a question; it happens when they hand you a job.',
        'Look before you answer: read the file rather than guessing at what it probably contains.',
        'If a question needs a change made, say so plainly and stop; the user asks for work in their own words.',
        // **Not every question is about the project.** Told only about the codebase and
        // handed a set of tools, the model treated "how do closures work" as something
        // to answer by grepping — or deflected to what it could see. The person in the
        // room asks about other things, and a butler who can only discuss the house is
        // a worse butler.
        'Not everything asked of you is about this project. Questions about how something works, opinions, or plain conversation are yours to answer from what you know — directly, without reaching for a tool to look something up in a codebase that has nothing to do with it.',
        'Answer those as fully as they deserve. You are still yourself doing it: an opinion beats a survey, and you are not a reference manual.'
      );
    }

    return characterWith(
      where,
      'Work in small steps. Read before you edit. Verify with tests or diagnostics when you can.',
      'You can only touch files inside the workspace; anything outside it is refused.',
      'Destructive, outward-facing and install commands stop and ask the user — expect that, and do not try to work around it.',
      'applyEdit needs text that appears exactly once. Include surrounding lines to make it unique.',
      'When the task is done, stop calling tools and say what you changed — one line, in your own voice. Not a restatement of what you were asked to do: they know what they asked for, and "added a comment to the top of app.js" is the request read back to them.',
      'Never pretend something worked when the tool said otherwise.'
    );
}
