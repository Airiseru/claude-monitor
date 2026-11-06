// Claude Monitor server: receives hook events, watches status line snapshots, reads transcripts,
// and serves the dashboard. Listens on 127.0.0.1 only.
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { CLAUDE, claudeInfo, setSessionTitle } from './agents.mjs';
import { PendingPermissions } from './permissions.mjs';
import { applyHook } from './sessions.mjs';
import { KEYS, Terminals } from './terminals.mjs';
import { TranscriptFile } from './transcript.mjs';

const PORT = Number(process.env.PORT ?? 4747);
const MONITOR_HOME = process.env.CLAUDE_MONITOR_HOME ?? join(homedir(), '.claude-monitor');
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
const STATUS_DIR = join(MONITOR_HOME, 'status');
const STATE_FILE = join(MONITOR_HOME, 'state.json'); // live statuses + removed sessions, kept across restarts
const UPLOADS_DIR = join(MONITOR_HOME, 'uploads'); // images sent from the page, one folder per session
const RECENT_MS = 36 * 3600_000;
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
const transcripts = new Map(); // transcript path -> TranscriptFile
const clients = new Set();     // open SSE responses
const pending = new PendingPermissions();
const hidden = new Set();      // session ids removed from the list; back on their next event
const terminals = new Terminals({ claude: CLAUDE, home: homedir(), conf: join(import.meta.dirname, 'tmux.conf'), changed: terminalsChanged });

// An event the page itself causes (a prompt sent, a session started or stopped), applied as
// the hooks would report it, so the list is right at once.
function pageEvent(ev) {
  const s = applyHook(sessions, ev, Date.now());
  if (s) { pending.settle(ev); refreshSoon(s.id); }
  broadcast();
}

// Which sessions run in tmux changed. A pane that's gone means Claude Code stopped (killed,
// or exited before its SessionEnd hook could report it). A session still asking whether to
// trust its folder needs you before it can start.
const TRUST_MESSAGE = 'Claude Code asks whether you trust this folder before it starts. Answer it in the Terminal tab.';
let wasLive = new Set();
function terminalsChanged() {
  const live = new Set([...terminals.owned.keys()].filter((id) => terminals.isLive(id)));
  for (const [id, s] of sessions) {
    if (!terminals.owned.has(id)) continue;
    const trust = terminals.needsTrust(id);
    if (trust && s.status !== 'needs_you') Object.assign(s, { status: 'needs_you', need: { kind: 'trust', message: TRUST_MESSAGE }, activity: null });
    else if (!trust && s.need?.kind === 'trust') Object.assign(s, { status: 'working', need: null });
    if (wasLive.has(id) && !live.has(id) && s.status !== 'ended') {
      for (const p of pending.forSession(id)) pending.resolve(p.id, null);
      Object.assign(s, { status: 'ended', need: null, activity: null });
    }
  }
  wasLive = live;
  saveSoon();
  broadcast();
}

// --- spend ---------------------------------------------------------------------------------

// What your sessions cost per day, at API prices (an estimate of usage, not a bill on a
// subscription). Status lines and the SDK report each session's running total, so a day's
// spend is the sum of how much those totals grew that day (server's local time). A total that
// went down was restarted, and counts from zero.
const SPEND_DAYS = 30;
const spend = { days: {}, seen: {} }; // days: 'YYYY-MM-DD' -> usd; seen: session id -> { usd, at }

const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function recordCost(id, usd, at) {
  if (typeof usd !== 'number' || !(usd > 0)) return;
  const before = spend.seen[id]?.usd ?? 0;
  const grew = usd >= before ? usd - before : usd;
  spend.seen[id] = { usd, at };
  if (grew > 0) spend.days[dayOf(at)] = (spend.days[dayOf(at)] ?? 0) + grew;
}

// Totals for the last SPEND_DAYS days, newest first, plus today and the last 7 days.
function spendSummary(now = Date.now()) {
  const days = [];
  for (let i = 0; i < SPEND_DAYS; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const day = dayOf(d.getTime());
    days.push({ day, usd: spend.days[day] ?? 0 });
  }
  const sum = (n) => days.slice(0, n).reduce((a, d) => a + d.usd, 0);
  const since = Object.keys(spend.days).sort()[0] ?? null; // the first day there's anything for
  return { today: sum(1), week: sum(7), month: sum(SPEND_DAYS), days, since };
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
    if (!SESSION_ID.test(id) || typeof entry?.cwd !== 'string') continue;
    const num = (n) => (typeof n === 'number' && n > 0 ? n : null);
    // Sessions saved before tmux were all started here; their context window and cost came
    // from the Agent SDK, and are kept for display.
    terminals.owned.set(id, { cwd: entry.cwd, model: entry.model ?? null, here: entry.here ?? true, contextWindow: num(entry.contextWindow), costUsd: num(entry.costUsd) });
  }
  for (const [day, usd] of Object.entries(saved.spend?.days ?? {})) {
    if (/^\d{4}-\d\d-\d\d$/.test(day) && typeof usd === 'number') spend.days[day] = usd;
  }
  for (const [id, v] of Object.entries(saved.spend?.seen ?? {})) {
    if (SESSION_ID.test(id) && typeof v?.usd === 'number' && typeof v?.at === 'number') spend.seen[id] = { usd: v.usd, at: v.at };
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
      owned: [...terminals.owned].filter(([id]) => sessions.has(id)),
      spend,
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

// Each transcript is followed (only new lines are parsed) and its latest summary kept.
async function readTranscript(path, options) {
  let file = transcripts.get(path);
  if (!file) transcripts.set(path, file = new TranscriptFile(path, options));
  return file.read();
}

// A session's subagents: <session>/subagents/agent-<id>.jsonl plus a .meta.json that names the
// parent's Agent tool call that started it.
const finishedAgents = new Map(); // meta file path -> summary of a finished subagent; it won't change again
async function readSubagents(transcriptPath) {
  const dir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const out = [];
  for (const file of await readdir(dir).catch(() => [])) {
    const agentId = file.match(/^agent-([\w-]+)\.meta\.json$/)?.[1];
    if (!agentId) continue;
    const metaPath = join(dir, file);
    const done = finishedAgents.get(metaPath);
    if (done) { out.push(done); continue; }
    const meta = await readFile(metaPath, 'utf8').then(JSON.parse).catch(() => null);
    const t = await readTranscript(join(dir, `agent-${agentId}.jsonl`), { sidechain: true }).catch(() => null);
    if (!meta || !t) continue;
    const tools = t.timeline.filter((i) => i.kind === 'tool');
    const agent = {
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
    };
    if (agent.finished && t.turnEnded) { // both, in case the meta file is written before the last lines
      finishedAgents.set(metaPath, agent);
      transcripts.delete(join(dir, `agent-${agentId}.jsonl`)); // the summary is all that's needed now
    }
    out.push(agent);
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

// Hooks fire before the transcript is written, so re-read it shortly after the last event.
const refreshTimers = new Map();
// How many of a session's subagents are still running, from their meta files. One that isn't
// marked finished but hasn't written to its transcript for a while is taken as gone (its session
// was killed, say), so it can't hold the count up forever.
const runningAgents = new Map(); // session id -> number of its subagents still running
const finishedMeta = new Set();  // subagent meta files already marked finished; they won't change
const STALE_AGENT_MS = 10 * 60_000;
async function countRunningAgents(s) {
  if (!s?.transcriptPath) return;
  const dir = join(s.transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let n = 0;
  for (const file of await readdir(dir).catch(() => [])) {
    const agentId = file.match(/^agent-([\w-]+)\.meta\.json$/)?.[1];
    const path = join(dir, file);
    if (!agentId || finishedMeta.has(path)) continue;
    const meta = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
    if (meta?.finished) { finishedMeta.add(path); continue; }
    const st = await stat(join(dir, `agent-${agentId}.jsonl`)).catch(() => null);
    if (meta && st && Date.now() - st.mtimeMs < STALE_AGENT_MS) n++;
  }
  runningAgents.set(s.id, n);
}

function refreshSoon(id) {
  clearTimeout(refreshTimers.get(id));
  refreshTimers.set(id, setTimeout(async () => {
    refreshTimers.delete(id);
    const path = sessions.get(id)?.transcriptPath;
    if (path) await readTranscript(path).catch(() => {});
    await countRunningAgents(sessions.get(id)).catch(() => {});
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
    await loadStatus(file, st.mtimeMs);
  }
}

// Your plan's usage limits are account-wide, so the freshest snapshot from any session wins.
// { fiveHour, sevenDay: { pct, resetsAt (ms) } | null, at (ms) } once a status line reports them.
let limits = null;

function readLimits(rateLimits, at) {
  const window = (w) => (w && typeof w.used_percentage === 'number'
    ? { pct: w.used_percentage, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null }
    : null);
  const next = { fiveHour: window(rateLimits?.five_hour), sevenDay: window(rateLimits?.seven_day), at };
  if ((next.fiveHour || next.sevenDay) && !(limits?.at > at)) limits = next;
}

async function loadStatus(file, mtimeMs = Date.now()) {
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
    recordCost(id, c.total_cost_usd, mtimeMs);
    readLimits(s.rate_limits, mtimeMs);
    broadcast();
  } catch {
    // Removed or unreadable: keep the last good snapshot.
  }
}

// --- session list --------------------------------------------------------------------------

function summary(s) {
  const t = transcripts.get(s.transcriptPath)?.latest;
  // Sessions started here before tmux had no status line: their context is the transcript's
  // latest token count against the model's window, and their cost, both from the Agent SDK.
  const owned = terminals.owned.get(s.id);
  const size = owned?.contextWindow ?? null;
  const context = contexts.get(s.id) ?? (t?.contextTokens
    ? { pct: size ? Math.min(100, (t.contextTokens / size) * 100) : null, size, tokens: t.contextTokens, model: null }
    : null);
  const cost = costs.get(s.id) ?? (owned?.costUsd ? { usd: owned.costUsd, linesAdded: null, linesRemoved: null } : null);
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
    cost,
    artifacts: t?.artifacts?.size ?? 0, // how many it published; the detail lists them
    alerts: { needs: s.needCount ?? 0, done: s.doneCount ?? 0 }, // counts that go up; see sessions.mjs
    runningSubagents: runningAgents.get(s.id) ?? 0,
    // Runs (or ran) in the monitor's tmux, so it takes messages from the page. live: running
    // right now; attach: the command that opens it in a terminal; here: started from the page.
    terminal: owned ? { live: terminals.isLive(s.id), attach: terminals.attachCommand(s.id), here: Boolean(owned.here) } : null,
  };
}

function list() {
  const cutoff = Date.now() - RECENT_MS;
  return [...sessions.values()].filter((s) => s.lastEventAt >= cutoff && !hidden.has(s.id)).map(summary);
}

// Sessions that have dropped out of the list (no events for RECENT_MS) are forgotten, with
// their cached transcripts and status line snapshots, so a server that runs for weeks doesn't
// keep every session it has ever seen. A live one stays, however long it has been quiet.
async function pruneOld(now = Date.now()) {
  const cutoff = now - RECENT_MS;
  for (const [id, s] of sessions) {
    if (s.lastEventAt >= cutoff || terminals.isLive(id) || pending.forSession(id).length) continue;
    sessions.delete(id);
    hidden.delete(id);
    terminals.owned.delete(id);
    await rm(join(UPLOADS_DIR, id), { recursive: true, force: true });
    contexts.delete(id);
    costs.delete(id);
    clearTimeout(refreshTimers.get(id));
    refreshTimers.delete(id);
  }
  // Keep the transcripts (and subagent transcripts) of the sessions that are left.
  const keep = [...sessions.values()].map((s) => s.transcriptPath).filter(Boolean);
  const kept = (path) => keep.some((p) => path === p || path.startsWith(`${p.replace(/\.jsonl$/, '')}/`));
  for (const path of transcripts.keys()) if (!kept(path)) transcripts.delete(path);
  for (const path of finishedAgents.keys()) if (!kept(path)) finishedAgents.delete(path);
  for (const path of finishedMeta) if (!kept(path)) finishedMeta.delete(path);
  for (const id of runningAgents.keys()) if (!sessions.has(id)) runningAgents.delete(id);
  // Spend: keep SPEND_DAYS days. A session's last total is kept as long, so a session resumed
  // within that time adds only what it spends from then on.
  const oldest = dayOf(now - SPEND_DAYS * 24 * 3600_000);
  for (const day of Object.keys(spend.days)) if (day < oldest) delete spend.days[day];
  for (const [id, v] of Object.entries(spend.seen)) if (v.at < now - SPEND_DAYS * 24 * 3600_000) delete spend.seen[id];
  // A session's status line rewrites its snapshot on its next turn, so old ones can go.
  for (const file of await readdir(STATUS_DIR).catch(() => [])) {
    const st = await stat(join(STATUS_DIR, file)).catch(() => null);
    if (!st || st.mtimeMs >= cutoff || sessions.has(basename(file, '.json'))) continue;
    await unlink(join(STATUS_DIR, file)).catch(() => {});
    statusMtimes.delete(file);
    contexts.delete(basename(file, '.json'));
    costs.delete(basename(file, '.json'));
  }
  saveSoon();
}

let broadcastTimer = null;
function broadcast() {
  saveSoon(); // every change that's worth showing is worth keeping
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const msg = `event: sessions\ndata: ${JSON.stringify(list())}\n\nevent: limits\ndata: ${JSON.stringify(limits)}\n\n`;
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

// --- images in prompts ---------------------------------------------------------------------

// Images sent with a prompt, as the API takes them: PNG, JPEG, GIF or WebP, at most 5 MB
// each. The page shrinks bigger ones before sending.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_BODY = MAX_IMAGES * Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 300_000;

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function readImages(images) {
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new HttpError(400, `Up to ${MAX_IMAGES} images per message`);
  return images.map((i) => {
    if (!IMAGE_TYPES.has(i?.mediaType)) throw new HttpError(400, 'Images must be PNG, JPEG, GIF or WebP');
    if (typeof i.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) throw new HttpError(400, 'Image data must be base64');
    if (Buffer.byteLength(i.data, 'base64') > MAX_IMAGE_BYTES) throw new HttpError(400, 'Each image must be 5 MB or less');
    return { mediaType: i.mediaType, data: i.data };
  });
}

// A terminal can't be sent image data, so images are saved as files and their paths go in
// the message, as when you drag an image into the terminal. Claude Code reads them from there.
async function messageWithImages(id, text, images) {
  if (!images.length) return text;
  const dir = join(UPLOADS_DIR, id);
  await mkdir(dir, { recursive: true });
  const paths = [];
  for (const [i, img] of images.entries()) {
    const path = join(dir, `${Date.now()}-${i + 1}.${IMAGE_EXT[img.mediaType]}`);
    await writeFile(path, Buffer.from(img.data, 'base64'));
    paths.push(path);
  }
  return [text, ...paths].filter(Boolean).join('\n');
}

// How a message shows in the session list until the transcript has it.
function promptText(text, images) {
  const note = images.length ? `[${images.length} image${images.length > 1 ? 's' : ''}]` : '';
  return [note, text].filter(Boolean).join(' ');
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

function hookDecision(decision, input) {
  const d = decision?.answers ? { behavior: 'allow', updatedInput: { ...input, answers: decision.answers } }
    : decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Claude Monitor' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
}

// Holds a PermissionRequest hook open until a click, a terminal answer, or the wait runs out.
// An empty 200 means "no decision": the terminal prompt carries on as if the monitor weren't there.
function holdPermission(ev, res) {
  // No dashboard open: don't hold anything. Claude's questions (AskUserQuestion) are held too,
  // and answered with the answers filled in.
  if (!clients.size) return res.writeHead(200).end();
  let timer;
  const id = pending.add(ev, (decision) => {
    clearTimeout(timer);
    if (!res.writableEnded) {
      if (decision) res.writeHead(200, { 'Content-Type': 'application/json' }).end(hookDecision(decision, ev.tool_input ?? {}));
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
    // A finished turn goes out with an up-to-date count of subagents still running, so the page
    // can tell "done" from "waiting on its background subagents".
    if (s && ev.hook_event_name === 'Stop') await countRunningAgents(s).catch(() => {});
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
    const { cwd, prompt, model = null, images: rawImages } = await readJson(req, MAX_PROMPT_BODY);
    const images = readImages(rawImages);
    if (model != null && !((await claudeInfo().catch(() => null))?.models ?? []).some((m) => m.value === model)) {
      throw new HttpError(400, 'Unknown model');
    }
    const dir = typeof cwd === 'string' ? resolvePath(cwd.trim().replace(/^~(?=\/|$)/, homedir())) : '';
    if (!isAbsolute(dir) || !(await stat(dir).then((st) => st.isDirectory(), () => false))) {
      throw new HttpError(400, 'That folder doesn’t exist');
    }
    if (typeof prompt !== 'string' || (!prompt.trim() && !images.length)) throw new HttpError(400, 'Type a first prompt');
    if (!terminals.available) throw new HttpError(400, 'tmux isn’t installed. Install it with: brew install tmux');
    const id = randomUUID(); // known up front, so images can be saved before Claude Code starts
    try {
      await terminals.start({ cwd: dir, prompt: await messageWithImages(id, prompt.trim(), images), model, id });
    } catch (err) { throw new HttpError(502, err.message); }
    pageEvent({ session_id: id, cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: promptText(prompt.trim(), images) });
    // Hooks report the transcript path too; this covers the moments before they do (or no hooks).
    const s = sessions.get(id);
    if (s) s.transcriptPath ??= join(PROJECTS_DIR, dir.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
    broadcast();
    return sendJson(res, { id });
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

  const act = pathname.match(/^\/api\/sessions\/([\w-]+)\/(send|interrupt|end|key)$/);
  if (req.method === 'POST' && act) {
    const [, id, action] = act;
    const owned = terminals.owned.get(id);
    if (!owned) throw new HttpError(404, 'Only sessions running in the monitor’s tmux take messages from the page');
    const live = terminals.isLive(id);
    if (action === 'send') {
      const { text = '', images: rawImages } = await readJson(req, MAX_PROMPT_BODY);
      const images = readImages(rawImages);
      if (typeof text !== 'string' || (!text.trim() && !images.length)) throw new HttpError(400, 'Type a message');
      const message = await messageWithImages(id, text.trim(), images);
      if (live) {
        // Typing into a menu or dialog would pick options in it.
        if (sessions.get(id)?.status === 'needs_you') throw new HttpError(409, 'Claude is waiting on a prompt. Answer it first (Terminal tab).');
        try { await terminals.send(id, message); } catch (err) { throw new HttpError(502, err.message); }
      } else {
        // Stopped: resume it in a new tmux session, unless it's open somewhere else.
        if (await terminals.openElsewhere(id)) throw new HttpError(409, 'This session is open in another terminal. Reply there.');
        if (!owned.cwd) throw new HttpError(409, 'Don’t know which folder this session ran in');
        try { await terminals.start({ cwd: owned.cwd, model: owned.model, prompt: message, resume: id }); } catch (err) { throw new HttpError(502, err.message); }
      }
      pageEvent({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: promptText(text.trim(), images) });
      return sendJson(res, { ok: true });
    }
    if (!live) throw new HttpError(409, 'This session isn’t running');
    try {
      if (action === 'interrupt') await terminals.key(id, 'escape');
      else if (action === 'key') {
        const { key } = await readJson(req, 1000);
        if (!Object.hasOwn(KEYS, key)) throw new HttpError(400, 'Unknown key');
        await terminals.key(id, key);
      } else {
        await terminals.end(id);
        pageEvent({ session_id: id, hook_event_name: 'SessionEnd' });
      }
    } catch (err) { throw err instanceof HttpError ? err : new HttpError(502, err.message); }
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
      permissionHook, tmux: terminals.available, folders: folders.slice(0, 30),
      account: claude?.account ?? null, models: claude?.models ?? [], editor: (await findEditor())?.name ?? null,
    });
  }

  if (pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: sessions\ndata: ${JSON.stringify(list())}\n\nevent: limits\ndata: ${JSON.stringify(limits)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname === '/api/sessions') return sendJson(res, list());
  if (pathname === '/api/limits') return sendJson(res, limits);
  if (pathname === '/api/spend') return sendJson(res, spendSummary());

  // What a session's terminal shows right now, for the page's Terminal tab.
  const scr = pathname.match(/^\/api\/sessions\/([\w-]+)\/screen$/);
  if (scr) {
    if (!terminals.isLive(scr[1])) throw new HttpError(404, 'This session isn’t running in tmux');
    return sendJson(res, { screen: await terminals.screen(scr[1]).catch(() => '') });
  }

  const m = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
  if (m) {
    const s = sessions.get(m[1]);
    if (!s?.transcriptPath) throw new HttpError(404, 'Not found');
    const t = await readTranscript(s.transcriptPath);
    return sendJson(res, {
      ...summary(s), lastResponse: t.lastResponse, lastResponseAt: t.lastResponseAt, turnEnded: t.turnEnded,
      timeline: t.timeline.slice(-500), messages: t.messages.slice(-300), files: [...t.files.values()],
      artifacts: [...t.artifacts.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
      subagents: await readSubagents(s.transcriptPath),
    });
  }

  const asset = STATIC[pathname];
  if (!asset) throw new HttpError(404, 'Not found');
  res.writeHead(200, {
    'Content-Type': asset[1],
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:", // blob: previews images you attach
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
await loadState(); // before the first scan, so spend already counted isn't counted again
await scanStatusDir();
setInterval(scanStatusDir, 2000);
await loadRecentSessions();
await pruneOld(); // drops transcripts read while looking for recent sessions
setInterval(() => pruneOld().catch((err) => console.error('Could not prune:', err.message)), 10 * 60_000);

await terminals.refresh();
setInterval(() => terminals.refresh().catch((err) => console.error('Could not list tmux sessions:', err.message)), 2000);

// Sessions in tmux keep running when the server stops; it finds them again when it starts.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => process.exit(0));
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
