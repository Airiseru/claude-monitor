// Claude Monitor server: receives hook events, watches status line snapshots, reads transcripts,
// and serves the dashboard. Listens on 127.0.0.1 only.
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { claudeInfo, DashboardSessions, setSessionTitle } from './agents.mjs';
import { PendingPermissions } from './permissions.mjs';
import { applyHook } from './sessions.mjs';
import { parseTranscript } from './transcript.mjs';

const PORT = Number(process.env.PORT ?? 4747);
const MONITOR_HOME = process.env.CLAUDE_MONITOR_HOME ?? join(homedir(), '.claude-monitor');
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
const STATUS_DIR = join(MONITOR_HOME, 'status');
const STATE_FILE = join(MONITOR_HOME, 'state.json'); // live statuses + removed sessions, kept across restarts
const RECENT_MS = 24 * 3600_000;
const MAX_HOOK_BODY = 5_000_000;
// How long a permission request waits for a click. Just under the hook's 600 s timeout, so
// the server always answers before Claude Code gives up on the hook.
const PERMISSION_WAIT_MS = Number(process.env.PERMISSION_WAIT_MS ?? 590_000);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
const TOKEN = randomBytes(24).toString('hex'); // per run; the page must send it to Allow/Deny
const SESSION_ID = /^[\w-]+$/;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon-alert.svg': ['favicon-alert.svg', 'image/svg+xml'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const sessions = new Map();    // session id -> live state (sessions.mjs)
const contexts = new Map();    // session id -> context use, from the latest status line snapshot
const costs = new Map();       // session id -> cost and lines changed, from the same snapshot
const transcripts = new Map(); // transcript path -> { mtimeMs, size, data }
const clients = new Set();     // open SSE responses
const pending = new PendingPermissions();
const hidden = new Set();      // session ids removed from the list; back on their next event
const dashboard = new DashboardSessions({
  decide: decideInPage,
  event: (ev) => { const s = applyHook(sessions, ev, Date.now()); if (s) { pending.settle(ev); refreshSoon(s.id); } broadcast(); },
  changed: () => broadcast(),
});

// A dashboard session's permission prompt or question: shown in the page with no time limit
// (there's no terminal to fall back to), answered by a click.
function decideInPage(sessionId, tool, input, signal) {
  return new Promise((resolve) => {
    const ev = { session_id: sessionId, tool_name: tool, tool_input: input };
    const id = pending.add(ev, (decision) => {
      broadcast();
      if (decision?.answers) resolve({ behavior: 'allow', updatedInput: { ...input, answers: decision.answers } });
      else if (decision === 'allow') resolve({ behavior: 'allow', updatedInput: input });
      else resolve({ behavior: 'deny', message: decision === 'deny' ? 'Denied from Claude Monitor' : 'No answer was given' });
    });
    signal?.addEventListener('abort', () => { pending.drop(id); broadcast(); }, { once: true });
    // Same state change a terminal session gets from its hooks.
    applyHook(sessions, { ...ev, hook_event_name: tool === 'AskUserQuestion' ? 'PreToolUse' : 'PermissionRequest' }, Date.now());
    broadcast();
  });
}

// --- saved state ---------------------------------------------------------------------------

const SAVED_FIELDS = ['id', 'status', 'need', 'activity', 'cwd', 'transcriptPath', 'lastEventAt', 'lastPrompt'];

async function loadState() {
  const saved = await readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => null);
  if (!saved) return;
  const cutoff = Date.now() - RECENT_MS;
  for (const s of saved.sessions ?? []) {
    if (!SESSION_ID.test(s.id ?? '') || !(s.lastEventAt >= cutoff)) continue;
    sessions.set(s.id, { ...Object.fromEntries(SAVED_FIELDS.map((k) => [k, s[k] ?? null])) });
    const t = s.transcriptPath && await readTranscript(s.transcriptPath).catch(() => null);
    // Events missed while the server was down: a turn that finished means it's waiting now.
    if (t?.turnEnded && (s.status === 'working' || s.status === 'needs_you')) {
      Object.assign(sessions.get(s.id), { status: 'waiting', need: null, activity: null });
    }
  }
  for (const id of saved.hidden ?? []) if (SESSION_ID.test(id)) hidden.add(id);
  for (const [id, o] of saved.owned ?? []) {
    const entry = typeof o === 'string' ? { cwd: o, model: null } : o; // older saves held just the folder
    if (SESSION_ID.test(id) && typeof entry?.cwd === 'string') dashboard.owned.set(id, { cwd: entry.cwd, model: entry.model ?? null });
  }
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const state = {
      sessions: [...sessions.values()].map((s) => Object.fromEntries(SAVED_FIELDS.map((k) => [k, s[k] ?? null]))),
      hidden: [...hidden].filter((id) => sessions.has(id)), // others have aged out of the list anyway
      owned: [...dashboard.owned].filter(([id]) => sessions.has(id)),
    };
    const tmp = `${STATE_FILE}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, STATE_FILE); // atomic: a crash mid-write never leaves half a file
    } catch (err) {
      console.error('Could not save state:', err.message);
    }
  }, 1000);
}

// --- transcripts ---------------------------------------------------------------------------

async function readTranscript(path, options) {
  const st = await stat(path);
  const hit = transcripts.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  const data = parseTranscript(await readFile(path, 'utf8'), options);
  transcripts.set(path, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

// A session's subagents: <session>/subagents/agent-<id>.jsonl plus a .meta.json that names the
// parent's Agent tool call that started it.
async function readSubagents(transcriptPath) {
  const dir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const out = [];
  for (const file of await readdir(dir).catch(() => [])) {
    const agentId = file.match(/^agent-([\w-]+)\.meta\.json$/)?.[1];
    if (!agentId) continue;
    const meta = await readFile(join(dir, file), 'utf8').then(JSON.parse).catch(() => null);
    const t = await readTranscript(join(dir, `agent-${agentId}.jsonl`), { sidechain: true }).catch(() => null);
    if (!meta || !t) continue;
    const tools = t.timeline.filter((i) => i.kind === 'tool');
    out.push({
      agentId,
      toolUseId: meta.toolUseId ?? null,
      type: meta.agentType ?? null,
      description: meta.description ?? null,
      finished: Boolean(meta.finished),
      prompt: t.timeline.find((i) => i.kind === 'prompt')?.text ?? null,
      startedAt: t.startedAt,
      updatedAt: t.updatedAt,
      toolCount: tools.length,
      tools: tools.slice(-200),
      reply: t.lastResponse,
    });
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

// Hooks fire before the transcript is written, so re-read it shortly after the last event.
const refreshTimers = new Map();
function refreshSoon(id) {
  clearTimeout(refreshTimers.get(id));
  refreshTimers.set(id, setTimeout(async () => {
    refreshTimers.delete(id);
    const path = sessions.get(id)?.transcriptPath;
    if (path) await readTranscript(path).catch(() => {});
    broadcast();
  }, 1000));
}

async function loadRecentSessions() {
  for (const dir of await readdir(PROJECTS_DIR).catch(() => [])) {
    for (const file of await readdir(join(PROJECTS_DIR, dir)).catch(() => [])) {
      const id = basename(file, '.jsonl');
      if (!file.endsWith('.jsonl') || !SESSION_ID.test(id) || sessions.has(id)) continue;
      const path = join(PROJECTS_DIR, dir, file);
      const st = await stat(path).catch(() => null);
      if (!st || Date.now() - st.mtimeMs > RECENT_MS) continue;
      const t = await readTranscript(path).catch(() => null);
      // Skip sessions where nothing happened (e.g. opened, /clear, closed).
      if (!t?.timeline.some((i) => i.kind === 'prompt' || i.kind === 'tool')) continue;
      sessions.set(id, { id, status: 'idle', need: null, activity: null, transcriptPath: path, lastEventAt: st.mtimeMs });
    }
  }
}

// --- status line snapshots -----------------------------------------------------------------

// Polled rather than fs.watch'd: one small file per session, and polling can't fail with
// EMFILE or miss events.
const statusMtimes = new Map(); // file -> mtimeMs last loaded
async function scanStatusDir() {
  for (const file of await readdir(STATUS_DIR).catch(() => [])) {
    const st = await stat(join(STATUS_DIR, file)).catch(() => null);
    if (!st || statusMtimes.get(file) === st.mtimeMs) continue;
    statusMtimes.set(file, st.mtimeMs);
    await loadStatus(file);
  }
}

async function loadStatus(file) {
  const id = basename(file, '.json');
  if (!file.endsWith('.json') || !SESSION_ID.test(id)) return;
  try {
    const s = JSON.parse(await readFile(join(STATUS_DIR, file), 'utf8'));
    const cw = s.context_window ?? {};
    contexts.set(id, {
      pct: cw.used_percentage ?? null,
      size: cw.context_window_size ?? null,
      tokens: cw.total_input_tokens ?? null,
      model: s.model?.display_name ?? null,
    });
    const c = s.cost ?? {};
    costs.set(id, {
      usd: c.total_cost_usd ?? null, // what the session's tokens cost at API prices
      linesAdded: c.total_lines_added ?? null,
      linesRemoved: c.total_lines_removed ?? null,
    });
    broadcast();
  } catch {
    // Removed or unreadable: keep the last good snapshot.
  }
}

// --- session list --------------------------------------------------------------------------

function summary(s) {
  const t = transcripts.get(s.transcriptPath)?.data;
  const context = contexts.get(s.id) ?? (t?.contextTokens ? { pct: null, size: null, tokens: t.contextTokens, model: null } : null);
  return {
    id: s.id,
    status: s.status,
    need: s.need,
    permissions: pending.forSession(s.id),
    activity: s.activity,
    title: t?.title ?? null,
    cwd: s.cwd ?? t?.cwd ?? null,
    branch: t?.branch ?? null,
    model: context?.model ?? t?.model ?? null,
    lastPrompt: s.lastPrompt ?? t?.lastPrompt ?? null,
    lastResponse: t?.lastResponse?.slice(0, 300) ?? null, // the detail view has all of it
    lastEventAt: s.lastEventAt,
    transcriptUpdatedAt: t?.updatedAt ?? null,
    context,
    cost: costs.get(s.id) ?? null,
    // Started here, so it takes prompts from the page; `live` is whether it's running right now.
    dashboard: dashboard.owned.has(s.id) ? { live: dashboard.isLive(s.id) } : null,
  };
}

function list() {
  const cutoff = Date.now() - RECENT_MS;
  return [...sessions.values()].filter((s) => s.lastEventAt >= cutoff && !hidden.has(s.id)).map(summary);
}

let broadcastTimer = null;
function broadcast() {
  saveSoon(); // every change that's worth showing is worth keeping
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const msg = `event: sessions\ndata: ${JSON.stringify(list())}\n\n`;
    for (const res of clients) res.write(msg);
  }, 200);
}

// The code editor to open changed files in: the first of these that's installed, else the
// default text editor (`open -t`).
const EDITORS = ['Cursor', 'Visual Studio Code', 'Zed', 'Windsurf', 'Sublime Text'];
async function findEditor() {
  for (const name of EDITORS) {
    for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
      const path = join(dir, `${name}.app`);
      if (await stat(path).then(() => true, () => false)) return { name, path };
    }
  }
  return null;
}

// --- HTTP ----------------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  try {
    return JSON.parse(await readBody(req, limit));
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(400, 'Invalid JSON');
  }
}

function tokenMatches(given) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hookDecision(decision) {
  const d = decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Claude Monitor' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
}

// Holds a PermissionRequest hook open until a click, a terminal answer, or the wait runs out.
// An empty 200 means "no decision": the terminal prompt carries on as if the monitor weren't there.
function holdPermission(ev, res) {
  // No dashboard open: don't hold anything. Questions aren't Allow/Deny: a dashboard session's
  // come through decideInPage, a terminal session's are answered in the terminal.
  if (!clients.size || ev.tool_name === 'AskUserQuestion') return res.writeHead(200).end();
  let timer;
  const id = pending.add(ev, (decision) => {
    clearTimeout(timer);
    if (!res.writableEnded) {
      if (decision) res.writeHead(200, { 'Content-Type': 'application/json' }).end(hookDecision(decision));
      else res.writeHead(200).end();
    }
    broadcast();
  });
  timer = setTimeout(() => pending.resolve(id, null), PERMISSION_WAIT_MS);
  res.on('close', () => {
    if (res.writableEnded) return;
    clearTimeout(timer);
    pending.drop(id);
    broadcast();
  });
}

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  // Host check blocks DNS rebinding; together with no CORS headers, other websites can't read
  // or post anything here.
  if (!ALLOWED_HOSTS.has(req.headers.host)) throw new HttpError(403, 'Forbidden');
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && (pathname === '/hook' || pathname === '/permission')) {
    if (req.headers.origin) throw new HttpError(403, 'Forbidden'); // browsers send Origin; hooks don't
    const ev = await readJson(req, MAX_HOOK_BODY);
    const s = applyHook(sessions, ev, Date.now());
    if (s) { hidden.delete(s.id); refreshSoon(s.id); broadcast(); } // a removed session that's active again comes back
    if (pathname === '/permission' && s && ev.hook_event_name === 'PermissionRequest') return holdPermission(ev, res);
    if (s && pending.settle(ev)) broadcast();
    res.writeHead(204).end(); // empty response: never changes what the session does
    return;
  }

  // Every action the page can take needs the same-origin page holding this run's token.
  if (req.method === 'POST' && pathname.startsWith('/api/')) {
    if (!ALLOWED_ORIGINS.has(req.headers.origin) || !tokenMatches(req.headers['x-monitor-token'])) {
      throw new HttpError(403, 'Forbidden');
    }
  }

  if (req.method === 'POST' && pathname === '/api/hide') {
    const { ids } = await readJson(req, 100_000);
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && SESSION_ID.test(id))) {
      throw new HttpError(400, 'ids must be session ids');
    }
    for (const id of ids) hidden.add(id);
    broadcast();
    return sendJson(res, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/focus-warp') {
    // Warp can't be told to switch to a specific tab from outside, so this brings it to the front.
    execFile('/usr/bin/open', ['-a', 'Warp'], (err) => { if (err) console.error('open -a Warp failed:', err.message); });
    return sendJson(res, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/open-file') {
    // Only files the session changed (as its transcript records them), so the page can't be
    // used to open anything else.
    const { id, path } = await readJson(req, 10_000);
    const s = typeof id === 'string' ? sessions.get(id) : null;
    const t = s?.transcriptPath && await readTranscript(s.transcriptPath).catch(() => null);
    if (!t || typeof path !== 'string' || !t.files.has(path)) throw new HttpError(404, 'Not a file this session changed');
    if (!(await stat(path).then((st) => st.isFile(), () => false))) throw new HttpError(404, 'That file no longer exists');
    const editor = await findEditor();
    execFile('/usr/bin/open', editor ? ['-a', editor.path, path] : ['-t', path], (err) => { if (err) console.error('open failed:', err.message); });
    return sendJson(res, { ok: true, editor: editor?.name ?? null });
  }

  if (req.method === 'POST' && pathname === '/api/choose-folder') {
    // A web page can't learn a folder's real path, but this server runs on your Mac, so it opens
    // the macOS folder dialog itself. The starting folder goes in as an argument, never as
    // script text.
    const { from } = await readJson(req, 10_000);
    const start = typeof from === 'string' ? resolvePath(from.replace(/^~(?=\/|$)/, homedir())) : '';
    const startExists = start && await stat(start).then((st) => st.isDirectory(), () => false);
    const script = [
      'on run argv',
      'activate',
      'set p to "Folder for the new Claude session"',
      'if (count of argv) > 0 then return POSIX path of (choose folder with prompt p default location (POSIX file (item 1 of argv)))',
      'return POSIX path of (choose folder with prompt p)',
      'end run',
    ];
    const args = [...script.flatMap((line) => ['-e', line]), ...(startExists ? [start] : [])];
    const folder = await new Promise((resolve) => {
      execFile('/usr/bin/osascript', args, (err, stdout) => resolve(err ? null : stdout.trim().replace(/(.)\/$/, '$1')));
    });
    return sendJson(res, folder ? { folder } : { cancelled: true }); // closing the dialog is a cancel
  }

  if (req.method === 'POST' && pathname === '/api/new-session') {
    const { cwd, prompt, model = null } = await readJson(req, 200_000);
    if (model != null && !((await claudeInfo().catch(() => null))?.models ?? []).some((m) => m.value === model)) {
      throw new HttpError(400, 'Unknown model');
    }
    const dir = typeof cwd === 'string' ? resolvePath(cwd.trim().replace(/^~(?=\/|$)/, homedir())) : '';
    if (!isAbsolute(dir) || !(await stat(dir).then((st) => st.isDirectory(), () => false))) {
      throw new HttpError(400, 'That folder doesn’t exist');
    }
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'Type a first prompt');
    let id;
    try { id = await dashboard.start({ cwd: dir, prompt, model }); } catch (err) { throw new HttpError(502, err.message); }
    // Hooks report the transcript path too; this covers the moments before they do (or no hooks).
    const s = sessions.get(id);
    if (s) s.transcriptPath ??= join(PROJECTS_DIR, dir.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
    broadcast();
    return sendJson(res, { id, auth: dashboard.lastAuth });
  }

  // Rename works for any session: it writes a title line to the transcript, as /rename does.
  const ren = pathname.match(/^\/api\/sessions\/([\w-]+)\/rename$/);
  if (req.method === 'POST' && ren) {
    const s = sessions.get(ren[1]);
    if (!s?.transcriptPath) throw new HttpError(404, 'Not found');
    const { title } = await readJson(req, 10_000);
    const clean = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    if (!clean || clean.length > 200) throw new HttpError(400, 'Title must be 1–200 characters');
    try { await setSessionTitle(s.id, clean); } catch (err) { throw new HttpError(502, err.message); }
    await readTranscript(s.transcriptPath).catch(() => {});
    broadcast();
    return sendJson(res, { ok: true, title: clean });
  }

  const act = pathname.match(/^\/api\/sessions\/([\w-]+)\/(send|interrupt|end)$/);
  if (req.method === 'POST' && act) {
    const [, id, action] = act;
    if (!dashboard.owned.has(id)) throw new HttpError(404, 'Only sessions started here take prompts from the page');
    if (action === 'send') {
      const { text } = await readJson(req, 200_000);
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Type a message');
      try { await dashboard.send(id, text); } catch (err) { throw new HttpError(502, err.message); }
    } else if (action === 'interrupt') {
      await dashboard.interrupt(id);
    } else {
      dashboard.end(id);
    }
    broadcast();
    return sendJson(res, { ok: true });
  }

  const decide = pathname.match(/^\/api\/permissions\/([\w-]+)$/);
  if (req.method === 'POST' && decide) {
    const body = await readJson(req, 100_000);
    const item = pending.get(decide[1]);
    if (!item) throw new HttpError(409, 'Already answered');
    let decision = body.decision;
    if (body.answers !== undefined) {
      // Answers to Claude's question: one string per question, keyed by the question's text.
      const questions = new Set((item.questions ?? []).map((q) => q.question));
      const entries = Object.entries(body.answers ?? {});
      if (!questions.size || !entries.length || !entries.every(([q, a]) => questions.has(q) && typeof a === 'string')) {
        throw new HttpError(400, 'answers must match the questions');
      }
      decision = { answers: body.answers };
    } else if (decision !== 'allow' && decision !== 'deny') {
      throw new HttpError(400, 'decision must be allow or deny');
    }
    const sessionId = pending.resolve(decide[1], decision);
    if (!sessionId) throw new HttpError(409, 'Already answered');
    const s = sessions.get(sessionId);
    if (s?.status === 'needs_you' && !pending.forSession(sessionId).length) {
      s.status = 'working';
      s.need = null;
    }
    broadcast();
    return sendJson(res, { ok: true });
  }

  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');

  // Readable only by same-origin pages: no CORS headers, and the Host check blocks rebinding.
  if (pathname === '/api/token') return sendJson(res, { token: TOKEN });

  // Whether `npm run hooks:install` has added the permission hook, so the page can explain a
  // prompt with no Allow/Deny buttons.
  if (pathname === '/api/setup') {
    const settings = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    const permissionHook = (settings.hooks?.PermissionRequest ?? [])
      .some((g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes('/permission?from=claude-monitor')));
    // Folders of recent sessions, offered when starting a new one.
    const folders = [...new Set([...sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt).map((s) => s.cwd).filter(Boolean))];
    const claude = await claudeInfo().catch((err) => { console.error('Could not read Claude Code account/models:', err.message); return null; });
    return sendJson(res, {
      permissionHook, auth: dashboard.lastAuth, folders: folders.slice(0, 30),
      account: claude?.account ?? null, models: claude?.models ?? [], editor: (await findEditor())?.name ?? null,
    });
  }

  if (pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: sessions\ndata: ${JSON.stringify(list())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname === '/api/sessions') return sendJson(res, list());

  const m = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
  if (m) {
    const s = sessions.get(m[1]);
    if (!s?.transcriptPath) throw new HttpError(404, 'Not found');
    const t = await readTranscript(s.transcriptPath);
    return sendJson(res, {
      ...summary(s), lastResponse: t.lastResponse, lastResponseAt: t.lastResponseAt, turnEnded: t.turnEnded,
      timeline: t.timeline.slice(-500), files: [...t.files.values()], subagents: await readSubagents(s.transcriptPath),
    });
  }

  const asset = STATIC[pathname];
  if (!asset) throw new HttpError(404, 'Not found');
  res.writeHead(200, {
    'Content-Type': asset[1],
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'",
  });
  res.end(await readFile(join(import.meta.dirname, 'public', asset[0])));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain' }).end(err.message);
    else res.end();
  });
});

await mkdir(STATUS_DIR, { recursive: true });
await scanStatusDir();
setInterval(scanStatusDir, 2000);
await loadState();
await loadRecentSessions();

// Stop dashboard sessions' Claude processes with the server; they resume on your next message.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { dashboard.endAll(); process.exit(0); });
}

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use. Is the monitor already running (npm start, or the login service)?`
    : err.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Monitor: http://localhost:${PORT}  (${sessions.size} recent sessions)`);
});
