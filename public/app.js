// Dashboard: live session list over Server-Sent Events, session detail fetched on demand.
// Transcript content is untrusted, so all text goes in through text nodes, never innerHTML.
import { renderMarkdown, toPlainText } from './markdown.js';

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
const LIVE = new Set(['needs_you', 'working']); // can't be removed from the list while live
const LONG_REPLY = 1200; // characters before a reply is shown collapsed

let sessions = [];
let selectedId = decodeURIComponent(location.hash.slice(1)) || null;
let detail = null;          // last fetched detail for selectedId
let detailVersion = null;   // which session state that detail was fetched for
let detailTimer = null;
const openFiles = new Set(); // expanded file paths in the detail view
const openReplies = new Set(); // session ids whose long reply is expanded
const answers = new Map();   // permission id -> 'sending' | 'allow' | 'deny' | 'gone' | error text
const token = fetch('/api/token').then((r) => r.json()).then((d) => d.token);
let permissionHookInstalled = true; // refreshed from /api/setup whenever a prompt can't be answered here

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

// Per-browser preferences only; the page works the same when storage is unavailable.
const pref = {
  get(key) { try { return localStorage.getItem(`claude-monitor.${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`claude-monitor.${key}`, value); } catch { /* ignore */ } },
};

// Every action the page takes goes through here: same-origin, with this run's token.
async function post(path, body = {}) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': await token },
    body: JSON.stringify(body),
  });
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
  if (s.status !== 'working' && s.lastResponse) return `Claude: ${toPlainText(s.lastResponse)}`;
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

// --- actions -------------------------------------------------------------------------------

async function answer(id, decision) {
  answers.set(id, 'sending');
  render();
  try {
    const res = await post(`/api/permissions/${encodeURIComponent(id)}`, { decision });
    answers.set(id, res.ok ? decision : res.status === 409 ? 'gone' : `Couldn’t send (error ${res.status})`);
  } catch {
    answers.set(id, 'Couldn’t reach the monitor server');
  }
  render();
}

async function removeSessions(ids) {
  if (ids.includes(selectedId)) select(null);
  sessions = sessions.filter((s) => !ids.includes(s.id)); // don't wait for the server to redraw
  render();
  await post('/api/hide', { ids }).catch(() => {});
}

const goToWarp = () => post('/api/focus-warp').catch(() => {});

const ANSWER_TEXT = { sending: 'Sending…', allow: 'Allowed', deny: 'Denied', gone: 'Already answered in the terminal' };

function permissionActions(p) {
  const state = answers.get(p.id);
  if (state && state !== 'sending') return h('span', { class: `answered ${state}` }, ANSWER_TEXT[state] ?? state);
  const busy = state === 'sending';
  return h('span', { class: 'actions' },
    h('button', { class: 'btn allow', disabled: busy, onclick: () => answer(p.id, 'allow') }, 'Allow'),
    h('button', { class: 'btn deny', disabled: busy, onclick: () => answer(p.id, 'deny') }, 'Deny'));
}

const warpButton = () => h('button', { class: 'btn', onclick: goToWarp }, 'Go to Warp');

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
    nav.append(h('h2', { class: `section ${status}` },
      h('span', { class: 'section-label' }, label),
      h('span', { class: 'count' }, group.length),
      !LIVE.has(status) && h('button', {
        class: 'link', 'aria-label': `Remove all ${group.length} from the list`, onclick: () => removeSessions(group.map((s) => s.id)),
      }, 'Clear')));
    for (const s of group) nav.append(card(s));
  }
  const waiting = sessions.filter((s) => s.status === 'needs_you').length;
  document.title = waiting ? `(${waiting}) Claude Monitor` : 'Claude Monitor';
  renderToolbar();
}

function card(s) {
  const meta = [folder(s.cwd), s.branch].filter(Boolean).join(' · ');
  const removable = !LIVE.has(s.status);
  const p = s.permissions[0];
  const actions = p
    ? (s.permissions.length > 1 ? h('span', { class: 'muted' }, `${s.permissions.length} requests, open to answer`) : permissionActions(p))
    : s.status === 'needs_you' && h('span', { class: 'actions' }, warpButton());
  return h('div', { class: `card-group${actions ? ' with-actions' : ''}` },
    h('button', {
      class: `card ${s.status}${s.id === selectedId ? ' selected' : ''}${removable ? ' removable' : ''}`,
      'aria-current': s.id === selectedId ? 'true' : null,
      onclick: () => select(s.id),
    },
      h('div', { class: 'card-top' },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { class: 'card-title' }, titleOf(s)),
        h('span', { class: 'ago' }, ago(s.lastEventAt))),
      meta && h('div', { class: 'card-meta' }, meta),
      h('div', { class: `card-line ${s.need ? 'need-line' : ''}` }, lineOf(s)),
      contextBar(s.context)),
    removable && h('button', { class: 'card-remove', 'aria-label': `Remove “${titleOf(s)}” from the list`, onclick: () => removeSessions([s.id]) }, '×'),
    actions && h('div', { class: 'card-actions' }, actions));
}

function select(id) {
  selectedId = id;
  history.replaceState(null, '', id ? `#${encodeURIComponent(id)}` : location.pathname);
  detail = null;
  detailVersion = null;
  openFiles.clear();
  render();
  if (id) loadDetail();
  document.getElementById('detail').scrollTop = 0;
}

// --- toolbar: sidebar and notifications ----------------------------------------------------

let sidebarHidden = pref.get('sidebar') === 'hidden';
let notifyOn = pref.get('notify') === 'on' && 'Notification' in window && Notification.permission === 'granted';

function renderToolbar() {
  document.body.classList.toggle('sidebar-hidden', sidebarHidden);
  const needs = sessions.filter((s) => s.status === 'needs_you').length;
  const toggle = document.getElementById('toggle-sidebar');
  toggle.textContent = sidebarHidden ? `Show sessions${needs ? ` (${needs} need you)` : ''}` : 'Hide sessions';
  toggle.setAttribute('aria-expanded', String(!sidebarHidden));
  toggle.classList.toggle('alert', sidebarHidden && needs > 0);

  const bell = document.getElementById('notify');
  if (!('Notification' in window)) { bell.hidden = true; return; }
  const blocked = Notification.permission === 'denied';
  bell.textContent = blocked ? 'Notifications blocked' : notifyOn ? 'Notifications on' : 'Notifications off';
  bell.setAttribute('aria-pressed', String(notifyOn));
  bell.disabled = blocked;
}

document.getElementById('toggle-sidebar').addEventListener('click', () => {
  sidebarHidden = !sidebarHidden;
  pref.set('sidebar', sidebarHidden ? 'hidden' : 'shown');
  renderToolbar();
});

document.getElementById('notify').addEventListener('click', async () => {
  if (!notifyOn && Notification.permission !== 'granted') await Notification.requestPermission();
  notifyOn = !notifyOn && Notification.permission === 'granted';
  pref.set('notify', notifyOn ? 'on' : 'off');
  renderToolbar();
});

// Notifies when a session starts needing you or finishes a turn, only while you're not
// looking at the dashboard.
let lastStatus = null; // session id -> status at the previous update; null before the first
function notifyChanges(list) {
  if (lastStatus && notifyOn && (document.hidden || !document.hasFocus())) {
    for (const s of list) {
      const was = lastStatus.get(s.id);
      if (s.status === 'needs_you' && was !== 'needs_you') {
        notify(s, 'Needs you', s.permissions[0]?.summary ?? s.need?.message);
      } else if (s.status === 'waiting' && was === 'working') {
        notify(s, 'Finished', s.lastResponse ? toPlainText(s.lastResponse) : s.lastPrompt);
      }
    }
  }
  lastStatus = new Map(list.map((s) => [s.id, s.status]));
}

function notify(s, what, body) {
  const n = new Notification(`${what}: ${titleOf(s)}`, { body: (body ?? '').slice(0, 180), tag: s.id });
  n.onclick = () => { window.focus(); select(s.id); n.close(); };
}

// --- detail --------------------------------------------------------------------------------

const versionOf = (s) => (s ? `${s.lastEventAt}|${s.transcriptUpdatedAt}` : null);

async function checkSetup() {
  try {
    const { permissionHook } = await (await fetch('/api/setup')).json();
    if (permissionHook !== permissionHookInstalled) { permissionHookInstalled = permissionHook; renderDetail(); }
  } catch {
    // Server unreachable: the connection indicator already says so.
  }
}

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
      contextBar(s.context, true),
      h('div', { class: 'detail-actions' },
        warpButton(),
        !LIVE.has(s.status) && h('button', { class: 'btn', onclick: () => removeSessions([s.id]) }, 'Remove from list'))),
    needSection(s),
    s.status === 'working' && s.activity && h('p', { class: 'now' }, h('strong', {}, 'Now: '), s.activity),
    s.lastPrompt && h('section', { class: 'block' }, h('h2', {}, 'Last prompt'), h('p', { class: 'prompt' }, s.lastPrompt)),
    d?.lastResponse && replySection(s, d),
    !d ? h('p', { class: 'empty' }, 'Loading…')
      : d.error ? h('p', { class: 'empty' }, d.error)
        : [filesSection(d), timelineSection(d)],
  );
  main.scrollTop = scroll;
}

function needSection(s) {
  if (s.permissions.length) {
    return h('section', { class: 'need-box' },
      h('h2', {}, s.permissions.length > 1 ? `${s.permissions.length} permission requests` : 'Permission needed'),
      s.permissions.map((p) => h('div', { class: 'perm' },
        h('div', { class: 'perm-head' }, h('strong', {}, p.summary), permissionActions(p)),
        h('pre', { class: 'perm-input' }, p.input))),
      h('p', { class: 'hint' }, 'You can also answer in the terminal. Whichever answer comes first is used.'));
  }
  if (!s.need) return null;
  const hint = s.need.kind !== 'permission' ? 'Answer it in this session’s Warp tab.'
    : permissionHookInstalled
      ? 'This prompt can only be answered in the session’s Warp tab (sandbox prompts can’t be answered from here).'
      : 'Allow and Deny need the permission hook, which isn’t installed. Run `npm run hooks:install` in ~/Documents/claude-monitor, then answer this one in Warp. Prompts after that get buttons here.';
  return h('section', { class: 'need-box' },
    h('h2', {}, s.need.kind === 'permission' ? 'Permission needed' : 'Question for you'),
    h('p', {}, s.need.message || ''),
    h('div', { class: 'need-foot' }, h('p', { class: 'hint' }, hint), warpButton()));
}

function replySection(s, d) {
  const long = d.lastResponse.length > LONG_REPLY;
  const open = openReplies.has(s.id);
  const toggle = () => { open ? openReplies.delete(s.id) : openReplies.add(s.id); renderDetail(); };
  return h('section', { class: 'block' },
    h('h2', {}, d.turnEnded ? 'Claude’s reply' : 'Claude’s reply so far',
      d.lastResponseAt && h('span', { class: 'muted small' }, clock(d.lastResponseAt))),
    h('div', { class: `reply md${long && !open ? ' clipped' : ''}` }, renderMarkdown(d.lastResponse)),
    long && h('button', { class: 'link', 'aria-expanded': String(open), onclick: toggle }, open ? 'Show less' : 'Show all'));
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
    notifyChanges(sessions);
    renderList();
    const s = sessions.find((x) => x.id === selectedId);
    if (s && detailVersion !== versionOf(s)) loadDetailSoon();
    if (s?.need?.kind === 'permission' && !s.permissions.length) checkSetup();
    renderDetail();
  });
  es.onopen = () => { conn.textContent = 'Live'; conn.className = 'conn live'; };
  es.onerror = () => { conn.textContent = 'Disconnected. Is the server running? Retrying…'; conn.className = 'conn down'; };
}

function render() {
  renderList();
  renderDetail();
}

render();
connect();
setInterval(renderList, 30_000); // keep "5m ago" fresh
