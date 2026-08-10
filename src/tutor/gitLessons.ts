/**
 * Teaching git, one concept at a time, at the moment it first matters.
 *
 * §4.10's rule: lessons are triggered by what actually happens, not by a syllabus. A
 * beginner does not need to know what a branch is until Clarvis makes one — and at
 * that moment they need it badly, because something just changed that they cannot see.
 *
 * Each lesson is **three sentences at most**: what it is, why it happened here, what it
 * means for them. Longer and it becomes a tutorial nobody reads; shorter and it is a
 * definition rather than an explanation.
 *
 * Pure and `vscode`-free, because the *words* are the feature.
 */
export type GitConcept =
  | 'branch'
  | 'commit'
  | 'switch'
  | 'merge'
  | 'discard'
  | 'conflict'
  | 'uncommitted'
  | 'remote'
  | 'flow';

export interface GitLesson {
  concept: GitConcept;
  /** Prefixed to the lesson, naming what just happened. */
  because: string;
  text: string;
}

const LESSONS: Record<GitConcept, GitLesson> = {
  branch: {
    concept: 'branch',
    because: 'I just made a branch.',
    text:
      "A branch is a separate copy of the project's history — work done on one doesn't touch the others. " +
      'I do every task on my own branch so that if the result is wrong, you throw the branch away and nothing of yours was ever changed. ' +
      "That's the whole safety net: it isn't that I'm careful, it's that my work starts somewhere you can discard.",
  },
  commit: {
    concept: 'commit',
    because: 'I just committed.',
    text:
      'A commit is a save point: a snapshot of the files as they are, with a note about why. ' +
      "Files you've edited but not committed exist only as they are right now — no history, nothing to go back to. " +
      'Committing often is the difference between "undo that change" and "retype the last hour".',
  },
  switch: {
    concept: 'switch',
    because: 'You just switched branch.',
    text:
      'Switching swaps the files in your editor for the versions on the other branch — the same folder, different contents. ' +
      "Anything you've changed but not committed isn't attached to a branch yet, so it comes along with you. " +
      "That's why I ask before moving when you have unsaved work: it can look like the changes followed you by mistake.",
  },
  merge: {
    concept: 'merge',
    because: 'You just merged.',
    text:
      'Merging copies the work from one branch onto another, so what was separate becomes part of the main history. ' +
      "Once merged, the branch has served its purpose — it's kept only so you can look back at it. " +
      'If both branches changed the same lines, git stops and asks you to choose; that\'s a conflict, and it is normal rather than a disaster.',
  },
  discard: {
    concept: 'discard',
    because: 'You just deleted a branch.',
    text:
      'Deleting a branch removes that line of history, so anything committed only there is gone — which is why I say so first. ' +
      'Anything merged elsewhere beforehand is perfectly safe, because it exists in the place you merged it to. ' +
      'Deleting finished branches is normal housekeeping rather than destruction.',
  },
  conflict: {
    concept: 'conflict',
    because: 'That merge hit a conflict.',
    text:
      'A conflict means both sides changed the same lines, and git refuses to guess which you meant. ' +
      'Nothing is broken and nothing is lost — the file now shows both versions, marked, and you pick. ' +
      'The Source Control view lists every file waiting on you.',
  },
  uncommitted: {
    concept: 'uncommitted',
    because: "You've got uncommitted changes.",
    text:
      "Uncommitted means edited but not yet saved into the project's history. " +
      "They live in the folder rather than on a branch, which is why they follow you when you switch. " +
      'They are also the only thing here I genuinely cannot get back for you, so they are worth committing before anything drastic.',
  },
  remote: {
    concept: 'remote',
    because: 'This project has a shared copy.',
    text:
      'A remote is the copy everyone shares — usually on GitHub — and your commits stay on this machine until you push them there. ' +
      'Nothing you do locally affects anyone else until that push, which makes local work a safe place to experiment. ' +
      'Pulling is the reverse: bringing in what others have done.',
  },
  flow: {
    concept: 'flow',
    because: "I've written the branch flow into plan.md.",
    text:
      'Most projects move work through named branches in a set order — build it somewhere, test it somewhere, release from somewhere. ' +
      'Writing that down means I offer your branches when a task finishes, instead of guessing at common names. ' +
      "It's a list in plan.md and you can edit it by hand at any time.",
  },
};

/**
 * The lesson for a concept, if it hasn't been taught yet.
 *
 * `taught` is the set already covered. Returning undefined for a repeat is the whole
 * mechanism: a tutor who explains branches every time you make one has stopped
 * teaching and started nagging, and §4.10 is explicit that the mode is meant to be
 * outgrown.
 */
export function lessonFor(concept: GitConcept, taught: string[]): GitLesson | undefined {
  return taught.includes(concept) ? undefined : LESSONS[concept];
}

/** Rendered for the transcript: what happened, then what it means. */
export function renderLesson(lesson: GitLesson): string {
  return `${lesson.because} ${lesson.text}`;
}

/** Every concept, for tests and for a "what have I learned" summary later. */
export function allConcepts(): GitConcept[] {
  return Object.keys(LESSONS) as GitConcept[];
}
