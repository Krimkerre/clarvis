import { createHash, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { Session } from './history';
import {
  emptyFile,
  fileLeftovers,
  fromMementos,
  parseFile,
  TranscriptFile,
  withoutSession,
  withSession,
} from './transcriptFile';

/** The keys conversations lived in until 20 September 2026; read once, to move them into the file. */
const CURRENT_KEY = 'clarvis.chat.current';
const HISTORY_KEY = 'clarvis.chat.history';

/**
 * Where a conversation is kept: a file under `globalStorageUri`, one per workspace.
 *
 * Named by a hash of the workspace folder, as `memory/PatternStore.ts` does for its notes, and
 * under `chats/` so the two cannot collide. The folder's own path is written inside the file, so a
 * moved project or a hash collision can be recognised rather than guessed at.
 *
 * **Every write re-reads first** (`transcriptFile.withSession`): two windows may hold the same
 * workspace, each with its own live session, and a whole-file write would drop the other's last
 * turn. The write itself is a temporary file renamed into place, so a crash mid-write leaves the
 * previous file rather than half of a new one.
 *
 * **The old key-value store is read exactly once**, when this file does not exist yet, and never
 * written again: two records of one conversation diverge the moment somebody opens a second
 * browser. What is in `workspaceState` is left there rather than deleted — it costs nothing, and
 * deleting the only other copy during a migration is how a migration becomes the thing that lost
 * the data.
 */
export class TranscriptStore {
  /** This window's session, so its writes never disturb another window's. */
  readonly sessionId = randomUUID();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  private get folder(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace';
  }

  private get fileUri(): vscode.Uri {
    const key = createHash('sha256').update(this.folder).digest('hex').slice(0, 16);
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'chats', `${key}.json`);
  }

  /** What is on disk, or what the old keys hold when nothing is. Any failure reads as empty. */
  async read(): Promise<TranscriptFile> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      return parseFile(JSON.parse(new TextDecoder().decode(bytes)), this.folder);
    } catch {
      return this.migrated();
    }
  }

  private migrated(): TranscriptFile {
    const current = this.context.workspaceState.get(CURRENT_KEY);
    const history = this.context.workspaceState.get(HISTORY_KEY);
    const file = fromMementos(this.folder, current, history, this.now());
    if (file.live.length > 0 || file.history.length > 0) {
      this.log(`chat: moving ${file.history.length} earlier conversation(s) into ${this.fileUri.fsPath}`);
    }
    return file;
  }

  /** The file with `change` applied, written whole through a temporary file. */
  async update(change: (file: TranscriptFile) => TranscriptFile): Promise<TranscriptFile> {
    const next = change(await this.read());
    const folder = vscode.Uri.joinPath(this.context.globalStorageUri, 'chats');
    // The directory may not exist on a fresh installation, and `writeFile` will not make it.
    await vscode.workspace.fs.createDirectory(folder);
    const temporary = vscode.Uri.joinPath(folder, `.${this.sessionId}.writing`);
    await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(next)));
    await vscode.workspace.fs.rename(temporary, this.fileUri, { overwrite: true });
    return next;
  }

  /** This window's live session, written on every turn. */
  async save(session: Session): Promise<void> {
    await this.update((file) => withSession(file, this.sessionId, session, this.now()));
  }

  /** Clear Conversation: the session goes from the file, not only from this window. */
  async forget(): Promise<void> {
    await this.update((file) => withoutSession(file, this.sessionId));
  }

  /** Files what earlier windows left behind, and says how many turns were filed. */
  async fileLeftovers(startedAt: number): Promise<Session[]> {
    let filed: Session[] = [];
    await this.update((file) => {
      const settled = fileLeftovers(file, this.sessionId, startedAt);
      filed = settled.filed;
      return settled.file;
    });
    return filed;
  }

  async history(): Promise<Session[]> {
    return (await this.read()).history;
  }

  /** For a window that has never written anything, so `read` has something to answer with. */
  empty(): TranscriptFile {
    return emptyFile(this.folder);
  }
}
