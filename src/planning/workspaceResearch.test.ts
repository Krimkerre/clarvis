import assert from 'node:assert/strict';
import Module from 'module';
import { test } from 'node:test';
import { describeWorkspaceSignals, looksLikeNewProject } from './workspaceSignals';

/**
 * What the offer to plan sees in a folder, read through the real `researchWorkspace` (M15 C2a follow-up).
 *
 * **Why this exists.** Since M15 C2a a run of Clarvis's own engine takes a project lock, and in a folder
 * without git that lock lives in `<root>/.clarvis/`. The offer to plan a new project counts the folder's
 * top-level entries (`looksLikeNewProject`: no git and two entries or fewer), so a folder holding two real
 * files and that lock folder stopped looking new, and the offer quietly stopped firing. `.clarvis` is
 * Clarvis's own bookkeeping, as `.git` and `node_modules` are other tools', and is left out of the count.
 *
 * `workspaceResearch.ts` imports `vscode`, which `node --test` can't load, so the test hands it a stand-in
 * with only what it calls: the workspace folder, the folder's listing, and a README read. Only the first
 * load goes through the stand-in; the module keeps it, and each test changes the listing it returns.
 */

/** A top-level entry as VS Code lists it: a name and a file type (1 is a file, 2 a folder). */
type Entry = [string, number];
const FILE = 1;
const FOLDER = 2;

let listing: Entry[] = [];

const vscodeStandIn = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/a-new-project' } }],
    fs: {
      readDirectory: async () => listing,
      readFile: async () => Buffer.from('# A new project\n'),
    },
  },
  Uri: { joinPath: (base: unknown, name: string) => ({ base, name }) },
};

/** The node module loader's private entry point, which is where a `require('vscode')` can be answered. */
type Loader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };

async function loadResearch() {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
    return request === 'vscode' ? vscodeStandIn : original.call(this, request, parent, isMain);
  };
  try {
    return await import('./workspaceResearch');
  } finally {
    loader._load = original;
  }
}

test("two files and Clarvis's own .clarvis lock folder still look like a new project", async () => {
  const { researchWorkspace } = await loadResearch();
  listing = [
    ['main.py', FILE],
    ['README.md', FILE],
    ['.clarvis', FOLDER],
  ];

  const signals = await researchWorkspace();

  assert.deepEqual(signals?.topLevelEntries, ['main.py', 'README.md'], 'the lock folder is not counted as the project’s own');
  assert.equal(looksLikeNewProject(signals), true);
});

test('a third real entry still reads as a folder someone has been working in, lock folder or not', async () => {
  const { researchWorkspace } = await loadResearch();
  listing = [
    ['main.py', FILE],
    ['README.md', FILE],
    ['tests', FOLDER],
    ['.clarvis', FOLDER],
  ];

  assert.equal(looksLikeNewProject(await researchWorkspace()), false);
});

// ------------------------- `.git`, looked for before it is filtered out

test('a folder under git is not a new project, however few files it holds', async () => {
  // `.git` was filtered out of the listing and then looked for in what was left, so `hasGit` was
  // always false: a git folder with two entries or fewer read as a brand new project, and the
  // interview was never told the project is under git. The planning review's item 4, 13 Sep.
  const { researchWorkspace } = await loadResearch();
  listing = [
    ['.git', FOLDER],
    ['main.py', FILE],
  ];

  const signals = await researchWorkspace();

  assert.ok(signals);
  assert.equal(signals.hasGit, true);
  assert.deepEqual(signals.topLevelEntries, ['main.py'], '.git is still not counted as one of the project’s entries');
  assert.equal(looksLikeNewProject(signals), false);
  assert.match(describeWorkspaceSignals(signals), /git repository/);
});

test('a git worktree, whose .git is a file rather than a folder, is under git too', async () => {
  const { researchWorkspace } = await loadResearch();
  listing = [
    ['.git', FILE],
    ['main.py', FILE],
  ];

  assert.equal((await researchWorkspace())?.hasGit, true);
});

test('a folder with no .git in it is not under git', async () => {
  const { researchWorkspace } = await loadResearch();
  listing = [
    ['main.py', FILE],
    ['.clarvis', FOLDER],
  ];

  assert.equal((await researchWorkspace())?.hasGit, false);
});
