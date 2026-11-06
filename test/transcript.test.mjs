import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { classifyPrompt, parseTranscript, TranscriptFile } from '../transcript.mjs';

const jsonl = (entries) => entries.map((l) => JSON.stringify(l)).join('\n') + '\n';

const lines = [
  { type: 'ai-title', aiTitle: 'Auto title' },
  { type: 'user', timestamp: '2026-11-04T01:00:00Z', cwd: '/w', gitBranch: 'main', message: { role: 'user', content: 'Fix the login bug' } },
  { type: 'assistant', timestamp: '2026-11-04T01:00:05Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 }, content: [
    { type: 'text', text: 'Looking.' },
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.py', old_string: 'x = 1', new_string: 'x = 2' } },
    { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/w/a.py', old_string: 'nope', new_string: 'y' } },
    { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } },
  ] } },
  { type: 'user', timestamp: '2026-11-04T01:00:06Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
    { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'String not found' },
  ] } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'meta, ignore me' } },
  { type: 'custom-title', customTitle: 'Login fix' },
  { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
  { type: 'some-future-entry', whatever: true },
];
const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json at all\n';

test('summarizes title, prompt, location and context', () => {
  const t = parseTranscript(text);
  assert.equal(t.title, 'Login fix', 'a /rename title wins over the auto title');
  assert.equal(t.lastPrompt, 'Fix the login bug');
  assert.equal(t.cwd, '/w');
  assert.equal(t.branch, 'main');
  assert.equal(t.model, 'claude-opus-5-5');
  assert.equal(t.contextTokens, 1002);
});

test('records edits per file and marks failed ones', () => {
  const f = parseTranscript(text).files.get('/w/a.py');
  assert.equal(f.edits.length, 2);
  assert.deepEqual(f.edits.map((e) => [e.before, e.after, e.failed]), [['x = 1', 'x = 2', false], ['nope', 'y', true]]);
});

test('timeline has prompts and tool calls in order, with failures', () => {
  const tl = parseTranscript(text).timeline;
  assert.deepEqual(tl.map((i) => [i.kind, i.text, Boolean(i.error)]), [
    ['prompt', 'Fix the login bug', false],
    ['tool', 'Edit a.py', false],
    ['tool', 'Edit a.py', true],
    ['tool', 'Run tests', false],
  ]);
  assert.equal(tl[3].command, 'npm test');
});

test('classifyPrompt separates prompts from bare commands and drops output', () => {
  assert.deepEqual(classifyPrompt('<command-name>/clear</command-name>\n<command-args></command-args>'), { kind: 'command', text: '/clear' });
  assert.deepEqual(classifyPrompt('<command-name>/loop</command-name>\n<command-args>5m /check</command-args>'), { kind: 'prompt', text: '/loop 5m /check' });
  assert.deepEqual(classifyPrompt('<bash-input>warpctrl tab list</bash-input>'), { kind: 'command', text: '! warpctrl tab list' });
  assert.equal(classifyPrompt('<local-command-stdout>junk</local-command-stdout>'), null);
  assert.equal(classifyPrompt('<task-notification>done</task-notification>'), null);
  assert.deepEqual(classifyPrompt('hello<system-reminder>x</system-reminder>'), { kind: 'prompt', text: 'hello' });
});

test('last response is the text after the last tool call, and turnEnded tracks end_turn', () => {
  const entry = (content, stop_reason) => ({ type: 'assistant', timestamp: 'T', message: { stop_reason, content } });
  const run = (...entries) => parseTranscript(entries.map((l) => JSON.stringify(l)).join('\n'));
  const prompt = { type: 'user', message: { role: 'user', content: 'Do it' } };

  const mid = run(prompt, entry([{ type: 'text', text: 'Let me check.' }], 'tool_use'), entry([{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }], 'tool_use'));
  assert.equal(mid.lastResponse, null, 'narration before a tool call is not the reply');
  assert.equal(mid.turnEnded, false);

  const done = run(prompt, entry([{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }], 'tool_use'),
    entry([{ type: 'thinking', thinking: '...' }], 'end_turn'), entry([{ type: 'text', text: 'Done. Tests pass.' }], 'end_turn'));
  assert.equal(done.lastResponse, 'Done. Tests pass.');
  assert.equal(done.turnEnded, true);

  const next = run(prompt, entry([{ type: 'text', text: 'Old answer' }], 'end_turn'), { type: 'user', message: { role: 'user', content: 'Again' } });
  assert.equal(next.lastResponse, null, 'a new prompt clears the previous reply');
  assert.equal(next.turnEnded, false);
});

test('subagent transcripts are read only with { sidechain: true }', () => {
  const text = [
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'Research X' } },
    { type: 'assistant', isSidechain: true, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://x.dev' } }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  assert.equal(parseTranscript(text).timeline.length, 0);
  const sub = parseTranscript(text, { sidechain: true });
  assert.deepEqual(sub.timeline.map((i) => [i.kind, i.text, i.id ?? null]), [['prompt', 'Research X', null], ['tool', 'Fetch https://x.dev', 't1']]);
});

test('bare commands and compaction summaries are not the last prompt', () => {
  const t = parseTranscript([
    { type: 'user', message: { role: 'user', content: 'Real question' } },
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation...' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/context</command-name>' } },
  ].map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(t.lastPrompt, 'Real question');
  assert.deepEqual(t.timeline.map((i) => i.kind), ['prompt', 'note', 'command']);
});

test('keeps the conversation as chat messages, splitting Claude’s text at tool calls', () => {
  const chat = [
    { type: 'user', timestamp: 't1', message: { role: 'user', content: 'Hi' } },
    { type: 'assistant', timestamp: 't2', message: { content: [{ type: 'text', text: 'Checking.' }] } },
    { type: 'assistant', timestamp: 't2', message: { content: [{ type: 'text', text: 'One sec.' }] } },
    { type: 'assistant', timestamp: 't3', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', timestamp: 't4', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a' }] } },
    { type: 'assistant', timestamp: 't5', message: { content: [{ type: 'text', text: 'Done.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  assert.deepEqual(parseTranscript(chat).messages, [
    { role: 'user', ts: 't1', text: 'Hi' },
    { role: 'assistant', ts: 't2', text: 'Checking.\n\nOne sec.' },
    { role: 'assistant', ts: 't5', text: 'Done.' },
  ]);
});

test('prompts that carried images are marked, including images sent with no text', () => {
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const t = parseTranscript(jsonl([
    { type: 'user', timestamp: '2026-11-04T03:00:00Z', message: { role: 'user', content: [png, png, { type: 'text', text: 'What is wrong here?' }] } },
    { type: 'user', timestamp: '2026-11-04T03:01:00Z', message: { role: 'user', content: [png] } },
  ]));
  assert.deepEqual(t.messages.map((m) => [m.text, m.images]), [['What is wrong here?', 2], ['', 1]]);
  assert.equal(t.lastPrompt, '[1 image]');
});

test('images sent from the page as file paths show as images, not paths', () => {
  const up = (n) => `/Users/me/.claude-monitor/uploads/df51775a-43c6/1793850909792-${n}.png`;
  const t = parseTranscript(jsonl([
    { type: 'user', timestamp: '2026-11-04T03:00:00Z', message: { role: 'user', content: `What colour is this?\n${up(1)}\n${up(2)}` } },
    { type: 'user', timestamp: '2026-11-04T03:01:00Z', message: { role: 'user', content: up(1) } },
    { type: 'user', timestamp: '2026-11-04T03:02:00Z', message: { role: 'user', content: 'Look at /tmp/shot.png please' } },
  ]));
  assert.deepEqual(t.messages.map((m) => [m.text, m.images]), [['What colour is this?', 2], ['', 1], ['Look at /tmp/shot.png please', undefined]]);
  assert.equal(t.timeline[1].text, '[1 image]');
});

// --- following a transcript file -----------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'claude-monitor-transcript-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const prompt = (text, ts = '2026-11-04T02:00:00Z') => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const said = (text) => ({ type: 'assistant', timestamp: '2026-11-04T02:00:01Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

test('reading a file a piece at a time gives the same result as reading it whole', async () => {
  const path = join(dir, 'pieces.jsonl');
  const whole = jsonl(lines);
  writeFileSync(path, '');
  const file = new TranscriptFile(path);
  for (let i = 0; i < whole.length; i += 97) {
    appendFileSync(path, whole.slice(i, i + 97));
    await file.read();
  }
  const got = await file.read();
  assert.equal(file.latest, got); // kept for callers that can't wait for a read
  const want = parseTranscript(whole);
  assert.deepEqual({ ...got, files: [...got.files.values()] }, { ...want, files: [...want.files.values()] });
});

test('a line still being written waits for its newline, even mid-character', async () => {
  const path = join(dir, 'partial.jsonl');
  writeFileSync(path, jsonl([prompt('first')]));
  const file = new TranscriptFile(path);
  assert.equal((await file.read()).lastPrompt, 'first');
  const next = Buffer.from(JSON.stringify(prompt('café ☕')) + '\n');
  const cut = next.indexOf(Buffer.from('☕')) + 1; // inside the emoji's bytes
  appendFileSync(path, next.subarray(0, cut));
  assert.equal((await file.read()).lastPrompt, 'first');
  appendFileSync(path, next.subarray(cut));
  assert.equal((await file.read()).lastPrompt, 'café ☕');
});

test('reads at the same time never parse the same lines twice', async () => {
  const path = join(dir, 'concurrent.jsonl');
  writeFileSync(path, jsonl([prompt('one'), said('hi')]));
  const file = new TranscriptFile(path);
  await file.read();
  appendFileSync(path, jsonl([prompt('two'), said('hello')]));
  const results = await Promise.all([file.read(), file.read(), file.read()]);
  for (const t of results) assert.deepEqual(t.messages.map((m) => m.text), ['one', 'hi', 'two', 'hello']);
});

test('a file that is rewritten shorter is read again from the start', async () => {
  const path = join(dir, 'rewritten.jsonl');
  writeFileSync(path, jsonl([prompt('one'), prompt('two'), prompt('three')]));
  const file = new TranscriptFile(path);
  assert.equal((await file.read()).timeline.length, 3);
  writeFileSync(path, jsonl([prompt('only')]));
  const t = await file.read();
  assert.deepEqual(t.timeline.map((i) => i.text), ['only']);
});

test('lists the artifacts a session published, docs included; a new version updates the entry, a delete removes it', () => {
  const use = (id, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Artifact', input }] } });
  const result = (id, ts, toolUseResult, is_error = false) => ({
    type: 'user', timestamp: ts, toolUseResult,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'Published …' }] },
  });
  const published = (seq, audience) => ({ url: 'https://claude.ai/artifact/abc', artifact_id: 'a1', title: 'Report', seq, version: `v-${seq}`, audience });
  const t = parseTranscript(jsonl([
    use('p1', { file_path: '/s/report.html' }),
    result('p1', '2026-11-04T01:00:00Z', published(1, 'owner')),
    use('r1', { action: 'read', url: 'https://claude.ai/artifact/other' }),
    result('r1', '2026-11-04T01:01:00Z', { url: 'https://claude.ai/artifact/other', artifact_id: 'a2', title: 'Someone else’s' }),
    use('u1', { url: 'https://claude.ai/artifact/abc', file_path: '/s/logo.png', asset: true }),
    result('u1', '2026-11-04T01:02:00Z', { url: 'https://claude.ai/artifact/abc', artifact_id: 'a1', title: 'Report', seq: 9 }),
    use('p2', { action: 'publish', file_path: '/s/report.html', url: 'https://claude.ai/artifact/abc' }),
    result('p2', '2026-11-04T01:03:00Z', published(2, 'users')),
    use('d1', { type_url: 'https://claude.ai/artifact/DocsType', title: 'Notes' }),
    result('d1', '2026-11-04T01:03:30Z', { created_from_type: true, url: 'https://claude.ai/artifact/doc9', title: 'Notes', version: 'v-1' }),
    use('p4', { file_path: '/s/gone.html' }),
    result('p4', '2026-11-04T01:03:40Z', { url: 'https://claude.ai/artifact/gone', artifact_id: 'g1', title: 'Gone', seq: 1 }),
    use('x1', { action: 'delete', url: 'https://claude.ai/artifact/abc', path: '0123456789abcdef0123456789abcdef' }),
    result('x1', '2026-11-04T01:03:45Z', { asset_delete: true }),
    use('x2', { action: 'delete', url: 'https://claude.ai/artifact/gone' }),
    result('x2', '2026-11-04T01:03:50Z', { artifact_delete: { url: 'https://claude.ai/artifact/gone', deleted: true } }),
    use('p3', { file_path: '/s/broken.html' }),
    result('p3', '2026-11-04T01:04:00Z', { url: 'https://claude.ai/artifact/zzz', artifact_id: 'a3', title: 'Broken' }, true),
  ]));
  assert.deepEqual([...t.artifacts.values()], [{
    id: 'abc', url: 'https://claude.ai/artifact/abc', title: 'Report', version: 2, audience: 'users',
    publishedAt: '2026-11-04T01:00:00Z', updatedAt: '2026-11-04T01:03:00Z',
  }, {
    id: 'doc9', url: 'https://claude.ai/artifact/doc9', title: 'Notes', version: null, audience: null,
    publishedAt: '2026-11-04T01:03:30Z', updatedAt: '2026-11-04T01:03:30Z',
  }]);
});

test('a doc made through the Claude Docs connector is listed, edits update it, a delete removes it', () => {
  const C = 'mcp__claude_ai_Claude_Docs__';
  const call = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: C + name, input }] } });
  const reply = (id, ts, text) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
  const born = (slug, link) => `{"verdict":"allow","created":{"bound":true},"frame":{"slug":"${slug}","url":"https://claude.ai/artifact/${link}"}}\n\nTrailer for Claude: open the doc.`;
  const entries = [
    call('b1', 'batch', { container: { kind: 'project', create: { name: 'Market research', doc: { markdown: '# x' } } }, batch: [] }),
    reply('b1', '2026-11-04T01:00:00Z', born('uuid-1', 'Link1')),
    call('u1', 'update', { container: { kind: 'project', id: 'uuid-1' }, ref: { object: 'node', id: 'n' }, payload: {} }),
    reply('u1', '2026-11-04T01:05:00Z', '{"verdict":"allow"}'),
    call('b2', 'batch', { container: { kind: 'project', create: { name: 'Scratch' } }, batch: [] }),
    reply('b2', '2026-11-04T01:06:00Z', born('uuid-2', 'Link2')),
    call('d1', 'delete', { ref: { object: 'project', id: 'uuid-2' } }),
    reply('d1', '2026-11-04T01:07:00Z', '{"verdict":"allow"}'),
  ];
  const t = parseTranscript(jsonl(entries));
  assert.deepEqual([...t.artifacts.values()], [{
    id: 'Link1', url: 'https://claude.ai/artifact/Link1', title: 'Market research', docId: 'uuid-1', version: null, audience: null,
    publishedAt: '2026-11-04T01:00:00Z', updatedAt: '2026-11-04T01:05:00Z',
  }]);
});
