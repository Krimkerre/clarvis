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
  git?: { branch: string; dirtyCount: number };
  /** Repeat errors seen at least twice (M5). */
  patterns: Pattern[];
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

  const { branch, dirtyCount } = facts.git;
  if (dirtyCount === 0) {
    return { text: `\`${branch}\`, clean.`, state: 'neutral' };
  }

  return {
    text: `\`${branch}\`, with ${dirtyCount} uncommitted ${plural(dirtyCount, 'change', 'changes')}.`,
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
