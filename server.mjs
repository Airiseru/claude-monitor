// Claude Monitor server: receives hook events, watches status line snapshots, reads transcripts,
// and serves the dashboard. Listens on 127.0.0.1 only.
import http from 'node:http';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { applyHook } from './sessions.mjs';
import { parseTranscript } from './transcript.mjs';

const PORT = Number(process.env.PORT ?? 4747);
const MONITOR_HOME = process.env.CLAUDE_MONITOR_HOME ?? join(homedir(), '.claude-monitor');
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
const STATUS_DIR = join(MONITOR_HOME, 'status');
const RECENT_MS = 24 * 3600_000;
const MAX_HOOK_BODY = 5_000_000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const SESSION_ID = /^[\w-]+$/;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const sessions = new Map();    // session id -> live state (sessions.mjs)
const contexts = new Map();    // session id -> latest status line snapshot
const transcripts = new Map(); // transcript path -> { mtimeMs, size, data }
const clients = new Set();     // open SSE responses

// --- transcripts ---------------------------------------------------------------------------

async function readTranscript(path) {
  const st = await stat(path);
  const hit = transcripts.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  const data = parseTranscript(await readFile(path, 'utf8'));
  transcripts.set(path, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
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
    activity: s.activity,
    title: t?.title ?? null,
    cwd: s.cwd ?? t?.cwd ?? null,
    branch: t?.branch ?? null,
    model: context?.model ?? t?.model ?? null,
    lastPrompt: s.lastPrompt ?? t?.lastPrompt ?? null,
    lastEventAt: s.lastEventAt,
    transcriptUpdatedAt: t?.updatedAt ?? null,
    context,
  };
}

function list() {
  const cutoff = Date.now() - RECENT_MS;
  return [...sessions.values()].filter((s) => s.lastEventAt >= cutoff).map(summary);
}

let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const msg = `event: sessions\ndata: ${JSON.stringify(list())}\n\n`;
    for (const res of clients) res.write(msg);
  }, 200);
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

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  // Host check blocks DNS rebinding; together with no CORS headers, other websites can't read
  // or post anything here.
  if (!ALLOWED_HOSTS.has(req.headers.host)) throw new HttpError(403, 'Forbidden');
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && pathname === '/hook') {
    if (req.headers.origin) throw new HttpError(403, 'Forbidden'); // browsers send Origin; hook curl doesn't
    let ev;
    try { ev = JSON.parse(await readBody(req, MAX_HOOK_BODY)); } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, 'Invalid JSON');
    }
    const s = applyHook(sessions, ev, Date.now());
    res.writeHead(204).end(); // empty response: never changes what the session does
    if (s) { refreshSoon(s.id); broadcast(); }
    return;
  }

  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');

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
    return sendJson(res, { ...summary(s), timeline: t.timeline.slice(-500), files: [...t.files.values()] });
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
await loadRecentSessions();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Monitor: http://localhost:${PORT}  (${sessions.size} recent sessions)`);
});
