import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import * as vm from 'vm';
import { slashRows } from '../chat/skillCommands';
import type { SkillListing } from '../engine/relay/relayTypes';

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
 *
 * **The slash pop-up too** (the owner's decision, 15 Sep 2026): the chat box's suggestions, filled from the host's
 * `slash-list` rows (built by the real `slashRows`), filtered as the first word is typed, driven by the keys and the mouse,
 * named for a screen reader, and holding RAVIS's words as text.
 */

const SOURCE = fs.readFileSync(path.join(repoRoot(__dirname), 'media', 'chat.js'), 'utf8');

interface FakeEvent {
  type: string;
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function fakeEvent(type: string, fields: Partial<FakeEvent> = {}): FakeEvent {
  const fired: FakeEvent = { type, defaultPrevented: false, preventDefault: () => void (fired.defaultPrevented = true), ...fields };
  return fired;
}

/** One node of the stand-in document: an element, or a text node (`nodeName` `#text`). */
class FakeNode {
  childNodes: FakeNode[] = [];
  className = '';
  scrollTop = 0;
  scrollHeight = 0;
  id = '';
  hidden = false;
  disabled = false;
  title = '';
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  readonly dataset: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: FakeEvent) => void)[]>();

  constructor(
    readonly nodeName: string,
    private ownText = '',
    private readonly owner?: FakeDocument
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

  /** The element children, as `children` gives them. */
  get children(): FakeNode[] {
    return this.childNodes.filter((node) => node.nodeName !== '#text');
  }

  appendChild(child: FakeNode): FakeNode {
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    return child;
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.childNodes = [...nodes];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(fired: FakeEvent): FakeEvent {
    for (const listener of this.listeners.get(fired.type) ?? []) listener(fired);
    return fired;
  }

  focus(): void {
    if (this.owner) this.owner.activeElement = this;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  // Model output must never reach the HTML parser.
  set innerHTML(_markup: string) {
    throw new Error('innerHTML was set: markup must never be how a chat turn is drawn');
  }

  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML was called: markup must never be how a chat turn is drawn');
  }
}

/** Just enough of `document` for what `chat.js` touches when it loads, when a turn arrives and while the box is typed in. */
class FakeDocument {
  activeElement: FakeNode | undefined;
  private readonly byId = new Map<string, FakeNode>();

  getElementById(id: string): FakeNode {
    const found = this.byId.get(id) ?? new FakeNode('DIV', '', this);
    this.byId.set(id, found);
    return found;
  }

  createElement(tag: string): FakeNode {
    return new FakeNode(tag.toUpperCase(), '', this);
  }

  createTextNode(text: string): FakeNode {
    return new FakeNode('#text', String(text));
  }
}

/** The panel's script, loaded into a fresh context, a way to send it host messages, and a way to type in its box. */
function openPanel() {
  const document = new FakeDocument();
  const listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  const posts: Record<string, unknown>[] = [];
  const context = {
    document,
    navigator: {},
    window: {
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    },
    // Cloned out of the script's context, so a posted message compares as a plain object.
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => void posts.push(structuredClone(message)) }),
    setInterval: () => 0,
    // The bowtie's menu has its own test (bowtieMenu.test.ts); here it only has to exist.
    ClarvisBowtieMenu: { createBowtieMenu: () => ({}) },
  };
  vm.runInNewContext(SOURCE, context);
  const input = document.getElementById('clarvis-input');
  const slash = document.getElementById('clarvis-slash');
  // As the markup has it (`ButlerViewProvider.chatMarkup`): the pop-up starts hidden.
  slash.hidden = true;
  return {
    document,
    input,
    slash,
    send: (data: unknown) => (listeners.get('message') ?? []).forEach((listener) => listener({ data })),
    posted: (type: string) => posts.filter((message) => message.type === type),
    /** Makes `text` the box's whole value, with the caret at `caret` (its end unless said), as typing does. */
    type(text: string, caret = text.length): void {
      input.value = text;
      input.setSelectionRange(caret, caret);
      input.fire(fakeEvent('input'));
    },
    /** A key pressed and let go in the box, as a browser sends it. The keydown event, to see what it prevented. */
    press(key: string, fields: Partial<FakeEvent> = {}): FakeEvent {
      const down = input.fire(fakeEvent('keydown', { key, ...fields }));
      input.fire(fakeEvent('keyup', { key, ...fields }));
      return down;
    },
    /** The pop-up's rows as shown: each row's label. */
    labels: () => slash.children.map((option) => option.children[0]?.textContent),
    /** The label of the row the keyboard is on, by the box's aria-activedescendant. */
    active: () => slash.children.find((option) => option.id === input.getAttribute('aria-activedescendant'))?.children[0]?.textContent,
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

// ── The slash pop-up ───────────────────────────────────────────────────────────

const SKILLS: SkillListing[] = [
  { id: 'nervis/nervis-notes', name: 'nervis-notes', description: 'How NERVIS tasks keep their notes.' },
  { id: 'personal/changelog-generator', name: 'changelog-generator', description: 'Writes a changelog from the git history.' },
  { id: 'personal/status', name: 'status', description: 'A weekly status report.' },
];

/** A panel the host has told its rows, as it does when the panel opens. */
function panelWithRows(skills: SkillListing[] = SKILLS) {
  const panel = openPanel();
  panel.send({ type: 'slash-list', rows: slashRows(skills) });
  return panel;
}

test('typing / shows every command and each skill with its description, marks the first row active, and asks the host for fresh skills once', () => {
  const panel = panelWithRows();
  assert.deepEqual([panel.slash.hidden, panel.labels()], [true, []], 'nothing before anything is typed');

  panel.type('/');

  assert.equal(panel.slash.hidden, false);
  assert.deepEqual(
    panel.labels(),
    slashRows(SKILLS)
      .filter((row) => row.primary)
      .map((row) => row.label)
  );
  assert.ok(panel.labels().includes('/skill status') && panel.labels().includes('/changelog-generator'));
  const [first, second] = panel.slash.children;
  assert.deepEqual([first.id, first.getAttribute('role'), first.getAttribute('aria-selected'), first.className], ['clarvis-slash-0', 'option', 'true', 'clarvis-slash-option active']);
  assert.deepEqual([second.id, second.getAttribute('aria-selected'), second.className], ['clarvis-slash-1', 'false', 'clarvis-slash-option']);
  assert.equal(first.children[1].textContent, 'List these commands and your skills');
  assert.deepEqual([panel.input.getAttribute('aria-expanded'), panel.input.getAttribute('aria-activedescendant')], ['true', 'clarvis-slash-0']);

  panel.type('/c');
  panel.type('/ch');
  assert.deepEqual(panel.posted('slash-open'), [{ type: 'slash-open' }], 'asked once as the slash word started, not at every letter');
});

test('the markup names the pop-up a listbox the box controls', () => {
  const provider = fs.readFileSync(path.join(repoRoot(__dirname), 'src', 'panels', 'ButlerViewProvider.ts'), 'utf8');
  assert.match(provider, /<div id="clarvis-slash" class="clarvis-slash" role="listbox" aria-label="Commands and skills" hidden><\/div>/);
  assert.match(provider, /<textarea id="clarvis-input"[^>]*aria-autocomplete="list" aria-haspopup="listbox" aria-controls="clarvis-slash" aria-expanded="false"/);
});

test('the rows follow the first word as plain text, never as a pattern: aliases, clashes and skills alike', () => {
  const panel = panelWithRows();

  panel.type('/st');
  assert.deepEqual(panel.labels(), ['/status', '/skill status'], "a skill named like /status is shown as /skill status");
  panel.type('/SK');
  assert.deepEqual(panel.labels(), ['/skill', '/skill status']);
  panel.type('/ch');
  assert.deepEqual(panel.labels(), ['/checkout', '/changelog-generator']);
  panel.type('/?');
  assert.deepEqual(panel.labels(), ['/?'], '"/?" typed is those two characters, not a pattern matching everything');
  panel.type('/.*');
  assert.equal(panel.slash.hidden, true);
  panel.type('/zzz');
  assert.deepEqual([panel.slash.hidden, panel.input.getAttribute('aria-expanded'), panel.input.getAttribute('aria-activedescendant')], [true, 'false', null]);
});

test('a skill whose name two skills share is shown by its full id', () => {
  const twin = { id: 'personal/nervis-notes', name: 'nervis-notes', description: 'My own way of keeping notes.' };
  const config = { id: 'nervis/config', name: 'config', description: 'Config conventions.' };
  const panel = panelWithRows([...SKILLS, twin, config]);

  panel.type('/nerv');
  assert.deepEqual(panel.labels(), ['/skill nervis/nervis-notes', '/skill personal/nervis-notes']);
  panel.type('/conf');
  assert.deepEqual(panel.labels(), ['/config', '/skill config']);
});

test('Up and Down move the active row, wrapping at either end, and the box names it', () => {
  const panel = panelWithRows();
  panel.type('/st');

  const down = panel.press('ArrowDown');
  assert.equal(down.defaultPrevented, true, "the caret doesn't move");
  assert.equal(panel.active(), '/skill status');
  assert.deepEqual(panel.slash.children.map((option) => option.getAttribute('aria-selected')), ['false', 'true']);
  assert.deepEqual(panel.slash.children.map((option) => option.className), ['clarvis-slash-option', 'clarvis-slash-option active']);
  panel.press('ArrowDown');
  assert.equal(panel.active(), '/status', 'past the last row, the first');
  panel.press('ArrowUp');
  assert.equal(panel.active(), '/skill status', 'before the first row, the last');
  panel.type('/sta');
  assert.equal(panel.active(), '/skill status', 'typing on keeps the active row while it is still listed');
});

test('Enter or Tab completes the active row with a space after it; Enter on a command typed in full sends it; Shift+Enter is a new line', () => {
  const panel = panelWithRows();

  panel.type('/chan');
  const enter = panel.press('Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual([panel.input.value, panel.input.selectionStart, panel.slash.hidden], ['/changelog-generator ', 21, true]);
  assert.deepEqual(panel.posted('ask'), [], 'completing sends nothing');

  panel.type('/st');
  panel.press('ArrowDown');
  const tab = panel.press('Tab');
  assert.equal(tab.defaultPrevented, true, 'Tab stays in the box');
  assert.equal(panel.input.value, '/skill status ');

  panel.type('/chan');
  const newLine = panel.press('Enter', { shiftKey: true });
  assert.deepEqual([newLine.defaultPrevented, panel.input.value], [false, '/chan']);

  panel.type('/help');
  panel.press('Enter');
  assert.deepEqual(panel.posted('ask'), [{ type: 'ask', text: '/help' }]);
  assert.deepEqual([panel.input.value, panel.slash.hidden], ['', true]);
});

test('Escape closes the pop-up, which stays closed for that word and comes back when the word changes', () => {
  const panel = panelWithRows();
  panel.type('/st');

  const escape = panel.press('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual([panel.slash.hidden, panel.input.getAttribute('aria-expanded'), panel.input.getAttribute('aria-activedescendant')], [true, 'false', null]);
  panel.input.fire(fakeEvent('keyup', { key: 'ArrowLeft' }));
  panel.input.fire(fakeEvent('click'));
  assert.equal(panel.slash.hidden, true, 'the caret moving within the word leaves it closed');
  const enter = panel.press('Enter');
  assert.deepEqual(panel.posted('ask'), [{ type: 'ask', text: '/st' }], 'with it closed, Enter sends');
  assert.equal(enter.defaultPrevented, true);

  panel.type('/st');
  panel.press('Escape');
  panel.type('/sta');
  assert.deepEqual(panel.labels(), ['/status', '/skill status']);
});

test('the pop-up is shown only while the box starts with / and the caret is in the first word', () => {
  const panel = panelWithRows();

  panel.type('/help me with this');
  assert.equal(panel.slash.hidden, true, 'the caret is past the first word');
  panel.input.setSelectionRange(3, 3);
  panel.input.fire(fakeEvent('keyup', { key: 'ArrowLeft' }));
  assert.deepEqual(panel.labels(), ['/help'], 'the caret moved back inside it by a key');
  panel.input.setSelectionRange(18, 18);
  panel.input.fire(fakeEvent('click'));
  assert.equal(panel.slash.hidden, true, 'and out of it by a click');
  panel.input.setSelectionRange(2, 2);
  panel.input.fire(fakeEvent('click'));
  assert.deepEqual(panel.labels(), ['/help'], 'and back in by a click');

  for (const text of ['use /help', ' /help', 'help']) {
    panel.type(text);
    assert.equal(panel.slash.hidden, true, text);
  }
  // The caret at the very start of a box that doesn't start with /: the first "word" is empty, and nothing is shown.
  panel.type(' /help', 0);
  assert.equal(panel.slash.hidden, true, 'a space before the / is not the start of a command');

  panel.type('/st');
  panel.input.fire(fakeEvent('blur'));
  assert.equal(panel.slash.hidden, true, 'leaving the box closes it');
});

test('a click completes its row, keeping what was typed after the first word, and a press on the pop-up keeps focus in the box', () => {
  const panel = panelWithRows();
  panel.type('/chan write it for 0.17.7', 5);

  const press = panel.slash.fire(fakeEvent('mousedown'));
  assert.equal(press.defaultPrevented, true);
  panel.slash.children[0].fire(fakeEvent('click'));

  assert.equal(panel.input.value, '/changelog-generator write it for 0.17.7');
  assert.deepEqual([panel.input.selectionStart, panel.slash.hidden, panel.document.activeElement === panel.input], [21, true, true]);
});

test("a skill's name and description from RAVIS stay text in the pop-up", () => {
  const evil = { id: 'personal/evil', name: '<img-src=x-onerror=alert(1)>', description: '<script>alert(2)</script> and <b>bold</b>' };
  const panel = panelWithRows([evil]);

  panel.type('/<img');

  const [option] = panel.slash.children;
  assert.deepEqual(
    option.children.map((part) => part.childNodes.map((node) => node.nodeName)),
    [['#text'], ['#text']],
    'one text node in each part: nothing was parsed into elements'
  );
  assert.equal(option.children[0].textContent, '/<img-src=x-onerror=alert(1)>');
  assert.equal(option.children[1].textContent, '<script>alert(2)</script> and <b>bold</b>');
});

test("Enter while an input method is composing is the input method's: it neither sends nor completes", () => {
  const panel = panelWithRows();

  panel.type('konnichiwa');
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    const enter = panel.press('Enter', composing);
    assert.deepEqual([enter.defaultPrevented, panel.input.value], [false, 'konnichiwa'], JSON.stringify(composing));
  }
  assert.deepEqual(panel.posted('ask'), []);

  panel.type('/chan');
  panel.press('Enter', { isComposing: true });
  assert.deepEqual([panel.input.value, panel.slash.hidden], ['/chan', false]);

  panel.type('hello');
  panel.press('Enter');
  assert.deepEqual(panel.posted('ask'), [{ type: 'ask', text: 'hello' }], 'a plain Enter still sends');
});

test("rows that arrive while a slash word is being typed are filtered at once, even when the old rows matched nothing", () => {
  const panel = panelWithRows([]);
  panel.type('/chan');
  assert.equal(panel.slash.hidden, true);

  panel.send({ type: 'slash-list', rows: slashRows(SKILLS) });
  assert.deepEqual(panel.labels(), ['/changelog-generator']);

  panel.send({ type: 'slash-list', rows: slashRows([]) });
  assert.equal(panel.slash.hidden, true, 'a skill switched off drops out of an open pop-up');
});

test('the host filling the box closes or opens the pop-up as its first word says', () => {
  const panel = panelWithRows();
  panel.send({ type: 'prefill', text: '/nervis' });
  assert.deepEqual(panel.labels(), ['/nervis-notes']);
});

/** The repository root: the nearest folder above `start` holding a package.json, however the tests were built. */
function repoRoot(start: string): string {
  for (let current = start; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    if (path.dirname(current) === current) throw new Error(`no package.json above ${start}`);
  }
}
