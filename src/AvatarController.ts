import { ButlerState, ButlerViewProvider } from './panels/ButlerViewProvider';
import { StatusBarMirror } from './StatusBarMirror';
import { ClarvisLog } from './ClarvisLog';
import { AvatarSource, MIN_DWELL_MS, wins } from './avatarArbitration';

/**
 * The single authority on what expression Clarvis is currently wearing.
 *
 * Every state change in the extension goes through setState() so the two visible
 * surfaces — the avatar webview and the status-bar glyph — can never drift apart.
 * Keeping the current state here (rather than in a module-level variable) means
 * there's exactly one owner of that value, and it disappears cleanly with the
 * extension instead of outliving it.
 *
 * **Arbitration (M8e2).** It shipped single-writer because a second writer did not exist
 * yet. Four do now, and they overlap constantly during a run, so a source may write only
 * if it outranks whoever holds the face — see `avatarArbitration.ts` for the order and
 * why equal rank is allowed through.
 */
export class AvatarController {
  private currentState: ButlerState = 'neutral';

  /** Who holds the face. Released back to `idle` when a claim ends. */
  private owner: AvatarSource = 'idle';

  /** When the current expression went up, for the dwell floor. */
  private shownAt = 0;

  /** A state that arrived too soon and is waiting out the floor. */
  private pending: { state: ButlerState; source: AvatarSource } | undefined;
  private dwellTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly provider: ButlerViewProvider,
    private readonly statusBar: StatusBarMirror,
    private readonly log: ClarvisLog
  ) {}

  /** The expression currently being displayed. */
  get state(): ButlerState {
    return this.currentState;
  }

  /**
   * Takes the face for the duration of something, and gives it back.
   *
   * The returned function is the only way to release, so a run cannot forget which
   * source it claimed as. Releasing to `idle` rather than to the previous owner is
   * deliberate: by the time a run ends, whatever held the face before it is long stale.
   */
  claim(source: AvatarSource): () => void {
    this.owner = source;
    this.log.write(`avatar: ${source} has the face`);

    return () => {
      if (this.owner !== source) return; // someone louder took over; not ours to release
      this.owner = 'idle';
      this.log.write(`avatar: ${source} released the face`);
    };
  }

  /** Changes the expression and propagates it to every surface that shows it. */
  setState(state: ButlerState, source: AvatarSource = 'watch'): void {
    if (!wins(source, this.owner)) {
      this.log.write(`avatar: ignored ${state} from ${source} (${this.owner} has the face)`);
      return;
    }

    // Repeats collapse rather than restarting the dwell — a run reporting "thinking"
    // eight times running is one expression, not eight.
    if (state === this.currentState && !this.pending) return;

    const waited = Date.now() - this.shownAt;
    if (waited < MIN_DWELL_MS) {
      // Only the newest is kept: mid-sequence expressions nobody would have seen are
      // not worth queueing, and a queue of faces would play back after the fact.
      this.pending = { state, source };
      clearTimeout(this.dwellTimer);
      this.dwellTimer = setTimeout(() => this.flush(), MIN_DWELL_MS - waited);
      return;
    }

    this.apply(state);
  }

  /** Frees the dwell timer so a reload cannot leave one dangling. */
  dispose(): void {
    clearTimeout(this.dwellTimer);
  }

  private flush(): void {
    const next = this.pending;
    this.pending = undefined;
    // Re-checked rather than assumed: the owner may have changed while it waited, and a
    // queued watcher expression must not land on top of a run that started meanwhile.
    if (next && wins(next.source, this.owner) && next.state !== this.currentState) {
      this.apply(next.state);
    }
  }

  private apply(state: ButlerState): void {
    this.currentState = state;
    this.shownAt = Date.now();
    this.statusBar.render(state);
    this.provider.setState(state); // posts {type:'state', name} into the webview
    this.log.write(`state -> ${state}`);
  }
}
