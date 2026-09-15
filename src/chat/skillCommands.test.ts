import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SkillsList } from '../agent/tools/skillTools';
import type { SkillListing } from '../engine/relay/relayTypes';
import { BUILT_IN_COMMANDS, BUILT_IN_SLASHES, chatAction, SKILL_COMMAND_DESCRIPTION, slashAttempt } from './chatCommands';
import {
  clashesWithBuiltIn,
  codexSkillNote,
  codexSkillTask,
  commandsHelp,
  NO_RAVIS_SKILLS_LINE,
  planSkillCommand,
  SKILL_BUSY_LINES,
  skillForm,
  slashRows,
  WHICH_SKILL_LINE,
  type SkillCommandState,
  type SkillStep,
  type SkillUse,
} from './skillCommands';

/**
 * Skills as slash commands (the owner's decisions of 15 September 2026, with the peer session's rules the same day):
 * `/skill-name …` and `/skill <name or id> …`, the built-in winning, only switched-on skills, one plain line for
 * everything that can't run, nothing caught mid-sentence, and Codex asked through its own mention. Also `/help`'s text
 * and the pop-up's rows, which say how each skill is typed.
 */

const NOTES: SkillListing = { id: 'nervis/nervis-notes', name: 'nervis-notes', description: 'How NERVIS tasks keep their notes.' };
const CHANGELOG: SkillListing = { id: 'personal/changelog-generator', name: 'changelog-generator', description: 'Writes a changelog from the git history.' };
/** Named like `/status`, an alias of `/git`. */
const STATUS: SkillListing = { id: 'personal/status', name: 'status', description: 'A weekly status report.' };
/** The same name as NOTES, from the owner's own folder. */
const TWIN: SkillListing = { id: 'personal/nervis-notes', name: 'nervis-notes', description: 'My own way of keeping notes.' };

const listed = (...skills: SkillListing[]): SkillsList => ({ kind: 'listed', skills });
const ON = listed(NOTES, CHANGELOG, STATUS);
const IDLE: SkillCommandState = { engine: 'clarvis', planning: false, questionWaiting: false, running: false };
const CODEX: SkillCommandState = { ...IDLE, engine: 'codex' };

function step(message: string, list: SkillsList = ON, state: SkillCommandState = IDLE): SkillStep | 'routes as today' {
  const attempt = slashAttempt(message);
  return attempt ? planSkillCommand(attempt, list, state) : 'routes as today';
}

function said(message: string, list: SkillsList = ON, state: SkillCommandState = IDLE): string {
  const planned = step(message, list, state);
  if (typeof planned !== 'object' || planned.kind !== 'say') return assert.fail(`${message}: expected one line, got ${JSON.stringify(planned)}`);
  return planned.line;
}

function used(message: string, list: SkillsList = ON, state: SkillCommandState = IDLE): SkillUse {
  const planned = step(message, list, state);
  if (typeof planned !== 'object' || planned.kind !== 'use') return assert.fail(`${message}: expected a skill to use, got ${JSON.stringify(planned)}`);
  return planned.use;
}

// ── Built-ins win, and stay exactly as they were ───────────────────────────────

test('a built-in slash word, any alias and in any case, never reaches the skills, even when a skill has its name', () => {
  for (const command of BUILT_IN_COMMANDS) {
    for (const slash of command.slash) {
      for (const message of [slash, slash.toUpperCase(), `${slash} with words after it`, `  ${slash}`]) {
        assert.equal(slashAttempt(message), undefined, message);
      }
    }
  }
  // STATUS is switched on, and /status is still git's.
  assert.equal(step('/status', ON), 'routes as today');
  assert.equal(chatAction('/status'), 'explainGit');
  assert.equal(step('/plan my project'), 'routes as today', 'a built-in with words after it routes as it always did');
});

test('clashes are checked against every alias, as the peer session listed them', () => {
  const aliases = [
    '/help', '/?', '/manual', '/key', '/setkey', '/mute', '/unmute', '/git', '/status', '/where', '/branch', '/checkout', '/settings', '/options',
    '/config', '/engine', '/model', '/clearkey', '/testvoice', '/cache', '/voice', '/clear', '/history', '/forget', '/plan',
  ];
  assert.deepEqual([...BUILT_IN_SLASHES].sort(), [...aliases].sort());
  for (const alias of aliases) assert.equal(clashesWithBuiltIn(alias.slice(1).toUpperCase()), true, alias);
  assert.equal(clashesWithBuiltIn('skill'), true, 'the /skill command itself');
  assert.equal(clashesWithBuiltIn('changelog-generator'), false);
});

test('/help lists the commands and skills; /manual opens the manual, as the natural phrasings still do', () => {
  assert.equal(chatAction('/help'), 'listCommands');
  assert.equal(chatAction('/?'), 'listCommands');
  assert.equal(chatAction('/manual'), 'help');
  assert.equal(chatAction('open the manual'), 'help');
  assert.equal(chatAction('what does /help do?'), null, 'a slash command is still the whole message');
});

test('every built-in command has one short description, and every slash form is lowercase', () => {
  for (const command of BUILT_IN_COMMANDS) {
    assert.ok(command.description.length > 0 && command.description.length <= 60, `${command.slash[0]}: ${command.description}`);
    for (const slash of command.slash) assert.match(slash, /^\/[a-z?]+$/);
  }
});

// ── Using a skill ──────────────────────────────────────────────────────────────

test('/skill-name uses a switched-on skill by its name, in any case, with the request kept as it was typed', () => {
  assert.deepEqual(used('/changelog-generator write a changelog for this'), {
    engine: 'clarvis',
    skill: CHANGELOG,
    name: 'changelog-generator',
    request: 'write a changelog for this',
  });
  assert.equal(used('/Changelog-Generator Fix README.md for 0.17.7').request, 'Fix README.md for 0.17.7');
  assert.equal(used('  /changelog-generator\nwrite it\nand tag it  ').request, 'write it\nand tag it', 'leading spaces, a line break after the name');
});

test('/skill reaches a skill by its full id or its name, including one named like a built-in, and keeps the request case', () => {
  assert.equal(used('/skill nervis-notes Fix README.md').request, 'Fix README.md');
  assert.equal(used('/skill nervis/nervis-notes Keep notes').skill, NOTES);
  assert.equal(used('/SKILL NERVIS/Nervis-Notes Keep notes').skill, NOTES, 'the id in any case');
  assert.deepEqual(used('/skill status for this week'), { engine: 'clarvis', skill: STATUS, name: 'status', request: 'for this week' });
});

test('a skill switched off since the pop-up listed it stays off: only the list read as the message is sent counts', () => {
  const now = listed(NOTES, STATUS);
  assert.equal(said('/changelog-generator write it', now), "There's no command or switched-on skill called /changelog-generator. /help lists them.");
  assert.equal(said('/skill changelog-generator write it', now), "There's no switched-on skill called changelog-generator. /help lists them.");
});

test('two switched-on skills with one name: the short form names both full forms and runs nothing; the full id reaches either', () => {
  const both = listed(NOTES, TWIN);
  assert.equal(said('/nervis-notes keep notes', both), 'More than one switched-on skill is called nervis-notes: type `/skill nervis/nervis-notes` or `/skill personal/nervis-notes`.');
  assert.equal(said('/skill nervis-notes keep notes', both), 'More than one switched-on skill is called nervis-notes: type `/skill nervis/nervis-notes` or `/skill personal/nervis-notes`.');
  assert.equal(used('/skill personal/nervis-notes keep notes', both).skill, TWIN);
});

test('a skill named without a request asks what to do, in one line, and nothing runs', () => {
  assert.equal(said('/changelog-generator'), 'What should `/changelog-generator` do? Type it again with the request after the name.');
  assert.equal(said('/skill nervis/nervis-notes   '), 'What should `/skill nervis/nervis-notes` do? Type it again with the request after the name.');
  assert.equal(said('/skill'), WHICH_SKILL_LINE);
});

// ── Nothing typed by mistake reaches a model ───────────────────────────────────

test('an unknown command gets one plain line and is never a task', () => {
  assert.equal(said('/foo'), "There's no command or switched-on skill called /foo. /help lists them.");
  assert.equal(said('/deploy the site now'), "There's no command or switched-on skill called /deploy. /help lists them.");
  assert.equal(said('/foo', { kind: 'not_used' }), "There's no command or switched-on skill called /foo. /help lists them.", 'the coding model is elsewhere');
  assert.equal(said('/skill foo do it', { kind: 'not_used' }), NO_RAVIS_SKILLS_LINE);
});

test('paths and slashes that merely start a message or sit mid-sentence route as they always did', () => {
  for (const message of [
    'use /changelog-generator for this',
    'what does /changelog-generator do?',
    '/src/app.ts is broken',
    '//comment out the test',
    '/',
    '/ this is not a command',
  ]) {
    assert.equal(step(message), 'routes as today', message);
  }
  // A first word no skill has, that doesn't look like a command: a folder, a file, a number.
  for (const message of ['/tmp is full', '/usr', '/Users is where it lives', '/2 tests fail', '/foo.txt is missing', '/?? what']) {
    assert.deepEqual(step(message), { kind: 'pass' }, message);
  }
});

test("a list that can't be read runs nothing for a command-shaped word, and lets a folder-shaped one route on", () => {
  const failed: SkillsList = { kind: 'failed', why: "RAVIS didn't answer (connect ECONNREFUSED)" };
  assert.equal(said('/changelog-generator write it', failed), "I couldn't read your skills from RAVIS, so `/changelog-generator` didn't run.");
  assert.equal(said('/skill notes write it', failed), "I couldn't read your skills from RAVIS, so `/skill notes` didn't run.");
  assert.deepEqual(step('/tmp is full', failed), { kind: 'pass' });
});

// ── Not while something else is going on ──────────────────────────────────────

test('a skill typed while planning, while a question waits or while a run is going gets one line, and is nobody’s answer', () => {
  assert.equal(said('/changelog-generator write it', ON, { ...IDLE, planning: true }), SKILL_BUSY_LINES.planning);
  assert.equal(said('/changelog-generator write it', ON, { ...IDLE, questionWaiting: true }), SKILL_BUSY_LINES.question);
  assert.equal(said('/skill status for this week', ON, { ...IDLE, running: true }), SKILL_BUSY_LINES.running);
  assert.equal(said('/changelog-generator', ON, { ...IDLE, running: true }), SKILL_BUSY_LINES.running, 'without a request too');
  assert.equal(said('/changelog-generator write it', ON, { ...IDLE, planning: true, questionWaiting: true, running: true }), SKILL_BUSY_LINES.planning);
  assert.equal(said('/changelog-generator write it', ON, { ...IDLE, questionWaiting: true, running: true }), SKILL_BUSY_LINES.question, 'the question on screen first');
  assert.deepEqual(SKILL_BUSY_LINES, {
    planning: "A skill can't start while I'm planning. Finish or stop it first.",
    question: 'Answer the question first; the skill can wait.',
    running: "A skill can't start while a run is going. Finish or stop it first.",
  });
  // An unknown command is still just unknown, and a path still routes to whatever is waiting for it.
  assert.equal(said('/foo', ON, { ...IDLE, running: true }), "There's no command or switched-on skill called /foo. /help lists them.");
  assert.deepEqual(step('/tmp is full', ON, { ...IDLE, questionWaiting: true }), { kind: 'pass' });
});

// ── Codex ──────────────────────────────────────────────────────────────────────

test("with Codex, a skill is asked for with Codex's own mention, and the owner is told Codex decides by its own switch", () => {
  const use = used('/changelog-generator write a changelog for this', ON, CODEX);
  assert.deepEqual(use, { engine: 'codex', skill: CHANGELOG, name: 'changelog-generator', request: 'write a changelog for this' });
  assert.equal(codexSkillTask(use, use.request), '$changelog-generator write a changelog for this');
  assert.equal(codexSkillNote(use), "Asking Codex to use the skill `changelog-generator`. Codex uses it if it's switched on for Codex on the Skills page.");
});

test('with Codex, /skill reaches a skill only Codex has, even when the list can’t be read; the short form still needs a skill Clarvis can see', () => {
  assert.deepEqual(used('/skill imagegen draw a bowtie', ON, CODEX), { engine: 'codex', skill: undefined, name: 'imagegen', request: 'draw a bowtie' });
  assert.equal(used('/skill imagegen draw a bowtie', { kind: 'failed', why: 'down' }, CODEX).name, 'imagegen');
  assert.equal(
    said('/imagegen draw a bowtie', ON, CODEX),
    "There's no command or switched-on skill called /imagegen. /help lists them. For a skill only Codex has, type /skill imagegen and the request."
  );
  assert.equal(said('/skill imagegen draw', ON, { ...CODEX, running: true }), SKILL_BUSY_LINES.running);
  assert.equal(said('/skill imagegen', ON, CODEX), 'What should `/skill imagegen` do? Type it again with the request after the name.');
});

test("with Codex, a name Codex's mentions can't carry is refused in one line; Clarvis's own engine has no such limit", () => {
  const dotted: SkillListing = { id: 'personal/notes-v2', name: 'notes.v2', description: 'Notes, again.' };
  const refused = "Codex can't be pointed at a skill called `notes.v2`: its skill mentions take only letters, digits, -, _ and :, and never a name like PATH or HOME.";
  assert.equal(said('/notes.v2 keep notes', listed(dotted), CODEX), refused);
  assert.equal(used('/notes.v2 keep notes', listed(dotted), IDLE).skill, dotted);
  assert.match(said('/skill path fix it', ON, CODEX), /can't be pointed at a skill called `path`/, 'Codex reads $PATH as the variable');
  assert.equal(used('/skill team:notes keep notes', ON, CODEX).name, 'team:notes', 'a colon is a mention character');
});

// ── How a skill is typed: the pop-up and /help ─────────────────────────────────

test('each skill is typed as /name, as /skill name when a built-in has the name, and as /skill <id> when two share it or it has a space', () => {
  const spaced: SkillListing = { id: 'personal/weekly-report', name: 'weekly report', description: 'The report.' };
  const skills = [NOTES, TWIN, STATUS, CHANGELOG, spaced];
  assert.deepEqual(
    skills.map((skill) => skillForm(skill, skills)),
    ['/skill nervis/nervis-notes', '/skill personal/nervis-notes', '/skill status', '/changelog-generator', '/skill personal/weekly-report']
  );
});

test("the pop-up's rows: every built-in form with its description, /skill, then each skill as it is typed", () => {
  const config: SkillListing = { id: 'nervis/config', name: 'config', description: 'Config conventions.\nSecond line.' };
  const rows = slashRows([NOTES, TWIN, CHANGELOG, config]);
  const byLabel = new Map(rows.map((row) => [row.label, row]));

  assert.deepEqual(byLabel.get('/help'), { kind: 'command', label: '/help', insert: '/help ', keys: ['/help'], description: 'List these commands and your skills', primary: true });
  assert.deepEqual(byLabel.get('/?'), { kind: 'command', label: '/?', insert: '/? ', keys: ['/?'], description: 'List these commands and your skills', primary: false });
  assert.equal(byLabel.get('/status')?.primary, false, 'an alias shows once its letters are typed');
  assert.deepEqual(byLabel.get('/skill'), { kind: 'command', label: '/skill', insert: '/skill ', keys: ['/skill'], description: SKILL_COMMAND_DESCRIPTION, primary: true });
  assert.equal(rows.filter((row) => row.kind === 'command').length, [...BUILT_IN_SLASHES].length + 1);

  assert.deepEqual(
    rows.filter((row) => row.kind === 'skill'),
    [
      { kind: 'skill', label: '/skill nervis/nervis-notes', insert: '/skill nervis/nervis-notes ', keys: ['/skill', '/nervis-notes'], description: NOTES.description, primary: true },
      { kind: 'skill', label: '/skill personal/nervis-notes', insert: '/skill personal/nervis-notes ', keys: ['/skill', '/nervis-notes'], description: TWIN.description, primary: true },
      { kind: 'skill', label: '/changelog-generator', insert: '/changelog-generator ', keys: ['/changelog-generator'], description: CHANGELOG.description, primary: true },
      { kind: 'skill', label: '/skill config', insert: '/skill config ', keys: ['/skill', '/config'], description: 'Config conventions. Second line.', primary: true },
    ]
  );
});

test("RAVIS's text in the rows stays text on one line, with no backtick to break inline code", () => {
  const odd: SkillListing = { id: 'personal/odd', name: '<b>`odd`</b>', description: '<script>alert(1)</script>' };
  const [row] = slashRows([odd]).filter((candidate) => candidate.kind === 'skill');
  assert.equal(row.label, "/skill personal/odd", 'a slash in the name means the full id');
  assert.equal(row.description, '<script>alert(1)</script>');
  assert.equal(slashRows([{ ...odd, id: 'personal/odd', name: '`odd`' }]).slice(-1)[0]?.label, "/'odd'");
});

test('/help lists the built-in commands with their descriptions, then the switched-on skills and how to type a clashing one', () => {
  const help = commandsHelp(listed(NOTES, CHANGELOG, STATUS), 'clarvis').split('\n');

  assert.equal(help[0], 'Commands:');
  assert.deepEqual(help.slice(1, 1 + BUILT_IN_COMMANDS.length), BUILT_IN_COMMANDS.map((command) => help.find((line) => line.endsWith(`: ${command.description}`))));
  assert.ok(help.includes('`/help` or `/?`: List these commands and your skills'));
  assert.ok(help.includes('`/manual`: Open the full manual'));
  assert.ok(help.includes('`/git`, `/status` or `/where`: Where you are in git, in plain words'));
  assert.ok(help.includes(`\`/skill <name>\`: ${SKILL_COMMAND_DESCRIPTION}`));
  assert.deepEqual(help.slice(-4), [
    "Skills switched on for Clarvis's own engine. Type one, then what to do:",
    '`/nervis-notes`: How NERVIS tasks keep their notes.',
    '`/changelog-generator`: Writes a changelog from the git history.',
    '`/skill status`: A weekly status report. (`/status` is a command, so type `/skill status`)',
  ]);
  assert.match(commandsHelp(listed(NOTES, TWIN), 'clarvis'), /`\/skill personal\/nervis-notes`: My own way of keeping notes\. \(another skill has this name, or it can't be typed on its own, so use the full id\)/);
});

test('/help says plainly when there are no skills, when they can’t be read, and what Codex does with them', () => {
  assert.equal(commandsHelp(listed(), 'clarvis').split('\n').slice(-1)[0], "No skills are switched on for Clarvis's own engine. NERVIS's Skills page switches them on.");
  assert.equal(commandsHelp({ kind: 'not_used' }, 'clarvis').split('\n').slice(-1)[0], NO_RAVIS_SKILLS_LINE);
  assert.equal(commandsHelp({ kind: 'failed', why: 'down' }, 'clarvis').split('\n').slice(-1)[0], "I couldn't read your skills from RAVIS just now, so they aren't listed.");
  assert.match(commandsHelp(listed(NOTES), 'codex'), /A job asks Codex for one: Codex uses it if it's switched on for Codex on the Skills page\. `\/skill <name>` also reaches a skill only Codex has\./);
  assert.match(commandsHelp(listed(), 'codex'), /Codex picks its own: `\/skill <name>` and a request asks it to use one, and Codex uses it if it's switched on for Codex on the Skills page\./);
});
