/**
 * FakeRavisRelay's skills for the models that aren't Codex (RAVIS 0.27.0; `skills.json` → `GET /api/v1/skills/models` and
 * `GET /api/v1/skills/models/read`): the list a run of Clarvis's own engine reads at its start, and the reads of a skill's
 * files, checked the way the fixture's route rules say RAVIS checks them.
 *
 * **Still a labelled test double.** It reads no folder and keeps no switch on disk. Its skills are the fixtures' own: the
 * list example's two, with `nervis/nervis-notes` holding the `SKILL.md` and `references/guide.md` its read examples show,
 * and the files the refusal examples name (`references/all-notes.md` over the cap, `assets/diagram.png` not text). Where the
 * fixtures show no text — graphify's `SKILL.md` — the text says it is a stand-in.
 *
 * Test controls: `skills` (every skill RAVIS read whole, in its order) and `on` (the ids switched on for the other models;
 * the list example has both on). `reads` records each read the way RAVIS logs it, the skill and the file, never the text.
 * Test support only.
 */

import { fixtureAnswer, type FakeAnswer } from './fakeAnswers';
import { exampleNamed, SKILL_READ_ROUTE, SKILLS_LIST_ROUTE, type FixtureRoute } from './relayContract';

/** The most a served file may hold (`skills.json` → skills.reading). */
const MOST_BYTES = 64 * 1024;

/** The NERVIS folder's skills come first, then the owner's personal ones (`skills.json` → the list's rules). */
const SOURCE_ORDER = ['nervis', 'personal'];

export interface FakeSkill {
  id: string;
  name: string;
  description: string;
  /** Its files, by their path inside the skill's folder. A `Buffer` holds bytes that needn't be UTF-8. */
  files: Record<string, string | Buffer>;
}

export class FakeSkills {
  readonly skills: FakeSkill[];
  /** The ids switched on for the other models. */
  readonly on: Set<string>;
  /** Each read as `<skill> <file>`: what RAVIS logs, never what the file says. */
  readonly reads: string[] = [];

  constructor() {
    const listed = (exampleNamed(SKILLS_LIST_ROUTE, 'the skills switched on for other models').response.body as { skills: Omit<FakeSkill, 'files'>[] })
      .skills;
    const text = (name: string) => (exampleNamed(SKILL_READ_ROUTE, name).response.body as { text: string }).text;
    const files: Record<string, Record<string, string | Buffer>> = {
      'nervis/nervis-notes': {
        'SKILL.md': text("a skill's SKILL.md"),
        'references/guide.md': text('another file of the skill'),
        'references/all-notes.md': 'A stand-in, one byte over the cap.\n'.padEnd(MOST_BYTES + 1, '.'),
        // A PNG's signature: 0x89 can't start a UTF-8 character.
        'assets/diagram.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    };
    this.skills = listed.map((skill) => ({ ...skill, files: files[skill.id] ?? { 'SKILL.md': standIn(skill) } }));
    this.on = new Set(listed.map((skill) => skill.id));
  }

  /** The answer for a skills route, or undefined for any other route. */
  answer(route: FixtureRoute, url: URL): FakeAnswer | undefined {
    if (route.key === SKILLS_LIST_ROUTE) return { status: 200, body: { skills: this.listed() } };
    if (route.key !== SKILL_READ_ROUTE) return undefined;
    return this.read(url.searchParams.get('skill') ?? '', url.searchParams.get('file') ?? 'SKILL.md');
  }

  /** Every skill switched on, the NERVIS folder's first and by name within each. */
  private listed(): Omit<FakeSkill, 'files'>[] {
    return this.skills
      .filter((skill) => this.on.has(skill.id))
      .sort((a, b) => SOURCE_ORDER.indexOf(sourceOf(a.id)) - SOURCE_ORDER.indexOf(sourceOf(b.id)) || a.name.localeCompare(b.name))
      .map(({ id, name, description }) => ({ id, name, description }));
  }

  /**
   * The read's rules in RAVIS's order: a skill that isn't on is `SKILL_NOT_FOUND` whatever the file, so a caller learns
   * nothing about skills it may not read; then the path's shape; then whether the file is there, its size and its text.
   */
  private read(id: string, file: string): FakeAnswer {
    this.reads.push(`${id} ${file}`);
    const skill = this.on.has(id) ? this.skills.find((candidate) => candidate.id === id) : undefined;
    if (!skill) return fixtureAnswer(SKILL_READ_ROUTE, 'a skill switched off, or unknown');
    const refused = pathRefusal(file);
    if (refused) return fixtureAnswer(SKILL_READ_ROUTE, refused === 'hidden' ? 'a hidden file' : 'a path out of the skill');
    const content = Object.hasOwn(skill.files, file) ? skill.files[file] : undefined;
    if (content === undefined) return fixtureAnswer(SKILL_READ_ROUTE, 'no such file');
    const bytes = Buffer.from(content);
    if (bytes.length > MOST_BYTES) return fixtureAnswer(SKILL_READ_ROUTE, 'a file over the cap');
    const text = utf8(bytes);
    if (text === undefined) return fixtureAnswer(SKILL_READ_ROUTE, "a file that isn't text");
    return { status: 200, body: { skill: skill.id, name: skill.name, file, bytes: bytes.length, text } };
  }
}

/**
 * `skills.json`'s path rule: an absolute path, an empty, `.` or `..` part, a backslash or a control character is
 * `outside_skill`; a part starting with a dot is `hidden`.
 */
function pathRefusal(file: string): 'outside_skill' | 'hidden' | undefined {
  if (file.startsWith('/') || file.includes('\\') || /\p{Cc}/u.test(file)) return 'outside_skill';
  const parts = file.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return 'outside_skill';
  return parts.some((part) => part.startsWith('.')) ? 'hidden' : undefined;
}

function sourceOf(id: string): string {
  return id.split('/')[0];
}

function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function standIn(skill: Omit<FakeSkill, 'files'>): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\nA stand-in: the fixtures show no text for this skill.\n`;
}
