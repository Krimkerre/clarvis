/**
 * Deciding which commands stop and ask.
 *
 * §4.6: gates are a **hard architectural stop, not a system-prompt request**. This
 * module is pure and knows nothing about models — it classifies a string, and the
 * caller refuses to run it without approval. A tool that could be talked out of its
 * own permissions would not be a gate.
 *
 * **A gate explains itself.** "Clarvis wants to run `npm install lodash` — Approve?"
 * teaches people to click Approve without reading, which is worse than no gate at all.
 * So every verdict carries what it does, why that is risky, and what the worst case
 * actually is.
 */

export type GateCategory =
  | 'destructive'
  | 'outward-facing'
  | 'dependency'
  | 'privilege'
  | 'remote-code';

export interface GateVerdict {
  category: GateCategory;
  /** The specific fragment that triggered it, so the reason is not a mystery. */
  matched: string;
  /** What this does, in plain words. */
  what: string;
  /** Why it is worth stopping for. */
  why: string;
  /** The realistic worst case, stated without melodrama. */
  worstCase: string;
  /**
   * Whether the thing can be taken back afterwards.
   *
   * Added when the M8 exit checklist asked for irreversible actions to be visually
   * distinct from reversible ones and found nothing distinguishing them. `npm install`
   * and `rm -rf` were being asked about in exactly the same words, which trains a user
   * to click through both at the same speed — and the whole value of a gate is that the
   * dangerous one reads differently from the routine one.
   */
  reversible: boolean;
}

interface Rule {
  category: GateCategory;
  pattern: RegExp;
  what: string;
  why: string;
  worstCase: string;
  /** Default is irreversible; a rule has to claim otherwise. */
  reversible?: boolean;
}

/**
 * The deny-list.
 *
 * Ordered most-severe first, since a command can match several and the user should be
 * told about the worst one. Deliberately conservative: a false stop costs one click,
 * a false pass can cost a working tree.
 */
const RULES: Rule[] = [
  {
    category: 'destructive',
    pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*/i,
    what: 'deletes files, and with -r or -f it does so without asking',
    why: 'Deleted files do not go to the Trash from a shell. There is no undo.',
    worstCase: 'Anything matched by that path is gone, including uncommitted work.',
  },
  {
    category: 'destructive',
    pattern: /\bgit\s+reset\s+--hard\b/i,
    what: 'throws away every uncommitted change and moves the branch',
    why: 'Uncommitted work is not in git, so git cannot give it back.',
    worstCase: 'Everything you have edited but not committed is lost.',
  },
  {
    category: 'destructive',
    pattern: /\bgit\s+clean\b/i,
    what: 'deletes untracked files',
    why: 'Untracked means git has no copy — including .env files and local notes.',
    worstCase: 'Local configuration and anything not yet added is deleted.',
  },
  {
    category: 'destructive',
    pattern: /\bgit\s+checkout\s+--\s|\bgit\s+restore\b/i,
    what: 'discards your edits to those files',
    why: 'It overwrites the working copy from the index or a commit.',
    worstCase: 'The changes in those files are lost.',
  },
  {
    category: 'destructive',
    pattern: /\b(mkfs|fdisk|diskutil|dd)\b/i,
    what: 'operates on a disk or partition directly',
    why: 'These write past the filesystem, not within it.',
    worstCase: 'Data loss well beyond this project.',
  },
  {
    category: 'destructive',
    pattern: /\bgit\s+branch\s+-D\b|\bgit\s+push\s+.*--force\b|--force-with-lease\b/i,
    what: 'force-deletes a branch or overwrites history',
    why: 'Force operations discard commits other people may already have.',
    worstCase: "Work is dropped from the branch, and anyone who pulled it has a conflict they didn't cause.",
  },
  {
    category: 'privilege',
    pattern: /\bsudo\b|\bdoas\b/i,
    what: 'runs with administrator privileges',
    why: 'Nothing this project needs requires root, so this reaches outside it by definition.',
    worstCase: 'A mistake stops being confined to your workspace.',
  },
  {
    category: 'remote-code',
    pattern: /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i,
    what: 'downloads a script and runs it immediately',
    why: 'Nobody reads what they just piped into a shell, and the server decides what you get.',
    worstCase: 'Arbitrary code runs as you, with whatever that URL served at that moment.',
  },
  {
    category: 'outward-facing',
    pattern: /\bgit\s+push\b/i,
    what: 'publishes commits to a remote',
    why: 'Once pushed, it is on a server other people can see and pull.',
    worstCase: 'A half-finished change becomes public and has to be reverted in public.',
  },
  {
    category: 'outward-facing',
    pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b/i,
    what: 'publishes a package to a public registry',
    why: 'Published versions are permanent — most registries do not allow re-use of a version number.',
    worstCase: 'A broken release is public, and the version number is spent for good.',
  },
  {
    category: 'dependency',
    pattern: /\b(npm|yarn|pnpm|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bcargo\s+add\b|\bgem\s+install\b|\bbrew\s+install\b/i,
    what: 'installs a package and its dependencies',
    why: 'A package runs install scripts on your machine, and pulls in code you did not choose directly.',
    worstCase: 'A compromised or typo-squatted package executes as you during install.',
    // Uninstalling is a real remedy, which is not true of anything else on this list.
    reversible: true,
  },
];

/**
 * Splits a command line into the pieces a shell would run separately.
 *
 * **This is the part a naive gate gets wrong.** Checking only the start of the string
 * means `npm test && rm -rf build` passes as "npm test" — the deny-list has to see
 * every segment, because the shell will run every segment.
 */
export function shellSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\||\n)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Classifies a command, returning the most serious thing it would do.
 *
 * `undefined` means nothing on the list matched — which is **not** a promise that the
 * command is safe, only that it is not one of the known-dangerous shapes. The
 * workspace boundary and the checkpoint are what cover the rest.
 */
export function classifyCommand(command: string): GateVerdict | undefined {
  // A pipe into a shell spans segments, so the whole line is tested for those rules
  // before the pieces are examined individually.
  for (const rule of RULES.filter((candidate) => candidate.category === 'remote-code')) {
    const match = rule.pattern.exec(command);
    if (match) return toVerdict(rule, match[0]);
  }

  for (const segment of shellSegments(command)) {
    for (const rule of RULES) {
      const match = rule.pattern.exec(segment);
      if (match) return toVerdict(rule, match[0].trim());
    }
  }

  return undefined;
}

function toVerdict(rule: Rule, matched: string): GateVerdict {
  return {
    category: rule.category,
    matched,
    what: rule.what,
    why: rule.why,
    worstCase: rule.worstCase,
    reversible: rule.reversible ?? false,
  };
}

/**
 * The four-part explanation a gate prompt carries (§4.6).
 *
 * Written out here rather than at the UI, so every surface that asks — the agent, a
 * debug command, a future planning step — asks in the same words.
 */
export function explainGate(command: string, verdict: GateVerdict): string {
  return [
    verdict.reversible ? 'Clarvis wants to run:' : 'CANNOT BE UNDONE — Clarvis wants to run:',
    `  ${command}`,
    '',
    `What it does:  ${verdict.what}`,
    `Why I'm asking:  ${verdict.why}`,
    `Worst case:  ${verdict.worstCase}`,
    // Said twice for the irreversible ones, at the top and at the bottom, because the
    // top line is what someone reads and the button is what they look at last.
    verdict.reversible ? 'This one can be undone afterwards.' : 'There is no undo for this.',
  ].join('\n');
}

/**
 * What the approve button says.
 *
 * The button is the last thing read before clicking, and "Run it" reads identically
 * whether the command installs a package or erases the working tree. Naming the
 * consequence there is the cheapest possible distinction.
 */
export function approveLabel(verdict: GateVerdict): string {
  return verdict.reversible ? 'Run it' : 'Run it anyway';
}
