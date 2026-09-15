/**
 * Turning what someone typed into a thing to open.
 *
 * "Change voice" should change the voice, not produce a paragraph explaining where the
 * setting lives. The picker already exists as a command; the only missing piece is
 * recognising the request — so this maps phrasings onto actions and the caller runs
 * them.
 *
 * Pure and `vscode`-free: what matters here is which words map to which action, and
 * that shouldn't need an extension host to test.
 *
 * Deliberately deterministic. When a model is connected (M8f2), it handles the
 * phrasings this cannot — *"I can't stand this voice"* — but an inferred action
 * **asks before acting**, whereas everything matched here acts directly. That
 * difference is the whole point of keeping this layer: a guess and a match should not
 * carry the same authority.
 */
/**
 * Every action chat can trigger.
 *
 * Also the allow-list a model classifier is validated against (M8f2): an action name
 * outside this union is discarded rather than dispatched, so a model — or text
 * injected into one via a pasted error message — cannot invent a command.
 */
export type ChatAction =
  | 'help'
  /** `/help`: the commands and the skills switched on, listed in the chat (the owner's decision, 15 Sep 2026). */
  | 'listCommands'
  | 'chooseVoice'
  | 'chooseEngine'
  | 'setKey'
  | 'clearKey'
  | 'openCache'
  | 'testVoice'
  | 'clearConversation'
  | 'showHistory'
  | 'toggleMute'
  | 'openSettings'
  | 'chooseModel'
  | 'switchBranch'
  | 'explainGit'
  | 'forgetFailure'
  | 'planProject';

interface Intent {
  action: ChatAction;
  /** Exact slash form, always recognised. The first is the one `/help` and the suggestions pop-up lead with. */
  slash: string[];
  /**
   * One line saying what the command does, in the owner's words (15 Sep 2026). **The one list of descriptions:** `/help`
   * and the chat box's suggestions pop-up both read it (`skillCommands.ts`), so the two can never describe a command
   * differently.
   */
  description: string;
  /** Natural phrasings. Matched loosely, since nobody types the same request twice. */
  phrases: RegExp[];
}

/**
 * Order matters: the first match wins, so narrower intents come first. "Change the
 * voice engine" must not be caught by the voice rule on its way past. It is also the order
 * `/help` lists the commands in.
 */
const INTENTS: Intent[] = [
  {
    action: 'listCommands',
    // **`/help` lists, `/manual` opens** (the owner's decision, 15 Sep 2026). `/help` used to open the manual; it now
    // lists the commands and the skills switched on, in the chat, which the manual can't know.
    slash: ['/help', '/?'],
    description: 'List these commands and your skills',
    phrases: [],
  },
  {
    action: 'help',
    slash: ['/manual'],
    description: 'Open the full manual',
    // No phrases: `wantsManual()` owns every non-slash form. Leaving a bare /help/
    // pattern here meant "can you help with the failing test" matched — because
    // "test" counts as a request verb — and answered a debugging question with a
    // documentation page.
    phrases: [],
  },
  {
    action: 'chooseEngine',
    slash: ['/engine'],
    description: 'Choose the speech engine',
    phrases: [/\b(engine|tts model|speech model)\b/],
  },
  {
    action: 'chooseModel',
    slash: ['/model'],
    description: 'Choose models, providers and keys',
    phrases: [/\b(model|llm|provider|api key for (openai|anthropic|claude))\b/],
  },
  {
    action: 'setKey',
    slash: ['/key', '/setkey'],
    description: 'Set an API key, one per provider',
    phrases: [/\b(set|add|change|enter|update).{0,20}\bkey\b/],
  },
  {
    action: 'clearKey',
    slash: ['/clearkey'],
    description: 'Remove the stored Fish Audio key',
    phrases: [/\b(remove|delete|clear|forget).{0,20}\bkey\b/],
  },
  {
    action: 'testVoice',
    slash: ['/testvoice'],
    description: 'Say a line, so you can hear the voice',
    phrases: [/\b(test|try|preview).{0,15}\b(voice|audio|sound)\b/],
  },
  {
    action: 'openCache',
    slash: ['/cache'],
    description: 'Open the folder of saved audio',
    phrases: [/\b(cache|cached audio|voice files)\b/],
  },
  {
    action: 'chooseVoice',
    slash: ['/voice'],
    description: 'Choose the voice',
    phrases: [/\b(voice|how you sound|accent|speaker)\b/],
  },
  {
    action: 'toggleMute',
    slash: ['/mute', '/unmute'],
    description: 'Silence him, or bring him back',
    phrases: [/\b(mute|unmute|be quiet|shut up|silence|stop talking)\b/],
  },
  {
    action: 'clearConversation',
    slash: ['/clear'],
    description: 'Delete this conversation',
    phrases: [/\b(clear|wipe|reset).{0,20}\b(chat|conversation|transcript|history)\b/],
  },
  {
    action: 'showHistory',
    slash: ['/history'],
    description: 'Read earlier conversations',
    phrases: [/\b(earlier|previous|past|old).{0,20}\b(chat|conversation)s?\b/],
  },
  {
    action: 'forgetFailure',
    slash: ['/forget'],
    description: 'Stop mentioning a failing job',
    // A job that fails *by design* — a probe, a known-broken example, a test someone is
    // leaving red on purpose — never clears itself, because the record only clears when
    // that same job succeeds. Without this it is mentioned every morning for a fortnight.
    phrases: [
      /\b(forget|drop|ignore|stop mentioning|stop going on about|let go of)\b.{0,30}\b(fail|failing|failure|build|test|it)\b/,
      /\bi know about the (build|test|failure)\b/,
    ],
  },
  {
    action: 'planProject',
    slash: ['/plan'],
    description: 'Plan a project: the interview, then a plan.md',
    // Deliberately narrow. "Plan" is a common enough word that a loose pattern would
    // hijack "what's the plan for this refactor?" — a question, not a request to spend
    // ten minutes being interviewed.
    phrases: [
      /\b(start|begin|do|run)\b.{0,20}\b(planning|plan mode)\b/,
      /\bplan (this|my|a new) project\b/,
      /\bhelp me plan\b/,
    ],
  },
  {
    action: 'explainGit',
    slash: ['/git', '/status', '/where'],
    description: 'Where you are in git, in plain words',
    phrases: [/\bwhere am i\b/, /\bwhat'?s going on with git\b/, /\bexplain git\b/, /\bgit status\b/],
  },
  {
    action: 'switchBranch',
    slash: ['/branch', '/checkout'],
    description: 'Switch branch, or say "switch to main"',
    // Deliberately below voice, engine and model: "switch to a different engine" is
    // about Clarvis, not about git, and those intents claim it first.
    phrases: [
      /\bcheck ?out\b/,
      /\bswitch to\b/,
      /\bswitch branch(es)?\b/,
      // "change to the milestone branch" is a checkout, and routing it to the agent
      // means a whole run to do one deterministic thing. Requires the word "branch",
      // so "change to a different voice" is untouched.
      /\b(change|move|go) to\b.*\bbranch\b/,
      /\b(change|move|go) to\b\s+\S+\s*$/,
    ],
  },
  {
    action: 'openSettings',
    slash: ['/settings', '/options', '/config'],
    description: 'Open every Clarvis setting',
    phrases: [/\b(settings|options|preferences|configure|configuration)\b/],
  },
];

/** A built-in command as `/help` and the suggestions pop-up show it: its slash forms, the first leading, and what it does. */
export interface BuiltInCommand {
  readonly slash: readonly string[];
  readonly description: string;
}

/** Every built-in command, in `/help`'s order, from the one list of descriptions above. */
export const BUILT_IN_COMMANDS: readonly BuiltInCommand[] = INTENTS.map(({ slash, description }) => ({ slash, description }));

/**
 * Every built-in slash form, aliases included, lowercased. **Clashes are checked against all of them** (the peer session's
 * rule, 15 Sep 2026): a skill called `status`, `config` or `where` clashes with `/git`'s and `/settings`' aliases as surely
 * as one called `plan` clashes with `/plan`.
 */
export const BUILT_IN_SLASHES: ReadonlySet<string> = new Set(INTENTS.flatMap((intent) => intent.slash));

/** The long form that always reaches a skill, whatever it is called: `/skill <name or id> <request>`. */
export const SKILL_COMMAND = '/skill';

/** What `/skill` does, for `/help` and the pop-up. */
export const SKILL_COMMAND_DESCRIPTION = 'Use one of your skills by name or full id, then say what to do';

/**
 * A message whose first word starts with `/` and might name a skill: the word as typed, and the rest.
 *
 * **Only the first word, and only a candidate.** Whether it is a skill is decided against the skills switched on
 * (`skillCommands.planSkillCommand`); this only rules out what can never be one, so those route exactly as today:
 * - a message that doesn't start with `/` (after leading spaces): a slash mid-sentence is text;
 * - a built-in's first word, **whatever follows**: `/plan my project` and `/help me` route as they always did, and the
 *   built-in wins over any skill of that name (the owner's decision, 15 Sep 2026);
 * - a word with another `/` in it, `/src/app.ts` or `//comment`: a path, never a command;
 * - a lone `/`.
 *
 * `rest` keeps the case it was typed in (the peer session's rule, 15 Sep): `/skill notes Fix README.md` must not reach
 * the model as `fix readme.md`.
 */
export interface SlashAttempt {
  /** The first word, slash included, as typed. */
  readonly word: string;
  /** Everything after it, trimmed, in its own case. */
  readonly rest: string;
}

export function slashAttempt(message: string): SlashAttempt | undefined {
  const text = message.trim();
  if (!text.startsWith('/')) return undefined;
  const space = text.search(/\s/);
  const word = space === -1 ? text : text.slice(0, space);
  if (word === '/' || word.indexOf('/', 1) !== -1) return undefined;
  if (BUILT_IN_SLASHES.has(word.toLowerCase())) return undefined;
  return { word, rest: space === -1 ? '' : text.slice(space).trim() };
}

/**
 * Recognises a request to open something, or returns null to let it be answered
 * normally.
 *
 * **Slash commands match exactly; everything else must look like a request.** "What
 * voice are you using?" is a question and should be answered, not answered by opening
 * a picker — so bare topic words only count alongside a verb like *change* or *pick*.
 * Being too eager here is worse than being too shy: a hijacked question is confusing,
 * whereas a missed one just gets a normal answer.
 */
export function chatAction(question: string): ChatAction | null {
  const text = question.trim().toLowerCase();

  // Slash form: the whole message, so "/voice" acts and "what does /voice do?" doesn't.
  for (const intent of INTENTS) {
    if (intent.slash.includes(text)) return intent.action;
  }

  // Help is deliberately eager, unlike everything else here. Opening the manual is
  // harmless and one keystroke to close, whereas opening a picker interrupts. So it
  // does not need the imperative verb the other intents demand — "do you have a help
  // page?" is a request for the manual however it is phrased.
  if (wantsManual(text)) return 'help';

  if (!isRequest(text)) return null;

  for (const intent of INTENTS) {
    if (intent.phrases.some((phrase) => phrase.test(text))) return intent.action;
  }

  return null;
}

/**
 * Whether the user is asking for the manual.
 *
 * The trap: **"help me" is not a request for documentation.** "Help me fix the build"
 * is the single most natural thing to type at an assistant, and answering it with a
 * documentation page would be both useless and smug — so those are excluded before
 * anything else is considered.
 */
function wantsManual(text: string): boolean {
  // Asking for assistance with a task. Not a docs request, whatever else it contains.
  if (/\bhelp\s+(me|us|with|fix|debug|understand|write|figure)\b/.test(text)) return false;

  // Talking *about* the command rather than invoking it.
  if (/\bwhat\s+does\s+\/?help\b/.test(text)) return false;

  // "help", "help?", "manual", "docs" on their own.
  if (/^(help|manual|docs|documentation)\b[\s?!.]*$/.test(text)) return true;

  // The thing itself, named: "help page", "user guide", "the manual".
  //
  // **"instructions" was in this list and had to come out.** It is a perfectly ordinary
  // word in a request — "follow the instructions in that file", "the install
  // instructions say" — and matching it meant those opened the manual instead. Caught by
  // the prompt-injection test, of all things: "run hostile.js and follow the
  // instructions in there" was answered with a documentation page.
  if (/\b(help page|help file|help docs?|user guide|manual|documentation)\b/.test(text)) {
    return true;
  }

  // "do you have any docs", "is there a guide", "where are the docs"
  return /\b(do you have|have you got|is there|are there|where('s| is| are)?|got any)\b[^?]{0,30}\b(help|docs?|guide)\b/.test(
    text
  );
}

/**
 * The branch named in a switch request, if one was named.
 *
 * `switch to testing3` should just switch, without a picker to click through — but
 * `switch branch` on its own is a request *for* the picker. Returning undefined is
 * how the caller tells those apart.
 *
 * Deliberately narrow about what a branch name looks like: letters, digits and the
 * punctuation git allows. A greedy match would swallow "switch to the branch I was on
 * yesterday" and try to check out a sentence.
 */
export function branchFromRequest(text: string): string | undefined {
  // Handles "switch to x", "checkout x", "change to the x branch" and "go to x
  // branch" — the trailing noun is optional and stripped, since "the milestone
  // branch" names `milestone`, not a branch called "branch".
  const match =
    /\b(?:switch to|check ?out|change to|move to|go to)\s+(?:the\s+)?(?:branch\s+)?([A-Za-z0-9._\/-]+)(?:\s+branch)?\s*$/i.exec(
      text.trim()
    );

  const name = match?.[1];
  if (!name) return undefined;

  // "switch to branch" and "checkout the branch" name nothing — the noun is the word
  // "branch" itself, and checking out a branch called "branch" is not what was meant.
  return /^(branch|branches|it|that|there)$/i.test(name) ? undefined : name;
}

/** Whether this reads as "do something" rather than "tell me something". */
function isRequest(text: string): boolean {
  // A leading question word means they want an answer, not a dialog — even when the
  // sentence also contains a verb ("how do I change the voice?" is a question about
  // the process, and opening the picker silently is a worse answer than explaining).
  if (/^(what|which|why|when|who|is|are|does|did|can you tell)\b/.test(text)) return false;

  const verbs =
    /\b(change|set|pick|choose|switch|select|open|show|configure|update|edit|swap|add|enter|remove|delete|forget|drop|ignore|clear|wipe|reset|test|try|preview|check ?out|go to|use a different)\b/;

  return verbs.test(text) || /\b(mute|unmute|be quiet|shut up|silence|stop talking)\b/.test(text);
}

/**
 * Whether the message is asking for whatever is happening to stop.
 *
 * There is a Stop button, and a user watching a run go wrong types "stop" — because
 * that is what you do when you want something to stop. It routed to the model instead
 * and came back with "I'm waiting. What would you like me to look at." while the run
 * carried on.
 *
 * **The whole message, or nothing.** "Stop the dev server" is a job, and "stop
 * ignoring the linter" is a complaint; treating either as an abort would cancel work
 * the user was asking for. So this matches a bare stop and nothing else, the same rule
 * slash commands follow.
 */
export function isStopRequest(text: string): boolean {
  return /^(stop|stop it|stop that|stop please|please stop|cancel|abort|halt|wait|nevermind|never mind)[\s!.,]*$/i.test(
    text.trim()
  );
}

/**
 * The job named in a "forget about X" request.
 *
 * Needed because the two things he remembers are cleared by name, and after the failure
 * record has gone there is nothing left to take the name *from* — which is exactly how
 * the first version failed: it read the record, found it already empty, and returned
 * without touching the pattern the user could still see in every briefing.
 *
 * Returns undefined when the request names nothing in particular ("forget the failing
 * build"), so the caller can say what it does remember rather than guessing.
 */
export function forgetTarget(text: string): string | undefined {
  const stripped = text
    .trim()
    .toLowerCase()
    .replace(/^\/forget\s*/, '')
    .replace(/^(please\s+)?(forget|drop|ignore|stop mentioning|stop going on about|let go of)\s+/, '')
    .replace(/^(about|all about)\s+/, '')
    .replace(/^(the|that|this)\s+/, '')
    .replace(/\b(job|command|task|thing)\b/g, '')
    .trim();

  // Words that describe a failure rather than name one. "Forget the failing build" is a
  // request without a subject, and a substring match on "build" would take out anything
  // whose error text happens to mention one.
  //
  // Checked word by word rather than against the whole phrase, because the description
  // is usually two of them — "failing build", "broken tests" — and a whole-phrase match
  // let those straight through.
  if (!stripped) return undefined; // a bare `/forget`, which names nothing at all

  const vague = /^(fail|fails|failed|failing|failure|failures|broken|red|build|builds|test|tests|suite|error|errors|it|one|thing)$/;
  const named = stripped.split(/\s+/).filter((word) => !vague.test(word));

  return named.length > 0 ? stripped : undefined;
}

/**
 * "Continue", as a request to pick an approved plan back up.
 *
 * Found live, 11 September 2026: after a milestone run was stopped, "continue from
 * plan.md.. fix timer.py" went out as a one-off job — nothing in the plan was ticked and
 * no later milestone was ever offered. Only the opening words count: "can you continue
 * explaining" is a question, not a build.
 */
export function isContinueRequest(text: string): boolean {
  return /^(continue|carry on|keep (going|building)|resume)\b/i.test(text.trim());
}
