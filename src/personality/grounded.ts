/**
 * Whether the numbers in a line came from the facts it was given.
 *
 * **The failure this exists to catch, from the model A/B on 20 Aug (F19).** Told only
 * `"probe-build-fail" (exit 1), 40 minutes ago`, a small model answered *"failed for the
 * 40th time … exactly 40 minutes ago"*. Given `2 error(s), 1 warning(s)` it produced *"the
 * same one we've been trying to fix for the past two commits"*.
 *
 * `ONLY_WHAT_YOU_WERE_GIVEN` forbids exactly this and is in every one of those prompts. It
 * holds on a capable model and dissolves on a small one — so, as everywhere else here, the
 * prompt states the intent and the code holds the guarantee.
 *
 * **Why the obvious check does not work.** "Is every number in the reply also in the
 * facts?" passes both of those: 40 was given, and so was 2. Neither model invented a
 * *value* — each took one it had been handed and **re-filed it under a different noun**.
 * Forty minutes became a fortieth occurrence; two errors became two commits. So the unit
 * of comparison is the pair, not the number.
 *
 * Pure, and it fails toward rejection: a line whose numbers cannot be accounted for is
 * dropped in favour of the written one, which is the same trade `discardsOriginalAnswer`
 * makes. A dull true sentence beats a lively false one, and a wrong number about someone's
 * build is the kind of wrong that gets believed.
 */

/** Spelled-out numbers a model uses in prose, including the ordinals. */
const WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, twentieth: 20, thirtieth: 30, fortieth: 40,
};

/**
 * `40`, `40th`, `forty`, `fortieth` — all the same forty.
 *
 * **`one` and `a` are excluded from the word list**, and deliberately not spelled the same
 * way as the rest. "One of settings.json, plan.md or app.js" is not a count of anything —
 * it is the ordinary English sense of "a single [thing]", and reading it as `1` produced a
 * spurious flag on `settings.json` in the 20 Aug run (see `grounded.test.ts`). Genuine uses
 * of "one" as a number ("failed one time") are rarer here than this false-positive shape,
 * and this check costs less by staying quiet than by crying wolf.
 */
function valueOf(token: string): number | undefined {
  const digits = /^(\d+)(?:st|nd|rd|th)?$/i.exec(token);
  if (digits) return Number(digits[1]);
  const word = token.toLowerCase();
  if (word === 'one' || word === 'first') return undefined;
  return WORDS[word];
}

/**
 * Words that never identify what a number counts.
 *
 * Three groups, each learned from a wrong pairing this produced on real output.
 *
 * *Positional filler* — without it, "40 minutes ago" and "40 minutes" pair differently and
 * a faithful rephrasing is rejected over punctuation.
 *
 * *Pronouns and auxiliaries* — "the same **one we've** been trying to fix" filed a claim of
 * `1:weve`. "One" there is a pronoun, not a count, and the giveaway is that the word beside
 * it cannot be a thing you have one of.
 *
 * Adverbs are handled separately by their `-ly` ending rather than listed: "exit status 1,
 * **exactly** 40 minutes" paired the 1 with "exactly" and invented `1:exactly`.
 */
const FILLER = new Set([
  'ago', 'old', 'and', 'or', 'of', 'in', 'on', 'at', 'the', 'a', 'an', 'more', 'less', 'other', 'same',
  'not', 'sure', 'which', 'edited', 'now', 'for', 'to', 'is', 'was', 'not', 'know', 'idea',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'them', 'us', 'me', 'him', 'her', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'ive', 'weve', 'youve', 'theyve', 'its', 'im', 'thats',
]);

/** An adverb is never the thing being counted. Regular enough not to need a list. */
function isAdverb(word: string): boolean {
  return word.length > 3 && word.endsWith('ly');
}

/**
 * `errors` → `error`, `minutes` → `minute`. Crude on purpose: only plurals matter here.
 *
 * The exceptions are not pedantry — an early version turned "status" into "statu" and then
 * reported `exit status 1` as an invented figure, which is the exact false positive that
 * would make this check unusable.
 */
function singular(word: string): string {
  const bare = word.toLowerCase().replace(/[^a-z]/g, '');
  if (bare.length > 3 && bare.endsWith('ies')) return `${bare.slice(0, -3)}y`;
  if (/(ss|us|is|as)$/.test(bare)) return bare;
  if (bare.length > 2 && bare.endsWith('s')) return bare.slice(0, -1);
  return bare;
}

/** One number as it appeared, with every nearby word that might say what it counts. */
export interface NumberUse {
  value: number;
  nouns: Set<string>;
}

/** How far either side of a number to look for the thing it counts. */
const WINDOW = 2;

/**
 * Every number a piece of text uses, with its candidate nouns.
 *
 * **Both directions, and more than one word.** `40 minutes` reads forward and `exit 1`
 * reads back, so a forward-only rule files the second under nothing. And the window is two
 * words rather than one because *"exit status 1"* is a faithful way to say *"(exit 1)"* —
 * with a one-word window the pair becomes `1:status`, matches nothing, and a true sentence
 * is reported as invented. The check is worthless the first time it does that.
 *
 * **Numbers welded into an identifier are skipped entirely** — `src/app.ts`,
 * `m8-chat-agent`, `claude-haiku-4-5`. Those are names, and reading the 8 in a branch name
 * as a quantity is the other way this starts rejecting true sentences.
 */
export function numberUses(text: string): NumberUse[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const uses: NumberUse[] = [];

  tokens.forEach((raw, index) => {
    if (/[a-z].*\d|\d.*[a-z]/i.test(raw.replace(/^(\d+)(st|nd|rd|th)$/i, '$1'))) return;
    if (/[/\\.@:]/.test(raw)) return;

    const value = valueOf(raw.replace(/[^a-z0-9]/gi, ''));
    if (value === undefined) return;

    const nouns = new Set<string>();
    for (let step = 1; step <= WINDOW; step++) {
      for (const candidate of [tokens[index + step], tokens[index - step]]) {
        const noun = candidate ? singular(candidate) : '';
        if (noun && !FILLER.has(noun) && !isAdverb(noun) && valueOf(noun) === undefined) nouns.add(noun);
      }
    }

    uses.push({ value, nouns });
  });

  return uses;
}

/** Every `value:thing` a text supports, for matching against. */
export function numberClaims(text: string): Set<string> {
  const claims = new Set<string>();
  for (const use of numberUses(text)) for (const noun of use.nouns) claims.add(`${use.value}:${noun}`);
  return claims;
}

/**
 * The claims a line makes that its facts do not support.
 *
 * Empty means every number in it can be accounted for. Non-empty is not proof of a lie —
 * a model may legitimately rephrase — but it is the point at which the written line is the
 * safer thing to say.
 */
export function ungroundedClaims(said: string, facts: string): string[] {
  const allowed = numberClaims(facts);

  // **Per use, not per pair.** A sentence can mention forty minutes *and* a fortieth
  // occurrence; flattening the pairs would let the true half vouch for the false one. A
  // single number is accounted for if *any* word near it matches something it was given,
  // which is what lets a faithful rephrasing through.
  return numberUses(said)
    .filter((use) => use.nouns.size > 0 && ![...use.nouns].some((noun) => allowed.has(`${use.value}:${noun}`)))
    .map((use) => `${use.value}:${[...use.nouns][0]}`);
}
