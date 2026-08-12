import { spawn } from 'child_process';

/**
 * Recording one clip of microphone audio, per platform.
 *
 * The mirror of `nativePlayer.ts`, and it exists for the same reason: M1 established
 * that the webview cannot open the microphone at all — `getUserMedia` returns
 * `NotAllowedError` on VS Code and VSCodium alike, *even with* OS-level permission
 * granted to the editor. So capture, like playback, happens in the extension host
 * where there is no Chromium sandbox in the way.
 *
 * Unlike playback, this needs a binary that isn't guaranteed to exist: `afplay` ships
 * with macOS, `ffmpeg` does not. Availability is therefore probed, never assumed.
 */
export interface RecorderCommand {
  command: string;
  /** Arguments for capturing `seconds` of 16 kHz mono WAV to `file`. */
  args: (file: string, seconds: number) => string[];
}

export function recorderCandidates(platform: NodeJS.Platform): RecorderCommand[] {
  // 16 kHz mono is what every ASR endpoint wants, and it keeps the upload small.
  const common = (file: string) => ['-ar', '16000', '-ac', '1', '-y', file];

  if (platform === 'darwin') {
    return [
      {
        command: 'ffmpeg',
        // ":default" — *not* ":0". The index is a position in the audio device list,
        // and on any machine with a virtual device installed (BlackHole, Loopback,
        // an aggregate device) index 0 is usually that, not the microphone. It
        // records happily and returns pure silence, which looks exactly like a
        // permission failure and is not one. Measured on a real machine.
        args: (file, seconds) => [
          '-nostdin', '-f', 'avfoundation', '-i', ':default',
          '-t', String(seconds), ...common(file),
        ],
      },
    ];
  }

  if (platform === 'win32') {
    return [
      {
        command: 'ffmpeg',
        args: (file, seconds) => [
          '-nostdin', '-f', 'dshow', '-i', 'audio=default',
          '-t', String(seconds), ...common(file),
        ],
      },
    ];
  }

  return [
    {
      command: 'ffmpeg',
      args: (file, seconds) => [
        '-nostdin', '-f', 'pulse', '-i', 'default',
        '-t', String(seconds), ...common(file),
      ],
    },
    // Ships with alsa-utils on most distros, so it's the one likely to be present
    // when ffmpeg isn't.
    {
      command: 'arecord',
      args: (file, seconds) => [
        '-f', 'S16_LE', '-r', '16000', '-c', '1', '-d', String(seconds), file,
      ],
    },
  ];
}

/**
 * Records one clip, resolving with the command that produced it.
 *
 * Tries candidates in order: a missing binary (`ENOENT`) moves to the next rather
 * than failing the recording, same as playback.
 */
export function recordClip(
  file: string,
  seconds: number,
  platform: NodeJS.Platform = process.platform,
  log: (message: string) => void = () => {}
): Promise<string> {
  const candidates = recorderCandidates(platform);

  const attempt = (index: number): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const candidate = candidates[index];
      if (!candidate) {
        reject(new Error('no recorder available'));
        return;
      }

      const child = spawn(candidate.command, candidate.args(file, seconds), { stdio: 'ignore' });
      log(`record: spawned ${candidate.command} pid=${child.pid}`);

      // `void`: the handler is a void callback, and the recursion settles the outer
      // promise itself rather than returning one to a listener that would drop it.
      child.on('error', () => void attempt(index + 1).then(resolve, reject));

      child.on('exit', (code, signal) => {
        log(`record: exit code=${code} signal=${signal}`);
        if (code === 0) resolve(candidate.command);
        else reject(new Error(`${candidate.command} exited ${code} (${signal ?? 'no signal'})`));
      });
    });

  return attempt(0);
}

/**
 * What's missing and how to get it, per platform.
 *
 * `afplay` ships with macOS; `ffmpeg` ships with nothing, so voice *input* can fail
 * for a reason voice output never does — a tool that simply isn't there. That is not
 * an error to report, it's a decision to hand back: the user may reasonably not want
 * another dependency, and a mic button that silently does nothing teaches them the
 * feature is broken rather than optional.
 *
 * The command is offered to copy, never run. Installing software on someone's machine
 * is their call, and a package manager invoked on their behalf is exactly the kind of
 * thing this project asks permission for everywhere else.
 */
export interface InstallHint {
  /** What is missing, in plain words. */
  missing: string;
  /** A command the user can run themselves, if they want to. */
  command: string;
  /** Where the command comes from, so an unfamiliar one isn't just pasted blind. */
  note: string;
}

export function installHint(platform: NodeJS.Platform = process.platform): InstallHint {
  if (platform === 'darwin') {
    return {
      missing: 'ffmpeg',
      command: 'brew install ffmpeg',
      note: 'Needs Homebrew (brew.sh). macOS ships no recorder of its own.',
    };
  }

  if (platform === 'win32') {
    return {
      missing: 'ffmpeg',
      command: 'winget install Gyan.FFmpeg',
      note: 'Or grab a build from ffmpeg.org and put it on your PATH.',
    };
  }

  return {
    missing: 'ffmpeg or arecord',
    command: 'sudo apt install ffmpeg   # or: sudo apt install alsa-utils',
    note: 'Whichever your distro packages — alsa-utils is often already present.',
  };
}

/** True when nothing on this machine can record. Distinguishes "absent" from "failed". */
export function isRecorderMissing(error: unknown): boolean {
  return String(error).includes('no recorder available');
}

/**
 * Below this, a recording carries no usable speech.
 *
 * Not zero: a muted or dead input device returns samples of ±1 rather than exact
 * silence, so testing for digital zero misses the case this is here to catch. -60
 * dBFS is far below speech (which peaks around -30 to -10) and far above the -90 an
 * empty device produces.
 */
export const SILENCE_FLOOR_DBFS = -60;

/** Whether a clip contains anything worth sending to a transcription service. */
export function hasAudio(wav: Buffer): boolean {
  return peakDbfs(wav) > SILENCE_FLOOR_DBFS;
}

/**
 * Peak amplitude in a 16-bit mono WAV, as dBFS.
 *
 * The reason this exists: **a denied microphone does not always fail loudly.** It can
 * hand back a perfectly well-formed file full of silence, and an exit code of 0 would
 * report that as success. Measuring the audio is the only way to tell "recorded" from
 * "recorded nothing". Digital silence returns -Infinity.
 *
 * Pure, so the distinction is testable without a microphone.
 */
export function peakDbfs(wav: Buffer): number {
  const HEADER_BYTES = 44; // canonical PCM WAV header
  let peak = 0;

  for (let offset = HEADER_BYTES; offset + 1 < wav.length; offset += 2) {
    const sample = Math.abs(wav.readInt16LE(offset));
    if (sample > peak) peak = sample;
  }

  if (peak === 0) return -Infinity;
  return 20 * Math.log10(peak / 32768);
}
