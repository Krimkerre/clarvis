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
  | 'chooseModel';

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
    phrases: [/\b(help|manual|documentation|docs|how do i use)\b/],
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

  // Help is special: someone typing "help" alone means it, verb or not.
  if (/^(help|manual|docs)\b/.test(text)) return 'help';

  if (!isRequest(text)) return null;

  for (const intent of INTENTS) {
    if (intent.phrases.some((phrase) => phrase.test(text))) return intent.action;
  }

  return null;
}

/** Whether this reads as "do something" rather than "tell me something". */
function isRequest(text: string): boolean {
  // A leading question word means they want an answer, not a dialog — even when the
  // sentence also contains a verb ("how do I change the voice?" is a question about
  // the process, and opening the picker silently is a worse answer than explaining).
  if (/^(what|which|why|when|who|is|are|does|did|can you tell)\b/.test(text)) return false;

  const verbs =
    /\b(change|set|pick|choose|switch|select|open|show|configure|update|edit|swap|add|enter|remove|delete|forget|clear|wipe|reset|test|try|preview|use a different)\b/;

  return verbs.test(text) || /\b(mute|unmute|be quiet|shut up|silence|stop talking)\b/.test(text);
}
