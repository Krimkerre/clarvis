/**
 * The six expressions, with nothing else attached.
 *
 * Lifted out of `ButlerViewProvider` at M8e3 for one reason: that file imports `vscode`,
 * so anything wanting to validate a state name dragged the whole extension host in with
 * it and could not be unit-tested. The union and its guard are the part other modules
 * actually need — the webview is where they happen to be rendered, not where they belong.
 *
 * `ButlerViewProvider` re-exports both, so every existing import still resolves.
 */

// The six expressions avatar.html's own setState() understands. Kept here (not
// just inferred from the HTML) so the rest of the extension gets type-checked
// state names instead of arbitrary strings.
export const BUTLER_STATES = ['neutral', 'judging', 'impressed', 'thinking', 'talking', 'surprised'] as const;
export type ButlerState = (typeof BUTLER_STATES)[number];

/**
 * Narrows an arbitrary string to a ButlerState.
 *
 * Used at the extension's trust boundaries — the QuickPick (which is typed as plain
 * `string`), messages arriving from the webview, and now the state a model claims for
 * its own reply. A model inventing `smug` costs nothing: it fails this and talks
 * normally.
 */
export function isButlerState(value: unknown): value is ButlerState {
  return typeof value === 'string' && (BUTLER_STATES as readonly string[]).includes(value);
}
