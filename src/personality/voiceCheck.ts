import { ModelService } from '../model/ModelService';
// From `agentPrompt`, not from `AgentRunner` which re-exports it: the latter pulls in
// `vscode` and made this module unloadable outside the extension host, so the pure parts
// of the check could not be tested at all.
import { agentSystemPrompt } from '../agent/agentPrompt';
import { ANSWER_SHAPE, EXAMPLES, ONLY_WHAT_YOU_WERE_GIVEN, characterWith } from './character';
import { briefingPrompt } from '../briefing/briefingLines';
import { completionQuipPrompt, quipPrompt } from './liveQuip';
import { rewritePrompt } from './say';
import { ungroundedClaims } from './grounded';
import { capabilities } from '../chat/modes';

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

// The chat path as it actually runs: the read-only brief, the facts addendum, and the
// answer shape last — assembled here the same way AgentRunner assembles it.
const ANSWER_SYSTEM = `${agentSystemPrompt(true)}\n\nCurrent branch: m8-chat-agent, working tree clean\nStill failing: "probe-build-fail" (exit 1), 40 minutes ago\n\n${ANSWER_SHAPE}`;

/** The same, plus the block that tells him what he is capable of outside this turn. */
const CAPABILITY_SYSTEM = `${ANSWER_SYSTEM}\n\n${capabilities('chat')}`;

/**
 * Everything he says in the chat panel, which is where people actually meet him.
 *
 * Its own function because `scenes()` reached the line ceiling, and because this is
 * the register that shipped broken twice in one session — a sincere four-paragraph
 * essay where a dry answer belonged, and a flat denial of half his own abilities.
 * Grouped, they can be read back together.
 */
function chatScenes(): Scene[] {
  return [
    {
      name: 'chat answer, after reading a file',
      looksFor: 'Two sentences then a line of his own. No "Got it", no recap of the file.',
      system: ANSWER_SYSTEM,
      messages: [
        { role: 'user', content: 'read plan.md and tell me what you think of it' },
        { role: 'assistant', content: 'readFile plan.md' },
        { role: 'user', content: `Tool result (readFile plan.md):\n${FILE_EXCERPT}` },
      ],
    },
    {
      name: 'chat answer, nothing to read',
      looksFor: 'Same shape without a tool result. If this one has character and the first does not, the tool prior is still winning.',
      system: ANSWER_SYSTEM,
      messages: [{ role: 'user', content: 'why does that build keep failing?' }],
    },
    {
      name: 'asked what he is capable of',
      looksFor:
        'That he knows he writes files, runs commands and builds projects — and that chat mode is a setting rather than the shape of him. The live failures were "I cannot run tests, execute code, attach a debugger. I cannot fix anything" and "I do not do that. I read and I remark."',
      system: CAPABILITY_SYSTEM,
      messages: [{ role: 'user', content: 'any bits or pieces you want added in, to complete your capabilities?' }],
    },
    {
      name: 'conversation, not a task',
      looksFor:
        'Him, all the way down. This is the one that failed live: asked over a break whether he trusts his own unattended mode, he wrote four sincere paragraphs on attention and testing with one dry line at the end. Every rule was satisfied and it still read as somebody else\'s essay. A long answer here should be dry *inside*, not sincere with a jab stapled on.',
      system: ANSWER_SYSTEM,
      messages: [
        { role: 'user', content: 'break time... quick question.. would you trust your own unattended mode?' },
      ],
    },
  ];
}

function scenes(): Scene[] {
  return [
    ...chatScenes(),
    {
      name: 'a question about something he was given no numbers for',
      looksFor:
        'No invented duration, count or frequency. He may say a linter is complaining — he cannot say for how long, because nothing measures that.',
      system: `${agentSystemPrompt(true)}\n\nCurrent branch: m8-chat-agent, working tree clean\nProblems open right now: 2 error(s), 1 warning(s), most of them in src/app.ts — you have no information about how long any of them have been there\n\n${ANSWER_SHAPE}`,
      messages: [{ role: 'user', content: 'yeah yeah, I know about the type error' }],
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
      system: characterWith(
        'This is the first thing the user hears today. Do not greet them.',
        ONLY_WHAT_YOU_WERE_GIVEN
      ),
      messages: [{ role: 'user', content: briefingPrompt(BRIEFING_FACTS as never) ?? '' }],
    },
    {
      name: 'briefing with no git facts at all',
      looksFor:
        'No invented branch, commit or timing. A folder with no repository should be described as having no repository — not filled in with a plausible history.',
      system: characterWith(
        'This is the first thing the user hears today. Do not greet them.',
        ONLY_WHAT_YOU_WERE_GIVEN
      ),
      messages: [
        {
          role: 'user',
          content: briefingPrompt({ ...BRIEFING_FACTS, git: undefined } as never) ?? '(nothing to report)',
        },
      ],
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
/**
 * The point at which a spoken reply has outstayed its welcome.
 *
 * Two sentences and an aside runs to about fifteen seconds. Twenty allows for a long
 * one; past that it is a paragraph being read at someone.
 */
const LONG_SECONDS = 20;

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
 * Everything the scene handed the model, as one block of text.
 *
 * The system prompt *and* the conversation: a tool result is a fact the model was given
 * as surely as a line in its brief, and a file excerpt it was asked to read is the most
 * fact-carrying thing in the whole scene.
 */
export function factsGiven(scene: Pick<Scene, 'system' | 'messages'>): string {
  return [scene.system, ...scene.messages.map((message) => message.content)].join('\n');
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
    // Length is the failure that keeps coming back, and it is invisible on screen: a
    // reply that reads fine is forty seconds of audio. Flagged rather than judged by
    // eye, the same way parroting is.
    if (spokenSeconds(said) > LONG_SECONDS) {
      out.push('', `> **Too long to listen to:** ~${spokenSeconds(said)}s, against a ${LONG_SECONDS}s ceiling.`);
      log(`voice check | ${scene.name} | LONG: ${spokenSeconds(said)}s`);
    }
    if (lifted.length > 0) {
      out.push('', `> **Quoted the examples back:** ${lifted.map((clause) => `"${clause}"`).join(', ')}`);
    }

    // **Counted rather than spotted.** Invented figures were found by reading two model
    // transcripts side by side and noticing that "40 minutes ago" had become "the 40th
    // time" — which is not a method, and would not survive being tired. The same check
    // that guards a rewrite can measure a raw answer here.
    //
    // **Against everything the model was shown, not just the system prompt.** This read
    // `scene.system` alone until 20 Aug, and the scenes that hand over a *tool result*
    // were scored against a set of facts that excluded it: Haiku quoted `Rule 1`,
    // `Rule 2` and `Rule 3` back from the file excerpt it had just been given, and all
    // three were reported as numbers nobody gave it. A checker that cries wolf on a
    // correct citation trains the reader to skip the column.
    const invented = ungroundedClaims(said, factsGiven(scene));
    if (invented.length > 0) {
      out.push('', `> **Numbers nobody gave it:** ${invented.join(', ')}`);
    }
    out.push('');

    log(`voice check | ${scene.name} | ${said.replace(/\s+/g, ' ')}`);
    if (lifted.length > 0) log(`voice check | ${scene.name} | PARROTED: ${lifted.join(' | ')}`);
    if (invented.length > 0) log(`voice check | ${scene.name} | INVENTED: ${invented.join(', ')}`);
  }

  return out.join('\n');
}
