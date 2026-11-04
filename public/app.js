// Dashboard: live session list over Server-Sent Events, session detail fetched on demand.
// Transcript content is untrusted, so all text goes in through text nodes, never innerHTML.

const SECTIONS = [
  ['needs_you', 'Needs you'],
  ['working', 'Working'],
  ['waiting', 'Waiting for your next prompt'],
  ['idle', 'Last 24 hours, no events since the monitor started'],
  ['ended', 'Ended'],
];
const STATUS_LABEL = {
  needs_you: 'Needs you', working: 'Working', waiting: 'Waiting for you', idle: 'Not seen live yet', ended: 'Ended',
};

let sessions = [];
let selectedId = decodeURIComponent(location.hash.slice(1)) || null;
let detail = null;          // last fetched detail for selectedId
let detailVersion = null;   // which session state that detail was fetched for
let detailTimer = null;
const openFiles = new Set(); // expanded file paths in the detail view

// --- helpers -------------------------------------------------------------------------------

// Appends children, flattening arrays and skipping null/false, so `cond && h(...)` works.
// (Element.append on its own would print "null", "false" or "[object HTMLElement]".)
function add(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  return add(el, ...children);
}

const folder = (cwd) => (cwd ? cwd.split('/').filter(Boolean).pop() : null);
const shortPath = (path, cwd) => (cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path.replace(/^\/Users\/[^/]+/, '~'));
const tokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function titleOf(s) {
  return s.title || (s.lastPrompt && s.lastPrompt.slice(0, 70)) || folder(s.cwd) || s.id.slice(0, 8);
}

function lineOf(s) {
  if (s.need) return s.need.message || (s.need.kind === 'permission' ? 'Permission needed' : 'Question for you');
  if (s.status === 'working' && s.activity) return s.activity;
  return s.lastPrompt ? `You: ${s.lastPrompt}` : '';
}

function contextBar(c, large = false) {
  if (!c) return null;
  if (c.pct == null) return c.tokens ? h('div', { class: 'ctx' }, h('span', { class: 'ctx-text' }, `${tokens(c.tokens)} tokens in context`)) : null;
  const pct = Math.round(c.pct);
  const level = pct >= 80 ? 'high' : pct >= 60 ? 'mid' : 'low';
  const label = c.size ? `${pct}% context · ${tokens(c.tokens ?? (c.pct / 100) * c.size)} of ${tokens(c.size)}` : `${pct}% context`;
  const fill = h('div', { class: `ctx-fill ${level}` });
  fill.style.width = `${Math.min(pct, 100)}%`; // via CSSOM: the CSP blocks style attributes
  return h('div', { class: `ctx ${large ? 'large' : ''}` },
    h('div', { class: 'ctx-track', role: 'meter', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Context used' }, fill),
    h('span', { class: 'ctx-text' }, label));
}

// --- session list --------------------------------------------------------------------------

function renderList() {
  const nav = document.getElementById('sessions');
  nav.replaceChildren();
  if (!sessions.length) {
    nav.append(h('p', { class: 'empty' }, 'No sessions in the last 24 hours.'));
  }
  for (const [status, label] of SECTIONS) {
    const group = sessions.filter((s) => s.status === status).sort((a, b) => b.lastEventAt - a.lastEventAt);
    if (!group.length) continue;
    nav.append(h('h2', { class: `section ${status}` }, label, h('span', { class: 'count' }, group.length)));
    for (const s of group) nav.append(card(s));
  }
  const waiting = sessions.filter((s) => s.status === 'needs_you').length;
  document.title = waiting ? `(${waiting}) Claude Monitor` : 'Claude Monitor';
}

function card(s) {
  const meta = [folder(s.cwd), s.branch].filter(Boolean).join(' · ');
  return h('button', {
    class: `card ${s.status}${s.id === selectedId ? ' selected' : ''}`,
    'aria-current': s.id === selectedId ? 'true' : null,
    onclick: () => select(s.id),
  },
    h('div', { class: 'card-top' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'card-title' }, titleOf(s)),
      h('span', { class: 'ago' }, ago(s.lastEventAt))),
    meta && h('div', { class: 'card-meta' }, meta),
    h('div', { class: `card-line ${s.need ? 'need-line' : ''}` }, lineOf(s)),
    contextBar(s.context));
}

function select(id) {
  selectedId = id;
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  detail = null;
  detailVersion = null;
  openFiles.clear();
  renderList();
  renderDetail();
  loadDetail();
  document.getElementById('detail').scrollTop = 0;
}

// --- detail --------------------------------------------------------------------------------

const versionOf = (s) => (s ? `${s.lastEventAt}|${s.transcriptUpdatedAt}` : null);

async function loadDetail() {
  const id = selectedId;
  const version = versionOf(sessions.find((s) => s.id === id));
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'No transcript for this session yet.' : `Error ${res.status}`);
    const data = await res.json();
    if (id !== selectedId) return;
    detail = data;
    detailVersion = version;
  } catch (err) {
    if (id !== selectedId) return;
    detail = { id, error: err.message };
  }
  renderDetail();
}

function loadDetailSoon() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(loadDetail, 800);
}

function renderDetail() {
  const main = document.getElementById('detail');
  const s = sessions.find((x) => x.id === selectedId);
  const scroll = main.scrollTop;
  main.replaceChildren();
  if (!s) {
    main.append(h('p', { class: 'empty' }, selectedId ? 'This session is no longer in the list.' : 'Select a session to see what it is doing.'));
    return;
  }
  const d = detail?.id === s.id ? detail : null;
  add(main,
    h('header', { class: 'detail-head' },
      h('div', { class: 'detail-title' },
        h('span', { class: `pill ${s.status}` }, STATUS_LABEL[s.status] ?? s.status),
        h('h1', {}, titleOf(s))),
      h('div', { class: 'meta' }, [s.cwd && s.cwd.replace(/^\/Users\/[^/]+/, '~'), s.branch, s.model].filter(Boolean).join('  ·  ')),
      contextBar(s.context, true)),
    s.need && h('section', { class: 'need-box' },
      h('h2', {}, s.need.kind === 'permission' ? 'Permission needed' : 'Question for you'),
      h('p', {}, s.need.message || ''),
      h('p', { class: 'hint' }, 'Answer it in this session’s Warp tab.')),
    s.status === 'working' && s.activity && h('p', { class: 'now' }, h('strong', {}, 'Now: '), s.activity),
    s.lastPrompt && h('section', { class: 'block' }, h('h2', {}, 'Last prompt'), h('p', { class: 'prompt' }, s.lastPrompt)),
    !d ? h('p', { class: 'empty' }, 'Loading…')
      : d.error ? h('p', { class: 'empty' }, d.error)
        : [filesSection(d), timelineSection(d)],
  );
  main.scrollTop = scroll;
}

function filesSection(d) {
  const files = [...d.files].sort((a, b) => (b.edits.at(-1)?.ts ?? '').localeCompare(a.edits.at(-1)?.ts ?? ''));
  return h('section', { class: 'block' },
    h('h2', {}, 'Files changed ', h('span', { class: 'count' }, files.length)),
    !files.length ? h('p', { class: 'muted' }, 'No files changed in this session.')
      : h('ul', { class: 'files' }, files.map((f) => fileRow(f, d.cwd))));
}

function fileRow(f, cwd) {
  const open = openFiles.has(f.path);
  const failed = f.edits.filter((e) => e.failed).length;
  const ok = f.edits.length - failed;
  return h('li', { class: 'file' },
    h('button', {
      class: 'file-head', 'aria-expanded': String(open),
      onclick: () => { open ? openFiles.delete(f.path) : openFiles.add(f.path); renderDetail(); },
    },
      h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      h('span', { class: 'path' }, shortPath(f.path, cwd)),
      h('span', { class: 'muted' }, `${ok} edit${ok === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''} · ${clock(f.edits.at(-1).ts)}`)),
    open && h('div', { class: 'edits' }, [...f.edits].reverse().map((e) =>
      h('div', { class: `edit ${e.failed ? 'failed' : ''}` },
        h('div', { class: 'edit-meta' }, `${clock(e.ts)} · ${e.tool}${e.failed ? ' · failed, file unchanged' : ''}`),
        e.before != null && h('pre', { class: 'diff del' }, e.before),
        e.after != null && h('pre', { class: 'diff add' }, e.after)))));
}

function timelineSection(d) {
  const items = [...d.timeline].reverse();
  return h('section', { class: 'block' },
    h('h2', {}, 'Timeline'),
    !items.length ? h('p', { class: 'muted' }, 'Nothing yet.')
      : h('ol', { class: 'timeline' }, items.map((it) =>
        h('li', { class: `tl tl-${it.kind}${it.error ? ' tl-error' : ''}` },
          h('span', { class: 'tl-time' }, it.ts ? clock(it.ts) : ''),
          h('div', { class: 'tl-body' },
            it.kind === 'prompt' ? [h('span', { class: 'tag you' }, 'You'), h('span', { class: 'tl-text' }, it.text)]
              : it.kind === 'command' || it.kind === 'note' ? [h('span', { class: 'tag' }, it.kind === 'command' ? 'Command' : 'Note'), h('span', { class: 'tl-text muted' }, it.text)]
              : [h('span', { class: 'tag' }, it.tool), h('span', { class: 'tl-text' }, it.text),
                it.error && h('span', { class: 'tag err' }, 'failed'),
                it.command && it.command !== it.text && h('code', { class: 'cmd' }, it.command)])))));
}

// --- live updates --------------------------------------------------------------------------

function connect() {
  const conn = document.getElementById('conn');
  const es = new EventSource('/events');
  es.addEventListener('sessions', (e) => {
    sessions = JSON.parse(e.data);
    renderList();
    const s = sessions.find((x) => x.id === selectedId);
    if (s && detailVersion !== versionOf(s)) loadDetailSoon();
    renderDetail();
  });
  es.onopen = () => { conn.textContent = 'Live'; conn.className = 'conn live'; };
  es.onerror = () => { conn.textContent = 'Disconnected. Is the server running? Retrying…'; conn.className = 'conn down'; };
}

renderDetail();
connect();
setInterval(renderList, 30_000); // keep "5m ago" fresh
