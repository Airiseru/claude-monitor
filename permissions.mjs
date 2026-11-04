// Permission requests held open until you click Allow or Deny in the dashboard, or until the
// session moves on without the dashboard (you answered in the terminal, or the turn ended).
// For dashboard sessions this also holds Claude's questions (AskUserQuestion) until answered.
import { randomUUID } from 'node:crypto';
import { describeTool } from './tools.mjs';

// The tool call this request was for has finished, so it was answered in the terminal.
const TOOL_DONE_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
// The turn is over: nothing held for this session can still be waiting.
const TURN_OVER_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'SessionEnd']);
const MAX_INPUT_SHOWN = 3000;

export class PendingPermissions {
  #items = new Map(); // request id -> { id, sessionId, tool, input, summary, createdAt, respond }

  // `respond(decision)` answers the request; decision is 'allow', 'deny', null (no decision), or
  // for a question { answers: { [question text]: answer } }.
  add(ev, respond) {
    const id = randomUUID();
    const input = ev.tool_input ?? {};
    this.#items.set(id, {
      id, sessionId: ev.session_id, tool: ev.tool_name, input,
      questions: ev.tool_name === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions : null,
      summary: describeTool(ev.tool_name, input), createdAt: Date.now(), respond,
    });
    return id;
  }

  get(id) {
    return this.#items.get(id) ?? null;
  }

  // Returns the request's session id, or null if it was already answered or dropped.
  resolve(id, decision) {
    const p = this.#items.get(id);
    if (!p) return null;
    this.#items.delete(id);
    p.respond(decision);
    return p.sessionId;
  }

  // The hook's connection closed (Claude Code gave up on it): forget it without answering.
  drop(id) {
    this.#items.delete(id);
  }

  // Releases requests that a hook event shows were settled elsewhere. PreToolUse and
  // Notification don't count: both can arrive after the request they belong to.
  settle(ev) {
    let settled = 0;
    for (const p of [...this.#items.values()]) {
      if (p.sessionId !== ev.session_id) continue;
      const toolDone = TOOL_DONE_EVENTS.has(ev.hook_event_name) && p.tool === ev.tool_name
        && JSON.stringify(p.input) === JSON.stringify(ev.tool_input ?? {});
      if (toolDone || TURN_OVER_EVENTS.has(ev.hook_event_name)) {
        this.resolve(p.id, null);
        settled++;
      }
    }
    return settled;
  }

  forSession(sessionId) {
    return [...this.#items.values()]
      .filter((p) => p.sessionId === sessionId)
      .map(({ id, tool, input, questions, summary, createdAt }) => ({
        id, tool, summary, createdAt, questions, input: JSON.stringify(input, null, 2).slice(0, MAX_INPUT_SHOWN),
      }));
  }
}
