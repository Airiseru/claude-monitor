import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PendingPermissions } from '../permissions.mjs';
import { applyHook } from '../sessions.mjs';

const request = (input, session_id = 's1') => ({ session_id, hook_event_name: 'PermissionRequest', tool_name: 'WebFetch', tool_input: input });

test('a click answers the held hook exactly once', () => {
  const pending = new PendingPermissions();
  const answers = [];
  const id = pending.add(request({ url: 'https://a.dev' }), (d) => answers.push(d));
  assert.equal(pending.forSession('s1').length, 1);
  assert.equal(pending.forSession('s1')[0].summary, 'Fetch https://a.dev');

  assert.equal(pending.resolve(id, 'allow'), 's1');
  assert.equal(pending.resolve(id, 'deny'), null, 'second answer is rejected');
  assert.deepEqual(answers, ['allow']);
  assert.equal(pending.forSession('s1').length, 0);
});

test('a terminal answer is detected from the same tool call finishing', () => {
  const pending = new PendingPermissions();
  const answers = [];
  pending.add(request({ url: 'https://a.dev' }), (d) => answers.push(['a', d]));
  pending.add(request({ url: 'https://b.dev' }), (d) => answers.push(['b', d]));

  // A parallel tool call finishing, or the request's own PreToolUse/Notification, settles nothing.
  assert.equal(pending.settle({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), 0);
  assert.equal(pending.settle({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://a.dev' } }), 0);
  assert.equal(pending.settle({ session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt' }), 0);
  assert.equal(pending.settle({ session_id: 's2', hook_event_name: 'Stop' }), 0, 'other sessions are untouched');

  assert.equal(pending.settle({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://a.dev' } }), 1);
  assert.deepEqual(answers, [['a', null]], 'released with no decision');

  assert.equal(pending.settle({ session_id: 's1', hook_event_name: 'Stop' }), 1, 'the turn ending releases the rest');
  assert.deepEqual(answers, [['a', null], ['b', null]]);
});

test('a dropped connection forgets the request without answering', () => {
  const pending = new PendingPermissions();
  const answers = [];
  const id = pending.add(request({ url: 'https://a.dev' }), (d) => answers.push(d));
  pending.drop(id);
  assert.equal(pending.resolve(id, 'allow'), null);
  assert.deepEqual(answers, []);
});

test('PermissionRequest marks the session as needing you, and the later notification keeps its message', () => {
  const m = new Map();
  applyHook(m, request({ url: 'https://a.dev' }), 1);
  assert.deepEqual(m.get('s1').need, { kind: 'permission', message: 'Wants permission: Fetch https://a.dev' });
  applyHook(m, { session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }, 2);
  assert.equal(m.get('s1').need.message, 'Wants permission: Fetch https://a.dev');
});
