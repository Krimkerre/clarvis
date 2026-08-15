/**
 * A durable record of one agent run — what it meant to do, what it did, and why.
 *
 * **Two review items, one gap.** "An inspectable before/after run summary" (B) and
 * "why did you do that?" (A) both need the same thing: a per-step record that survives
 * the terminal scrolling past it. Today a run's narration exists only as text streamed
 * through `AgentEvent` and gone the moment the panel moves on — asking "why did you
 * touch that file" ten minutes later has nothing to answer from but the model's general
 * memory of the conversation, which is exactly the "generic model hindsight" the review
 * says not to build on.
 *
 * One ledger serves both: B renders it whole, as a support artifact; A searches it for
 * the step that mentions the file or command asked about, and returns the narration
 * that was said *before* that step ran — the actual plan-step → decision chain, not a
 * model reconstructing one after the fact.
 *
 * Pure. Persistence, git and the panel are the caller's problem.
 */

/** One tool call, with what was said about it before it ran. */
export interface RunStep {
  step: number;
  /** What the model said just before this step — the "why". Empty if it said nothing. */
  narration: string;
  /** The tool call itself, in the same words the transcript already uses. */
  action: string;
  /** The file this step touched, if any — the thing a "why did you edit X" matches on. */
  file?: string;
  /** True when the user declined this step. It still belongs in the record. */
  declined: boolean;
}

/** Where the last run's record is kept. One run, not a history — see the note above. */
export const LAST_RUN_KEY = 'clarvis.agent.lastRun';

export interface RunRecord {
  /** What was asked for, verbatim — the "Intent" field. */
  intent: string;
  startedAt: number;
  steps: RunStep[];
  /** Files touched, deduplicated, in the order first touched. */
  filesChanged: string[];
  /** What the run said when it finished. */
  result: string;
  /** Where it left the work — filled in by the caller from git, once the run has a branch. */
  branchState?: string;
}

/**
 * The subset of `AgentEvent` this needs, so the ledger has no dependency on
 * `AgentRunner` and can be built and tested from a plain array of plain objects.
 */
export interface LedgerEvent {
  kind: 'text' | 'tool' | 'gate' | 'done' | 'error';
  text: string;
  detail?: string;
  step?: number;
}

/**
 * Builds the record from the events a run actually produced.
 *
 * **Narration attaches to the step that follows it**, not the one it arrived with —
 * the model says what it is about to do in a `text` event, then a `tool` event carries
 * the call itself. Held until a `tool` event claims it; a `text` event with no `tool`
 * after it (the closing summary) never gets attached to a step, which is correct — it
 * is the result, not a decision about a step.
 */
export function buildRunRecord(intent: string, startedAt: number, events: readonly LedgerEvent[]): RunRecord {
  const steps: RunStep[] = [];
  const filesChanged: string[] = [];
  let pendingNarration = '';
  let result = '';

  for (const event of events) {
    if (event.kind === 'text') {
      pendingNarration = event.text.trim();
      continue;
    }

    if (event.kind === 'tool') {
      const file = fileFromDetail(event.detail);
      steps.push({
        step: event.step ?? steps.length + 1,
        narration: pendingNarration,
        action: event.detail ?? event.text,
        file,
        declined: false,
      });
      pendingNarration = '';
      // **Changed, not merely mentioned.** `runCommand: npm test` has a path-shaped
      // tail too — the command itself — and treating it as a file put "npm test" in
      // "Files changed". Only the tools that actually write are what that field means.
      if (file && MUTATES.has(toolName(event.detail)) && !filesChanged.includes(file)) {
        filesChanged.push(file);
      }
      continue;
    }

    if (event.kind === 'gate' && event.text.startsWith('Skipped: ')) {
      // A declined step still belongs to the record — it is part of what happened,
      // and "asked to, was told no" is itself an answer to "why didn't you".
      const last = steps[steps.length - 1];
      if (last) last.declined = true;
      continue;
    }

    if (event.kind === 'done') {
      result = event.text.trim();
    }
  }

  return { intent, startedAt, steps, filesChanged, result };
}

/** Tools whose detail's tail is a file path — as opposed to a command or a pattern. */
const MUTATES = new Set(['applyEdit', 'writeFile']);
const FILE_SHAPED = new Set(['applyEdit', 'writeFile', 'readFile']);

/** The tool name from a detail string like `applyEdit: src/app.ts`. */
function toolName(detail: string | undefined): string {
  return detail?.split(':')[0]?.trim() ?? '';
}

/** Pulls a path out of a detail string, only for tools whose tail actually is one. */
function fileFromDetail(detail: string | undefined): string | undefined {
  if (!detail || !FILE_SHAPED.has(toolName(detail))) return undefined;
  const colon = detail.indexOf(': ');
  if (colon === -1) return undefined;
  const rest = detail.slice(colon + 2).trim();
  return rest || undefined;
}

/**
 * The full record, as a document — review item B, rendered.
 *
 * Six fields, matching what the review asked for: Intent, Files changed, Checks (the
 * steps, since an ad-hoc run has no separate check list), Result, Remaining concern,
 * Branch/undo state. "Remaining concern" is derived rather than asked for — a run that
 * declined nothing and finished cleanly has none, and inventing one would be exactly
 * the fabricated confidence this project has a rule against.
 */
export function renderRunSummary(record: RunRecord): string {
  const concern = remainingConcern(record);

  return [
    `# Run summary — ${new Date(record.startedAt).toLocaleString()}`,
    '',
    '## Intent',
    record.intent || '(not recorded)',
    '',
    '## Files changed',
    record.filesChanged.length ? record.filesChanged.map((f) => `- ${f}`).join('\n') : '(none)',
    '',
    '## Steps',
    record.steps.length
      ? record.steps
          .map((s) => {
            const mark = s.declined ? '❌ declined — ' : '';
            const why = s.narration ? `${s.narration}\n  ` : '';
            return `${s.step}. ${mark}${why}${s.action}`;
          })
          .join('\n')
      : '(none — nothing was touched)',
    '',
    '## Result',
    record.result || '(the run ended with nothing said)',
    '',
    '## Remaining concern',
    concern,
    ...(record.branchState ? ['', '## Branch state', record.branchState] : []),
  ].join('\n');
}

function remainingConcern(record: RunRecord): string {
  const declined = record.steps.filter((s) => s.declined);
  if (declined.length > 0) {
    return `${declined.length} step(s) were declined and not done: ${declined.map((s) => s.action).join('; ')}.`;
  }
  if (record.filesChanged.length === 0) {
    return 'Nothing was changed — check Result for why, if that matters.';
  }
  return 'None recorded.';
}

/**
 * Words too common to mean anything on their own, in a question about a step.
 *
 * Without this, "why did you edit app.ts?" fails to match — the needle after stripping
 * "why did you" is "edit app.ts?", and no step's haystack contains that *exact*
 * phrase, punctuation and all. What the question actually contains that is worth
 * matching on is "app.ts"; "edit" and "that" are noise around it.
 */
const NOISE_WORDS = new Set([
  'do',
  'did',
  'edit',
  'change',
  'touch',
  'run',
  'that',
  'this',
  'the',
  'to',
  'you',
  'file',
]);

/**
 * Answers "why did you do that" for one step, matched by file or command.
 *
 * **Word-level, not whole-phrase.** A question is phrased as a sentence — "why did you
 * edit app.ts?" — and a step's record is a tool call — "applyEdit: src/app.ts". Neither
 * contains the other as a literal substring; what they share is one meaningful word.
 * So the needle is split, stripped of the common connective words around a file
 * mention, and matched piece by piece — the same deliberately blunt spirit as
 * `forgetMatching` (§4.2): the user names the thing the way they see it, not the way
 * the tool call spelled it. Most recent match wins, since "that" usually means the
 * last thing done to it.
 */
export function explainStep(record: RunRecord, needle: string): RunStep | undefined {
  const words = needle
    .toLowerCase()
    .split(/[^a-z0-9./_-]+/)
    .filter((word) => word.length >= 3 && !NOISE_WORDS.has(word));
  if (words.length === 0) return undefined;

  for (let i = record.steps.length - 1; i >= 0; i--) {
    const step = record.steps[i];
    const haystack = `${step.file ?? ''} ${step.action}`.toLowerCase();
    if (words.some((word) => haystack.includes(word))) return step;
  }
  return undefined;
}
