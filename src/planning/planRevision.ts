import { characterWith, ONLY_WHAT_YOU_WERE_GIVEN } from '../personality/character';
import { milestoneChecklist, readMilestones } from './planUpdate';

/**
 * Applying typed feedback to a drafted plan.md (M9i).
 *
 * **Why sections, and why code does the splicing.** Refining used to add the feedback as a
 * note and redraw the same plan, so "remove cloud sync" sat beneath the cloud-sync scope and
 * step it contradicted — and the build was handed the step. Asking a model to rewrite the whole
 * document instead would mean trusting it to reproduce §0 and the branch flow word for word, on
 * a local model as well as a frontier one, with a hand edit elsewhere in the draft one careless
 * rewrite from gone. So the model returns only the sections the feedback changes, and code
 * splices them into the draft as it reads right now, refuses what it cannot place, and checks
 * that what is left still has a milestone to build.
 *
 * Pure and `vscode`-free, like the other prompt modules; `Analysis.ts` is the model glue.
 */

/** Sections typed feedback never rewrites. A hand edit still can: the document is theirs. */
const FIXED_SECTIONS = [/^## 0\. Working Process/, /^## Branch flow$/];

/** A `## ` section: its heading line, and where it starts and ends among the plan's lines. */
interface Section {
  heading: string;
  start: number;
  end: number;
}

/** One section's replacement, as the model gave it. */
export interface SectionChange {
  heading: string;
  body: string;
}

/** What applying feedback came to: the new draft and the sections that changed, or why the draft is unchanged. */
export type Revision = { text: string; changed: string[]; asNote?: boolean } | { unchanged: string };

/** The system prompt for a revision. */
export function revisionSystemPrompt(): string {
  return characterWith(
    'You are revising a drafted plan.md so that it carries one piece of feedback from the person',
    'it belongs to. Change what the feedback changes and nothing else, never add a requirement',
    'they did not ask for, and answer only in the structured format requested.',
    ONLY_WHAT_YOU_WERE_GIVEN
  );
}

/**
 * The instruction for one revision.
 *
 * **The whole draft goes in; only changed sections come out.** The model needs the rest to
 * keep the plan consistent — a change of scope usually reaches the milestones too — but
 * repeating it back would be the whole-document rewrite this exists to avoid.
 */
export function revisionPrompt(planText: string, feedback: string): string {
  return [
    'Here is a drafted plan.md, between the markers:',
    '<<<PLAN',
    planText,
    'PLAN>>>',
    '',
    'The person reviewing it said:',
    '<<<FEEDBACK',
    feedback,
    'FEEDBACK>>>',
    '',
    'Apply that feedback to the plan. Rewrite every section it affects — an answer, the scope, a',
    "milestone's steps and their checks — so the plan reads as one decision rather than a note",
    'contradicting what is above it. Leave every section it does not affect exactly as it is.',
    '',
    'Two sections are fixed and must never be output: "## 0. Working Process — Plan Mode vs. Code',
    'Mode" and "## Branch flow".',
    '',
    'A milestone keeps exactly this shape, because the editor reads it back:',
    '### Milestone 1 — what it delivers',
    '- [ ] a piece of work',
    '  - Check: how to tell it works — something that would fail if it did not',
    '  - Result: not run yet',
    '',
    'Output nothing but the sections you changed, each in exactly this shape:',
    'SECTION: <the section heading line, copied exactly from the plan>',
    '<the whole new text of that section, without its heading>',
    'END SECTION',
    '',
    'If the feedback needs no change to the plan, output exactly one line instead:',
    'NO-CHANGE: <one sentence why>',
  ].join('\n');
}

/**
 * Reads the model's reply: the sections it changed, `NO-CHANGE` and its reason, or `undefined`
 * for anything else — including a reply cut off before its last `END SECTION`, which would
 * otherwise apply half an answer as though it were all of it.
 */
export function parseRevision(text: string): { changes: SectionChange[] } | { noChange: string } | undefined {
  const opened = text.match(/^SECTION:/gm)?.length ?? 0;
  const changes = [...text.matchAll(/^SECTION:[ \t]*(.+?)[ \t]*\r?\n([\s\S]*?)^END SECTION[ \t]*$/gm)].map((match) => ({
    heading: match[1].trim(),
    body: match[2],
  }));

  if (opened > 0) return changes.length === opened ? { changes } : undefined;
  const noChange = /^NO-CHANGE:\s*(.+)$/m.exec(text);
  return noChange ? { noChange: noChange[1].trim() } : undefined;
}

/** Every `## ` section of a plan, leaving out anything inside a fenced code block. */
function sectionsOf(lines: string[]): Section[] {
  const starts: number[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith('## ')) starts.push(index);
  });
  return starts.map((start, index) => ({ heading: lines[start].trim(), start, end: starts[index + 1] ?? lines.length }));
}

/** A changed section's text as lines. The blank lines around it are the plan's to keep, not the model's. */
function bodyLines(body: string): string[] {
  const trimmed = body.replace(/^\s*\n/, '').replace(/\s+$/, '');
  return trimmed ? trimmed.split('\n') : [];
}

/** Whether a plan has a milestone with a step that carries a check — something a build can be handed. */
function buildable(planText: string): boolean {
  return readMilestones(planText).some((milestone) =>
    milestoneChecklist(planText, milestone.number).some((step) => step.hasCheck)
  );
}

/** Why a changed section cannot be placed, or `undefined` when it can. */
function placementProblem(heading: string, sections: Section[], taken: Section[]): string | undefined {
  if (FIXED_SECTIONS.some((fixed) => fixed.test(heading))) {
    return `it tried to rewrite "${heading}", which typed feedback never changes — edit that section in the draft yourself if it has to change`;
  }
  const matching = sections.filter((section) => section.heading === heading);
  if (matching.length !== 1) return `it named a section the draft does not have: "${heading}"`;
  if (taken.includes(matching[0])) return `it rewrote "${heading}" twice`;
  return undefined;
}

/**
 * Splices each changed section into the plan, or says why it will not.
 *
 * Refused: a fixed section, a heading the draft does not have (or has twice), the same section
 * twice over, and a result with no milestone left to build where the draft had one.
 */
export function applyRevision(planText: string, changes: SectionChange[]): { text: string } | { problem: string } {
  const lines = planText.split('\n');
  const sections = sectionsOf(lines);
  const placed: { change: SectionChange; section: Section }[] = [];

  for (const change of changes) {
    const problem = placementProblem(change.heading, sections, placed.map((entry) => entry.section));
    if (problem) return { problem };
    placed.push({ change, section: sections.find((section) => section.heading === change.heading)! });
  }

  // Bottom up, so a splice never moves a section still waiting for its own.
  for (const { change, section } of placed.sort((a, b) => b.section.start - a.section.start)) {
    lines.splice(section.start + 1, section.end - section.start - 1, '', ...bodyLines(change.body), '');
  }

  const text = lines.join('\n');
  if (buildable(planText) && !buildable(text)) {
    return { problem: 'it would have left the plan with no milestone that has a step and a check' };
  }
  return { text };
}

/**
 * The model's reply as a revision of `planText`: the new draft and the sections it changed, or
 * one sentence saying why the draft is unchanged, to be said as it stands.
 */
export function readRevision(planText: string, reply: string, timedOut: boolean): Revision {
  if (timedOut) {
    return { unchanged: 'That took longer than the model had, so the draft is unchanged. Say it again to try once more, or edit the draft yourself.' };
  }

  const parsed = parseRevision(reply);
  if (!parsed) {
    return { unchanged: 'The reply did not come back in a shape I could apply, so the draft is unchanged. Say it again to try once more, or edit the draft yourself.' };
  }
  if ('noChange' in parsed) return { unchanged: `Nothing in the draft needed to change for that: ${parsed.noChange}` };

  const applied = applyRevision(planText, parsed.changes);
  if ('problem' in applied) return { unchanged: `I could not apply that — ${applied.problem} — so the draft is unchanged.` };
  return { text: applied.text, changed: parsed.changes.map((change) => change.heading.replace(/^##\s*/, '')) };
}

/**
 * The feedback added under Notes, for when there is no model to rework the plan with.
 *
 * What refining did before M9i, kept for the one case it still suits: the words are not lost,
 * and what is said afterwards makes plain that the sections they affect were not changed.
 */
export function withNote(planText: string, note: string): string {
  const lines = planText.split('\n');
  const sections = sectionsOf(lines);
  const notes = sections.find((section) => section.heading === '## Notes');

  if (notes) {
    let after = notes.end;
    while (after > notes.start + 1 && !lines[after - 1].trim()) after--;
    lines.splice(after, 0, `- ${note}`);
    return lines.join('\n');
  }

  const milestones = sections.find((section) => section.heading.startsWith('## 7. Milestones'));
  lines.splice(milestones ? milestones.start : lines.length, 0, '## Notes', '', `- ${note}`, '');
  return lines.join('\n');
}

/** What is said once a revision lands. */
export function changedLine(revision: { changed: string[]; asNote?: boolean }): string {
  return revision.asNote
    ? 'There is no model to rework the plan with, so that went under Notes as it stands — change the sections it affects before you approve.'
    : `Changed ${revision.changed.join(', ')}. Read it over, then approve it or say what else should change.`;
}

/** What is said when the draft was edited while a revision of it was being written. */
export function conflictLine(feedback: string): string {
  return `You edited the draft while I was reworking it, so I kept your edits and did not apply "${feedback}". Say it again to apply it to your version.`;
}
