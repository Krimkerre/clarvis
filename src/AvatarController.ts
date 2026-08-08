import { ButlerState, ButlerViewProvider } from './panels/ButlerViewProvider';
import { StatusBarMirror } from './StatusBarMirror';
import { ClarvisLog } from './ClarvisLog';

/**
 * The single authority on what expression Clarvis is currently wearing.
 *
 * Every state change in the extension goes through setState() so the two visible
 * surfaces — the avatar webview and the status-bar glyph — can never drift apart.
 * Keeping the current state here (rather than in a module-level variable) means
 * there's exactly one owner of that value, and it disappears cleanly with the
 * extension instead of outliving it.
 */
export class AvatarController {
  private currentState: ButlerState = 'neutral';

  constructor(
    private readonly provider: ButlerViewProvider,
    private readonly statusBar: StatusBarMirror,
    private readonly log: ClarvisLog
  ) {}

  /** The expression currently being displayed. */
  get state(): ButlerState {
    return this.currentState;
  }

  /** Changes the expression and propagates it to every surface that shows it. */
  setState(state: ButlerState): void {
    this.currentState = state;
    this.statusBar.render(state);
    this.provider.setState(state); // posts {type:'state', name} into the webview
    this.log.write(`state -> ${state}`);
  }
}
