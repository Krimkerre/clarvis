import * as vscode from 'vscode';
import { InterviewMemory } from './PlanningFlow';
import { INTERVIEW_KEY, parseSnapshot } from './interviewStore';
import { InterviewState } from './interviewTopics';

/**
 * A half-finished interview, kept in `workspaceState`.
 *
 * Workspace-scoped rather than global: a plan is about *this* project, and offering
 * one window's unfinished interview in another project's window would be worse than
 * losing it.
 *
 * Written on every answer, which is cheap — `workspaceState` is a local key-value
 * store, not a file — and the alternative is saving at the end, which is exactly the
 * point a reload prevents you reaching.
 */
export function workspaceMemory(context: vscode.ExtensionContext): InterviewMemory {
  return {
    async save(state: InterviewState, seed: string): Promise<void> {
      await context.workspaceState.update(INTERVIEW_KEY, { seed, state, at: Date.now() });
    },

    load() {
      return parseSnapshot(context.workspaceState.get<unknown>(INTERVIEW_KEY));
    },

    async clear(): Promise<void> {
      await context.workspaceState.update(INTERVIEW_KEY, undefined);
    },
  };
}
