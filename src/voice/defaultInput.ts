import { execFile } from 'child_process';

/**
 * Which input device the OS would hand a recorder that asks for the default one.
 *
 * **Why the probe needs this.** `nativeRecorder` records `:default` rather than
 * `:0`, because index 0 is usually a virtual device on any machine with one
 * installed — the comment there was written after exactly that happened here.
 * That fixed the selection and left the *diagnosis* ambiguous: a silent
 * recording could still mean permission denied, a muted mic, or a default that
 * points at something which produces silence by design. Naming the device
 * closes two of those three.
 *
 * Best-effort by construction. An empty string means "could not be told", and
 * the probe then keeps its original three-way wording rather than asserting
 * something it does not know.
 */

/** Long enough for a slow `system_profiler`, short enough not to hang a command. */
const TIMEOUT_MS = 5_000;

/**
 * The device named in the block that claims to be the default input.
 *
 * `system_profiler SPAudioDataType` prints one indented block per device, with
 * the device name as a heading and its properties beneath it. The default is
 * marked inside the block rather than at the top, so this walks back from the
 * marker to the nearest heading above it — which is the device it belongs to.
 */
export function parseDefaultInput(profile: string): string {
  const lines = profile.split('\n');
  const marker = lines.findIndex((line) => /Default Input Device:\s*Yes/.test(line));
  if (marker < 0) return '';

  for (let index = marker - 1; index >= 0; index--) {
    const heading = /^\s*([^:]+):\s*$/.exec(lines[index]);
    // A heading is a line that is only a name and a colon. Property lines carry
    // a value after theirs, so they never match and are skipped.
    if (heading) return heading[1].trim();
  }
  return '';
}

export async function defaultInputDevice(
  platform: NodeJS.Platform,
  run: typeof execFile = execFile
): Promise<string> {
  // Only macOS is implemented, because only macOS is what `nativeRecorder`'s
  // `:default` hazard was measured on. Returning '' elsewhere is honest: the
  // probe says less rather than guessing.
  if (platform !== 'darwin') return '';

  return new Promise<string>((resolve) => {
    run('system_profiler', ['SPAudioDataType'], { timeout: TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? '' : parseDefaultInput(String(stdout)));
    });
  });
}
