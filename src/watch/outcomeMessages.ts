import { Outcome } from './BusyTracker';

/**
 * "125s" is meaningless at a glance; "2m 5s" isn't. Renders the duration that gets
 * tacked onto every outcome message.
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Hardcoded line pools — M6 replaces these wholesale with the real quip bank (§5),
 * which adds weighted selection, no-repeat-within-session tracking, and earned-sass
 * gating. Deliberately minimal until then.
 */
const SUCCESS_LINES = [
  'Finished. Green. I amused myself in your absence.',
  "Done, and clean. I'll allow it.",
];
const FAILURE_LINES = [
  "Finished. Red, I'm afraid.",
  'Done. Not the outcome either of us wanted.',
];

function pickRandom(lines: readonly string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

/**
 * Composes the notification text for a finished job: a butler line matching the
 * result, followed by what actually happened.
 *
 * Takes the whole Outcome rather than its fields individually — the caller always
 * has one, and passing three loose primitives invites getting their order wrong.
 */
export function outcomeMessage(outcome: Outcome): string {
  const succeeded = outcome.exitCode === 0;
  const line = pickRandom(succeeded ? SUCCESS_LINES : FAILURE_LINES);
  return `${line} (${outcome.label}, ${formatDuration(outcome.durationMs)})`;
}
