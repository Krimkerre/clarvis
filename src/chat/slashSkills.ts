/**
 * The skills behind the chat box's suggestions pop-up, and the fresh list a slash command is checked against (the owner's
 * decisions, 15 Sep 2026).
 *
 * **The webview has no network**, so the extension host reads RAVIS and posts the pop-up its rows (`slash-list`): the
 * built-in commands at once, then the skills once the list is read.
 *
 * **When the pop-up's list is read:**
 * - when the panel opens (`opened`), and when the window regains focus (`focused`), since that is when a switch flipped on
 *   NERVIS's Skills page, in another window, is most likely to be new;
 * - when Clarvis's settings change (`settings`), since the coding model decides whether there are skills at all;
 * - and while typing `/` (`typing`), **at most once a minute**: the pop-up asks each time it opens, and a quick run of
 *   commands shouldn't be a quick run of RAVIS reads.
 *
 * A read already under way is waited for rather than repeated.
 *
 * **A command as it is sent never uses this copy** (`listNow` always reads): the pop-up may be a minute stale, and a skill
 * the owner switched off in that minute must stay off (the peer session's rule, 15 Sep).
 *
 * vscode-free: its host is a function, so the timing is tested with a clock.
 */

import { listSkills, type SkillsList, type SkillsLookup } from '../agent/tools/skillTools';
import type { SkillListing } from '../engine/relay/relayTypes';
import { slashRows, type SlashRow } from './skillCommands';

/** The longest the pop-up waits between reads while the owner types `/`. */
export const REFRESH_WHILE_TYPING_MS = 60_000;

export type SlashRefresh = 'opened' | 'focused' | 'settings' | 'typing';

/** The message the pop-up takes its rows from. */
export interface SlashListMessage {
  type: 'slash-list';
  rows: SlashRow[];
}

export interface SlashSkillsDeps {
  /** Where the skills are read, asked at each read, so a settings change counts from the next. */
  lookup: () => SkillsLookup;
  post: (message: SlashListMessage) => void;
  log: (line: string) => void;
  now?: () => number;
  timeoutMs?: number;
}

export class SlashSkills {
  /** The skills the last successful read listed. A failed read keeps them: the send-time check is the one that counts. */
  private known: readonly SkillListing[] = [];
  private lastRead: number | undefined;
  private reading: Promise<SkillsList> | undefined;

  constructor(private readonly deps: SlashSkillsDeps) {}

  /** The skills switched on now, read from RAVIS on every call, and the pop-up told what they are. */
  listNow(): Promise<SkillsList> {
    return this.read();
  }

  /** Brings the pop-up's rows up to date, unless typing asked within the last minute or a read is already under way. */
  async refresh(reason: SlashRefresh): Promise<void> {
    if (reason === 'typing' && this.lastRead !== undefined && this.now() - this.lastRead < REFRESH_WHILE_TYPING_MS) return;
    if (this.reading) {
      await this.reading;
      return;
    }
    this.post();
    await this.read();
  }

  private async read(): Promise<SkillsList> {
    this.lastRead = this.now();
    const reading = listSkills(this.deps.lookup(), new AbortController().signal, this.deps.timeoutMs);
    this.reading = reading;
    try {
      const list = await reading;
      if (list.kind === 'failed') this.deps.log(`slash: skills not listed — ${list.why}`);
      else this.known = list.kind === 'listed' ? list.skills : [];
      this.post();
      return list;
    } finally {
      if (this.reading === reading) this.reading = undefined;
    }
  }

  private post(): void {
    this.deps.post({ type: 'slash-list', rows: slashRows(this.known) });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
