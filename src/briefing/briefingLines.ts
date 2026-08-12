import type { FailureRecord } from './lastFailure';

/** Everything the briefing can draw on. Any part may be missing. */
export interface BriefingFacts {
  /** Absent when there's no Git extension, or the folder isn't a repository. */
  git?: { branch: string; dirtyCount: number; untrackedCount?: number };
  failure?: FailureRecord;
  recentFiles: string[];
  /** M5 fills this in; until then the briefing is simply shorter. */
  patternHint?: string;
}

/**
 * Picks one phrasing out of several.
 *
 * Injected rather than calling `Math.random()` inline so the wording is testable —
 * and so a test can assert *every* variant reads correctly, instead of whichever one
 * chance happened to produce.
 */
export type Choose = (count: number) => number;

const randomChoice: Choose = (count) => Math.floor(Math.random() * count);

/** `src/watch/BusyTracker.ts` → `BusyTracker.ts`. Paths are noise in one line of prose. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * The opener, which is what makes this sound like a person rather than a status bar.
 *
 * Chosen against the *mood of the facts*, not at random across all of them: greeting
 * someone cheerfully over a red build is the specific failure that makes a character
 * feel like a template. Each set is written for the situation it belongs to.
 */
function openerLine(facts: BriefingFacts, choose: Choose): string {
  if (facts.failure) {
    return pick(
      [
        'You’re back. It didn’t fix itself, if you were wondering.',
        'Ah, you’ve returned. Nothing has improved in your absence.',
        'Welcome back. I kept everything exactly as broken as you left it.',
      ],
      choose
    );
  }

  if (facts.git && facts.git.dirtyCount > 8) {
    return pick(
      [
        'You’re back. So is the pile of uncommitted work.',
        'Morning. Or whatever this is. There’s rather a lot outstanding.',
        'Welcome back to whatever this was going to be.',
      ],
      choose
    );
  }

  return pick(
    [
      'You’re back. Everything is roughly where you left it.',
      'Welcome back. Nothing exploded, which I consider a personal achievement.',
      'There you are. All quiet, disappointingly.',
    ],
    choose
  );
}

function gitLine(git: NonNullable<BriefingFacts['git']>, choose: Choose): string {
  // New files git has never seen are worth a mention, but they are not "uncommitted
  // changes" — saying so about a stray scratch file made him sound wrong about a
  // repository the user knows better than he does.
  const newFiles = git.untrackedCount
    ? ` ${git.untrackedCount} new ${git.untrackedCount === 1 ? 'file' : 'files'} git has not been told about.`
    : '';

  if (git.dirtyCount === 0) {
    return pick(
      [
        `You’re on ${git.branch}, and the tree is clean.${newFiles}`,
        `${git.branch}, nothing uncommitted. Suspiciously tidy.${newFiles}`,
        `Branch ${git.branch} — clean, for now.${newFiles}`,
      ],
      choose
    );
  }

  const files = git.dirtyCount === 1 ? 'file' : 'files';
  return pick(
    [
      `You’re on ${git.branch} with ${git.dirtyCount} ${files} uncommitted.${newFiles}`,
      `${git.branch}, ${git.dirtyCount} ${files} still unsaved to history.${newFiles}`,
      `${git.branch} — ${git.dirtyCount} ${files} dirty, in case that matters to you.${newFiles}`,
    ],
    choose
  );
}

function failureLine(failure: FailureRecord, choose: Choose): string {
  // No exit code means it was cancelled or a debug session — "was failing" would be a lie.
  if (failure.exitCode === undefined) {
    return pick(
      [
        `${failure.label} was still running when you left. I stopped watching eventually.`,
        `${failure.label} never finished. We’ll never know how that ended.`,
        `${failure.label} was mid-thought when the window closed.`,
      ],
      choose
    );
  }

  return pick(
    [
      `${failure.label} was red when you fled.`,
      `${failure.label} failed, and then you left. I noticed the order of those.`,
      `${failure.label} is still failing. It has had plenty of time to reconsider.`,
    ],
    choose
  );
}

function filesLine(files: string[], choose: Choose): string {
  const names = files.slice(0, 3).map(basename);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  return pick(
    [`You were last in ${list}.`, `Last seen editing ${list}.`, `${list}, most recently.`], choose);
}

function pick(options: string[], choose: Choose): string {
  return options[Math.min(Math.max(choose(options.length), 0), options.length - 1)];
}

/**
 * How many lines survive, per §4.3.
 *
 * The opener costs one of them. That's the trade: a briefing that sounds like a person
 * and says three things beats one that sounds like a log and says four.
 */
const MAX_LINES = 4;

/**
 * Composes the briefing, skipping anything it has no facts for.
 *
 * Every line has to earn its place: a missing part is omitted rather than padded with
 * "no failures recorded", which is noise pretending to be information.
 *
 * When there are more facts than room, the least useful line is dropped rather than
 * the last one — what you were editing is pleasant context, but a red build and a
 * recurring error are the reasons this feature exists.
 *
 * Returns an empty array when there's nothing worth saying — a fresh window on a
 * non-repo folder with no history should produce silence, not a greeting. An opener
 * on its own is a chatbot saying hello, which is exactly what §4.3 rules out.
 */
export function buildBriefingLines(facts: BriefingFacts, choose: Choose = randomChoice): string[] {
  // Reading order, each with how much it deserves to survive the cap.
  const body = [
    { text: facts.failure ? failureLine(facts.failure, choose) : undefined, priority: 1 },
    { text: facts.patternHint, priority: 2 },
    { text: facts.git ? gitLine(facts.git, choose) : undefined, priority: 3 },
    { text: facts.recentFiles.length > 0 ? filesLine(facts.recentFiles, choose) : undefined, priority: 4 },
  ].filter((line): line is { text: string; priority: number } => line.text !== undefined);

  if (body.length === 0) return [];

  const kept = [...body]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_LINES - 1)
    .map((line) => line.text);

  // Back into reading order — sorting by priority above was only about what survives.
  return [openerLine(facts, choose), ...body.filter((line) => kept.includes(line.text)).map((l) => l.text)];
}

/**
 * The same facts, handed to a model to phrase.
 *
 * Identical reasoning to the chat path: this module knows what happened and says it in
 * a fixed set of shapes, while a model says things well and knows nothing about the
 * project. The canned lines remain the fallback for no key, no network, and a slow
 * response — a briefing that arrives late is worse than a plain one that arrives on
 * time.
 *
 * The instructions repeat §4.3's rules rather than trusting the model to infer them:
 * four lines, no greeting for its own sake, and nothing invented.
 */
export function briefingPrompt(facts: BriefingFacts): string | undefined {
  const observed: string[] = [];

  if (facts.git) {
    observed.push(
      `Branch ${facts.git.branch}, ${facts.git.dirtyCount === 0 ? 'working tree clean' : `${facts.git.dirtyCount} file(s) uncommitted`}`
    );
  }

  if (facts.failure) {
    observed.push(
      facts.failure.exitCode === undefined
        ? `"${facts.failure.label}" was still running when the window closed`
        : `"${facts.failure.label}" failed with exit ${facts.failure.exitCode} and has not been fixed`
    );
  }

  if (facts.recentFiles.length > 0) {
    observed.push(`Last edited: ${facts.recentFiles.slice(0, 3).map(basename).join(', ')}`);
  }

  if (facts.patternHint) observed.push(facts.patternHint);

  // Nothing worth reporting means silence, exactly as the canned path decides — a
  // model asked to brief on an empty list will always find something to say.
  if (observed.length === 0) return undefined;

  return [
    'Brief the user on where they left off. This is the first thing they hear on opening the editor.',
    'Rules: at most four short sentences. Open in character, matched to the mood of the facts —',
    'never cheerful about a failure. State only what is listed below; invent nothing.',
    'No greeting for its own sake, no offers of help, no questions.',
    '',
    'What you observed:',
    ...observed.map((line) => `- ${line}`),
  ].join('\n');
}
