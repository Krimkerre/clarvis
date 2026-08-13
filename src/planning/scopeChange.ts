import { MilestoneStep, parseMilestoneSteps } from './milestonePrompt';

/**
 * Telling a course correction from a change of scope, mid-build.
 *
 * §0 promises that scope changes discovered while building kick back to Plan Mode —
 * new gap analysis, new sign-off — rather than growing silently inside Code Mode.
 * Every generated `plan.md` says so in writing, and nothing implemented it: anything
 * said mid-run was folded in as a correction and the plan quietly stopped describing
 * the project.
 *
 * **The distinction is the whole feature, and it is not obvious.** "Use pytest
 * instead" changes how a step is done; "it should also email me the results" is a
 * feature nobody planned, costed or approved. Treating the first as a scope change
 * would put a sign-off gate in front of a preference. Treating the second as a
 * correction is how a v1 becomes a v3 without anyone deciding to.
 */

/** What the user's mid-build message turned out to be. */
export type ScopeVerdict =
  | { kind: 'correction' }
  | { kind: 'scope'; summary: string; placement: 'now' | 'later'; steps: MilestoneStep[] };

export function scopeChangePrompt(planText: string, milestoneTitle: string, said: string): string {
  return [
    "Here is a project's plan:",
    '',
    planText.slice(0, 6000),
    '',
    `The agent is part-way through "${milestoneTitle}". The user just said:`,
    '',
    said,
    '',
    'Is that a correction to how the current work is being done, or does it add',
    'something the plan does not cover?',
    '',
    'A correction changes the method: a different library, a different name, do it',
    'this way instead. It needs no new steps — the same work, done differently.',
    'A scope change adds behaviour nobody planned or agreed to: a new feature, a new',
    'output, a new thing it has to handle.',
    '',
    'If it is a correction, output exactly one line: CORRECTION',
    '',
    'If it adds scope, output this and nothing else:',
    'SCOPE: one sentence on what it adds',
    'WHEN: now — if the current milestone is wrong without it',
    'WHEN: later — if the current milestone is still worth finishing as planned',
    'Then the steps it needs, one per line:',
    'The step | the check that proves it works',
    '',
    'Only what they actually asked for. Do not add steps for things they did not say.',
  ].join('\n');
}

/** Reads the verdict back. Anything unparseable is a correction — see below. */
export function parseScopeChange(text: string): ScopeVerdict {
  const trimmed = text.trim();

  const scope = /^SCOPE:\s*(.+)$/im.exec(trimmed);
  if (!scope) return { kind: 'correction' };

  const steps = parseMilestoneSteps(
    trimmed
      .split('\n')
      .filter((line) => !/^\s*(SCOPE|WHEN|CORRECTION)\b/i.test(line))
      .join('\n')
  );

  // **No steps means no scope change, whatever it called itself.** A kickback that
  // stops the build, opens a sign-off gate and then has nothing to add to the plan
  // is pure ceremony — and worse than the silence it was meant to fix, because it
  // trains people to click through the gate.
  if (steps.length === 0) return { kind: 'correction' };

  return {
    kind: 'scope',
    summary: scope[1].trim(),
    placement: /^WHEN:\s*now\b/im.test(trimmed) ? 'now' : 'later',
    steps,
  };
}
