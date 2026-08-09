import { Turn } from './thread';

/** One window's worth of conversation, closed and filed away. */
export interface Session {
  startedAt: number;
  turns: Turn[];
}

/**
 * How many past sessions are kept.
 *
 * `workspaceState` is a key-value store, not a database — an unbounded archive would
 * grow forever in a workspace someone works in daily. Twenty is far more than anyone
 * scrolls back through and still small enough to load without thinking about it.
 */
export const MAX_SESSIONS = 20;

/**
 * Files a finished session, newest first, dropping the oldest beyond the cap.
 *
 * An empty session is not filed at all: opening a window and never asking anything
 * would otherwise pad the archive with blank entries and push out real ones.
 */
export function archiveSession(history: Session[], session: Session, max = MAX_SESSIONS): Session[] {
  if (session.turns.length === 0) return history;
  return [session, ...history].slice(0, max);
}

/**
 * Rebuilds the archive from storage, discarding anything malformed.
 *
 * Stored state outlives the build that wrote it. A half-written array or an older
 * shape must degrade to "fewer sessions", never to a panel that throws on open.
 */
export function parseHistory(raw: unknown): Session[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((session): session is Session => {
      if (!session || typeof session !== 'object') return false;
      const candidate = session as Partial<Session>;
      return typeof candidate.startedAt === 'number' && Array.isArray(candidate.turns);
    })
    .map((session) => ({ startedAt: session.startedAt, turns: parseTurns(session.turns) }));
}

/** Keeps only well-formed turns — same reasoning as parseHistory, one level down. */
function parseTurns(raw: unknown[]): Turn[] {
  return raw.filter((turn): turn is Turn => {
    if (!turn || typeof turn !== 'object') return false;
    const candidate = turn as Partial<Turn>;
    return (
      (candidate.speaker === 'user' || candidate.speaker === 'clarvis') &&
      typeof candidate.text === 'string' &&
      typeof candidate.at === 'number'
    );
  });
}

/**
 * A one-line description of a session, for picking one out of a list.
 *
 * The first thing you asked is what makes a session recognisable — far more so than
 * a timestamp, which is why it leads the label rather than trailing it.
 */
export function describeSession(session: Session): { label: string; detail: string } {
  const firstQuestion = session.turns.find((turn) => turn.speaker === 'user');

  return {
    label: firstQuestion ? truncate(firstQuestion.text, 60) : '(nothing asked)',
    detail: `${new Date(session.startedAt).toLocaleString()} — ${session.turns.length} turns`,
  };
}

/** Renders a session as Markdown, for opening in a normal editor tab. */
export function formatSession(session: Session): string {
  const lines = [`# Clarvis — ${new Date(session.startedAt).toLocaleString()}`, ''];

  for (const turn of session.turns) {
    lines.push(`**${turn.speaker === 'user' ? 'You' : 'Clarvis'}:** ${turn.text}`, '');
  }

  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
