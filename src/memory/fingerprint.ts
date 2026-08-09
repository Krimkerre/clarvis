import { createHash } from 'crypto';

/**
 * Collapses an error message to a stable key, so "the same error" is recognisable
 * across runs even though the incidental details change every time.
 *
 * The normalisations, and why each is here — every one of these varies between two
 * occurrences of what is obviously the same problem:
 *   - absolute paths (differ per machine and per checkout)
 *   - line:column numbers (drift as the file is edited)
 *   - hex blobs: hashes, object ids, addresses
 *   - timestamps and durations
 *   - long bare numbers (pids, ports, byte counts)
 *
 * Deliberately conservative. Over-normalising collapses genuinely different errors
 * into one key, which is worse than missing a match: a wrong "seen this before"
 * suggestion actively wastes someone's time, whereas a miss just stays quiet.
 */
export function normalizeError(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s:]+|\/[^\s:]{2,}/g, '<path>') // windows + posix paths
    .replace(/:\d+:\d+/g, ':<pos>') // file:12:34
    .replace(/\bline \d+/gi, 'line <n>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hash>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>')
    .replace(/\b\d+(\.\d+)?(ms|s|m)\b/g, '<dur>')
    .replace(/\b\d{3,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400); // long stack traces are mostly frames; the head is the identity
}

/**
 * A short, stable id for an error. Hashed rather than stored raw so the key is a
 * predictable length regardless of how enormous the original stack trace was.
 */
export function fingerprint(text: string): string {
  return createHash('sha256').update(normalizeError(text)).digest('hex').slice(0, 16);
}
