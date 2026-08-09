import { spawn } from 'child_process';

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
export function playFile(file: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const candidates = playerCandidates(platform);

  const attempt = (index: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const candidate = candidates[index];
      if (!candidate) {
        reject(new Error('no audio player available'));
        return;
      }

      const child = spawn(candidate.command, candidate.args(file), { stdio: 'ignore' });

      child.on('error', () => {
        // Binary missing: try the next candidate rather than giving up.
        attempt(index + 1).then(resolve, reject);
      });

      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${candidate.command} exited ${code}`));
      });
    });

  return attempt(0);
}
