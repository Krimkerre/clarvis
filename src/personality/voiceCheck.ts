import { ModelService } from '../model/ModelService';
import { agentSystemPrompt } from '../agent/AgentRunner';
import { ANSWER_SHAPE, EXAMPLES, characterWith } from './character';
import { briefingPrompt } from '../briefing/briefingLines';
import { completionQuipPrompt, quipPrompt } from './liveQuip';
import { rewritePrompt } from './say';

/**
 * Reads his lines back, so a personality change can be judged before it ships.
 *
 * **Why this exists.** Every personality change up to this point was verified by reading
 * *prompt text* and by tests asserting on prompt text. Not one generated line was read
 * before it reached the user, so three consecutive "fixes" shipped — each sound in
 * principle, each flatter in practice — and the user found all three by using the thing.
 * A prompt is a hypothesis; only the output settles it.
 *
 * **Why it runs inside the extension rather than as a script.** Keys live in
 * SecretStorage and the model choice lives in settings, so anything outside the
 * extension host would need its own copy of both, and a harness testing its own copy of
 * the configuration is testing nothing. Same reason the prompts are imported from where
 * they are used rather than restated here: a drifted copy is worse than no check at all.
 */

/** One thing to say, built from the same prompt the real surface uses. */
interface Scene {
  name: string;
  /** What is being judged, so the output is readable without this file open. */
  looksFor: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

/**
 * Stands in for a file the model has just read.
 *
 * Short on purpose. The failure being reproduced is the *prior* — a model holding fresh
 * tool results falls into summarising the document — and that arrives with the shape of
 * the exchange, not with the length of the excerpt.
 */
const FILE_EXCERPT = [
  '# Clarvis — plan',
  '',
  '## 2. Personality',
  'Rule 1: never cheerful about a failure.',
  'Rule 2: the sharper register is earned, not default.',
  'Rule 3: propose before you touch anything.',
].join('\n');

/** The facts the briefing is built from, as a plausible morning. */
const BRIEFING_FACTS = {
  git: { branch: 'm8-chat-agent', dirtyCount: 0 },
  recentFiles: ['settings.json', 'plan.md', 'app.js'],
  lastFailure: { label: 'probe-build-fail', exitCode: 1, at: Date.now() - 40 * 60_000 },
  patternHint: 'That build has failed the same way four times this week.',
};

function scenes(): Scene[] {
  // The chat path as it actually runs: the read-only brief, the facts addendum, and the
  // answer shape last — assembled here the same way AgentRunner assembles it.
  const answerSystem = `${agentSystemPrompt(true)}\n\nCurrent branch: m8-chat-agent, working tree clean\nStill failing: "probe-build-fail" (exit 1), 40 minutes ago\n\n${ANSWER_SHAPE}`;

  return [
    {
      name: 'chat answer, after reading a file',
      looksFor: 'Two sentences then a line of his own. No "Got it", no recap of the file.',
      system: answerSystem,
      messages: [
        { role: 'user', content: 'read plan.md and tell me what you think of it' },
        { role: 'assistant', content: 'readFile plan.md' },
        { role: 'user', content: `Tool result (readFile plan.md):\n${FILE_EXCERPT}` },
      ],
    },
    {
      name: 'chat answer, nothing to read',
      looksFor: 'Same shape without a tool result. If this one has character and the first does not, the tool prior is still winning.',
      system: answerSystem,
      messages: [{ role: 'user', content: 'why does that build keep failing?' }],
    },
    {
      name: 'agent run summary',
      looksFor: 'What changed, in one line, in his voice — not a changelog.',
      system: agentSystemPrompt(false),
      messages: [
        { role: 'user', content: 'add a comment to the top of app.js explaining what it does' },
        { role: 'assistant', content: 'I read app.js, then applied the edit.' },
        // **The work is stated as finished, explicitly.** The first version of this
        // scene ended on a tool result and got "I need to see what's in app.js first —
        // readFile app.js" back: a fake tool result is not a real tool call, so the
        // model tried to start the loop instead of closing it, and the summary voice
        // went untested while the scene appeared to pass.
        {
          role: 'user',
          content:
            'Tool result (applyEdit app.js): edit applied, 1 file changed.\nThe task is now complete and no tools remain. Give your closing line.',
        },
      ],
    },
    {
      name: 'morning briefing',
      looksFor: 'The surface that already sounded right. If this regresses, the change hurt more than it helped.',
      system: characterWith('This is the first thing the user hears today. Do not greet them.'),
      messages: [{ role: 'user', content: briefingPrompt(BRIEFING_FACTS as never) ?? '' }],
    },
    {
      name: 'quip — same failure again',
      looksFor: 'Pointed, and about this failure rather than failure in general.',
      system: 'You write one short, dry remark. Nothing else.',
      messages: [
        {
          role: 'user',
          content: quipPrompt({
            trigger: 'repeatFailure',
            detail: 'probe-build-fail, exit 1, fourth time this week',
            sharp: true,
          }),
        },
      ],
    },
    {
      name: 'aside after a task',
      looksFor: 'Comic relief that does not restate the summary.',
      system: 'You write one short, dry remark. Nothing else.',
      messages: [
        {
          role: 'user',
          content: completionQuipPrompt('add a comment to app.js', 'Comment added to app.js.'),
        },
      ],
    },
    {
      name: 'rewrite of a written line',
      looksFor: 'Better than the plain original, or the layer is not paying for itself.',
      system: 'You rewrite one line in character. Nothing else.',
      messages: [
        {
          role: 'user',
          content: rewritePrompt({
            purpose: 'report',
            fallback: 'Switched to branch testing.',
            keep: ['testing'],
          }),
        },
      ],
    },
  ];
}

/**
 * Roughly how long a line takes to say.
 *
 * The number that mattered most and was hardest to see: a reply that reads fine on
 * screen was thirty-nine seconds of audio. Speech runs near 150 words a minute, so this
 * is deliberately crude — it only has to make "that is too long" obvious at a glance.
 */
function spokenSeconds(text: string): number {
  return Math.round((text.trim().split(/\s+/).length / 150) * 60);
}

/**
 * Any example line he has quoted back instead of writing his own.
 *
 * The first run of this check produced a briefing ending "At some point it stops being
 * bad luck" — word for word from the examples — and I only noticed by reading carefully.
 * A check that depends on the reader being sharp is a check that fails on a tired
 * afternoon, so it is mechanical now.
 *
 * Matched on clauses rather than whole lines: the model lifted half an example, not all
 * of it, and half is enough for the user to hear the same joke twice.
 */
function parroted(said: string): string[] {
  const haystack = said.toLowerCase();

  return EXAMPLES.flatMap((example) => example.split(/(?<=[.;])\s+/))
    .map((clause) => clause.trim())
    .filter((clause) => clause.split(/\s+/).length >= 4)
    .filter((clause) => haystack.includes(clause.toLowerCase().replace(/[.]$/, '')));
}

/**
 * Says every line and returns them as a report.
 *
 * Run sequentially rather than in parallel: this exists to be read while it fills in,
 * and a burst of concurrent requests against a rate-limited provider produces a page of
 * errors instead of a page of lines.
 */
export async function runVoiceCheck(
  models: ModelService,
  log: (message: string) => void
): Promise<string> {
  const out: string[] = [
    '# Clarvis — voice check',
    '',
    `Chat model: \`${models.model('chat')}\` · coding model: \`${models.model('agent')}\``,
    '',
    'Read the lines, not the prompts. Each block says what it is being judged on.',
    '',
  ];

  for (const scene of scenes()) {
    out.push(`## ${scene.name}`, '', `_Looking for: ${scene.looksFor}_`, '');

    let text = '';
    try {
      for await (const fragment of models.stream(
        { system: scene.system, messages: scene.messages },
        'chat'
      )) {
        text += fragment;
      }
    } catch (error) {
      text = `(failed: ${String(error)})`;
    }

    const said = text.trim() || '(nothing came back)';
    const lifted = parroted(said);

    out.push(said, '', `\`${said.split(/\s+/).length} words · ~${spokenSeconds(said)}s spoken\``);
    if (lifted.length > 0) {
      out.push('', `> **Quoted the examples back:** ${lifted.map((clause) => `"${clause}"`).join(', ')}`);
    }
    out.push('');

    log(`voice check | ${scene.name} | ${said.replace(/\s+/g, ' ')}`);
    if (lifted.length > 0) log(`voice check | ${scene.name} | PARROTED: ${lifted.join(' | ')}`);
  }

  return out.join('\n');
}
