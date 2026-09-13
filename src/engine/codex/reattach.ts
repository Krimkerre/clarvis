/**
 * Which Codex task a window picks back up when it opens (plan.md M15, C2a; design §5.7).
 *
 * **Why a window looks at all.** A Codex task outlives the editor that started it: the tab closes, the
 * window reloads, the owner opens the project in desktop VS Code instead of the browser editor. When a
 * window opens on the project, RAVIS lists the workspace's sessions (no tokens, no payloads) and this
 * decides what to do with them:
 * - **follow** a live session whose token this Mac's token file holds — from the stored cursor, or a
 *   snapshot — so a waiting question is asked here and finished work is saved;
 * - **offer Reconnect** for one whose token is missing: RAVIS reissues it once no window has been
 *   attached for 60 s, and a fresh token is no weaker than reading the file;
 * - **say so** when the token file is there but not safe to use (loose permissions, a symlink), and
 *   leave it alone.
 *
 * **One at a time.** A window follows one coding run. The one to follow first is the one a person is
 * holding up — a question waiting — then one whose work is waiting to be saved, then the most recently
 * active.
 *
 * Pure: the caller lists the sessions and reads the token file.
 */

import type { SessionSummary } from '../relay/relayTypes';
import type { TokenRead } from '../relay/tokenStore';

/** States with something to follow: a turn running, a stop under way, or work to save. */
const LIVE = new Set([
  'starting',
  'running',
  'waiting_on_you',
  'stopping',
  'stopped',
  'leftover',
  'paused_unanswered',
  'paused_for_update',
  'completed_needs_review',
  'uncertain',
]);

const WORK_TO_SAVE = new Set(['stopped', 'paused_unanswered', 'paused_for_update', 'completed_needs_review', 'uncertain']);

export type ReattachStep =
  | { kind: 'follow'; session: SessionSummary }
  | { kind: 'reconnect'; session: SessionSummary }
  | { kind: 'unsafe_token'; session: SessionSummary; reason: Extract<TokenRead, { kind: 'refused' }>['reason'] }
  | { kind: 'nothing' };

export function reattachStep(sessions: readonly SessionSummary[], tokenFor: (sessionId: string) => TokenRead): ReattachStep {
  const session = sessions.filter((candidate) => LIVE.has(candidate.state)).sort(byUrgency)[0];
  if (!session) return { kind: 'nothing' };
  const token = tokenFor(session.id);
  if (token.kind === 'found') return { kind: 'follow', session };
  if (token.kind === 'missing') return { kind: 'reconnect', session };
  return { kind: 'unsafe_token', session, reason: token.reason };
}

/** A waiting question first, then work to save, then the most recently updated. */
function byUrgency(a: SessionSummary, b: SessionSummary): number {
  return urgency(b) - urgency(a) || b.updated_at.localeCompare(a.updated_at);
}

function urgency(session: SessionSummary): number {
  if (session.waiting_on_you) return 2;
  return WORK_TO_SAVE.has(session.state) ? 1 : 0;
}
