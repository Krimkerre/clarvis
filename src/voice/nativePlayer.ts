import { spawn, ChildProcess } from 'child_process';

/** The player currently making noise, if any. See playFile() for why one is enough. */
let current: ChildProcess | undefined;

/**
 * Silences whatever is playing right now.
 *
 * Killing the process is the only way to stop mid-word: these players have no pause
 * channel, and waiting for the current utterance to end is exactly the behaviour mute
 * exists to avoid — the sentence you need gone is the one already talking.
 *
 * Returns whether anything was actually stopped, so a mute with nothing playing is a
 * silent no-op rather than an error.
 */
export function stopPlayback(): boolean {
  if (!current) return false;
  current.kill();
  current = undefined;
  return true;
}

/** A command line for playing one audio file, chosen per platform. */
export interface PlayerCommand {
  command: string;
  args: (file: string) => string[];
}

/**
 * Candidate players, most preferred first.
 *
 * All of these are **headless**: no window, no dock icon, no focus stolen. They play
 * and exit, which is the whole reason this approach works — the process exiting is
 * also the "finished playing" signal, so the avatar can track real playback without a
 * timer or a round-trip through the webview.
 */
export function playerCandidates(platform: NodeJS.Platform): PlayerCommand[] {
  if (platform === 'darwin') {
    return [{ command: 'afplay', args: (file) => [file] }];
  }

  if (platform === 'win32') {
    // MediaPlayer handles mp3, unlike SoundPlayer which is wav-only. `-WindowStyle
    // Hidden` keeps it invisible; PlaySync-style blocking is emulated by waiting on
    // NaturalDuration so the process exits when the audio does.
    return [
      {
        command: 'powershell',
        args: (file) => [
          '-NoProfile',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Add-Type -AssemblyName presentationCore; ` +
            `$p = New-Object system.windows.media.mediaplayer; ` +
            `$p.Open([uri]'${file}'); $p.Play(); ` +
            `Start-Sleep -Milliseconds 300; ` +
            `while ($p.Position -lt $p.NaturalDuration.TimeSpan) { Start-Sleep -Milliseconds 100 }`,
        ],
      },
    ];
  }

  // Linux and friends: whichever of these the distro happens to ship.
  return [
    { command: 'paplay', args: (file) => [file] },
    { command: 'ffplay', args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
    { command: 'mpg123', args: (file) => ['-q', file] },
  ];
}

/**
 * Plays a file with the first player that works, resolving when playback finishes.
 *
 * Tries candidates in order because Linux audio is a lottery — a missing binary
 * (`ENOENT`) moves to the next one rather than failing the utterance.
 */
export function playFile(
  file: string,
  platform: NodeJS.Platform = process.platform,
  log: (message: string) => void = () => {}
): Promise<void> {
  const candidates = playerCandidates(platform);
  const startedAt = Date.now();

  // Only one player runs at a time (VoiceService serialises utterances), so a single
  // module-scoped handle is enough to make stopPlayback() possible. Tracking a list
  // would imply a concurrency that deliberately doesn't exist.

  const attempt = (index: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const candidate = candidates[index];
      if (!candidate) {
        reject(new Error('no audio player available'));
        return;
      }

      const child = spawn(candidate.command, candidate.args(file), { stdio: 'ignore' });
      current = child;
      log(`play: spawned ${candidate.command} pid=${child.pid}`);

      child.on('error', () => {
        if (current === child) current = undefined;
        // Binary missing: try the next candidate rather than giving up.
        attempt(index + 1).then(resolve, reject);
      });

      child.on('exit', (code, signal) => {
        if (current === child) current = undefined;
        // signal is the tell: a clean finish exits 0, whereas being killed mid-word
        // arrives as SIGTERM/SIGKILL and is what a cut-off utterance looks like.
        log(`play: exit code=${code} signal=${signal} after ${Date.now() - startedAt}ms`);
        // Killed on purpose (mute) exits via a signal with no code. That is a
        // completed utterance as far as callers are concerned — resolving keeps it
        // out of the fallback path, which would otherwise "helpfully" re-speak the
        // line through the system voice the instant you silenced it.
        if (code === 0 || signal) resolve();
        else reject(new Error(`${candidate.command} exited ${code} (${signal ?? 'no signal'})`));
      });
    });

  return attempt(0);
}
