import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import { CALIBRATION_FOLDER, CALIBRATION_REQUESTS, K11_FOR_THE_SESSION, type CalibrationRequest } from './calibrationRequests';

/**
 * The fakes' calibration requests are what Codex 0.154.0 really sent (plan.md M15, C2b). RAVIS committed the
 * transcripts of calibration run `cal_5a1d6ecc33b4`; wherever the NERVIS-ecosystem checkout sits beside this one, as
 * it does on the owner's Mac, every field copied into `calibrationRequests.ts` is compared with the line it came from,
 * so a fake can't drift into a request Codex never made. A clean clone of Clarvis has no sibling, and skips.
 */

interface TranscriptLine {
  n: number;
  direction: string;
  method: string;
  body: Record<string, any>;
}

const root = findRepoRoot(__dirname);
const folder = path.join(root, '..', 'NERVIS-ecosystem', CALIBRATION_FOLDER);
const skip = fs.existsSync(folder) ? false : 'no NERVIS-ecosystem checkout beside this one';

test("every calibration request in the fakes is Codex's own, line for line", { skip }, () => {
  for (const asked of CALIBRATION_REQUESTS) {
    const lines = transcript(asked.from.file);
    const line = lines.find((candidate) => candidate.n === asked.from.n);
    const where = `${asked.from.file} line ${asked.from.n}`;

    assert.ok(line, `${where} is missing`);
    assert.equal(line.direction, 'from_codex', where);
    assert.equal(line.method, asked.kind === 'command' ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval', where);
    assert.equal(line.body.itemId, asked.itemId, where);
    assert.equal(line.body.reason ?? null, asked.payload.reason, `${where}: the reason`);
    if (asked.kind === 'command') sameCommand(line.body, asked, where);
    else sameFileChange(lines, line.body, asked, where);
  }
});

test('calibration answered K11 "for the session" — the answer RAVIS never offers a window', { skip }, () => {
  const answer = transcript('K11.jsonl').find((line) => line.direction === 'to_codex_answer' && line.n === K11_FOR_THE_SESSION.from.n + 1);

  assert.equal(answer?.body.decision, 'acceptForSession');
  assert.deepEqual(K11_FOR_THE_SESSION.allowed_decisions, ['once', 'skip', 'stop']);
});

/** A command: Codex's own words, run in the project root (which RAVIS shows as `.`), with no network or extra access. */
function sameCommand(body: Record<string, any>, asked: CalibrationRequest, where: string): void {
  assert.equal(body.command, asked.payload.command, `${where}: the command`);
  assert.equal(body.cwd, '<project-a>', `${where}: run in the project root`);
  assert.equal(asked.payload.cwd, '.');
  assert.equal(body.commandActions?.[0]?.command, asked.script, `${where}: the script inside the wrapper`);
  assert.equal(body.networkApprovalContext ?? null, asked.payload.network, `${where}: no network asked`);
  assert.equal(body.additionalPermissions ?? null, asked.payload.escalation, `${where}: no escalation asked`);
}

/** A file change carries no files of its own: RAVIS takes them from the item Codex started. */
function sameFileChange(lines: TranscriptLine[], body: Record<string, any>, asked: CalibrationRequest, where: string): void {
  const started = lines.find((line) => line.method === 'item/started' && line.body.item?.id === asked.itemId);
  const changes = started?.body.item.changes as { path: string; kind: { type: string }; diff: string }[];
  const files = asked.payload.files as { path: string; change: string; added: number }[];

  assert.equal(body.grantRoot ?? null, null, `${where}: no grant root`);
  assert.equal(changes.length, files.length, `${where}: the files`);
  changes.forEach((change, index) => {
    assert.equal(change.path, `<project-a>/${files[index].path}`);
    assert.equal(change.kind.type, files[index].change);
    assert.equal(change.diff.split('\n').filter(Boolean).length, files[index].added, "an added file's lines");
  });
}

function transcript(file: string): TranscriptLine[] {
  return fs
    .readFileSync(path.join(folder, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TranscriptLine);
}

function findRepoRoot(start: string): string {
  for (let current = start; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    if (path.dirname(current) === current) throw new Error(`no package.json above ${start}`);
  }
}
