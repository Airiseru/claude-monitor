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
const picks = new Map();     // question request id -> { [question]: Set of picked labels }
const others = new Map();    // question request id -> { [question]: typed answer }
const token = fetch('/api/token').then((r) => r.json()).then((d) => d.token);
let permissionHookInstalled = true; // refreshed from /api/setup whenever a prompt can't be answered here
let setup = { auth: null, folders: [] }; // from /api/setup: login in use, recent folders
let newSessionOpen = false;
const newDraft = { cwd: '', prompt: '', error: null, busy: false };

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
const usd = (n) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

// Context bar plus cost, side by side. Cost is the session's tokens at API prices: an estimate
// of usage, not a bill, on a subscription.
function stats(s, large = false) {
  const c = s.cost;
  const cost = c?.usd != null && (large
    ? `≈ ${usd(c.usd)} at API prices${c.linesAdded != null ? ` · +${c.linesAdded.toLocaleString()} / −${(c.linesRemoved ?? 0).toLocaleString()} lines` : ''}`
    : usd(c.usd));
  const bar = contextBar(s.context, large);
  if (!bar && !cost) return null;
  return h('div', { class: `stats${large ? ' large' : ''}` }, bar, cost && h('span', { class: 'ctx-text' }, cost));
}
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

// Claude's AskUserQuestion, answered from the page (dashboard sessions only): pick options, or
// type your own answer, for each question.
function questionForm(p) {
  const state = answers.get(p.id);
  if (state && state !== 'sending') return h('p', { class: `answered ${state}` }, state === 'allow' ? 'Answer sent' : ANSWER_TEXT[state] ?? state);
  const chosen = picks.get(p.id) ?? {};
  const typed = others.get(p.id) ?? {};
  const answerFor = (q) => (typed[q.question]?.trim() || [...(chosen[q.question] ?? [])].join(', '));
  const complete = p.questions.every((q) => answerFor(q));

  const pick = (q, label) => {
    const set = new Set(q.multiSelect ? chosen[q.question] : []);
    set.has(label) ? set.delete(label) : set.add(label);
    picks.set(p.id, { ...chosen, [q.question]: set });
    renderDetail();
  };
  const submit = async (e) => {
    e.preventDefault();
    document.activeElement?.blur();
    answers.set(p.id, 'sending');
    render();
    try {
      const res = await post(`/api/permissions/${encodeURIComponent(p.id)}`, {
        answers: Object.fromEntries(p.questions.map((q) => [q.question, answerFor(q)])),
      });
      answers.set(p.id, res.ok ? 'allow' : res.status === 409 ? 'gone' : `Couldn’t send (error ${res.status})`);
    } catch {
      answers.set(p.id, 'Couldn’t reach the monitor server');
    }
    render();
  };

  return h('form', { class: 'question', onsubmit: submit },
    p.questions.map((q) => {
      const other = h('input', {
        class: 'input', placeholder: 'Or type your own answer', 'aria-label': `Your own answer to: ${q.question}`,
        oninput: (e) => { others.set(p.id, { ...(others.get(p.id) ?? {}), [q.question]: e.target.value }); },
      });
      other.value = typed[q.question] ?? '';
      return h('fieldset', { class: 'q' },
        h('legend', {}, q.header ? h('span', { class: 'tag' }, q.header) : null, ' ', q.question,
          q.multiSelect && h('span', { class: 'muted small' }, '  (pick any)')),
        h('div', { class: 'options' }, (q.options ?? []).map((o) => {
          const on = chosen[q.question]?.has(o.label);
          return h('button', { type: 'button', class: `option${on ? ' on' : ''}`, 'aria-pressed': String(Boolean(on)), onclick: () => pick(q, o.label) },
            h('strong', {}, o.label), o.description && h('span', { class: 'muted' }, o.description));
        })),
        other);
    }),
    h('div', { class: 'detail-actions' },
      h('button', { type: 'submit', class: 'btn allow', disabled: state === 'sending' || !complete }, state === 'sending' ? 'Sending…' : 'Send answer'),
      h('button', { type: 'button', class: 'btn deny', disabled: state === 'sending', onclick: () => answer(p.id, 'deny') }, 'Skip question')));
}

// --- reply box (dashboard sessions) --------------------------------------------------------

const drafts = new Map(); // session id -> unsent reply text
const composer = {
  form: document.getElementById('composer'),
  note: document.getElementById('composer-note'),
  text: document.getElementById('composer-text'),
  status: document.getElementById('composer-status'),
  stop: document.getElementById('composer-stop'),
  end: document.getElementById('composer-end'),
  send: document.getElementById('composer-send'),
  sessionId: null,
};

function renderComposer(s) {
  const show = Boolean(s?.dashboard) && !newSessionOpen;
  composer.form.hidden = !show;
  if (!show) { composer.sessionId = null; return; }
  if (composer.sessionId !== s.id) { // switched session: swap in that session's draft
    composer.sessionId = s.id;
    composer.text.value = drafts.get(s.id) ?? '';
    composer.status.textContent = '';
  }
  const live = s.dashboard.live;
  composer.note.textContent = live
    ? (s.status === 'working' ? 'Claude is working. What you send now goes after this turn.' : '')
    : 'This session isn’t running. Sending a message starts it again where it left off.';
  composer.note.hidden = !composer.note.textContent;
  composer.stop.hidden = !(live && s.status === 'working');
  composer.end.hidden = !live;
}

composer.text.addEventListener('input', () => drafts.set(composer.sessionId, composer.text.value));
composer.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) composer.form.requestSubmit(); });

composer.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = composer.sessionId;
  const text = composer.text.value.trim();
  if (!id || !text) return;
  composer.send.disabled = true;
  composer.status.textContent = 'Sending…';
  try {
    const res = await post(`/api/sessions/${encodeURIComponent(id)}/send`, { text });
    if (!res.ok) throw new Error((await res.text()) || `Error ${res.status}`);
    drafts.delete(id);
    if (composer.sessionId === id) { composer.text.value = ''; composer.status.textContent = 'Sent'; }
  } catch (err) {
    composer.status.textContent = `Not sent: ${err.message}`; // the text stays in the box
  } finally {
    composer.send.disabled = false;
  }
});

for (const [button, action, label] of [[composer.stop, 'interrupt', 'Stopping…'], [composer.end, 'end', 'Ending…']]) {
  button.addEventListener('click', async () => {
    composer.status.textContent = label;
    const res = await post(`/api/sessions/${encodeURIComponent(composer.sessionId)}/${action}`).catch(() => null);
    composer.status.textContent = res?.ok ? '' : 'Couldn’t reach the monitor server';
  });
}

// Catch up on a redraw that waited while you typed in the detail view.
document.getElementById('detail-content').addEventListener('focusout', () => {
  setTimeout(() => { if (detailDeferred) renderDetail(); }, 0);
});

// --- session list --------------------------------------------------------------------------

function renderList() {
  const nav = document.getElementById('sessions');
  nav.replaceChildren(h('button', {
    class: `btn new-session${newSessionOpen ? ' selected' : ''}`, onclick: openNewSession,
  }, '+ New session'));
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
  const meta = [folder(s.cwd), s.branch, s.dashboard && 'started here'].filter(Boolean).join(' · ');
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
      stats(s)),
    removable && h('button', { class: 'card-remove', 'aria-label': `Remove “${titleOf(s)}” from the list`, onclick: () => removeSessions([s.id]) }, '×'),
    actions && h('div', { class: 'card-actions' }, actions));
}

function select(id) {
  newSessionOpen = false;
  selectedId = id;
  history.replaceState(null, '', id ? `#${encodeURIComponent(id)}` : location.pathname);
  detail = null;
  detailVersion = null;
  openFiles.clear();
  render();
  if (id) loadDetail();
  document.getElementById('detail-content').scrollTop = 0;
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
    const { permissionHook, auth, folders } = await (await fetch('/api/setup')).json();
    setup = { auth, folders: folders ?? [] };
    if (permissionHook !== permissionHookInstalled) { permissionHookInstalled = permissionHook; renderDetail(); }
  } catch {
    // Server unreachable: the connection indicator already says so.
  }
}

// --- new session ---------------------------------------------------------------------------

async function openNewSession() {
  selectedId = null;
  history.replaceState(null, '', location.pathname);
  newSessionOpen = true;
  await checkSetup();
  if (!newDraft.cwd) newDraft.cwd = setup.folders[0] ?? '';
  render();
  document.getElementById('new-prompt')?.focus();
}

async function startNewSession(e) {
  e.preventDefault();
  document.activeElement?.blur(); // leaving the field lets the page redraw (see renderDetail)
  newDraft.busy = true;
  newDraft.error = null;
  renderDetail();
  try {
    const res = await post('/api/new-session', { cwd: newDraft.cwd, prompt: newDraft.prompt });
    const text = await res.text(); // errors come back as plain text
    if (!res.ok) throw new Error(text || `Error ${res.status}`);
    Object.assign(newDraft, { prompt: '', busy: false });
    select(JSON.parse(text).id);
  } catch (err) {
    Object.assign(newDraft, { busy: false, error: err.message });
    renderDetail();
  }
}

// What credential dashboard sessions use, in words (SDK apiKeySource; 'none' means no API key,
// so Claude Code uses your login).
function authText(auth) {
  if (auth === 'ANTHROPIC_API_KEY' || auth === 'apiKeyHelper') return 'an API key (billed per token to that API account)';
  if (auth == null) return 'your Claude login, as in the terminal';
  return 'your Claude login (no API key found)';
}

// Opens the macOS folder dialog (through the server, which can see real paths).
async function chooseFolder() {
  newDraft.choosing = true;
  renderDetail();
  try {
    const res = await post('/api/choose-folder', { from: newDraft.cwd });
    const { folder } = await res.json();
    if (folder) newDraft.cwd = folder;
  } catch {
    newDraft.error = 'Couldn’t open the folder dialog';
  }
  newDraft.choosing = false;
  renderDetail();
}

const tilde = (path) => path.replace(/^\/Users\/[^/]+/, '~');

function newSessionForm() {
  const folders = [...new Set([newDraft.cwd, ...setup.folders].filter(Boolean))];
  const cwdSelect = h('select', { id: 'new-cwd', class: 'input', required: true, onchange: (e) => { newDraft.cwd = e.target.value; } },
    folders.length ? folders.map((f) => h('option', { value: f }, tilde(f))) : h('option', { value: '' }, 'No folder chosen yet'));
  cwdSelect.value = newDraft.cwd;
  const promptInput = h('textarea', {
    id: 'new-prompt', class: 'input', rows: 6, required: true, oninput: (e) => { newDraft.prompt = e.target.value; },
  });
  promptInput.value = newDraft.prompt;
  promptInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.form.requestSubmit(); });
  return h('form', { class: 'new-form', onsubmit: startNewSession },
    h('h1', {}, 'New session'),
    h('p', { class: 'muted' }, 'Starts Claude Code in a folder and lets you reply from this page. Its permission prompts and questions show up here. It runs with ',
      authText(setup.auth), '. For your own use only.'),
    h('label', { for: 'new-cwd' }, 'Folder'),
    h('div', { class: 'folder-row' },
      cwdSelect,
      h('button', { type: 'button', class: 'btn', disabled: newDraft.choosing, onclick: chooseFolder },
        newDraft.choosing ? 'Choosing… (see the dialog)' : 'Choose in Finder…')),
    h('label', { for: 'new-prompt' }, 'First prompt'),
    promptInput,
    newDraft.error && h('p', { class: 'form-error', role: 'alert' }, newDraft.error),
    h('div', { class: 'detail-actions' },
      h('button', { type: 'submit', class: 'btn allow', disabled: newDraft.busy }, newDraft.busy ? 'Starting…' : 'Start session'),
      h('button', { type: 'button', class: 'btn', onclick: () => { newSessionOpen = false; render(); } }, 'Cancel')));
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

let detailDeferred = false; // a redraw waiting for you to leave a text field

function renderDetail() {
  const content = document.getElementById('detail-content');
  // Redrawing would throw away what you're typing; catch up when you leave the field.
  const typing = content.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (typing) { detailDeferred = true; return; }
  detailDeferred = false;
  const s = sessions.find((x) => x.id === selectedId);
  const scroll = content.scrollTop;
  content.replaceChildren();
  renderComposer(s);
  if (newSessionOpen) { content.append(newSessionForm()); return; }
  if (!s) {
    content.append(h('p', { class: 'empty' }, selectedId ? 'This session is no longer in the list.' : 'Select a session to see what it is doing.'));
    return;
  }
  const d = detail?.id === s.id ? detail : null;
  add(content,
    h('header', { class: 'detail-head' },
      h('div', { class: 'detail-title' },
        h('span', { class: `pill ${s.status}` }, STATUS_LABEL[s.status] ?? s.status),
        h('h1', {}, titleOf(s))),
      h('div', { class: 'meta' }, [s.cwd && s.cwd.replace(/^\/Users\/[^/]+/, '~'), s.branch, s.model].filter(Boolean).join('  ·  ')),
      stats(s, true),
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
  content.scrollTop = scroll;
}

function needSection(s) {
  const questions = s.permissions.filter((p) => p.questions);
  const requests = s.permissions.filter((p) => !p.questions);
  if (questions.length) return h('section', { class: 'need-box' }, h('h2', {}, 'Question for you'), questions.map(questionForm));
  if (requests.length) {
    return h('section', { class: 'need-box' },
      h('h2', {}, requests.length > 1 ? `${requests.length} permission requests` : 'Permission needed'),
      requests.map((p) => h('div', { class: 'perm' },
        h('div', { class: 'perm-head' }, h('strong', {}, p.summary), permissionActions(p)),
        h('pre', { class: 'perm-input' }, p.input))),
      h('p', { class: 'hint' }, s.dashboard
        ? 'This session was started here, so it waits for your answer on this page.'
        : 'You can also answer in the terminal. Whichever answer comes first is used.'));
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
