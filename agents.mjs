// Sessions started from the dashboard, run through the Claude Agent SDK so prompts and replies
// can be typed in the browser. They run your installed `claude` with its own login and your
// settings, so the monitor's hooks report them like any other session. Personal use only: the
// login is yours (see PLAN.md, "Dashboard sessions").
import { query } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE = join(homedir(), '.local', 'bin', 'claude');
const START_TIMEOUT_MS = 60_000;

const userMessage = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });

// Prompts waiting to be sent: an async iterable that stays open between turns, which is what
// keeps an SDK session alive for follow-up messages.
class Inbox {
  #queue = [];
  #wake = null;
  #closed = false;

  push(text) { this.#queue.push(userMessage(text)); this.#wake?.(); }
  close() { this.#closed = true; this.#wake?.(); }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.#queue.length) yield this.#queue.shift();
      if (this.#closed) return;
      await new Promise((resolve) => { this.#wake = resolve; });
      this.#wake = null;
    }
  }
}

// The subprocess must use your Claude login: no API key, and none of the markers a parent
// Claude Code session sets (one of them turns off transcript saving).
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'ANTHROPIC_API_KEY' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  }
  return env;
}

export class DashboardSessions {
  #live = new Map(); // session id -> { q, inbox }
  owned = new Map(); // session id -> cwd, for every session started here (kept across restarts)
  lastAuth = null;   // where the last session's credential came from (SDK apiKeySource), e.g. 'none' = your login

  // decide(sessionId, toolName, input, signal) -> Promise<PermissionResult>: asks you in the page.
  // event(hookShapedEvent): a turn started or ended, reported like the hooks would, so status
  //   is right even without the hooks installed.
  // changed(): something about these sessions changed, so redraw.
  constructor({ decide, event, changed }) {
    this.decide = decide;
    this.event = event;
    this.changed = changed;
  }

  isLive(id) { return this.#live.has(id); }

  // Starts a session (or resumes one started here) and resolves with its session id once
  // Claude Code has started it.
  start({ cwd, prompt, resume = null }) {
    const inbox = new Inbox();
    inbox.push(prompt);
    let sessionId = resume;
    const q = query({
      prompt: inbox,
      options: {
        cwd,
        ...(resume ? { resume } : {}),
        pathToClaudeCodeExecutable: CLAUDE,
        settingSources: ['user', 'project', 'local'], // your hooks, rules and CLAUDE.md, as in a terminal
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        env: childEnv(),
        canUseTool: (tool, input, { signal }) => this.decide(sessionId, tool, input, signal),
      },
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Claude Code didn’t start within a minute'));
        q.close();
      }, START_TIMEOUT_MS);
      (async () => {
        try {
          for await (const m of q) {
            if (m.type === 'system' && m.subtype === 'init') {
              clearTimeout(timer);
              sessionId = m.session_id;
              this.lastAuth = m.apiKeySource ?? null;
              this.#live.set(sessionId, { q, inbox });
              this.owned.set(sessionId, cwd);
              this.event({ session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt });
              resolve(sessionId);
            } else if (m.type === 'result' && sessionId) {
              this.event({ session_id: sessionId, cwd, hook_event_name: 'Stop' });
            }
          }
        } catch (err) {
          console.error(`Dashboard session ${sessionId ?? '(starting)'} stopped:`, err.message);
          reject(err);
        } finally {
          clearTimeout(timer);
          if (sessionId) this.#live.delete(sessionId);
          this.changed();
          reject(new Error('The session ended before it started')); // no-op if already settled
        }
      })();
    });
  }

  // Sends a prompt. A session started here but no longer running (server restarted, or ended)
  // is resumed with it. Returns false for sessions not started here.
  async send(id, text) {
    const live = this.#live.get(id);
    if (live) {
      live.inbox.push(text);
      this.event({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: text });
      return true;
    }
    const cwd = this.owned.get(id);
    if (!cwd) return false;
    await this.start({ cwd, prompt: text, resume: id });
    return true;
  }

  async interrupt(id) {
    await this.#live.get(id)?.q.interrupt();
  }

  end(id) {
    const live = this.#live.get(id);
    if (!live) return;
    live.inbox.close();
    live.q.close();
    this.#live.delete(id);
    this.changed();
  }

  endAll() {
    for (const id of [...this.#live.keys()]) this.end(id);
  }
}
