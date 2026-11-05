import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { classifyPrompt, parseTranscript, TranscriptFile } from '../transcript.mjs';

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

// --- following a transcript file -----------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'claude-monitor-transcript-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const jsonl = (entries) => entries.map((l) => JSON.stringify(l)).join('\n') + '\n';
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
