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
  | 'forgetFailure';

interface Intent {
  action: ChatAction;
  /** Exact slash form, always recognised. */
  slash: string[];
  /** Natural phrasings. Matched loosely, since nobody types the same request twice. */
  phrases: RegExp[];
}

/**
 * Order matters: the first match wins, so narrower intents come first. "Change the
 * voice engine" must not be caught by the voice rule on its way past.
 */
const INTENTS: Intent[] = [
  {
    action: 'help',
    slash: ['/help', '/?', '/manual'],
    // No phrases: `wantsManual()` owns every non-slash form. Leaving a bare /help/
    // pattern here meant "can you help with the failing test" matched — because
    // "test" counts as a request verb — and answered a debugging question with a
    // documentation page.
    phrases: [],
  },
  {
    action: 'chooseEngine',
    slash: ['/engine'],
    phrases: [/\b(engine|tts model|speech model)\b/],
  },
  {
    action: 'chooseModel',
    slash: ['/model'],
    phrases: [/\b(model|llm|provider|api key for (openai|anthropic|claude))\b/],
  },
  {
    action: 'setKey',
    slash: ['/key', '/setkey'],
    phrases: [/\b(set|add|change|enter|update).{0,20}\bkey\b/],
  },
  {
    action: 'clearKey',
    slash: ['/clearkey'],
    phrases: [/\b(remove|delete|clear|forget).{0,20}\bkey\b/],
  },
  {
    action: 'testVoice',
    slash: ['/testvoice'],
    phrases: [/\b(test|try|preview).{0,15}\b(voice|audio|sound)\b/],
  },
  {
    action: 'openCache',
    slash: ['/cache'],
    phrases: [/\b(cache|cached audio|voice files)\b/],
  },
  {
    action: 'chooseVoice',
    slash: ['/voice'],
    phrases: [/\b(voice|how you sound|accent|speaker)\b/],
  },
  {
    action: 'toggleMute',
    slash: ['/mute', '/unmute'],
    phrases: [/\b(mute|unmute|be quiet|shut up|silence|stop talking)\b/],
  },
  {
    action: 'clearConversation',
    slash: ['/clear'],
    phrases: [/\b(clear|wipe|reset).{0,20}\b(chat|conversation|transcript|history)\b/],
  },
  {
    action: 'showHistory',
    slash: ['/history'],
    phrases: [/\b(earlier|previous|past|old).{0,20}\b(chat|conversation)s?\b/],
  },
  {
    action: 'forgetFailure',
    slash: ['/forget'],
    // A job that fails *by design* — a probe, a known-broken example, a test someone is
    // leaving red on purpose — never clears itself, because the record only clears when
    // that same job succeeds. Without this it is mentioned every morning for a fortnight.
    phrases: [
      /\b(forget|drop|ignore|stop mentioning|stop going on about|let go of)\b.{0,30}\b(fail|failing|failure|build|test|it)\b/,
      /\bi know about the (build|test|failure)\b/,
    ],
  },
  {
    action: 'explainGit',
    slash: ['/git', '/status', '/where'],
    phrases: [/\bwhere am i\b/, /\bwhat'?s going on with git\b/, /\bexplain git\b/, /\bgit status\b/],
  },
  {
    action: 'switchBranch',
    slash: ['/branch', '/checkout'],
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
    phrases: [/\b(settings|options|preferences|configure|configuration)\b/],
  },
];

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
