/**
 * Where a Codex session's capability token is kept between windows (plan.md M15, C1; design §3.5.1).
 *
 * **Why a file, and why this one.** RAVIS returns a session's token once, at creation (and again only
 * through a reissue). A task outlives the window that started it, and may be reattached from the other
 * editor — started in code-server, picked up in desktop VS Code — so the token can't live in either
 * host's `workspaceState`. It lives in
 * `~/.local/share/clarvis/agent-sessions/<sha256(workspace root realpath)>.json`, which both hosts on
 * this Mac read.
 *
 * **How it is kept.** The folder is 0700 and the file 0600. Every write goes to a new temporary file
 * in the same folder and is renamed over the old one, so a reader sees the old file or the new one,
 * never half of one — and a write that fails part-way leaves the old file as it was. An entry is
 * removed when its session ends, and the file with its last entry. Codex's own commands are denied
 * read access to this folder by RAVIS's permission profile (design §4.9).
 *
 * **What the token protects against,** plainly: other windows and other clients presenting the Clarvis
 * credential. Not a program running as the owner, which can read this file like any other.
 *
 * **One file per root, possibly several sessions.** A task left idle by a switch and a new task can
 * both be live in one folder, so the file maps session ids to tokens. Two windows saving to the same
 * root within the same few milliseconds could lose one entry; that session then offers Reconnect,
 * which reissues its token (the contract's recovery for a missing token).
 */

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifySecretFile } from '../../bridge/secretFile';

/** `ast_` and 43 base64url characters: 256 bits (`conventions.json`). */
export const SESSION_TOKEN_FORMAT = /^ast_[A-Za-z0-9_-]{43}$/;

/** RAVIS's session ids start `as_` (`conventions.json` identifiers). */
const SESSION_ID_FORMAT = /^as_[A-Za-z0-9]+$/;

export function defaultTokenFolder(home: string = os.homedir()): string {
  return path.join(home, '.local', 'share', 'clarvis', 'agent-sessions');
}

/** One session's entry. */
export interface StoredToken {
  token: string;
  taskId: string;
  savedAt: string;
}

interface TokenFile {
  version: 1;
  root: string;
  sessions: Record<string, StoredToken>;
}

export type TokenRead =
  | { kind: 'found'; entry: StoredToken }
  | { kind: 'missing' }
  | { kind: 'refused'; reason: 'symlink' | 'not-a-file' | 'loose-permissions' | 'unreadable' };

/** The few file operations a write makes, so a test can make one of them fail part-way. */
export interface WriteIo {
  openSync(file: string, flags: string, mode: number): number;
  writeSync(fd: number, data: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
}

export class TokenStore {
  constructor(
    readonly folder: string = defaultTokenFolder(),
    private readonly io: WriteIo = fs
  ) {}

  /** The file for a workspace root. The root is resolved first, so a symlinked path finds the same file. */
  fileFor(workspaceRoot: string): string {
    return path.join(this.folder, `${sha256(resolveRoot(workspaceRoot))}.json`);
  }

  /** Keeps `token` for session `sessionId`. Throws on a malformed token or id: those are bugs, not states. */
  save(workspaceRoot: string, sessionId: string, token: string, taskId: string, now: Date = new Date()): void {
    if (!SESSION_TOKEN_FORMAT.test(token)) throw new TypeError('not a session token');
    if (!SESSION_ID_FORMAT.test(sessionId)) throw new TypeError('not a session id');
    const root = resolveRoot(workspaceRoot);
    const sessions = this.trustedSessions(root);
    sessions[sessionId] = { token, taskId, savedAt: now.toISOString() };
    this.write(root, sessions);
  }

  read(workspaceRoot: string, sessionId: string): TokenRead {
    const loaded = this.load(resolveRoot(workspaceRoot));
    if (loaded.kind !== 'loaded') return loaded;
    const entry = Object.hasOwn(loaded.file.sessions, sessionId) ? loaded.file.sessions[sessionId] : undefined;
    return entry ? { kind: 'found', entry } : { kind: 'missing' };
  }

  /** Removes a session's entry, and the file once nothing is left in it. */
  forget(workspaceRoot: string, sessionId: string): void {
    const root = resolveRoot(workspaceRoot);
    const sessions = this.trustedSessions(root);
    if (!Object.hasOwn(sessions, sessionId)) return;
    delete sessions[sessionId];
    if (Object.keys(sessions).length > 0) return this.write(root, sessions);
    fs.rmSync(this.fileFor(root), { force: true });
  }

  /**
   * The sessions in a root's file, or none when the file is missing or can't be trusted. A file that
   * is loose, a symlink or unreadable is replaced rather than merged: its contents can't be vouched for.
   */
  private trustedSessions(root: string): Record<string, StoredToken> {
    const loaded = this.load(root);
    return loaded.kind === 'loaded' ? { ...loaded.file.sessions } : {};
  }

  private load(root: string): { kind: 'loaded'; file: TokenFile } | Exclude<TokenRead, { kind: 'found' }> {
    const file = this.fileFor(root);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(file);
    } catch {
      return { kind: 'missing' };
    }
    const verdict = verifySecretFile(stats);
    if (verdict !== 'ok') return { kind: 'refused', reason: verdict };
    const parsed = parseTokenFile(fs.readFileSync(file, 'utf8'), root);
    return parsed ? { kind: 'loaded', file: parsed } : { kind: 'refused', reason: 'unreadable' };
  }

  private write(root: string, sessions: Record<string, StoredToken>): void {
    this.ensureFolder();
    const target = this.fileFor(root);
    const temporary = path.join(this.folder, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    const body: TokenFile = { version: 1, root, sessions };
    try {
      const fd = this.io.openSync(temporary, 'wx', 0o600);
      try {
        this.io.writeSync(fd, JSON.stringify(body, null, 2) + '\n');
        this.io.fsyncSync(fd);
      } finally {
        this.io.closeSync(fd);
      }
      this.io.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  /** Makes the folder 0700, tightening one that already exists; refuses a symlink in its place. */
  private ensureFolder(): void {
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.folder).isSymbolicLink()) throw new Error(`${this.folder} is a symlink`);
    fs.chmodSync(this.folder, 0o700);
  }
}

function parseTokenFile(text: string, root: string): TokenFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const file = value as Partial<TokenFile> | null;
  if (!file || file.version !== 1 || file.root !== root) return undefined;
  if (typeof file.sessions !== 'object' || file.sessions === null) return undefined;
  const entries = Object.values(file.sessions);
  return entries.every((entry) => SESSION_TOKEN_FORMAT.test(entry?.token ?? '')) ? (file as TokenFile) : undefined;
}

/** The realpath, or the plain absolute path for a folder that no longer exists (forgetting its token). */
function resolveRoot(workspaceRoot: string): string {
  try {
    return fs.realpathSync.native(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
