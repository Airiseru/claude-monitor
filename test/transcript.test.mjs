import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPrompt, parseTranscript } from '../transcript.mjs';

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

test('bare commands and compaction summaries are not the last prompt', () => {
  const t = parseTranscript([
    { type: 'user', message: { role: 'user', content: 'Real question' } },
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation...' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/context</command-name>' } },
  ].map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(t.lastPrompt, 'Real question');
  assert.deepEqual(t.timeline.map((i) => i.kind), ['prompt', 'note', 'command']);
});
