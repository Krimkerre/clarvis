/**
 * Who gets to decide what Clarvis's face is doing.
 *
 * M2 and M3 shipped a single writer, because there was only one: the watcher. There are
 * four now — an agent run, a chat reply, the watcher and the voice — and they all fire
 * at once during a run. Without an order they overwrite each other, and the face ends up
 * showing whichever one happened to be last rather than whichever matters most: a build
 * finishing three seconds into a five-minute run should not wipe the run's expression.
 *
 * Kept separate from `AvatarController` so the rule can be tested without a webview, a
 * status bar or an extension host. The rule is the part that is easy to get wrong; the
 * plumbing around it is not.
 */

/** Every source that writes to the face, weakest first. */
export const AVATAR_SOURCES = ['idle', 'watch', 'chat', 'agent'] as const;

export type AvatarSource = (typeof AVATAR_SOURCES)[number];

const RANK: Record<AvatarSource, number> = {
  idle: 0,
  /** Background work finishing — the least important thing on screen. */
  watch: 1,
  /** A reply being thought about or spoken. The user is waiting on this. */
  chat: 2,
  /** A run the user started and is watching happen. Outranks everything. */
  agent: 3,
};

/**
 * Whether `incoming` may write while `owner` holds the face.
 *
 * Equal rank wins, deliberately: a source updating its own expression — thinking, then
 * talking, then neutral — is not a fight, and treating it as one would freeze the face
 * at whatever that source showed first.
 */
export function wins(incoming: AvatarSource, owner: AvatarSource): boolean {
  return RANK[incoming] >= RANK[owner];
}

/**
 * How long an expression stays before another may replace it.
 *
 * A run calling eight tools in four seconds produced eight state changes, and a face
 * that changes eight times in four seconds reads as a fault rather than as a character.
 * Long enough to be seen, short enough that nothing feels laggy.
 */
export const MIN_DWELL_MS = 800;
