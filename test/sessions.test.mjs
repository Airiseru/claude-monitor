import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHook } from '../sessions.mjs';

const ev = (hook_event_name, extra = {}) => ({ session_id: 's1', cwd: '/w', transcript_path: '/t.jsonl', hook_event_name, ...extra });

test('a turn moves working -> needs you -> working -> waiting', () => {
  const m = new Map();
  applyHook(m, ev('SessionStart'), 1);
  assert.equal(m.get('s1').status, 'waiting');

  applyHook(m, ev('UserPromptSubmit', { prompt: 'fix the bug' }), 2);
  assert.equal(m.get('s1').status, 'working');
  assert.equal(m.get('s1').lastPrompt, 'fix the bug');

  applyHook(m, ev('PreToolUse', { tool_name: 'WebFetch', tool_input: { url: 'https://x.dev' } }), 3);
  assert.equal(m.get('s1').activity, 'Fetch https://x.dev');

  applyHook(m, ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }), 4);
  assert.equal(m.get('s1').status, 'needs_you');
  assert.deepEqual(m.get('s1').need, { kind: 'permission', message: 'Claude needs your permission' });
  assert.equal(m.get('s1').activity, 'Fetch https://x.dev', 'keeps what it was trying to do');

  applyHook(m, ev('PostToolUse', { tool_name: 'WebFetch' }), 5);
  assert.equal(m.get('s1').status, 'working');
  assert.equal(m.get('s1').need, null);

  applyHook(m, ev('Stop'), 6);
  assert.equal(m.get('s1').status, 'waiting');
  assert.equal(m.get('s1').lastEventAt, 6);
});

test('AskUserQuestion shows the question as needing you', () => {
  const m = new Map();
  applyHook(m, ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which DB?' }] } }), 1);
  assert.equal(m.get('s1').status, 'needs_you');
  assert.deepEqual(m.get('s1').need, { kind: 'question', message: 'Which DB?' });
});

test('idle_prompt notification does not override waiting', () => {
  const m = new Map();
  applyHook(m, ev('Stop'), 1);
  applyHook(m, ev('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting' }), 2);
  assert.equal(m.get('s1').status, 'waiting');
  assert.equal(m.get('s1').need, null);
});

test('rejects events without a safe session id', () => {
  const m = new Map();
  assert.equal(applyHook(m, { hook_event_name: 'Stop' }, 1), null);
  assert.equal(applyHook(m, { session_id: '../etc', hook_event_name: 'Stop' }, 1), null);
  assert.equal(m.size, 0);
});

test('a prompt with images sent from the page shows the image count, not the paths', () => {
  const sessions = new Map();
  const s = applyHook(sessions, { session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'Which colour?\n/Users/me/.claude-monitor/uploads/a/1793850909792-1.png' }, 1);
  assert.equal(s.lastPrompt, '[1 image] Which colour?');
});
