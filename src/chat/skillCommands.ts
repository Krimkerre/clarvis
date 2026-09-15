/**
 * Skills as slash commands: what a message starting with `/` asks for, once it isn't a built-in (the owner's decisions of
 * 15 September 2026, with the peer session's rules the same day).
 *
 * - **`/skill-name …` uses a switched-on skill by its own name**; `/skill <name or id> …` always reaches one, whatever it
 *   is called. A built-in command wins over a skill of the same name, alias included, and never reaches this file
 *   (`chatCommands.slashAttempt`).
 * - **Only skills switched on for the engine in use.** Clarvis's own engine reads RAVIS's list for the models that aren't
 *   Codex; a skill switched off stays off even when typed. Codex keeps its own switches, which RAVIS enforces and Clarvis
 *   can't read, so a Codex job is sent Codex's own mention, `$name`, and told so in one line.
 * - **Nothing typed by mistake is sent to a model.** An unknown command, a skill named without a request, a name two
 *   skills share, a list that couldn't be read, and a skill typed while planning, while a run is going or while a question
 *   waits: each gets one plain line, and nothing runs.
 * - **Only the first word, and only when it names a command or a skill.** A path or a slash mid-sentence routes as it
 *   always did.
 *
 * Also `/help`'s text and the suggestions pop-up's rows, so the rule for how a skill is typed is written once.
 *
 * Pure and `vscode`-free, like `chatCommands.ts`: which words mean which skill shouldn't need an extension host to test.
 */

import { skillDescriptionLine, skillTextLine } from '../agent/agentPrompt';
import type { SkillsList } from '../agent/tools/skillTools';
import type { SkillListing } from '../engine/relay/relayTypes';
import { BUILT_IN_COMMANDS, BUILT_IN_SLASHES, SKILL_COMMAND, SKILL_COMMAND_DESCRIPTION, type SlashAttempt } from './chatCommands';

/** The coding engine a job would go to. Answers are always Clarvis's own chat model. */
export type SlashEngine = 'clarvis' | 'codex';

/** What else is going on when a skill command arrives. */
export interface SkillCommandState {
  readonly engine: SlashEngine;
  /** The planning interview is under way: every message is its answer. */
  readonly planning: boolean;
  /** A question is on screen, waiting for its answer: a step, a landing offer, any offer. */
  readonly questionWaiting: boolean;
  /** A coding run is going. */
  readonly running: boolean;
}

/** A skill to use, and what for. */
export interface SkillUse {
  readonly engine: SlashEngine;
  /** The skill as RAVIS lists it for Clarvis's own engine. Absent only for a skill named to Codex that this list doesn't hold. */
  readonly skill?: SkillListing;
  /** The name Codex is asked for: the skill's own, as RAVIS lists it, or as typed. */
  readonly name: string;
  /** Everything after the skill's name, in its own case. Never empty. */
  readonly request: string;
}

export type SkillStep =
  /** Not a skill command: route the message as today. */
  | { kind: 'pass' }
  /** One line in the chat, and nothing runs. */
  | { kind: 'say'; line: string; log: string }
  | { kind: 'use'; use: SkillUse; log: string };

// ── The lines ──────────────────────────────────────────────────────────────────

export const SKILL_BUSY_LINES = {
  planning: "A skill can't start while I'm planning. Finish or stop it first.",
  question: 'Answer the question first; the skill can wait.',
  running: "A skill can't start while a run is going. Finish or stop it first.",
} as const;

export const WHICH_SKILL_LINE = "Which skill? Type `/skill`, the skill's name, then what to do. /help lists them.";

export const NO_RAVIS_SKILLS_LINE = "Skills come through RAVIS, and your coding model doesn't use it, so there are none to use here.";

/** The owner's words for a skill Codex is asked for: Clarvis can't read Codex's switches. */
export const CODEX_SKILLS_NOTE = "Codex uses it if it's switched on for Codex on the Skills page.";

export function unknownCommandLine(word: string, engine: SlashEngine): string {
  const codex = engine === 'codex' ? ` For a skill only Codex has, type /skill ${word.slice(1)} and the request.` : '';
  return `There's no command or switched-on skill called ${word}. /help lists them.${codex}`;
}

export function unknownSkillLine(name: string): string {
  return `There's no switched-on skill called ${name}. /help lists them.`;
}

export function noRequestLine(typed: string): string {
  return `What should \`${typed}\` do? Type it again with the request after the name.`;
}

export function listFailedLine(typed: string): string {
  return `I couldn't read your skills from RAVIS, so \`${typed}\` didn't run.`;
}

/** Codex's mentions take `[A-Za-z0-9_:-]` and skip common environment variables (Codex 0.154's `skills/src/mentions.rs`). */
export function codexUnmentionableLine(name: string): string {
  return `Codex can't be pointed at a skill called \`${name}\`: its skill mentions take only letters, digits, -, _ and :, and never a name like PATH or HOME.`;
}

/** Said before a Codex job that uses a skill. */
export function codexSkillNote(use: SkillUse): string {
  return `Asking Codex to use the skill \`${use.name}\`. ${CODEX_SKILLS_NOTE}`;
}

/** An answer uses Clarvis's own chat model, which can load only a skill switched on for it. */
export function notForAnswersLine(name: string): string {
  return `The skill \`${name}\` isn't switched on for Clarvis's own engine, so I can't load it to answer. Only a job goes to Codex.`;
}

/**
 * A Codex job that uses a skill: the request with Codex's explicit mention in front, `$name request`. Codex 0.154 collects
 * `$name` from a turn's text and applies the skill only while it is enabled for Codex (`collect_explicit_skill_mentions`).
 */
export function codexSkillTask(use: SkillUse, task: string): string {
  return `$${use.name} ${task}`;
}

// ── Deciding ───────────────────────────────────────────────────────────────────

/**
 * Top-level folders a message may start with. `/tmp is full` is about a folder: when no skill has that name it routes as
 * a message rather than getting the unknown-command line.
 */
const ROOT_FOLDERS = new Set(['applications', 'bin', 'dev', 'etc', 'home', 'lib', 'library', 'mnt', 'opt', 'private', 'proc', 'root', 'sbin', 'srv', 'system', 'tmp', 'users', 'usr', 'var', 'volumes']);

/** Environment variables Codex never reads as a skill mention (Codex 0.154's `is_common_env_var`). */
const CODEX_ENV_NAMES = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM', 'XDG_CONFIG_HOME']);

/**
 * What a slash attempt asks for, against the skills switched on **now** (`list`, read as the message is sent; never the
 * pop-up's copy).
 */
export function planSkillCommand(attempt: SlashAttempt, list: SkillsList, state: SkillCommandState): SkillStep {
  const long = attempt.word.toLowerCase() === SKILL_COMMAND;
  const target = long ? firstWord(attempt.rest) : { word: attempt.word.slice(1), rest: attempt.rest };
  if (long && !target.word) return say(WHICH_SKILL_LINE, '/skill named no skill');
  const skills = list.kind === 'listed' ? list.skills : [];
  const found = long ? findByIdOrName(target.word, skills) : findByName(target.word, skills);
  const typed = long ? `${attempt.word} ${target.word}` : attempt.word;
  if (found.length > 1) return say(ambiguousLine(target.word, found), `${found.length} skills are called ${target.word}`);
  if (found.length === 1) return using({ skill: found[0], name: found[0].name, request: target.rest, typed }, state);
  // Codex needs no list to be asked for a skill by name: its switches are its own.
  if (long && state.engine === 'codex') return using({ name: target.word, request: target.rest, typed }, state);
  return notFound(attempt, long, target.word, list, state.engine);
}

function using(found: { skill?: SkillListing; name: string; request: string; typed: string }, state: SkillCommandState): SkillStep {
  const busy = busyLine(state);
  const id = found.skill?.id ?? found.name;
  if (busy) return say(busy, `${id} not started — something else is under way`);
  if (!found.request) return say(noRequestLine(found.typed), `${id} named without a request`);
  if (state.engine === 'codex' && !mentionable(found.name)) return say(codexUnmentionableLine(found.name), `${id} can't be mentioned to Codex`);
  return { kind: 'use', use: { engine: state.engine, skill: found.skill, name: found.name, request: found.request }, log: `${id} invoked for ${state.engine === 'codex' ? 'Codex' : "Clarvis's own engine"}` };
}

/** Planning first, then a question on screen, then a run: the most specific thing to finish first. */
function busyLine(state: SkillCommandState): string | undefined {
  if (state.planning) return SKILL_BUSY_LINES.planning;
  if (state.questionWaiting) return SKILL_BUSY_LINES.question;
  return state.running ? SKILL_BUSY_LINES.running : undefined;
}

function notFound(attempt: SlashAttempt, long: boolean, name: string, list: SkillsList, engine: SlashEngine): SkillStep {
  // A path-like or sentence-like first word routes as it always did: only a command-shaped word gets a line.
  if (!long && !looksLikeCommand(attempt.word)) return { kind: 'pass' };
  const typed = long ? `${attempt.word} ${name}` : attempt.word;
  if (list.kind === 'failed') return say(listFailedLine(typed), `skills not listed — ${list.why}`);
  if (long && list.kind === 'not_used') return say(NO_RAVIS_SKILLS_LINE, 'the coding model does not use RAVIS');
  return long ? say(unknownSkillLine(name), `no skill ${name}`) : say(unknownCommandLine(attempt.word, engine), `no command or skill ${attempt.word}`);
}

/** `/word` of letters, digits, `_`, `-` and `:`, starting with a letter, and not a top-level folder. */
function looksLikeCommand(word: string): boolean {
  return /^\/\p{L}[\p{L}\p{N}_:-]*$/u.test(word) && !ROOT_FOLDERS.has(word.slice(1).toLowerCase());
}

function mentionable(name: string): boolean {
  return /^[A-Za-z0-9_:-]+$/.test(name) && !CODEX_ENV_NAMES.has(name.toUpperCase());
}

function findByName(word: string, skills: readonly SkillListing[]): readonly SkillListing[] {
  const lower = word.toLowerCase();
  return skills.filter((skill) => skill.name.toLowerCase() === lower);
}

/** The full id first, exactly and then in any case; then the name, which must be unique to be used. */
function findByIdOrName(word: string, skills: readonly SkillListing[]): readonly SkillListing[] {
  const exact = skills.filter((skill) => skill.id === word);
  if (exact.length > 0) return exact;
  const loose = skills.filter((skill) => skill.id.toLowerCase() === word.toLowerCase());
  return loose.length === 1 ? loose : findByName(word, skills);
}

function firstWord(text: string): { word: string; rest: string } {
  const space = text.search(/\s/);
  return space === -1 ? { word: text, rest: '' } : { word: text.slice(0, space), rest: text.slice(space).trim() };
}

function say(line: string, log: string): SkillStep {
  return { kind: 'say', line, log };
}

function ambiguousLine(name: string, skills: readonly SkillListing[]): string {
  const forms = skills.map((skill) => `\`${SKILL_COMMAND} ${shown(skill.id)}\``);
  return `More than one switched-on skill is called ${shown(name)}: type ${forms.slice(0, -1).join(', ')} or ${forms[forms.length - 1]}.`;
}

// ── How a skill is typed: /help and the pop-up ────────────────────────────────

/**
 * How the owner types a skill: `/name`; `/skill name` when the name is a built-in's, any alias counted, or `skill`; and
 * `/skill <id>` when another switched-on skill shares the name, or the name has a space or a slash in it.
 */
export function skillForm(skill: SkillListing, skills: readonly SkillListing[]): string {
  const lower = skill.name.toLowerCase();
  const shared = skills.some((other) => other.id !== skill.id && other.name.toLowerCase() === lower);
  if (shared || !/^[^\s/]+$/.test(skill.name)) return `${SKILL_COMMAND} ${skill.id}`;
  return clashesWithBuiltIn(skill.name) ? `${SKILL_COMMAND} ${skill.name}` : `/${skill.name}`;
}

/** Whether `/name` is already a built-in's, alias included, or the `/skill` command itself. */
export function clashesWithBuiltIn(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === SKILL_COMMAND.slice(1) || BUILT_IN_SLASHES.has(`/${lower}`);
}

/** One row of the suggestions pop-up. */
export interface SlashRow {
  readonly kind: 'command' | 'skill';
  /** What the row shows. */
  readonly label: string;
  /** What Enter or Tab puts in the box: the command, then a space. */
  readonly insert: string;
  /** Lowercased slash words the typed word is a prefix of, for the row to show. Compared as plain text, never a pattern. */
  readonly keys: readonly string[];
  readonly description: string;
  /** Shown for a lone `/`. An alias row is shown only once its own letters are typed. */
  readonly primary: boolean;
}

/** The pop-up's rows: every built-in form with its description, `/skill`, then each skill as it is typed. */
export function slashRows(skills: readonly SkillListing[]): SlashRow[] {
  const commands = [...BUILT_IN_COMMANDS, { slash: [SKILL_COMMAND], description: SKILL_COMMAND_DESCRIPTION }].flatMap((command) =>
    command.slash.map(
      (slash, index): SlashRow => ({ kind: 'command', label: slash, insert: `${slash} `, keys: [slash], description: command.description, primary: index === 0 })
    )
  );
  const skillRows = skills.map((skill): SlashRow => {
    const form = shown(skillForm(skill, skills));
    const keys = form.startsWith(`${SKILL_COMMAND} `) ? [SKILL_COMMAND, `/${shown(skill.name).toLowerCase()}`] : [form.toLowerCase()];
    return { kind: 'skill', label: form, insert: `${form} `, keys, description: skillDescriptionLine(skill.description), primary: true };
  });
  return [...commands, ...skillRows];
}

/** `/help`: the built-in commands with their descriptions, then the skills and how to type each. */
export function commandsHelp(list: SkillsList, engine: SlashEngine): string {
  return [
    'Commands:',
    ...BUILT_IN_COMMANDS.map((command) => `${slashForms(command.slash)}: ${command.description}`),
    `\`${SKILL_COMMAND} <name>\`: ${SKILL_COMMAND_DESCRIPTION}`,
    '',
    ...skillsHelp(list, engine),
  ].join('\n');
}

function skillsHelp(list: SkillsList, engine: SlashEngine): string[] {
  if (list.kind === 'not_used') return [NO_RAVIS_SKILLS_LINE];
  if (list.kind === 'failed') return ["I couldn't read your skills from RAVIS just now, so they aren't listed."];
  if (list.skills.length === 0) {
    return [
      engine === 'codex'
        ? "No skills are switched on for Clarvis's own engine. Codex picks its own: `/skill <name>` and a request asks it to use one, and Codex uses it if it's switched on for Codex on the Skills page."
        : "No skills are switched on for Clarvis's own engine. NERVIS's Skills page switches them on.",
    ];
  }
  const heading =
    engine === 'codex'
      ? `Skills switched on for Clarvis's own engine. A job asks Codex for one: ${CODEX_SKILLS_NOTE} \`/skill <name>\` also reaches a skill only Codex has.`
      : "Skills switched on for Clarvis's own engine. Type one, then what to do:";
  return [heading, ...list.skills.map((skill) => skillHelpLine(skill, list.skills))];
}

function skillHelpLine(skill: SkillListing, skills: readonly SkillListing[]): string {
  const form = skillForm(skill, skills);
  const name = shown(skill.name);
  const why = !form.startsWith(`${SKILL_COMMAND} `)
    ? ''
    : form === `${SKILL_COMMAND} ${skill.name}`
      ? ` (\`/${name.toLowerCase()}\` is a command, so type \`${SKILL_COMMAND} ${name}\`)`
      : " (another skill has this name, or it can't be typed on its own, so use the full id)";
  return `\`${shown(form)}\`: ${skillDescriptionLine(skill.description)}${why}`;
}

function slashForms(slash: readonly string[]): string {
  const quoted = slash.map((form) => `\`${form}\``);
  return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

/** RAVIS's text for the chat: one line, and no backtick to break the inline code it sits in. */
function shown(value: string): string {
  return skillTextLine(value).replace(/`/g, "'");
}
