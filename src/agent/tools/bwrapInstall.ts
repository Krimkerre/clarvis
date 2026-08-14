/**
 * Installing the sandbox on Linux, rather than shrugging and running without one.
 *
 * macOS ships `sandbox-exec`; Linux ships nothing. So the Linux path was "no sandbox
 * here, shall I run commands unconfined?" — a security question asked of someone who
 * is one `apt-get install` away from not having to answer it. Bubblewrap is a small,
 * standard package in every major distribution's repositories, and it is what
 * Flatpak uses, so most desktops already have it.
 *
 * Pure on purpose: which command a distribution needs is a lookup, and a lookup is
 * worth testing without a Linux box to hand.
 */

/** How each package manager spells it, in the order they are looked for. */
const MANAGERS: { binary: string; command: string }[] = [
  { binary: 'apt-get', command: 'sudo apt-get install -y bubblewrap' },
  { binary: 'dnf', command: 'sudo dnf install -y bubblewrap' },
  // --needed rather than a plain -S: reinstalling a package that is already there is
  // a strange thing for an offer of help to do.
  { binary: 'pacman', command: 'sudo pacman -S --needed bubblewrap' },
  { binary: 'zypper', command: 'sudo zypper install -y bubblewrap' },
  { binary: 'apk', command: 'sudo apk add bubblewrap' },
];

/** The binaries to probe for, most common first. */
export function packageManagers(): string[] {
  return MANAGERS.map((manager) => manager.binary);
}

/**
 * The install line for a package manager, or `undefined` for one not listed.
 *
 * Undefined is a real answer and the caller must handle it: on an unrecognised
 * distribution, guessing a command that starts with `sudo` is worse than admitting
 * the specifics were never written down — the same rule the conventions lookup follows.
 */
export function installCommand(binary: string | undefined): string | undefined {
  return MANAGERS.find((manager) => manager.binary === binary)?.command;
}
