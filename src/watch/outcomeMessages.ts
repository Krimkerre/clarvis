// "125s" is meaningless at a glance; "2m 5s" isn't. Used to render the duration
// tacked onto every outcome message.
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// Hardcoded pool — M6 replaces this wholesale with the real quip bank (§5), which
// adds weighted random selection, no-repeat-within-session tracking, and earned-
// sass gating. This is deliberately minimal until then.
const SUCCESS_LINES = [
  'Finished. Green. I amused myself in your absence.',
  "Done, and clean. I'll allow it.",
];
const FAILURE_LINES = [
  "Finished. Red, I'm afraid.",
  'Done. Not the outcome either of us wanted.',
];

// Picks a line matching the outcome and appends what actually happened (label +
// duration), so the butler voice and the hard facts always travel together.
export function outcomeMessage(label: string, exitCode: number | undefined, durationMs: number): string {
  const pool = exitCode === 0 ? SUCCESS_LINES : FAILURE_LINES;
  const line = pool[Math.floor(Math.random() * pool.length)];
  return `${line} (${label}, ${formatDuration(durationMs)})`;
}
