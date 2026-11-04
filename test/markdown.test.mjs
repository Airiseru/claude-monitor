import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBlocks, parseInline, renderMarkdown, toPlainText } from '../public/markdown.js';

// Just enough of a DOM to check what renderMarkdown builds.
const fakeDoc = {
  createElement: (tag) => ({ tag, children: [], append(...c) { this.children.push(...c); } }),
  createDocumentFragment() { return this.createElement('#fragment'); },
  createTextNode: (text) => text,
};
const show = (n) => (typeof n === 'string' ? n
  : `<${n.tag}${n.href ? ` href=${n.href}` : ''}>${n.textContent ?? ''}${n.children.map(show).join('')}</${n.tag}>`);

test('renders to elements with text only; unsafe links lose the link', () => {
  const out = show(renderMarkdown('# Hi\n\n- **a** [ok](https://x.dev) [bad](javascript:alert(1))\n\n| h |\n|---|\n| c |', fakeDoc));
  assert.equal(out, '<#fragment><h3>Hi</h3>'
    + '<ul><li><p><strong>a</strong> <a href=https://x.dev>ok</a> bad</p></li></ul>'
    + '<div><table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table></div></#fragment>');
});

const types = (blocks) => blocks.map((b) => b.type);

test('blocks: headings, paragraphs, code, rules, quotes', () => {
  const b = parseBlocks('## Done\n\nAll **good**.\nSecond line.\n\n```js\nconst x = 1;\n\n// kept\n```\n---\n> quoted\n> more');
  assert.deepEqual(types(b), ['heading', 'p', 'code', 'hr', 'quote']);
  assert.equal(b[0].level, 2);
  assert.equal(b[2].lang, 'js');
  assert.equal(b[2].text, 'const x = 1;\n\n// kept', 'blank lines and markers inside code are kept');
  assert.deepEqual(types(b[4].children), ['p']);
});

test('lists: bullets, numbers with a start, nesting, and a paragraph after', () => {
  const b = parseBlocks('- one\n- two\n  - two.a\n  - two.b\n- three\n\n3. c\n4. d\n\nAfter.');
  assert.deepEqual(types(b), ['ul', 'ol', 'p']);
  assert.equal(b[0].items.length, 3);
  assert.deepEqual(types(b[0].items[1]), ['p', 'ul'], 'indented items nest under the item above');
  assert.equal(b[0].items[1][1].items.length, 2);
  assert.equal(b[1].start, 3);
});

test('tables', () => {
  const [t] = parseBlocks('| What | Count |\n|---|---:|\n| prompts | 621 |\n| questions | 43 |');
  assert.equal(t.type, 'table');
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][1][0].text, '621');
});

test('inline: code, bold, italic, links; markers inside code stay literal', () => {
  const n = parseInline('Run `npm **test**`, then **check** _this_ and [docs](https://x.dev). 2*3*4 stays.');
  assert.deepEqual(n.map((x) => x.t), ['text', 'code', 'text', 'strong', 'text', 'em', 'text', 'link', 'text']);
  assert.equal(n[1].text, 'npm **test**');
  assert.equal(n[7].href, 'https://x.dev');
  assert.equal(n.at(-1).text, '. 2*3*4 stays.');
});

test('toPlainText drops markers for previews', () => {
  assert.equal(toPlainText('## Done\n\n- **Fixed** the `bug`\n- Tests pass'), 'Done Fixed the bug · Tests pass');
});
