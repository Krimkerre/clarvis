import { archiveSession, parseHistory, Session } from './history';

/**
 * The shape of the file conversations are kept in, and the rules for changing it.
 *
 * **Why a file at all** (20 September 2026). Conversations lived in `workspaceState`, which VS
 * Code keeps *in the browser* when the editor is code-server — measured during E-C7's recovery
 * test: nothing was written on the machine at any point, and the same editor opened in a second
 * browser showed an empty history. So a conversation belonged to one browser profile, and clearing
 * that browser's site data lost it. `globalStorageUri` is on the machine running the extension
 * host in both editors, which is the owner's own machine either way — and in the browser case this
 * writes conversation text where nothing was written before, which is the point and worth saying.
 *
 * **Keyed by session, not by file.** Two windows can have the same workspace open, and each holds
 * its own live session. Writing the whole file would lose the other window's last turn, so every
 * write re-reads, replaces *its own* session by id, and leaves the rest alone.
 *
 * This module is the shapes and the rules; `transcriptStore.ts` is the part that touches disk.
 */

/** One live session, and when it was last written. */
export interface LiveSession {
  id: string;
  session: Session;
  updatedAt: number;
}

/** What the file holds. `folder` is diagnosis only: which workspace this file belongs to. */
export interface TranscriptFile {
  folder: string;
  live: LiveSession[];
  history: Session[];
}

export function emptyFile(folder: string): TranscriptFile {
  return { folder, live: [], history: [] };
}

/**
 * Rebuilds the file from what was read, discarding anything malformed.
 *
 * Same rule as `parseHistory` one level up: stored state outlives the build that wrote it, and a
 * half-written file must degrade to fewer conversations rather than to a panel that throws.
 */
export function parseFile(raw: unknown, folder: string): TranscriptFile {
  if (!raw || typeof raw !== 'object') return emptyFile(folder);
  const candidate = raw as Partial<TranscriptFile>;
  const live = Array.isArray(candidate.live) ? candidate.live : [];

  return {
    folder: typeof candidate.folder === 'string' ? candidate.folder : folder,
    live: live.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const one = entry as Partial<LiveSession>;
      const [session] = parseHistory([one.session]);
      if (!session || typeof one.id !== 'string') return [];
      return [{ id: one.id, session, updatedAt: typeof one.updatedAt === 'number' ? one.updatedAt : session.startedAt }];
    }),
    history: parseHistory(candidate.history),
  };
}

/** This window's session written into the file, with every other window's left as it was. */
export function withSession(file: TranscriptFile, id: string, session: Session, now: number): TranscriptFile {
  const others = file.live.filter((entry) => entry.id !== id);
  return { ...file, live: [...others, { id, session, updatedAt: now }] };
}

/** This window's session removed — what Clear Conversation does, which is a delete. */
export function withoutSession(file: TranscriptFile, id: string): TranscriptFile {
  return { ...file, live: file.live.filter((entry) => entry.id !== id) };
}

/**
 * Sessions left behind by windows that are gone, filed into the archive.
 *
 * Done at startup, because shutdown is not guaranteed to happen — a crashed window's conversation
 * is filed when the next one opens. **A window still open keeps its session**: only entries last
 * written before this window started are treated as left behind, so two windows on one workspace
 * do not archive each other's live conversation. One that has been idle since before this window
 * opened is filed anyway, which is the same answer the single-key version always gave, and it
 * stays in the archive rather than being lost.
 */
export function fileLeftovers(
  file: TranscriptFile, mine: string, startedAt: number
): { file: TranscriptFile; filed: Session[] } {
  const leftovers = file.live.filter((entry) => entry.id !== mine && entry.updatedAt < startedAt);
  if (leftovers.length === 0) return { file, filed: [] };

  const kept = file.live.filter((entry) => !leftovers.includes(entry));
  // Oldest first, so the newest conversation ends up at the front of the archive.
  const ordered = [...leftovers].sort((a, b) => a.session.startedAt - b.session.startedAt);
  const history = ordered.reduce((sofar, entry) => archiveSession(sofar, entry.session), file.history);
  return { file: { ...file, live: kept, history }, filed: ordered.map((entry) => entry.session) };
}

/** What a workspace that has never been written looks like, built from the old key-value store. */
export function fromMementos(folder: string, current: unknown, history: unknown, now: number): TranscriptFile {
  const [live] = parseHistory([current]);
  return {
    folder,
    live: live ? [{ id: `migrated-${live.startedAt}`, session: live, updatedAt: now }] : [],
    history: parseHistory(history),
  };
}
