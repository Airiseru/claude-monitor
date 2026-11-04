// Live state of each session, driven by Claude Code hook events.
//   working   - a prompt is being worked on
//   needs_you - waiting on a permission prompt or a question
//   waiting   - finished its turn, waiting for your next prompt
//   idle      - seen in a recent transcript, but no live events since the monitor started
//   ended     - the session exited
import { describeTool, questionText } from './tools.mjs';

const DECISION_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

// Applies one hook event to `sessions` (a Map) and returns the updated session, or null when
// the event has no session id.
export function applyHook(sessions, ev, now) {
  const id = ev?.session_id;
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return null;
  const s = sessions.get(id) ?? { id, status: 'idle', need: null, activity: null };
  if (ev.cwd) s.cwd = ev.cwd;
  if (ev.transcript_path) s.transcriptPath = ev.transcript_path;
  s.lastEventAt = now;

  switch (ev.hook_event_name) {
    case 'SessionStart':
      set(s, 'waiting');
      break;
    case 'UserPromptSubmit':
      set(s, 'working');
      if (ev.prompt) s.lastPrompt = ev.prompt;
      break;
    case 'PreToolUse':
      if (ev.tool_name === 'AskUserQuestion') set(s, 'needs_you', { kind: 'question', message: questionText(ev.tool_input) });
      else set(s, 'working');
      s.activity = describeTool(ev.tool_name, ev.tool_input);
      // Hooks inside a subagent carry its id and type.
      if (ev.agent_id) s.activity = `Subagent (${ev.agent_type ?? 'agent'}): ${s.activity}`;
      break;
    case 'PostToolUse': case 'PostToolUseFailure': case 'PermissionDenied':
      set(s, 'working', null, s.activity);
      break;
    case 'PermissionRequest':
      s.activity = describeTool(ev.tool_name, ev.tool_input);
      set(s, 'needs_you', { kind: 'permission', message: `Wants permission: ${s.activity}` }, s.activity);
      break;
    case 'Notification':
      // idle_prompt and the rest are informational: Stop already marked the session as waiting.
      if (DECISION_NOTIFICATIONS.has(ev.notification_type)) {
        const kind = ev.notification_type === 'permission_prompt' ? 'permission' : 'question';
        // Keep a more specific message from PermissionRequest over the generic notification.
        const keep = s.status === 'needs_you' && s.need?.kind === kind;
        set(s, 'needs_you', keep ? s.need : { kind, message: ev.message ?? null }, s.activity);
      }
      break;
    case 'Stop':
      set(s, 'waiting');
      break;
    case 'SessionEnd':
      set(s, 'ended');
      break;
  }
  sessions.set(id, s);
  return s;
}

function set(s, status, need = null, activity = null) {
  s.status = status;
  s.need = need;
  s.activity = activity;
}
