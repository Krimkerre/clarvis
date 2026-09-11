/**
 * What a failed command says is missing from this computer — and what to do about it.
 *
 * **Why this exists.** 11 September 2026: a planned pomodoro timer needed tkinter, and the
 * Python on this machine had been built without it. The command said so in one line —
 * `ModuleNotFoundError: No module named '_tkinter'` — and the run carried on regardless: it
 * tried to reinstall the machine's Python, ticked steps whose checks had never run, rewrote
 * the plan to say they "cannot be tested", and chat later said the project was written in
 * Go. None of that was the dependency's fault. A missing piece of the machine was treated as
 * something to work around, when it is a question for the person whose machine it is.
 *
 * So the run stops and asks, in every mode, the way the deny-list gate does for `rm -rf`.
 * Today it was tkinter; this reads the shapes the common toolchains use to say "not here",
 * so tomorrow's missing compiler or package gets the same treatment.
 *
 * Pure — no `vscode` — so every shape below is exercised under `node --test`.
 */

/** What sort of thing is missing, which decides what can be done about it. */
export type MissingKind = 'package' | 'program' | 'system-part';

export interface MissingDependency {
  /** What is missing, in the words a person would search for. */
  name: string;
  kind: MissingKind;
  /** One plain phrase about what it is. */
  about: string;
  /** The output line that said so, trimmed. */
  evidence: string;
  /**
   * Whether it can go into the project itself — a Python package into a virtual
   * environment, a Node package into `node_modules` — without changing the machine.
   */
  projectInstallable: boolean;
}

type Found = Omit<MissingDependency, 'evidence'>;

interface Shape {
  pattern: RegExp;
  read: (match: RegExpMatchArray) => Found | undefined;
}

/** Python's own compiled modules (`_tkinter`, `_ssl`, `_sqlite3`), which no package adds. */
const PYTHON_BUILT_IN = /^_[a-z0-9_]+$/;

function program(match: RegExpMatchArray): Found {
  return {
    name: match[1],
    kind: 'program',
    projectInstallable: false,
    about: 'a program this needs that is not installed on this computer',
  };
}

function pythonModule(match: RegExpMatchArray): Found {
  const top = match[1].split('.')[0];
  if (PYTHON_BUILT_IN.test(top)) {
    return {
      name: top.slice(1),
      kind: 'system-part',
      projectInstallable: false,
      about: 'part of Python itself — built in when Python is installed, so no package can add it',
    };
  }
  return { name: top, kind: 'package', projectInstallable: true, about: 'a Python package this code imports' };
}

/** Ordered: the first shape a line matches decides what it means. */
const SHAPES: Shape[] = [
  { pattern: /No module named '?([\w.]+)'?/, read: pythonModule },
  {
    // A bare name is a package. `./util` or `/abs/path` is the project's own file — a bug
    // in the code, not something missing from the machine.
    pattern: /Cannot find (?:module|package) '([^']+)'/,
    read: (match) =>
      /^[./]/.test(match[1])
        ? undefined
        : { name: match[1], kind: 'package', projectInstallable: true, about: 'a Node package this code imports' },
  },
  {
    pattern: /cannot load such file -- ([\w/.-]+)/,
    read: (match) => ({
      name: match[1].split('/')[0],
      kind: 'package',
      projectInstallable: true,
      about: 'a Ruby gem this code requires',
    }),
  },
  {
    pattern: /no required module provides package ([\w./-]+)/,
    read: (match) => ({ name: match[1], kind: 'package', projectInstallable: true, about: 'a Go module this code imports' }),
  },
  {
    pattern: /Library not loaded: (\S+)/,
    read: (match) => ({
      name: match[1].split('/').pop() || match[1],
      kind: 'system-part',
      projectInstallable: false,
      about: 'a system library this program links against',
    }),
  },
  {
    pattern: /fatal error: '?([\w./+-]+\.h)'?(?:: No such file or directory| file not found)/,
    read: (match) => ({
      name: match[1],
      kind: 'system-part',
      projectInstallable: false,
      about: "a system library's development headers, needed to compile this",
    }),
  },
  {
    pattern: /xcrun: error: invalid active developer path/,
    read: () => ({
      name: 'Xcode Command Line Tools',
      kind: 'program',
      projectInstallable: false,
      about: "Apple's compilers and developer tools",
    }),
  },
  // Programs: zsh, bash, dash and env each say it differently.
  { pattern: /command not found: ([\w.+-]+)/, read: program },
  { pattern: /(?:^|\s)([\w.+-]+): command not found/, read: program },
  { pattern: /^(?:\/bin\/)?sh: (?:\d+: )?([\w.+-]+): not found/, read: program },
  { pattern: /env: '?([\w.+-]+)'?: No such file or directory/, read: program },
];

/**
 * What a failed command says is missing, or nothing.
 *
 * Only a command that failed. A passing test suite that prints "No module named" while
 * testing an error path has not found anything missing, and a killed command said nothing.
 */
export function missingDependency(output: string, exitCode: number | undefined): MissingDependency | undefined {
  if (exitCode === undefined || exitCode === 0) return undefined;
  for (const line of output.split('\n')) {
    for (const shape of SHAPES) {
      const match = line.match(shape.pattern);
      const found = match ? shape.read(match) : undefined;
      if (found) return { ...found, evidence: line.trim().slice(0, 200) };
    }
  }
  return undefined;
}

export const INSTALL_HERE = 'Install it into this project';
export const INSTALL_MYSELF = "I'll install it myself";
export const ANOTHER_WAY = 'Find another way';
export const STOP_HERE = 'Stop here';

export type MissingDecision = 'install-here' | 'install-myself' | 'another-way' | 'stop';

/** The answers on offer. Installing into the project only where that is possible at all. */
export function missingOptions(missing: MissingDependency): string[] {
  return [...(missing.projectInstallable ? [INSTALL_HERE] : []), INSTALL_MYSELF, ANOTHER_WAY, STOP_HERE];
}

/** The question, with what is missing, where it was found and the line that said so. */
export function explainMissing(command: string, missing: MissingDependency): string {
  return [
    'Something this needs is missing from this computer.',
    '',
    `Missing:  ${missing.name} — ${missing.about}`,
    `Found while running:  ${command}`,
    `It said:  ${missing.evidence}`,
    '',
    "I've stopped rather than guess or change how this computer is set up. What should I do?",
  ].join('\n');
}

export interface MissingOutcome {
  decision: MissingDecision;
  /** What the model is told when the run goes on. */
  toldTheModel: string;
  /** What the person is told when the run ends here; absent when it goes on. */
  halt?: string;
}

/**
 * What happens next, given the answer.
 *
 * **Installing it themselves ends the run, and so does closing the dialog.** A run that
 * went on without the dependency is the run that ticked steps whose checks never ran. The
 * halt text ends on a question so "yes" or "continue" picks the work back up.
 */
export function missingOutcome(missing: MissingDependency, answer: string | undefined): MissingOutcome {
  const { name } = missing;
  if (answer === INSTALL_HERE && missing.projectInstallable) {
    return {
      decision: 'install-here',
      toldTheModel: `The user wants ${name} installed into this project only — a virtual environment or the project's own package list, never system-wide. Install it that way, then run the command again. The install will stop and ask them first.`,
    };
  }
  if (answer === ANOTHER_WAY) {
    return {
      decision: 'another-way',
      toldTheModel: `The user does not want ${name} installed. Do not install it or anything else, and do not change how this computer is set up. If the work can be done without ${name} using what is already installed, do that. If the plan depends on ${name}, stop and say plainly what in the plan would have to change — do not edit the plan or tick any step yourself.`,
    };
  }
  if (answer === INSTALL_MYSELF) {
    return {
      decision: 'install-myself',
      toldTheModel: 'The user will install it themselves. Stop now.',
      halt: `I've stopped: ${name} is missing from this computer, and you said you'll install it. Nothing was ticked off. Shall I carry on from here once it's there?`,
    };
  }
  return {
    decision: 'stop',
    toldTheModel: 'The user stopped the run. Stop now.',
    halt: `I've stopped: ${name} is missing from this computer, and nothing was ticked off. How would you like to handle it?`,
  };
}

/** Where the last missing dependency is remembered, for the facts an answer is given. */
export const BLOCKER_KEY = 'clarvis.agent.lastMissing';

/** A few days: long enough to still matter tomorrow, short enough not to linger for ever. */
export const BLOCKER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface BlockerRecord {
  name: string;
  about: string;
  command: string;
  evidence: string;
  decision: MissingDecision;
  at: number;
}

const DECISIONS: Record<MissingDecision, string> = {
  'install-here': 'install it into the project',
  'install-myself': 'they will install it themselves',
  'another-way': 'find a way without it',
  stop: 'stop and decide later',
};

export function blockerRecord(
  command: string,
  missing: MissingDependency,
  decision: MissingDecision,
  now: number
): BlockerRecord {
  return { name: missing.name, about: missing.about, command, evidence: missing.evidence, decision, at: now };
}

/** The stored record, if it is well formed and recent; anything else is treated as absent. */
export function activeBlocker(raw: unknown, now: number): BlockerRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Partial<BlockerRecord>;
  if (typeof record.name !== 'string' || typeof record.command !== 'string') return undefined;
  if (typeof record.at !== 'number' || now - record.at > BLOCKER_TTL_MS) return undefined;
  if (!record.decision || !(record.decision in DECISIONS)) return undefined;
  return {
    name: record.name,
    about: String(record.about ?? ''),
    command: record.command,
    evidence: String(record.evidence ?? ''),
    decision: record.decision,
    at: record.at,
  };
}

/** Whether a later command settles the record: the same command, now succeeding. */
export function clearsBlocker(record: BlockerRecord | undefined, command: string, exitCode: number | undefined): boolean {
  return record !== undefined && exitCode === 0 && record.command === command;
}

/** The fact line an answer is given, so a missing dependency is not explained away. */
export function blockerLine(record: BlockerRecord, when: string): string {
  return `Missing on this computer: ${record.name} (${record.about}) — found ${when} running "${record.command}", which said: ${record.evidence}. What the person chose: ${DECISIONS[record.decision]}.`;
}
