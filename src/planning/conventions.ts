/**
 * The Conventions section of a generated plan (M9d2 — §4.9).
 *
 * A generated plan already carries §0's *working process* — Plan Mode, Code Mode,
 * sign-off — which is true in any language. It carried nothing about how to actually
 * write the code, so the agent built in whatever style its model reached for, and a
 * project someone comes back to in three months has no standard to come back to.
 *
 * **A lookup, never a model call**, and that is the load-bearing decision. A
 * hallucinated style rule presented as *your project's standard* is worse than a
 * generic one, because the person most in need of the rules is exactly the person who
 * cannot tell which ones were invented. A language nobody wrote an entry for gets the
 * generic set and says so.
 */

/** How chatty the code should be. Recorded during the interview, never assumed. */
export type CommentStyle = 'explanatory' | 'lean';

/** The idioms of one language, as far as we honestly know them. */
interface LanguageRules {
  /** Matched against whatever the user said, lowercased. */
  aliases: string[];
  label: string;
  rules: string[];
}

/**
 * The rules that hold anywhere.
 *
 * Deliberately short. Everything here has to be true of a Rust binary, a Python
 * script and a browser app alike — the moment a rule needs a qualifier it belongs in
 * a language entry instead, or nowhere.
 */
const UNIVERSAL = [
  'Names say what a thing is for, not what type it is. A name needing a comment to explain it is the wrong name.',
  'One job per function. If describing it needs the word "and", it is two functions.',
  'Handle the error where you can do something about it, not everywhere it could be mentioned.',
  'No dead code, no commented-out code, no "might need this later". The history remembers it for you.',
  'Anything worth testing goes somewhere it can be tested without starting the whole application.',
];

/**
 * Per-language idioms.
 *
 * Only what is genuinely characteristic of the language and would be *wrong* to state
 * in another. Generic good advice lives in `UNIVERSAL`; repeating it here in five
 * dialects would suggest the differences matter more than they do.
 */
const LANGUAGES: LanguageRules[] = [
  {
    aliases: ['python', 'py', 'python3'],
    label: 'Python',
    rules: [
      'PEP 8: `snake_case` for functions and variables, `PascalCase` for classes, four spaces.',
      'Type hints on anything public. They are documentation the interpreter can check.',
      'Prefer the standard library. `pathlib` over string paths, `dataclasses` over dicts-as-records.',
      'Context managers (`with`) for anything that has to be closed.',
    ],
  },
  {
    aliases: ['typescript', 'ts', 'javascript', 'js', 'node', 'nodejs', 'node.js'],
    label: 'TypeScript / JavaScript',
    rules: [
      '`camelCase` for functions and variables, `PascalCase` for types and classes.',
      'No `any`. A type you cannot express yet is `unknown`, which forces you to check it.',
      '`const` unless reassignment is the point. Prefer `map`/`filter` to loops that build arrays.',
      'Async all the way down: no callbacks where a promise fits, no `.then()` chains where `await` reads better.',
    ],
  },
  {
    aliases: ['go', 'golang'],
    label: 'Go',
    rules: [
      '`gofmt` decides formatting. It is not a style question and never was.',
      'Errors are returned and handled, never ignored with `_`. Wrap with context: `fmt.Errorf("...: %w", err)`.',
      'Short names in short scopes, longer names for longer lives. `i` in a loop, not `indexCounter`.',
      'Accept interfaces, return structs.',
    ],
  },
  {
    aliases: ['rust', 'rs'],
    label: 'Rust',
    rules: [
      '`cargo fmt` and `cargo clippy` decide formatting and lints. Both run clean before anything is done.',
      '`Result` for anything that can fail. `unwrap()` only where failure is genuinely impossible, and say why.',
      'Borrow before you clone. Reach for `clone()` when the borrow checker has a real point, not to quiet it.',
      '`snake_case` for functions, `PascalCase` for types, `SCREAMING_SNAKE_CASE` for constants.',
    ],
  },
];

/** How the comment decision is written into the plan, in the user's own terms. */
const COMMENT_RULES: Record<CommentStyle, string> = {
  explanatory:
    'Comments throughout, explaining what the code does and why it does it that way. Chosen for a codebase that gets read by people still learning it, including you in three months.',
  lean: 'Comments only where something is genuinely surprising. The code is expected to explain itself, and a comment marks the exception. What most professional codebases do.',
};

/** The one rule that is not a preference, whichever style was chosen. */
const COMMENTS_STAY_TRUE =
  'Whichever style: a comment describing what the code *used to* do is worse than no comment. Any line edited gets its comment updated with it. This one is correctness, not taste.';

/** The language entry, or `undefined` when nobody wrote one. */
function lookup(language: string | undefined): LanguageRules | undefined {
  if (!language) return undefined;

  const said = language.toLowerCase();
  return LANGUAGES.find((entry) => entry.aliases.some((alias) => said.includes(alias)));
}

/**
 * The Conventions section, as markdown.
 *
 * **Honest about what it does not know.** A language with no entry gets the universal
 * rules and a line saying the specifics are missing — which is useful, and reads as
 * what it is. Inventing four plausible-sounding idioms for a language nobody here has
 * written would be worse than the gap.
 */
export function conventionsSection(language: string | undefined, comments: CommentStyle | undefined): string {
  const entry = lookup(language);

  return [
    '## Conventions',
    '',
    'How the code in this project is written. The agent follows this, and so should',
    'anyone else — it is here to be read and argued with rather than held in a prompt',
    'nobody can see.',
    '',
    ...UNIVERSAL.map((rule) => `- ${rule}`),
    '',
    ...(entry
      ? [`**${entry.label}:**`, '', ...entry.rules.map((rule) => `- ${rule}`), '']
      : [
          language
            ? `**${language}:** nobody has written the specific idioms for this one down here yet, so the rules above are all this section can honestly claim. Follow whatever ${language} projects normally do, and write it in here when you settle on it.`
            : '**No language chosen yet**, so the rules above are all this section can claim.',
          '',
        ]),
    '**Comments:**',
    '',
    `- ${comments ? COMMENT_RULES[comments] : 'Not decided. Either style is defensible; pick one and write it here, so the agent stops guessing.'}`,
    `- ${COMMENTS_STAY_TRUE}`,
  ].join('\n');
}

/** Reads the interview's answer back as a setting. Anything unclear stays undecided. */
export function parseCommentStyle(answer: string | undefined): CommentStyle | undefined {
  if (!answer) return undefined;

  const said = answer.toLowerCase();
  if (/\b(lean|sparse|minimal|self.?document|professional|few|none|clean)\b/.test(said)) return 'lean';
  if (/\b(explanatory|throughout|chatty|verbose|lots|many|explain|learning|teach)\b/.test(said)) return 'explanatory';
  return undefined;
}
