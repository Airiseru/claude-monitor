// End-to-end tests of server.mjs over HTTP. Each run starts the real server as a child process
// with throwaway home, state and transcript folders. Nothing here starts Claude, Warp, an
// editor or a dialog: endpoints that would are only checked for what they refuse.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const SERVER = join(import.meta.dirname, '..', 'server.mjs');
const SESSION = '11111111-2222-3333-4444-555555555555';
const root = mkdtempSync(join(tmpdir(), 'claude-monitor-test-'));
const home = join(root, 'home');
const monitorHome = join(root, 'monitor');
const projects = join(root, 'projects');
const work = join(root, 'work');
let port, base, server, token;

// --- helpers -------------------------------------------------------------------------------

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
});

// Raw request, so tests can set Host/Origin freely and keep paths like /../ as they are.
function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const hook = (ev, path = '/hook') => request('POST', path, { headers: { 'content-type': 'application/json' }, body: { session_id: SESSION, ...ev } });
const act = (path, body = {}, { withToken = true, origin } = {}) => request('POST', path, {
  headers: { 'content-type': 'application/json', origin: origin ?? base, ...(withToken ? { 'x-monitor-token': token } : {}) }, body,
});
const sessionNow = async () => (await request('GET', '/api/sessions')).json().find((s) => s.id === SESSION);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

async function startServer() {
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOME: home, CLAUDE_MONITOR_HOME: monitorHome, CLAUDE_PROJECTS_DIR: projects, PORT: String(port), PERMISSION_WAIT_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitFor(() => request('GET', '/api/token').then((r) => r.status === 200, () => false), 'the server to start');
  token = (await request('GET', '/api/token')).json().token;
}

async function stopServer() {
  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await exited;
}

// An open dashboard tab, which is what makes the server hold permission requests.
function openDashboard() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.once('data', () => resolve(() => req.destroy()));
    });
  });
}

before(async () => {
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const dir = join(projects, '-work');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(work, 'a.txt'), 'after\n');
  const lines = [
    { type: 'ai-title', aiTitle: 'Fixture session' },
    { type: 'user', timestamp: new Date().toISOString(), cwd: work, gitBranch: 'main', message: { role: 'user', content: 'Change a.txt' } },
    { type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: join(work, 'a.txt'), old_string: 'before', new_string: 'after' } }] } },
    { type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: **a.txt** changed.' }] } },
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServer();
});

after(async () => {
  if (server.exitCode === null) await stopServer();
  rmSync(root, { recursive: true, force: true });
});

// --- tests ---------------------------------------------------------------------------------

test('loads recent sessions from transcripts', async () => {
  const s = await sessionNow();
  assert.equal(s.status, 'idle');
  assert.equal(s.title, 'Fixture session');
  assert.equal(s.lastPrompt, 'Change a.txt');
  assert.equal(s.lastResponse, 'Done: **a.txt** changed.');
  assert.equal(s.branch, 'main');
  const d = (await request('GET', `/api/sessions/${SESSION}`)).json();
  assert.deepEqual(d.files.map((f) => f.path), [join(work, 'a.txt')]);
  assert.equal(d.turnEnded, true);
});

test('refuses other hosts, cross-site hook posts, bad JSON and unknown paths', async () => {
  assert.equal((await request('GET', '/api/sessions', { headers: { host: 'evil.example:80' } })).status, 403);
  assert.equal((await request('POST', '/hook', { headers: { origin: 'https://evil.example' }, body: {} })).status, 403);
  assert.equal((await request('POST', '/hook', { body: 'not json' })).status, 400);
  assert.equal((await request('GET', '/../server.mjs')).status, 404);
  assert.equal((await request('GET', '/nope')).status, 404);
  const icon = await request('GET', '/favicon-alert.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['content-type'], 'image/svg+xml');
});

test('every page action needs the token and a same-origin Origin', async () => {
  for (const path of ['/api/hide', '/api/focus-warp', '/api/open-file', '/api/choose-folder', '/api/new-session',
    `/api/sessions/${SESSION}/rename`, `/api/sessions/${SESSION}/send`, '/api/permissions/x']) {
    assert.equal((await act(path, {}, { withToken: false })).status, 403, `${path} without token`);
    assert.equal((await act(path, {}, { origin: 'https://evil.example' })).status, 403, `${path} from another site`);
  }
});

test('hook events move a session through its statuses', async () => {
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Do the thing', cwd: work });
  assert.equal((await sessionNow()).status, 'working');
  await hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  const s = await sessionNow();
  assert.equal(s.status, 'needs_you');
  assert.equal(s.need.kind, 'permission');
  await hook({ hook_event_name: 'Stop' });
  assert.equal((await sessionNow()).status, 'waiting');
});

test('permission requests pass straight through when no dashboard is open', async () => {
  const res = await hook({ hook_event_name: 'PermissionRequest', tool_name: 'WebFetch', tool_input: { url: 'https://a.dev' } }, '/permission');
  assert.equal(res.status, 200);
  assert.equal(res.body, '', 'no decision: the terminal prompt carries on');
});

test('with a dashboard open, Allow and Deny answer the held hook once', async () => {
  const close = await openDashboard();
  try {
    for (const decision of ['allow', 'deny']) {
      const held = hook({ hook_event_name: 'PermissionRequest', tool_name: 'WebFetch', tool_input: { url: `https://${decision}.dev` } }, '/permission');
      const p = await waitFor(async () => (await sessionNow()).permissions[0], 'the held request');
      assert.equal((await act(`/api/permissions/${p.id}`, { decision: 'maybe' })).status, 400);
      assert.equal((await act(`/api/permissions/${p.id}`, { decision })).status, 200);
      assert.equal((await act(`/api/permissions/${p.id}`, { decision })).status, 409, 'answered once only');
      const out = JSON.parse((await held).body).hookSpecificOutput;
      assert.equal(out.hookEventName, 'PermissionRequest');
      assert.equal(out.decision.behavior, decision);
    }
  } finally {
    close();
  }
});

test('a held request is released by a terminal answer, or when the wait runs out', async () => {
  const close = await openDashboard();
  try {
    const input = { url: 'https://terminal.dev' };
    const held = hook({ hook_event_name: 'PermissionRequest', tool_name: 'WebFetch', tool_input: input }, '/permission');
    await waitFor(async () => (await sessionNow()).permissions.length, 'the held request');
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }); // a different call
    assert.equal((await sessionNow()).permissions.length, 1, 'another tool finishing doesn’t release it');
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_input: input });
    assert.equal((await held).body, '', 'released with no decision');

    const started = Date.now();
    const timedOut = await hook({ hook_event_name: 'PermissionRequest', tool_name: 'WebFetch', tool_input: { url: 'https://slow.dev' } }, '/permission');
    assert.equal(timedOut.body, '');
    assert.ok(Date.now() - started >= 1400, 'held for the configured wait');
    assert.equal((await sessionNow()).permissions.length, 0);
  } finally {
    close();
  }
});

test('page actions validate their input', async () => {
  assert.equal((await act('/api/new-session', { cwd: join(root, 'missing'), prompt: 'hi' })).status, 400);
  assert.equal((await act('/api/new-session', { cwd: work, prompt: '  ' })).status, 400);
  assert.equal((await act(`/api/sessions/${SESSION}/rename`, { title: '   ' })).status, 400);
  assert.equal((await act('/api/sessions/no-such-session/rename', { title: 'x' })).status, 404);
  assert.equal((await act(`/api/sessions/${SESSION}/send`, { text: 'hi' })).status, 404, 'only sessions started here take prompts');
  assert.equal((await act('/api/open-file', { id: SESSION, path: '/etc/hosts' })).status, 404, 'only files the session changed');
  assert.equal((await act('/api/hide', { ids: ['../x'] })).status, 400);
  // Images are checked before anything starts.
  const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  assert.equal((await act('/api/new-session', { cwd: work, prompt: 'hi', images: [{ mediaType: 'image/svg+xml', data: 'AAAA' }] })).status, 400);
  assert.equal((await act('/api/new-session', { cwd: work, prompt: 'hi', images: [{ mediaType: 'image/png', data: 'not base64!' }] })).status, 400);
  assert.equal((await act('/api/new-session', { cwd: work, prompt: 'hi', images: Array(6).fill(png) })).status, 400, 'at most 5 images');
});

test('usage limits come from the freshest status line snapshot', async () => {
  const status = join(monitorHome, 'status');
  mkdirSync(status, { recursive: true });
  const snapshot = (pct) => JSON.stringify({ session_id: SESSION, rate_limits: { five_hour: { used_percentage: pct, resets_at: 1793790000 }, seven_day: { used_percentage: 4, resets_at: 1794294000 } } });
  writeFileSync(join(status, `${SESSION}.json`), snapshot(14));
  const limits = await waitFor(async () => (await request('GET', '/api/limits')).json(), 'limits', 5000);
  assert.deepEqual(limits.fiveHour, { pct: 14, resetsAt: 1793790000000 });
  assert.equal(limits.sevenDay.pct, 4);
});

test('spend adds up how much each session’s running total grew, and survives a restart', async () => {
  const status = join(monitorHome, 'status');
  const other = '99999999-2222-3333-4444-555555555555';
  const write = (id, usd) => writeFileSync(join(status, `${id}.json`), JSON.stringify({ session_id: id, cost: { total_cost_usd: usd } }));
  const today = async () => (await request('GET', '/api/spend')).json().today;
  write(SESSION, 1.5);
  await waitFor(async () => Math.abs(await today() - 1.5) < 1e-9, 'first total');
  write(SESSION, 2); // the same session, 50 cents later
  write(other, 0.25);
  await waitFor(async () => Math.abs(await today() - 2.25) < 1e-9, 'growth only');
  await sleep(1300); // saved about a second after a change
  await stopServer();
  await startServer();
  await sleep(300); // the first scan of snapshots it has already counted
  const s = (await request('GET', '/api/spend')).json();
  assert.ok(Math.abs(s.today - 2.25) < 1e-9, `not counted twice after a restart (got ${s.today})`);
  assert.ok(Math.abs(s.week - 2.25) < 1e-9);
  assert.equal(s.days.length, 30);
});

test('a removed session stays removed across a restart and comes back on new activity', async () => {
  assert.equal((await act('/api/hide', { ids: [SESSION] })).status, 200);
  assert.equal(await sessionNow(), undefined);
  await sleep(1300); // state is saved about a second after a change
  await stopServer();
  await startServer();
  assert.equal(await sessionNow(), undefined, 'still removed after restart');
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Back again', cwd: work });
  assert.equal((await sessionNow())?.status, 'working');
});
