import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import * as vm from 'vm';

/**
 * A chat turn's inline code, rendered as the webview renders it: `media/chat.js` run in a fresh script context over
 * a small stand-in for the document, and a `chat-turn` message sent to it the way the extension host sends one.
 *
 * **Why this exists.** `chat.js` lived inside a TypeScript template literal for most of M8, where its backtick split
 * had to be written with a doubled backslash. When it became a real file (4f6e33e) that doubled backslash came with
 * it, so the split looked for the six-character text backslash-u-0-0-6-0, which never appears, and no inline code rendered from
 * then on. Nothing checked what the panel actually drew.
 *
 * **Markup stays text.** Model output lands in these rows, so the stand-in's `innerHTML` throws: a rendering path
 * that ever hands text to the HTML parser fails here instead of in somebody's panel.
 */

const SOURCE = fs.readFileSync(path.join(repoRoot(__dirname), 'media', 'chat.js'), 'utf8');

/** One node of the stand-in document: an element, or a text node (`nodeName` `#text`). */
class FakeNode {
  childNodes: FakeNode[] = [];
  className = '';
  scrollTop = 0;
  scrollHeight = 0;

  constructor(
    readonly nodeName: string,
    private ownText = ''
  ) {}

  get textContent(): string {
    return this.nodeName === '#text' ? this.ownText : this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    if (this.nodeName === '#text') {
      this.ownText = String(value);
      return;
    }
    this.childNodes = [new FakeNode('#text', String(value))];
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  appendChild(child: FakeNode): FakeNode {
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    return child;
  }

  addEventListener(): void {}

  // Model output must never reach the HTML parser.
  set innerHTML(_markup: string) {
    throw new Error('innerHTML was set: markup must never be how a chat turn is drawn');
  }

  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML was called: markup must never be how a chat turn is drawn');
  }
}

/** Just enough of `document` for what `chat.js` touches when it loads and when a turn arrives. */
class FakeDocument {
  private readonly byId = new Map<string, FakeNode>();

  getElementById(id: string): FakeNode {
    const found = this.byId.get(id) ?? new FakeNode('DIV');
    this.byId.set(id, found);
    return found;
  }

  createElement(tag: string): FakeNode {
    return new FakeNode(tag.toUpperCase());
  }

  createTextNode(text: string): FakeNode {
    return new FakeNode('#text', String(text));
  }
}

/** The panel's script, loaded into a fresh context, and a way to send it host messages. */
function openPanel(): { document: FakeDocument; send(data: unknown): void } {
  const document = new FakeDocument();
  const listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  const context = {
    document,
    navigator: {},
    window: {
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    },
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    setInterval: () => 0,
    // The bowtie's menu has its own test (bowtieMenu.test.ts); here it only has to exist.
    ClarvisBowtieMenu: { createBowtieMenu: () => ({}) },
  };
  vm.runInNewContext(SOURCE, context);
  return {
    document,
    send: (data) => (listeners.get('message') ?? []).forEach((listener) => listener({ data })),
  };
}

/** The newest turn's body after its speaker label, as [what each node is, its text]. */
function newestTurn(document: FakeDocument): [string, string][] {
  const row = document.getElementById('clarvis-transcript').lastChild;
  assert.ok(row, 'a chat-turn message adds a row to the transcript');
  return row.childNodes
    .slice(1)
    .map((node) => [node.nodeName === '#text' ? 'text' : node.nodeName.toLowerCase(), node.textContent]);
}

test('a backtick span in a chat turn renders as inline code', () => {
  const panel = openPanel();

  panel.send({ type: 'chat-turn', speaker: 'clarvis', text: 'Run `npm test` before you commit.' });

  assert.deepEqual(newestTurn(panel.document), [
    ['text', 'Run '],
    ['code', 'npm test'],
    ['text', ' before you commit.'],
  ]);
});

test('markup a model sends stays text, in plain text and in inline code alike', () => {
  const panel = openPanel();

  panel.send({
    type: 'chat-turn',
    speaker: 'clarvis',
    text: '<img src=x onerror=alert(1)> then `<script>alert(2)</script>`',
  });

  assert.deepEqual(newestTurn(panel.document), [
    ['text', '<img src=x onerror=alert(1)> then '],
    ['code', '<script>alert(2)</script>'],
    ['text', ''],
  ]);
  // The <code> holds one text node and nothing else: the tags were never parsed into elements.
  const code = panel.document.getElementById('clarvis-transcript').lastChild?.childNodes[2];
  assert.deepEqual(
    code?.childNodes.map((node) => node.nodeName),
    ['#text']
  );
});

/** The repository root: the nearest folder above `start` holding a package.json, however the tests were built. */
function repoRoot(start: string): string {
  for (let current = start; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    if (path.dirname(current) === current) throw new Error(`no package.json above ${start}`);
  }
}
