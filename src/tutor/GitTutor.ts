import * as vscode from 'vscode';
import { GitConcept, lessonFor, renderLesson } from './gitLessons';

/**
 * Teaches a git concept the first time it comes up — and only in tutor mode.
 *
 * §4.10: lessons arrive when the thing happens, not from a syllabus. The trigger is
 * therefore scattered across the git-facing code, and this class is what keeps that
 * from becoming scattered *policy* — mode check, already-taught check and wording all
 * live here, so a call site is one line that cannot get the rules wrong.
 */

/**
 * What has been taught, remembered **per user rather than per project**.
 *
 * Someone who learned what a branch is on their first project has learned it. Teaching
 * it again in their second would be the tutor forgetting them, which is worse than
 * never having taught it.
 */
const TAUGHT_KEY = 'clarvis.tutor.gitTaught';

export class GitTutor {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly note: (text: string) => void,
    private readonly log: (message: string) => void
  ) {}

  /**
   * Teaches the concept if this is its first appearance.
   *
   * Deliberately fire-and-forget for callers: a lesson must never delay the thing it
   * is explaining, and a failure to teach is not a failure to work.
   */
  async teach(concept: GitConcept): Promise<void> {
    if (!this.inTutorMode()) return;

    const taught = this.context.globalState.get<string[]>(TAUGHT_KEY) ?? [];
    const lesson = lessonFor(concept, taught);
    if (!lesson) return;

    await this.context.globalState.update(TAUGHT_KEY, [...taught, concept]);
    this.log(`tutor: taught "${concept}"`);
    this.note(renderLesson(lesson));
  }

  private inTutorMode(): boolean {
    return vscode.workspace.getConfiguration('clarvis').get<string>('chat.mode', 'auto') === 'tutor';
  }
}
