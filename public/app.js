// Dashboard: live session list over Server-Sent Events, session detail fetched on demand.
// Transcript content is untrusted, so all text goes in through text nodes, never innerHTML.
import { renderMarkdown, toPlainText } from './markdown.js';

const SECTIONS = [
  ['needs_you', 'Needs you'],
  ['working', 'Working'],
  ['waiting', 'Waiting for your next prompt'],
  ['idle', 'Last 36 hours, no events since the monitor started'],
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
let setup = { auth: null, folders: [], models: [] }; // from /api/setup: login in use, recent folders, models
let newSessionOpen = false;
const newDraft = { cwd: '', prompt: '', model: 'default', error: null, images: [] };
let starting = null;         // { cwd, prompt, model } while a new session spins up
let renaming = null;         // { id, value, error, busy } while a title is being edited
const filter = { text: '', project: '' }; // sidebar search and project filter
const openAgents = new Set(); // Agent tool-call ids whose subagent work is expanded
let detailTab = 'timeline';   // 'timeline' | 'chat': what the session panel shows below its header
let chatToEnd = false;        // scroll the chat to its latest message on the next draw
let copied = null;            // session id whose resume command was just copied

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
const imagesNote = (n) => `${n} image${n > 1 ? 's' : ''} attached`;
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

// Ask before removing: a modal "are you sure?" that resolves to true only on Remove.
function confirmRemove(ids) {
  const one = ids.length === 1 && sessions.find((s) => s.id === ids[0]);
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' },
      h('h2', { id: 'confirm-title' }, one ? 'Remove this session from the list?' : `Remove ${ids.length} sessions from the list?`),
      h('p', {}, one ? `“${titleOf(one)}” will be hidden from the monitor.` : 'They will be hidden from the monitor.'),
      h('form', { method: 'dialog', class: 'actions' },
        h('button', { class: 'btn', value: 'cancel', autofocus: true }, 'Cancel'),
        h('button', { class: 'btn danger', value: 'remove' }, 'Remove')));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(dialog.returnValue === 'remove'); });
    // A click on the backdrop (outside the box) cancels.
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('cancel'); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

async function removeSessions(ids) {
  if (!(await confirmRemove(ids))) return;
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

// --- images in prompts ---------------------------------------------------------------------

// Images are pasted (or dropped) into the reply box or the New session form.
// What the API takes: PNG, JPEG, GIF or WebP, up to 5 MB and 8000 px a side. Anything else the
// browser can open (a big screenshot, a HEIC photo in Safari) is shrunk to 2000 px and sent as
// JPEG; Claude sees images at about that size anyway.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SHRINK_TO = 2000;

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// -> { mediaType, data (base64), url (preview), name }
async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || 'That file'} isn’t an image`);
  let bitmap = null;
  try { bitmap = await createImageBitmap(file); } catch { /* the browser can't open it */ }
  const fits = IMAGE_TYPES.has(file.type) && file.size <= MAX_IMAGE_BYTES && (!bitmap || Math.max(bitmap.width, bitmap.height) <= 8000);
  let blob = file;
  if (!fits) {
    if (!bitmap) throw new Error(`Can’t read ${file.name || 'that image'}. Try PNG or JPEG.`);
    const scale = Math.min(1, SHRINK_TO / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // JPEG has no transparency
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error(`${file.name || 'That image'} is too large`);
  }
  bitmap?.close();
  return { mediaType: blob.type, data: await toBase64(blob), url: URL.createObjectURL(blob), name: file.name || 'Pasted image' };
}

// Adds image files to `list` (up to MAX_IMAGES), then calls done(error message or null).
async function addImages(list, files, done) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return done(files.length ? 'Only images can be attached' : null);
  let error = null;
  for (const file of images) {
    if (list.length >= MAX_IMAGES) { error = `Up to ${MAX_IMAGES} images per message`; break; }
    try { list.push(await prepareImage(file)); } catch (err) { error = err.message; }
  }
  done(error);
}

function clearImages(list) {
  for (const i of list) URL.revokeObjectURL(i.url);
  list.length = 0;
}

const imagesPayload = (list) => (list.length ? list.map(({ mediaType, data }) => ({ mediaType, data })) : undefined);

// Thumbnails of the attached images, each with a remove button.
function renderAttachments(box, list, changed) {
  box.replaceChildren(...list.map((img, i) => h('figure', { class: 'attachment' },
    h('img', { src: img.url, alt: img.name }),
    h('button', {
      type: 'button', class: 'attachment-remove', 'aria-label': `Remove ${img.name}`, title: 'Remove',
      onclick: () => { URL.revokeObjectURL(img.url); list.splice(i, 1); changed(); },
    }, '×'))));
  box.hidden = !list.length;
}

// Paste and drag-and-drop of images onto `zone`; text pastes are left alone.
function acceptImages(zone, onFiles) {
  zone.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    onFiles(files);
  });
  zone.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    zone.classList.add('dropping');
  });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dropping'); });
  zone.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    zone.classList.remove('dropping');
    onFiles(e.dataTransfer.files);
  });
}

// --- reply box (dashboard sessions) --------------------------------------------------------

const drafts = new Map(); // session id -> unsent reply text
const attached = new Map(); // session id -> images attached to the unsent reply
const composer = {
  images: document.getElementById('composer-images'),
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
    renderComposerImages();
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

function composerImages() {
  const id = composer.sessionId;
  if (!attached.has(id)) attached.set(id, []);
  return attached.get(id);
}
const renderComposerImages = () => renderAttachments(composer.images, composerImages(), renderComposerImages);

function attachToComposer(files) {
  const id = composer.sessionId;
  if (!id) return;
  composer.status.textContent = 'Adding images…';
  addImages(composerImages(), files, (error) => {
    if (composer.sessionId !== id) return;
    composer.status.textContent = error ?? '';
    renderComposerImages();
  });
}
acceptImages(composer.form, attachToComposer);
composer.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) composer.form.requestSubmit(); });

composer.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = composer.sessionId;
  const text = composer.text.value.trim();
  const images = composerImages();
  if (!id || (!text && !images.length)) return;
  composer.send.disabled = true;
  composer.status.textContent = 'Sending…';
  try {
    const res = await post(`/api/sessions/${encodeURIComponent(id)}/send`, { text, images: imagesPayload(images) });
    if (!res.ok) throw new Error((await res.text()) || `Error ${res.status}`);
    drafts.delete(id);
    clearImages(images);
    if (composer.sessionId === id) { composer.text.value = ''; composer.status.textContent = 'Sent'; renderComposerImages(); }
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

// Every word typed must appear somewhere in the session's title, folder, branch, last prompt,
// Claude's reply, or what it's doing; the project filter matches the folder exactly.
function matches(s) {
  if (filter.project && s.cwd !== filter.project) return false;
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [titleOf(s), s.cwd, s.branch, s.lastPrompt, s.lastResponse && toPlainText(s.lastResponse), s.need?.message, s.activity]
    .filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

let projectKey = null; // rebuild the project menu only when the set of folders changes
function renderProjectOptions() {
  const folders = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].sort((a, b) => folder(a).localeCompare(folder(b)));
  if (filter.project && !folders.includes(filter.project)) folders.push(filter.project);
  const key = folders.join('\n');
  if (key === projectKey) return;
  projectKey = key;
  const select = document.getElementById('project');
  select.replaceChildren(h('option', { value: '' }, 'All projects'), folders.map((f) => h('option', { value: f }, tilde(f))));
  select.value = filter.project;
}

function startingCard() {
  return h('div', { class: 'card-group' },
    h('div', { class: 'card working starting', 'aria-live': 'polite' },
      h('div', { class: 'card-top' },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { class: 'card-title' }, starting.prompt.slice(0, 70)),
        h('span', { class: 'ago' }, 'starting')),
      h('div', { class: 'card-meta' }, [folder(starting.cwd), modelName(starting.model)].filter(Boolean).join(' · ')),
      h('div', { class: 'card-line' }, 'Starting Claude Code…')));
}

// Sidebar sections: by status (Needs you first), or by project folder (most recently active
// first, and within a project the sessions that need you first).
const STATUS_ORDER = Object.fromEntries(SECTIONS.map(([status], i) => [status, i]));
let groupBy = pref.get('group') === 'project' ? 'project' : 'status';
let visibleOrder = []; // session ids in the order shown, for ↑/↓

function groupSessions(list) {
  const recent = (a, b) => b.lastEventAt - a.lastEventAt;
  if (groupBy === 'status') {
    return SECTIONS.map(([status, label]) => ({ label, className: status, sessions: list.filter((s) => s.status === status).sort(recent) }))
      .filter((g) => g.sessions.length);
  }
  const byFolder = new Map();
  for (const s of list) {
    const key = s.cwd ?? '';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(s);
  }
  return [...byFolder].map(([cwd, group]) => ({
    label: cwd ? tilde(cwd) : 'Unknown folder',
    className: 'project',
    needs: group.filter((s) => s.status === 'needs_you').length,
    latest: Math.max(...group.map((s) => s.lastEventAt)),
    sessions: group.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || recent(a, b)),
  })).sort((a, b) => b.latest - a.latest);
}

function renderList() {
  document.getElementById('new-session').classList.toggle('selected', newSessionOpen);
  for (const b of document.querySelectorAll('.group-by .seg')) b.setAttribute('aria-pressed', String(b.dataset.group === groupBy));
  renderProjectOptions();
  const nav = document.getElementById('sessions');
  nav.replaceChildren();
  const shown = sessions.filter(matches);
  if (filter.text || filter.project) {
    nav.append(h('div', { class: 'filter-note' },
      `Showing ${shown.length} of ${sessions.length}`,
      h('button', { class: 'link', onclick: clearFilter }, 'Clear filters')));
  }
  if (starting) nav.append(h('h2', { class: 'section working' }, h('span', { class: 'section-label' }, 'Starting')), startingCard());
  if (!sessions.length) {
    nav.append(h('p', { class: 'empty' }, 'No sessions in the last 36 hours.'));
  } else if (!shown.length) {
    nav.append(h('p', { class: 'empty' }, 'No sessions match.'));
  }
  visibleOrder = [];
  for (const g of groupSessions(shown)) {
    const removable = g.sessions.filter((s) => !LIVE.has(s.status));
    nav.append(h('h2', { class: `section ${g.className}` },
      h('span', { class: 'section-label' }, g.label),
      h('span', { class: 'count' }, g.sessions.length),
      g.needs > 0 && groupBy === 'project' && h('span', { class: 'count needs' }, `${g.needs} need you`),
      removable.length > 0 && h('button', {
        class: 'link', 'aria-label': `Remove ${removable.length} from the list`, onclick: () => removeSessions(removable.map((s) => s.id)),
      }, 'Clear')));
    for (const s of g.sessions) { nav.append(card(s)); visibleOrder.push(s.id); }
  }
  const waiting = sessions.filter((s) => s.status === 'needs_you').length;
  document.title = waiting ? `(${waiting}) Claude Monitor` : 'Claude Monitor';
  const icon = waiting ? '/favicon-alert.svg' : '/favicon.svg'; // orange dot when something needs you
  const link = document.getElementById('favicon');
  if (link.getAttribute('href') !== icon) link.setAttribute('href', icon);
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
      'data-id': s.id,
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
  chatToEnd = detailTab === 'chat';
  render();
  if (id) loadDetail();
  document.getElementById('detail-content').scrollTop = 0;
}

function clearFilter() {
  filter.text = filter.project = '';
  document.getElementById('search').value = '';
  document.getElementById('project').value = '';
  renderList();
}

for (const b of document.querySelectorAll('.group-by .seg')) {
  b.addEventListener('click', () => { groupBy = b.dataset.group; pref.set('group', groupBy); renderList(); });
}

// --- keyboard shortcuts --------------------------------------------------------------------
//   /  search    ↑ ↓ (or k j)  previous / next session    a / d  allow / deny its request
//   n  new session    w  Go to Warp    Esc  leave a field, or close the new-session form

function moveSelection(step) {
  if (!visibleOrder.length) return;
  const at = visibleOrder.indexOf(selectedId);
  const next = visibleOrder[at === -1 ? (step > 0 ? 0 : visibleOrder.length - 1) : Math.min(Math.max(at + step, 0), visibleOrder.length - 1)];
  if (next === selectedId) return;
  select(next);
  document.querySelector(`.card[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return; // a modal handles its own keys
  const el = document.activeElement;
  if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) {
    if (e.key === 'Escape') el.blur();
    return; // typing: leave every other key alone
  }
  const s = sessions.find((x) => x.id === selectedId);
  const request = s?.permissions.find((p) => !p.questions);
  const keys = {
    '/': () => document.getElementById('search').focus(),
    ArrowDown: () => moveSelection(1), j: () => moveSelection(1),
    ArrowUp: () => moveSelection(-1), k: () => moveSelection(-1),
    a: () => request && answer(request.id, 'allow'),
    d: () => request && answer(request.id, 'deny'),
    n: () => openNewSession(),
    w: () => goToWarp(),
    Escape: () => {
      if (newSessionOpen) { newSessionOpen = false; render(); }
    },
  };
  const run = keys[e.key];
  if (!run) return;
  e.preventDefault();
  run();
});

// --- usage limits (header) -----------------------------------------------------------------

let limits = null; // { fiveHour, sevenDay: { pct, resetsAt } | null, at }

function resetText(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `resets ${clock(ms)}` : `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${clock(ms)}`;
}

function renderLimits() {
  const box = document.getElementById('limits');
  box.replaceChildren();
  if (!limits) return;
  for (const [label, w] of [['5-hour', limits.fiveHour], ['Weekly', limits.sevenDay]]) {
    if (!w) continue;
    const pct = Math.round(w.pct);
    const fill = h('div', { class: `ctx-fill ${pct >= 80 ? 'high' : pct >= 60 ? 'mid' : 'low'}` });
    fill.style.width = `${Math.min(pct, 100)}%`;
    box.append(h('div', { class: 'limit' },
      h('span', { class: 'limit-label' }, `${label} ${pct}%`),
      h('div', { class: 'ctx-track', role: 'meter', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${label} usage limit` }, fill),
      w.resetsAt && h('span', { class: 'limit-reset' }, resetText(w.resetsAt))));
  }
}

document.getElementById('new-session').addEventListener('click', openNewSession);
document.getElementById('search').addEventListener('input', (e) => { filter.text = e.target.value; renderList(); });
document.getElementById('project').addEventListener('change', (e) => { filter.project = e.target.value; renderList(); });

// --- insights: possibly stuck, context nearly full, spend ----------------------------------

// Shown only when you open the panel from the header.
const STUCK_MS = 10 * 60_000; // working, with no hook event for this long
const CONTEXT_FULL = 80;      // percent of the context window
let insightsOpen = false;
let spend = null;             // from /api/spend
let spendAt = 0;

async function loadSpend() {
  spendAt = Date.now();
  try { spend = await fetch('/api/spend').then((r) => (r.ok ? r.json() : null)); } catch { /* keep the last one */ }
  renderInsights();
}

function insightRow(s, detailText) {
  return h('li', {},
    h('button', { class: 'link insight-session', onclick: () => { setInsightsOpen(false); select(s.id); } }, titleOf(s)),
    h('span', { class: 'muted' }, detailText));
}

const mins = (ms) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

function renderInsights() {
  const dialog = document.getElementById('insights');
  const box = document.getElementById('insights-body');
  const toggle = document.getElementById('insights-toggle');
  if (insightsOpen && !dialog.open) dialog.showModal();
  else if (!insightsOpen && dialog.open) dialog.close();
  toggle.setAttribute('aria-expanded', String(insightsOpen));
  if (!insightsOpen) return;
  if (Date.now() - spendAt > 30_000) loadSpend(); // refreshed while the panel stays open

  const now = Date.now();
  const stuck = sessions.filter((s) => s.status === 'working' && now - s.lastEventAt > STUCK_MS)
    .sort((a, b) => a.lastEventAt - b.lastEventAt);
  const full = sessions.filter((s) => s.status !== 'ended' && s.context?.pct >= CONTEXT_FULL)
    .sort((a, b) => b.context.pct - a.context.pct);
  const recent = spend?.days.slice(0, 7) ?? [];

  box.replaceChildren(h('div', { class: 'insights-grid' },
    h('section', {},
      h('h2', {}, 'Possibly stuck'),
      h('p', { class: 'hint' }, `Working, but nothing reported for over ${mins(STUCK_MS)}. A long build or test run looks like this too.`),
      stuck.length
        ? h('ul', { class: 'insight-list' }, stuck.map((s) => insightRow(s, `quiet for ${mins(now - s.lastEventAt)}${s.activity ? ` · last: ${s.activity}` : ''}`)))
        : h('p', { class: 'muted' }, 'Nothing looks stuck.')),
    h('section', {},
      h('h2', {}, 'Context nearly full'),
      h('p', { class: 'hint' }, `At ${CONTEXT_FULL}% or more. Claude Code compacts the conversation when it runs out; /compact or a fresh session first keeps more control.`),
      full.length
        ? h('ul', { class: 'insight-list' }, full.map((s) => insightRow(s, `${Math.round(s.context.pct)}% used`)))
        : h('p', { class: 'muted' }, 'Every session has room.')),
    h('section', {},
      h('h2', {}, 'Spend'),
      h('p', { class: 'hint' }, 'Your sessions’ tokens at API prices: an estimate of usage, not a bill on a subscription.'),
      !spend ? h('p', { class: 'muted' }, 'Loading…') : [
        h('dl', { class: 'spend-totals' },
          h('div', {}, h('dt', {}, 'Today'), h('dd', {}, usd(spend.today))),
          h('div', {}, h('dt', {}, 'Last 7 days'), h('dd', {}, usd(spend.week))),
          h('div', {}, h('dt', {}, 'Last 30 days'), h('dd', {}, usd(spend.month)))),
        h('table', { class: 'spend-days' },
          h('tbody', {}, recent.map((d) => h('tr', {}, h('th', { scope: 'row' }, dayLabel(d.day)), h('td', {}, d.usd ? usd(d.usd) : '—'))))),
        spend.since && h('p', { class: 'hint' }, `Counted since ${dayLabel(spend.since)}, when the monitor started keeping track.`),
      ]),
  ));
}

function setInsightsOpen(open) {
  if (open === insightsOpen) return;
  insightsOpen = open;
  if (open) spendAt = 0; // fresh totals each time it opens
  renderInsights();
}
document.getElementById('insights-toggle').addEventListener('click', () => setInsightsOpen(!insightsOpen));
document.getElementById('insights-close').addEventListener('click', () => setInsightsOpen(false));
// A click on the dimmed backdrop closes it (the dialog itself has no padding, so only the
// backdrop targets it directly). Picking a session in it closes it too.
document.getElementById('insights').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) setInsightsOpen(false);
});
// Escape closes the dialog natively; keep our state in step.
document.getElementById('insights').addEventListener('close', () => {
  if (insightsOpen) { insightsOpen = false; renderInsights(); }
});

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

// Sidebar width: drag the edge (or focus it and use ←/→); double-click resets. Saved per browser.
const SIDEBAR = { min: 260, default: 380, max: () => Math.max(260, Math.min(720, window.innerWidth - 360)) };
const resizer = document.getElementById('sidebar-resize');
function setSidebarWidth(px, save = true) {
  const w = Math.round(Math.min(Math.max(px, SIDEBAR.min), SIDEBAR.max()));
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`); // CSSOM: allowed by the CSP
  resizer.setAttribute('aria-valuenow', w);
  resizer.setAttribute('aria-valuemin', SIDEBAR.min);
  resizer.setAttribute('aria-valuemax', SIDEBAR.max());
  if (save) pref.set('sidebarWidth', w);
}
setSidebarWidth(Number(pref.get('sidebarWidth')) || SIDEBAR.default, false);
resizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  const left = document.getElementById('sidebar').getBoundingClientRect().left;
  const move = (ev) => setSidebarWidth(ev.clientX - left);
  const up = () => { resizer.removeEventListener('pointermove', move); document.body.classList.remove('resizing'); };
  document.body.classList.add('resizing');
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up, { once: true });
  resizer.addEventListener('lostpointercapture', up, { once: true });
});
resizer.addEventListener('dblclick', () => setSidebarWidth(SIDEBAR.default));
resizer.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -20, ArrowRight: 20 }[e.key];
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  setSidebarWidth(Number(resizer.getAttribute('aria-valuenow')) + step);
});
window.addEventListener('resize', () => setSidebarWidth(Number(pref.get('sidebarWidth')) || SIDEBAR.default, false));

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
    const { permissionHook, auth, folders, models, account, editor } = await (await fetch('/api/setup')).json();
    const editorChanged = editor !== setup.editor;
    setup = { auth, folders: folders ?? [], models: models ?? [], account, editor };
    if (editorChanged) renderDetail();
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

// The form closes at once and a "Starting" card stands in until Claude Code is up; on failure
// the form comes back with what you typed and the error.
async function startNewSession(e) {
  e.preventDefault();
  document.activeElement?.blur(); // leaving the field lets the page redraw (see renderDetail)
  if (!newDraft.prompt.trim() && !newDraft.images.length) {
    newDraft.error = 'Type a first prompt';
    renderDetail();
    return;
  }
  starting = { cwd: newDraft.cwd, prompt: newDraft.prompt, model: newDraft.model, images: newDraft.images.length };
  newDraft.error = null;
  newSessionOpen = false;
  render();
  try {
    const res = await post('/api/new-session', {
      cwd: starting.cwd, prompt: starting.prompt, model: starting.model === 'default' ? null : starting.model,
      images: imagesPayload(newDraft.images),
    });
    const text = await res.text(); // errors come back as plain text
    if (!res.ok) throw new Error(text || `Error ${res.status}`);
    starting = null;
    newDraft.prompt = '';
    clearImages(newDraft.images);
    select(JSON.parse(text).id);
  } catch (err) {
    starting = null;
    newDraft.error = err.message;
    newSessionOpen = true;
    render();
  }
}

const modelName = (value) => (value && value !== 'default'
  ? setup.models.find((m) => m.value === value)?.displayName ?? value
  : null);

// Which account dashboard sessions use, in words: whatever Claude Code is signed into.
// apiKeySource 'none' (or absent) means no API key, so it's the Claude login.
function authText() {
  const source = setup.account?.apiKeySource ?? setup.auth;
  if (source === 'ANTHROPIC_API_KEY' || source === 'apiKeyHelper') return 'an API key, billed per token to that API account';
  const a = setup.account;
  if (!a?.email) return 'the Claude account Claude Code is signed into, as in the terminal';
  const plan = [a.plan && `${a.plan[0].toUpperCase()}${a.plan.slice(1)} plan`, a.organization].filter(Boolean).join(', ');
  return `the Claude account Claude Code is signed into: ${a.email}${plan ? ` (${plan})` : ''}`;
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

// The models your account offers, as Claude Code lists them ("Default" is your usual model).
function modelSelect() {
  const options = setup.models.length ? setup.models : [{ value: 'default', displayName: 'Default', description: '' }];
  const select = h('select', { id: 'new-model', class: 'input', onchange: (e) => { newDraft.model = e.target.value; } },
    options.map((m) => h('option', { value: m.value }, m.description ? `${m.displayName} — ${m.description}` : m.displayName)));
  select.value = options.some((m) => m.value === newDraft.model) ? newDraft.model : options[0].value;
  newDraft.model = select.value;
  return h('span', { class: 'select-wrap' }, select);
}

function startingView() {
  return h('section', { class: 'block' },
    h('div', { class: 'detail-title' }, h('span', { class: 'pill working' }, 'Starting'), h('h1', {}, 'Starting Claude Code…')),
    h('p', { class: 'meta' }, [tilde(starting.cwd), modelName(starting.model) ?? 'default model'].join('  ·  ')),
    h('h2', {}, 'First prompt'), h('p', { class: 'prompt' }, starting.prompt),
    starting.images > 0 && h('p', { class: 'muted' }, imagesNote(starting.images)));
}

function newSessionForm() {
  const folders = [...new Set([newDraft.cwd, ...setup.folders].filter(Boolean))];
  const cwdSelect = h('select', { id: 'new-cwd', class: 'input', required: true, onchange: (e) => { newDraft.cwd = e.target.value; } },
    folders.length ? folders.map((f) => h('option', { value: f }, tilde(f))) : h('option', { value: '' }, 'No folder chosen yet'));
  cwdSelect.value = newDraft.cwd;
  const promptInput = h('textarea', {
    id: 'new-prompt', class: 'input', rows: 6, oninput: (e) => { newDraft.prompt = e.target.value; },
    placeholder: 'Paste images here too',
  });
  // Thumbnails update in place: a full redraw waits while you're typing in the prompt.
  const strip = h('div', { class: 'attachments', 'aria-label': 'Attached images' });
  const note = h('span', { class: 'hint', role: 'status' });
  const showImages = () => renderAttachments(strip, newDraft.images, showImages);
  const attach = (files) => {
    note.textContent = 'Adding images…';
    addImages(newDraft.images, files, (error) => { note.textContent = error ?? ''; showImages(); });
  };
  showImages();
  promptInput.value = newDraft.prompt;
  promptInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.form.requestSubmit(); });
  const form = h('form', { class: 'new-form', onsubmit: startNewSession },
    h('h1', {}, 'New session'),
    h('p', { class: 'muted' }, 'Starts Claude Code in a folder and lets you reply from this page. Its permission prompts and questions show up here. It runs with ',
      authText(), '.'),
    h('label', { for: 'new-cwd' }, 'Folder'),
    h('div', { class: 'folder-row' },
      h('span', { class: 'select-wrap' }, cwdSelect),
      h('button', { type: 'button', class: 'btn', disabled: newDraft.choosing, onclick: chooseFolder },
        newDraft.choosing ? 'Choosing… (see the dialog)' : 'Choose in Finder…')),
    h('label', { for: 'new-model' }, 'Model'),
    modelSelect(),
    h('label', { for: 'new-prompt' }, 'First prompt'),
    strip,
    promptInput,
    note,
    newDraft.error && h('p', { class: 'form-error', role: 'alert' }, newDraft.error),
    h('div', { class: 'detail-actions' },
      h('button', { type: 'submit', class: 'btn allow' }, 'Start session'),
      h('button', { type: 'button', class: 'btn', onclick: () => { newSessionOpen = false; render(); } }, 'Cancel')));
  acceptImages(form, attach);
  return form;
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
  if (starting && !selectedId) { content.append(startingView()); return; }
  if (!s) {
    content.append(h('p', { class: 'empty' }, selectedId ? 'This session is no longer in the list.' : 'Select a session to see what it is doing.'));
    return;
  }
  const d = detail?.id === s.id ? detail : null;
  // In the chat, stay pinned to the newest message if you were already at the bottom.
  const atEnd = content.scrollHeight - scroll - content.clientHeight < 40;
  add(content,
    h('header', { class: 'detail-head' },
      h('div', { class: 'detail-title' },
        h('span', { class: `pill ${s.status}` }, STATUS_LABEL[s.status] ?? s.status),
        renaming?.id === s.id ? renameForm(s)
          : [h('h1', {}, titleOf(s)), h('button', { class: 'link', onclick: () => startRename(s) }, 'Rename')]),
      h('div', { class: 'meta' }, [s.cwd && s.cwd.replace(/^\/Users\/[^/]+/, '~'), s.branch, s.model].filter(Boolean).join('  ·  ')),
      sessionIdRow(s),
      stats(s, true),
      h('div', { class: 'detail-actions' },
        warpButton(),
        !LIVE.has(s.status) && h('button', { class: 'btn', onclick: () => removeSessions([s.id]) }, 'Remove from list'))),
    needSection(s),
    s.status === 'working' && s.activity && h('p', { class: 'now' }, h('strong', {}, 'Now: '), s.activity),
    runningSubagents(d),
    detailTabs(),
    h('div', { id: 'detail-panel', role: 'tabpanel', 'aria-labelledby': `tab-${detailTab}` },
      detailTab === 'timeline' && [
        s.lastPrompt && h('section', { class: 'block' }, h('h2', {}, 'Last prompt'), h('p', { class: 'prompt' }, s.lastPrompt)),
        d?.lastResponse && replySection(s, d)],
      !d ? h('p', { class: 'empty' }, 'Loading…')
        : d.error ? h('p', { class: 'empty' }, d.error)
          : detailTab === 'chat' ? chatSection(d) : [filesSection(d), timelineSection(d)]),
  );
  if (detailTab === 'chat' && (atEnd || chatToEnd)) {
    content.scrollTop = content.scrollHeight;
    if (d) chatToEnd = false;
  } else {
    content.scrollTop = scroll;
  }
}

// The session id, and the command that resumes it in a terminal (e.g. a Warp tab).
function sessionIdRow(s) {
  const command = `claude --resume ${s.id}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); copied = s.id; } catch { copied = null; }
    renderDetail();
    setTimeout(() => { if (copied === s.id) { copied = null; renderDetail(); } }, 1500);
  };
  return h('div', { class: 'session-id' },
    h('span', { class: 'muted' }, 'Session'),
    h('code', {}, s.id),
    h('button', { class: 'link', onclick: copy, title: command, 'aria-label': `Copy “${command}”` },
      copied === s.id ? 'Copied' : 'Copy resume command'));
}

// The tabs stay pinned to the top while you scroll. Switching tabs from further down shows the
// new tab's start just under them (the chat starts at its newest message) instead of leaving
// you partway down the other tab's content.
function setTab(tab) {
  if (tab === detailTab) return;
  const content = document.getElementById('detail-content');
  const tabs = content.querySelector('.tabs');
  const pinned = tabs && content.scrollTop > tabs.offsetTop;
  detailTab = tab;
  chatToEnd = tab === 'chat';
  renderDetail();
  if (pinned && tab !== 'chat') content.scrollTop = content.querySelector('.tabs')?.offsetTop ?? 0;
  document.getElementById(`tab-${tab}`)?.focus({ preventScroll: true });
}

function detailTabs() {
  const tabs = [['timeline', 'Timeline'], ['chat', 'Chat history']];
  return h('div', {
    class: 'tabs', role: 'tablist', 'aria-label': 'Session view',
    onkeydown: (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = tabs.findIndex(([t]) => t === detailTab);
      setTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0]);
    },
  }, tabs.map(([tab, label]) => h('button', {
    id: `tab-${tab}`, class: 'tab', role: 'tab', 'aria-selected': String(tab === detailTab),
    'aria-controls': 'detail-panel', tabindex: tab === detailTab ? '0' : '-1', onclick: () => setTab(tab),
  }, label)));
}

// The conversation, oldest first: your prompts and Claude's text replies (tool calls are in the timeline).
function chatSection(d) {
  const messages = d.messages ?? [];
  if (!messages.length) return h('p', { class: 'muted' }, 'No messages yet.');
  return h('ol', { class: 'chat' }, messages.map((m) => h('li', { class: `msg ${m.role}` },
    h('div', { class: 'msg-meta' }, m.role === 'user' ? 'You' : 'Claude', m.ts && h('span', { class: 'muted' }, clock(m.ts))),
    m.images > 0 && h('p', { class: 'msg-images' }, imagesNote(m.images)),
    m.role === 'user' ? m.text && h('p', { class: 'msg-text' }, m.text) : h('div', { class: 'msg-text md' }, renderMarkdown(m.text)))));
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
      : h('ul', { class: 'files' }, files.map((f) => fileRow(f, d))));
}

const fileErrors = new Map(); // file path -> why it couldn't be opened

async function openFile(sessionId, path) {
  fileErrors.delete(path);
  try {
    const res = await post('/api/open-file', { id: sessionId, path });
    if (!res.ok) throw new Error((await res.text()) || `Error ${res.status}`);
  } catch (err) {
    fileErrors.set(path, err.message);
  }
  renderDetail();
}

function fileRow(f, d) {
  const open = openFiles.has(f.path);
  const failed = f.edits.filter((e) => e.failed).length;
  const ok = f.edits.length - failed;
  const cwd = d.cwd;
  return h('li', { class: 'file' },
    h('button', {
      class: 'file-head', 'aria-expanded': String(open),
      onclick: () => { open ? openFiles.delete(f.path) : openFiles.add(f.path); renderDetail(); },
    },
      h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      h('span', { class: 'path' }, shortPath(f.path, cwd)),
      h('span', { class: 'muted' }, `${ok} edit${ok === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''} · ${clock(f.edits.at(-1).ts)}`)),
    open && h('div', { class: 'edits' },
      h('div', { class: 'file-actions' },
        h('button', { class: 'btn', onclick: () => openFile(d.id, f.path), 'aria-label': `Open ${shortPath(f.path, cwd)} in ${setup.editor ?? 'your editor'}` },
          setup.editor ? `Open in ${setup.editor === 'Visual Studio Code' ? 'VS Code' : setup.editor}` : 'Open in editor'),
        fileErrors.has(f.path) && h('span', { class: 'form-error' }, fileErrors.get(f.path))),
      [...f.edits].reverse().map((e) =>
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
                it.command && it.command !== it.text && h('code', { class: 'cmd' }, it.command),
                subagentWork(d.subagents?.find((a) => a.toolUseId && a.toolUseId === it.id))])))));
}

// What a subagent did, folded under the Agent call that started it.
function subagentWork(a) {
  if (!a) return null;
  const open = openAgents.has(a.toolUseId);
  const toggle = () => { open ? openAgents.delete(a.toolUseId) : openAgents.add(a.toolUseId); renderDetail(); };
  return h('div', { class: 'subagent' },
    h('button', { class: 'link', 'aria-expanded': String(open), onclick: toggle },
      `${open ? '▾' : '▸'} ${a.type ?? 'Subagent'}: ${a.toolCount} tool call${a.toolCount === 1 ? '' : 's'} · ${a.finished ? 'finished' : 'still running'}`),
    open && h('div', { class: 'subagent-body' },
      a.prompt && h('details', {}, h('summary', {}, 'What it was asked'), h('p', { class: 'sub-prompt' }, a.prompt)),
      a.tools.length ? h('ol', { class: 'timeline sub-tools' }, a.tools.map((t) =>
        h('li', { class: `tl${t.error ? ' tl-error' : ''}` },
          h('span', { class: 'tl-time' }, t.ts ? clock(t.ts) : ''),
          h('div', { class: 'tl-body' }, h('span', { class: 'tag' }, t.tool), h('span', { class: 'tl-text' }, t.text),
            t.error && h('span', { class: 'tag err' }, 'failed')))))
        : h('p', { class: 'muted' }, 'No tool calls.'),
      a.reply && h('div', {}, h('h3', { class: 'sub-h' }, 'Its reply'), h('div', { class: 'reply md' }, renderMarkdown(a.reply)))));
}

function runningSubagents(d) {
  const running = (d?.subagents ?? []).filter((a) => !a.finished);
  if (!running.length) return null;
  return h('p', { class: 'now' }, h('strong', {}, `Subagent${running.length > 1 ? 's' : ''} running: `),
    running.map((a) => `${a.type ?? 'agent'} (${a.description ?? 'no description'})`).join(', '));
}

// --- rename --------------------------------------------------------------------------------

function startRename(s) {
  renaming = { id: s.id, value: titleOf(s), error: null, busy: false };
  renderDetail();
  const input = document.getElementById('rename-input');
  input?.focus();
  input?.select();
}

function renameForm(s) {
  const input = h('input', {
    id: 'rename-input', class: 'input rename-input', maxlength: 200, 'aria-label': 'Session title', required: true,
    oninput: (e) => { renaming.value = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Escape') { renaming = null; e.target.blur(); renderDetail(); } },
  });
  input.value = renaming.value;
  const save = async (e) => {
    e.preventDefault();
    document.activeElement?.blur();
    renaming.busy = true;
    renderDetail();
    try {
      const res = await post(`/api/sessions/${encodeURIComponent(s.id)}/rename`, { title: renaming.value });
      if (!res.ok) throw new Error((await res.text()) || `Error ${res.status}`);
      renaming = null;
    } catch (err) {
      Object.assign(renaming, { busy: false, error: err.message });
    }
    renderDetail();
  };
  return h('form', { class: 'rename', onsubmit: save },
    input,
    h('button', { type: 'submit', class: 'btn allow', disabled: renaming.busy }, renaming.busy ? 'Saving…' : 'Save'),
    h('button', { type: 'button', class: 'btn', onclick: () => { renaming = null; renderDetail(); } }, 'Cancel'),
    renaming.error && h('span', { class: 'form-error' }, renaming.error));
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
    renderInsights();
  });
  es.addEventListener('limits', (e) => {
    const next = JSON.parse(e.data);
    if (JSON.stringify(next) === JSON.stringify(limits)) return;
    limits = next;
    renderLimits();
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
checkSetup(); // editor name for "Open in …", account for the New session form
setInterval(() => { renderList(); renderInsights(); }, 30_000); // keep "5m ago" and "quiet for" fresh
