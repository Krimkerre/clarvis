import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { GitFacts } from '../../engine/checkpoint/gitFacts';
import type { LeftWorkDeps } from '../../engine/codex/leftTasks';
import { RelayClient } from '../../engine/relay/relayClient';
import { RelayHttp, relayEndpoint } from '../../engine/relay/relayHttp';
import type { SessionState } from '../../engine/relay/relayTypes';
import { TokenStore } from '../../engine/relay/tokenStore';
import { CLARVIS_CREDENTIAL, FakeRavisRelay } from './FakeRavisRelay';
import type { MachineSession } from './fakeSessions';

/**
 * A project like the owner's live test of 15 Sep 2026 (`live-test-c`), for the tests of building on Codex's earlier work
 * (plan.md M15): a real git repository in a temporary folder, whose trunk is `master` unless a test says otherwise,
 * beside `FakeRavisRelay` and a token file of its own.
 *
 * `leaveCodexWork` leaves Codex work the way a Codex task settled with `next: 'idle'` and "Leave it there" leaves it: a
 * commit of its own on `clarvis/<task>` off the trunk, the window back where it was, and an idle RAVIS session on that
 * branch whose key the token file holds.
 *
 * The relay is the test double; git is real, and never this repository.
 */
export interface LeftWorkProject {
  root: string;
  trunk: string;
  fake: FakeRavisRelay;
  relay: RelayClient;
  tokens: TokenStore;
  /** Each request sent to RAVIS, as `METHOD /path`, in the order it was started. */
  sent: string[];
  git(...args: string[]): string;
  deps(extra?: Partial<LeftWorkDeps>): LeftWorkDeps;
  leaveCodexWork(branch: string, options?: { file?: string; updatedAt?: string; storeKey?: boolean; state?: SessionState }): MachineSession;
}

export async function leftWorkProject(t: TestContext, trunk = 'master'): Promise<LeftWorkProject> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-left-work-')));
  const root = path.join(base, 'live-test-c');
  fs.mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
  git('init', '--quiet', `--initial-branch=${trunk}`);
  for (const [key, value] of [
    ['user.name', 'Clarvis test'],
    ['user.email', 'clarvis-test@example.invalid'],
    ['commit.gpgsign', 'false'],
  ]) {
    git('config', key, value);
  }
  fs.writeFileSync(path.join(root, 'README.md'), '# Greeter\n\nBuild the greeter: greet.py prints a greeting.\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'first');

  const fake = await FakeRavisRelay.start();
  const sent: string[] = [];
  const relay = new RelayClient(recordingHttp(fake, sent));
  const tokens = new TokenStore(path.join(base, 'agent-sessions'));
  t.after(async () => {
    await fake.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const leaveCodexWork: LeftWorkProject['leaveCodexWork'] = (branch, options = {}) => {
    const back = git('symbolic-ref', '--short', 'HEAD');
    git('checkout', '--quiet', '-b', branch, trunk);
    const file = options.file ?? `${branch.split('/').pop()}.py`;
    fs.writeFileSync(path.join(root, file), `print("${branch}")\n`);
    git('add', file);
    git('commit', '--quiet', '-m', `Codex: ${branch}`);
    git('checkout', '--quiet', back);
    const session = fake.sessions().seed({ root, state: options.state ?? 'idle', holdsLock: false, turnActive: false, updatedAt: options.updatedAt });
    session.stream.patchView({ branch: { name: branch, head_commit_at_start: git('rev-parse', trunk) } });
    if (options.storeKey !== false) tokens.save(root, session.id, session.token, session.taskId);
    return session;
  };

  return {
    root,
    trunk,
    fake,
    relay,
    tokens,
    sent,
    git,
    deps: (extra = {}) => ({ relay, tokens, git: new GitFacts(root), root, ...extra }),
    leaveCodexWork,
  };
}

/** The relay's HTTP, recording each request as it is started. */
function recordingHttp(fake: FakeRavisRelay, sent: string[]): RelayHttp {
  const endpoint = relayEndpoint(fake.url, CLARVIS_CREDENTIAL);
  if (!endpoint.ok) throw new Error(endpoint.reason);
  return new RelayHttp(endpoint.endpoint, (input, init) => {
    sent.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return fetch(input, init);
  });
}
