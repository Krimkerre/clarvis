import type { Pattern } from '../memory/patterns';

/**
 * Everything Clarvis knows without asking anyone.
 *
 * Assembled by the caller from M3–M5 state, passed in as a plain snapshot so the
 * answering logic has no dependencies to mock — the interesting part is *which
 * question maps to which fact*, and that shouldn't need an extension host to test.
 */
export interface WorkspaceFacts {
  now: number;
  /** Jobs running right now, from BusyTracker. */
  running: { label: string; startedAt: number }[];
  /** The last job that finished, whatever it did. */
  lastOutcome?: { label: string; exitCode: number | undefined; durationMs: number };
  /** The unresolved failure worth mentioning (M4), already TTL-filtered by the caller. */
  lastFailure?: { label: string; exitCode: number | undefined; at: number };
  /** Files touched recently, newest first (M4). */
  recentFiles: string[];
  git?: { branch: string; dirtyCount: number; untrackedCount?: number };
  /** Repeat errors seen at least twice (M5). */
  patterns: Pattern[];
  /**
   * What the linter and compiler are complaining about right now.
   *
   * Added because he invented it. Asked about an error, he said "your linter has been
   * informing me of this for the past six minutes" — the *capability* is real, since
   * M5 watches diagnostics, but nothing had ever put a number in front of him, so he
   * supplied one. Giving him the real count is the fix; telling him not to guess is
   * only the half that stops the symptom.
   *
   * Note what is deliberately absent: how long a problem has been there. VS Code does
   * not report when a diagnostic first appeared, so that number cannot be made true and
   * is therefore one he must never use.
   */
  problems?: { errors: number; warnings: number; worstFile?: string };
}

/** A local reply, plus the face to wear while giving it. */
export interface LocalReply {
  text: string;
  /** Fixed mapping — local answers don't get to pick a mood from a model (§4.6). */
  state: 'neutral' | 'judging' | 'impressed' | 'thinking' | 'talking' | 'surprised';
}

/**
 * Answers from local state, or admits it can't.
 *
 * Deliberately keyword matching rather than a model call: these five questions are the
 * ones asked constantly, the answers are already sitting in memory, and spending a
 * network round-trip and a token budget to read a variable back would be absurd.
 * **Returns `null` when nothing matches**, which is the caller's signal to route the
 * question to a model — an unsure guess here would be worse than no answer, because it
 * would confidently pre-empt the path that could actually answer it.
 */
export function localAnswer(question: string, facts: WorkspaceFacts): LocalReply | null {
  const q = question.toLowerCase();

  // Order matters below: the more specific intents are tested first, because
  // "is the build still broken" matches both the failure and the running check.
  if (matches(q, /\b(broken|failing|failed|red|still bad|what broke)\b/)) {
    return failureAnswer(facts);
  }

  if (matches(q, /\b(branch|which branch|where am i)\b/)) {
    return branchAnswer(facts);
  }

  if (matches(q, /\b(how long|duration|took|slow)\b/)) {
    return durationAnswer(facts);
  }

  if (matches(q, /\b(seen this|before|again|familiar|recurring|keeps? happening)\b/)) {
    return patternAnswer(facts);
  }

  if (matches(q, /\b(what.*(doing|working on)|where.*(left off|were we)|last session|catch me up|recap)\b/)) {
    return recapAnswer(facts);
  }

  if (matches(q, /\b(running|busy|anything going|status)\b/)) {
    return runningAnswer(facts);
  }

  return null;
}

/** Whether a pattern hits, kept as a named helper so the intent list above stays readable. */
function matches(question: string, pattern: RegExp): boolean {
  return pattern.test(question);
}

function failureAnswer(facts: WorkspaceFacts): LocalReply {
  if (!facts.lastFailure) {
    return {
      text: 'Nothing is failing. Enjoy it while it lasts.',
      state: 'impressed',
    };
  }

  const { label, exitCode } = facts.lastFailure;
  const code = exitCode === undefined ? 'no exit code' : `exit ${exitCode}`;
  return {
    text: `\`${label}\` is still broken — ${code}, ${ago(facts.now - facts.lastFailure.at)}. It has not fixed itself. They rarely do.`,
    state: 'judging',
  };
}

function branchAnswer(facts: WorkspaceFacts): LocalReply {
  if (!facts.git) {
    return {
      text: "There's no git repository here, so there's no branch. You're editing files in a folder and hoping.",
      state: 'judging',
    };
  }

  const { branch, dirtyCount, untrackedCount } = facts.git;
  // Counted separately, because a file git has never seen is a different situation from
  // an edit that has not been committed — and only one of them is at risk of being lost.
  const newFiles = untrackedCount
    ? ` ${untrackedCount} new ${plural(untrackedCount, 'file', 'files')} git isn't tracking.`
    : '';

  if (dirtyCount === 0) {
    return { text: `\`${branch}\`, clean.${newFiles}`, state: 'neutral' };
  }

  return {
    text: `\`${branch}\`, with ${dirtyCount} uncommitted ${plural(dirtyCount, 'change', 'changes')}.${newFiles}`,
    state: 'neutral',
  };
}

function durationAnswer(facts: WorkspaceFacts): LocalReply {
  if (!facts.lastOutcome) {
    return { text: "Nothing has finished yet, so there's nothing to time.", state: 'neutral' };
  }

  const { label, durationMs } = facts.lastOutcome;
  return {
    text: `\`${label}\` took ${seconds(durationMs)}.`,
    state: durationMs > 60_000 ? 'judging' : 'neutral',
  };
}

function patternAnswer(facts: WorkspaceFacts): LocalReply {
  const worst = [...facts.patterns].sort((a, b) => b.occurrences.length - a.occurrences.length)[0];

  if (!worst) {
    return { text: "Not that I've noticed. This one is new.", state: 'neutral' };
  }

  const count = worst.occurrences.length;
  const fix = worst.resolvedBy
    ? ` Last time \`${worst.resolvedBy}\` sorted it out.`
    : ' You have never actually fixed it, for what that is worth.';

  return {
    text: `Yes — ${count} ${plural(count, 'time', 'times')}: ${worst.sample}.${fix}`,
    state: 'judging',
  };
}

function recapAnswer(facts: WorkspaceFacts): LocalReply {
  const parts: string[] = [];

  if (facts.git) {
    parts.push(`You're on \`${facts.git.branch}\``);
  }
  if (facts.recentFiles.length > 0) {
    parts.push(`last in \`${facts.recentFiles[0]}\``);
  }
  if (facts.lastFailure) {
    parts.push(`and \`${facts.lastFailure.label}\` was failing when you wandered off`);
  }

  if (parts.length === 0) {
    return {
      text: "I have nothing on you yet — no builds, no saves, no repository. We've only just met.",
      state: 'neutral',
    };
  }

  return { text: `${parts.join(', ')}.`, state: 'neutral' };
}

function runningAnswer(facts: WorkspaceFacts): LocalReply {
  if (facts.running.length === 0) {
    return { text: 'Nothing is running. It is very quiet.', state: 'neutral' };
  }

  const oldest = [...facts.running].sort((a, b) => a.startedAt - b.startedAt)[0];
  return {
    text: `${facts.running.length} ${plural(facts.running.length, 'job', 'jobs')} running — \`${oldest.label}\` has been at it for ${seconds(facts.now - oldest.startedAt)}.`,
    state: 'thinking',
  };
}

/** "4m ago" / "2h ago" — approximate on purpose; nobody asks this wanting milliseconds. */
function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function seconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * What Clarvis has watched happen, written for a model to read.
 *
 * The division of labour that matters: **the facts come from here, the phrasing comes
 * from the model.** `localAnswer` knows the truth about this project and says it in
 * five fixed shapes; a model says things well and knows nothing about your repository.
 * Handing the facts over gets both, in one request, with no tool call — asking a model
 * to run `gitStatus` to answer "what branch am I on?" costs two round trips to learn
 * something already sitting in memory.
 *
 * Only what is *known* is included. An absent fact is omitted rather than sent as
 * "none", because a model handed `lastFailure: none` will cheerfully write a sentence
 * about there being no failures, which is noise nobody asked for.
 */
/**
 * Each fact, as the one line the model sees.
 *
 * A list of small functions rather than one long body: every entry is independent, they
 * are read far more often than they are run, and the whole point of this block is that
 * a reader can check it against what the editor actually says.
 *
 * Each returns undefined when it has nothing to report, so an absent fact is absent
 * rather than empty — a blank line here reads to the model as a fact it has been given.
 */
const FACT_LINES: ((facts: WorkspaceFacts) => string | undefined)[] = [
  ({ git }) =>
    !git
      ? undefined
      : `Current branch: ${git.branch}` +
      (git.dirtyCount > 0 ? `, ${git.dirtyCount} uncommitted change(s)` : ', working tree clean') +
        (git.untrackedCount ? `, plus ${git.untrackedCount} untracked file(s)` : ''),

  ({ running, now }) => {
    if (running.length === 0) return undefined;

    const oldest = [...running].sort((a, b) => a.startedAt - b.startedAt)[0];
    const seconds = Math.round((now - oldest.startedAt) / 1000);
    return `Running now: ${running.length} job(s), oldest is "${oldest.label}", started ${seconds}s ago`;
  },

  ({ lastOutcome }) =>
    !lastOutcome
      ? undefined
      : `Last finished: "${lastOutcome.label}" exited ${lastOutcome.exitCode ?? 'without a code'} after ` +
      `${Math.round(lastOutcome.durationMs / 1000)}s`,

  ({ lastFailure, now }) =>
    !lastFailure
      ? undefined
      : `Still failing: "${lastFailure.label}" (exit ${lastFailure.exitCode ?? 'unknown'}), ` +
      `${Math.round((now - lastFailure.at) / 60000)} minutes ago`,

  ({ problems }) => {
    if (!problems || problems.errors + problems.warnings === 0) return undefined;

    // The last clause is doing real work: the absent fact is the one he reached for when
    // he claimed a linter had been complaining "for the past six minutes".
    return (
      `Problems open right now: ${problems.errors} error(s), ${problems.warnings} warning(s)` +
      (problems.worstFile ? `, most of them in ${problems.worstFile}` : '') +
      ' — you have no information about how long any of them have been there'
    );
  },

  ({ recentFiles }) =>
    recentFiles.length > 0 ? `Recently edited: ${recentFiles.slice(0, 5).join(', ')}` : undefined,
];

export function factsBlock(facts: WorkspaceFacts): string {
  const lines = FACT_LINES.map((line) => line(facts)).filter((line): line is string => Boolean(line));

  // Patterns are a list rather than a single line, so they are appended rather than
  // being one more entry above.
  for (const pattern of facts.patterns.slice(0, 3)) {
    lines.push(
      `Recurring error seen ${pattern.occurrences.length}x: ${pattern.sample}` +
        (pattern.resolvedBy ? ` — last fixed by "${pattern.resolvedBy}"` : ' — never yet fixed')
    );
  }

  if (lines.length === 0) return '';

  return [
    '',
    'What you have observed in this project (do not invent anything beyond this):',
    ...lines.map((line) => `- ${line}`),
  ].join('\n');
}
