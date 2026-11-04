// Small Markdown renderer for Claude's replies: headings, lists (nested), fenced code, quotes,
// tables, rules, and inline code / bold / italic / links. It builds DOM nodes with textContent
// only, never innerHTML, so reply text can't inject markup. parseBlocks / parseInline are pure
// (no DOM), which keeps them testable in Node.

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]);
const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i])
  || QUOTE.test(lines[i]) || LIST_ITEM.test(lines[i]) || isTableStart(lines, i);
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function parseBlocks(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }

    if ((m = line.match(FENCE))) {
      const fence = m[1];
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) body.push(lines[i]);
      i++; // closing fence (or end of text)
      blocks.push({ type: 'code', lang: m[2], text: body.join('\n') });
    } else if ((m = line.match(HEADING))) {
      blocks.push({ type: 'heading', level: m[1].length, inline: parseInline(m[2]) });
      i++;
    } else if (RULE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
    } else if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', children: parseBlocks(body.join('\n')) });
    } else if (isTableStart(lines, i)) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
      blocks.push({ type: 'table', head: head.map(parseInline), rows: rows.map((r) => r.map(parseInline)) });
    } else if ((m = line.match(LIST_ITEM))) {
      i = parseList(lines, i, blocks);
    } else {
      const body = [line.trim()];
      for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) body.push(lines[i].trim());
      blocks.push({ type: 'p', inline: parseInline(body.join('\n')) });
    }
  }
  return blocks;
}

// A list of items at one indent; deeper-indented lines belong to the item above (which is how
// nested lists come out). Returns the index after the list.
function parseList(lines, i, blocks) {
  const first = lines[i].match(LIST_ITEM);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = []; // each: { offset, lines }
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST_ITEM);
    if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
      items.push({ offset: m[1].length + m[2].length + 1, lines: [m[3]] });
      i++;
    } else if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = lines[j];
      const continues = next != null && (next.match(/^\s*/)[0].length > indent
        || (LIST_ITEM.test(next) && next.match(LIST_ITEM)[1].length === indent));
      if (!continues) break;
      items.at(-1).lines.push('');
      i++;
    } else if (line.match(/^\s*/)[0].length > indent) {
      const item = items.at(-1);
      const lead = line.match(/^\s*/)[0].length;
      item.lines.push(line.slice(Math.min(lead, item.offset)));
      i++;
    } else {
      break;
    }
  }
  blocks.push({
    type: ordered ? 'ol' : 'ul',
    start: ordered ? parseInt(first[2], 10) : null,
    items: items.map((it) => parseBlocks(it.lines.join('\n'))),
  });
  return i;
}

const INLINE = new RegExp([
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source,          // 1,2: code
  /\*\*(?=\S)([\s\S]*?\S)\*\*/.source,                 // 3: strong
  /__(?=\S)([\s\S]*?\S)__/.source,                     // 4: strong
  /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.source, // 5,6: link; URL may hold (balanced) parens
  /(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/.source,  // 7: em
  /(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/.source,    // 8: em
].join('|'));

export function parseInline(src) {
  const out = [];
  let rest = String(src ?? '');
  while (rest) {
    const m = rest.match(INLINE);
    if (!m) { out.push({ t: 'text', text: rest }); break; }
    if (m.index) out.push({ t: 'text', text: rest.slice(0, m.index) });
    if (m[1]) out.push({ t: 'code', text: m[2] });
    else if (m[3] ?? m[4]) out.push({ t: 'strong', children: parseInline(m[3] ?? m[4]) });
    else if (m[5]) out.push({ t: 'link', href: m[6], children: parseInline(m[5]) });
    else out.push({ t: 'em', children: parseInline(m[7] ?? m[8]) });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// Reply text without Markdown markers, for one-line previews and notifications.
export function toPlainText(src) {
  const inline = (nodes) => nodes.map((n) => (n.children ? inline(n.children) : n.text)).join('');
  const block = (b) => {
    switch (b.type) {
      case 'p': case 'heading': return inline(b.inline);
      case 'code': return b.text;
      case 'quote': return b.children.map(block).join(' ');
      case 'ul': case 'ol': return b.items.map((it) => it.map(block).join(' ')).join(' · ');
      case 'table': return [b.head, ...b.rows].map((r) => r.map(inline).join(' | ')).join(' · ');
      default: return '';
    }
  };
  return parseBlocks(src).map(block).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// --- DOM ----------------------------------------------------------------------------------

const SAFE_LINK = /^(https?:|mailto:)/i;

export function renderMarkdown(src, doc = document) {
  const el = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };

  const inline = (nodes, parent) => {
    for (const n of nodes) {
      if (n.t === 'text') {
        n.text.split('\n').forEach((part, k) => { if (k) parent.append(el('br')); parent.append(part); });
      } else if (n.t === 'code') {
        const c = el('code'); c.textContent = n.text; parent.append(c);
      } else if (n.t === 'link' && SAFE_LINK.test(n.href)) {
        const a = el('a'); a.href = n.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        inline(n.children, a); parent.append(a);
      } else if (n.t === 'link') {
        inline(n.children, parent); // unsafe scheme: keep the text, drop the link
      } else {
        const e = el(n.t === 'strong' ? 'strong' : 'em'); inline(n.children, e); parent.append(e);
      }
    }
    return parent;
  };

  const block = (b) => {
    switch (b.type) {
      case 'heading': return inline(b.inline, el(`h${Math.min(b.level + 2, 6)}`, 'md-h'));
      case 'p': return inline(b.inline, el('p'));
      case 'hr': return el('hr');
      case 'code': {
        const pre = el('pre', 'md-code'); const c = el('code'); c.textContent = b.text; pre.append(c); return pre;
      }
      case 'quote': { const q = el('blockquote'); b.children.forEach((c) => q.append(block(c))); return q; }
      case 'ul': case 'ol': {
        const list = el(b.type);
        if (b.start != null && b.start !== 1) list.start = b.start;
        for (const item of b.items) { const li = el('li'); item.forEach((c) => li.append(block(c))); list.append(li); }
        return list;
      }
      case 'table': {
        const wrap = el('div', 'md-table'); const table = el('table');
        const thead = el('thead'); const tr = el('tr');
        b.head.forEach((c) => tr.append(inline(c, el('th')))); thead.append(tr); table.append(thead);
        const body = el('tbody');
        for (const row of b.rows) { const r = el('tr'); row.forEach((c) => r.append(inline(c, el('td')))); body.append(r); }
        table.append(body); wrap.append(table); return wrap;
      }
      default: return doc.createTextNode('');
    }
  };

  const frag = doc.createDocumentFragment();
  for (const b of parseBlocks(src)) frag.append(block(b));
  return frag;
}
