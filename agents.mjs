// Sessions started from the dashboard, run through the Claude Agent SDK so prompts and replies
// can be typed in the browser. They run your installed `claude` with its own login and your
// settings, so the monitor's hooks report them like any other session. Personal use only: the
// login is yours (see PLAN.md, "Dashboard sessions").
import { query, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE = join(homedir(), '.local', 'bin', 'claude');
const START_TIMEOUT_MS = 60_000;

// A prompt: text, plus any images ({ mediaType, data: base64 }) placed before it, as when you
// paste them in the terminal.
export function promptContent(text, images = []) {
  if (!images.length) return text;
  return [
    ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
    ...(text ? [{ type: 'text', text }] : []),
  ];
}
const userMessage = (content) => ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });

// Prompts waiting to be sent: an async iterable that stays open between turns, which is what
// keeps an SDK session alive for follow-up messages.
class Inbox {
  #queue = [];
  #wake = null;
  #closed = false;

  push(content) { this.#queue.push(userMessage(content)); this.#wake?.(); }
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

// The account Claude Code is signed into and the models it offers. Read from a Claude Code
// process that's never sent a prompt (no usage), loads no settings or hooks, and saves nothing.
// Re-read after a few minutes, so switching accounts with /login shows up.
const INFO_MAX_AGE_MS = 5 * 60_000;
let info = null; // { at, value: Promise<{ account, models }> }, shared by every caller
export function claudeInfo() {
  if (info && Date.now() - info.at < INFO_MAX_AGE_MS) return info.value;
  const value = (async () => {
    async function* noPrompt() { await new Promise(() => {}); }
    const q = query({
      prompt: noPrompt(),
      options: { pathToClaudeCodeExecutable: CLAUDE, settingSources: [], persistSession: false, env: childEnv(), cwd: homedir() },
    });
    try {
      const [account, models] = await Promise.all([q.accountInfo(), q.supportedModels()]);
      return {
        account: { email: account.email ?? null, organization: account.organization ?? null, plan: account.subscriptionType ?? null, apiKeySource: account.apiKeySource ?? null },
        models: models.map(({ value: v, displayName, description }) => ({ value: v, displayName, description })),
      };
    } finally {
      q.close();
    }
  })();
  info = { at: Date.now(), value };
  value.catch(() => { if (info?.value === value) info = null; }); // try again next time
  return value;
}

// Sets a session's title, as /rename does: one custom-title line appended to its transcript.
// No call to Claude.
export const setSessionTitle = (sessionId, title) => renameSession(sessionId, title);

// How a prompt shows in the session list until the transcript has it.
function promptText(text, images) {
  const note = images.length ? `[${images.length} image${images.length > 1 ? 's' : ''}]` : '';
  return [note, text].filter(Boolean).join(' ');
}

export class DashboardSessions {
  #live = new Map(); // session id -> { q, inbox }
  // session id -> { cwd, model, contextWindow, costUsd }, for every session started here (kept
  // across restarts). These sessions have no terminal, so no status line reports their context
  // and cost; both come from the SDK's result message instead.
  owned = new Map();
  lastAuth = null;   // where the last session's credential came from (SDK apiKeySource), e.g. 'none' = your login

  // decide(sessionId, toolName, input, signal) -> Promise<PermissionResult>: asks you in the page.
  // event(hookShapedEvent): a turn started or ended, reported like the hooks would, so status
  //   is right even without the hooks installed.
  // changed(): something about these sessions changed, so redraw.
  // cost(sessionId, usd): the session's running cost total, after each turn.
  constructor({ decide, event, changed, cost = () => {} }) {
    this.decide = decide;
    this.event = event;
    this.changed = changed;
    this.cost = cost;
  }

  isLive(id) { return this.#live.has(id); }

  // Starts a session (or resumes one started here) and resolves with its session id once
  // Claude Code has started it. model: a value from listModels(); null or 'default' = your default.
  start({ cwd, prompt, images = [], resume = null, model = null }) {
    const inbox = new Inbox();
    inbox.push(promptContent(prompt, images));
    let mainModel = null;
    let sessionId = resume;
    const q = query({
      prompt: inbox,
      options: {
        cwd,
        ...(resume ? { resume } : {}),
        ...(model && model !== 'default' ? { model } : {}),
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
              mainModel = m.model ?? null;
              this.#live.set(sessionId, { q, inbox });
              this.owned.set(sessionId, { ...this.owned.get(sessionId), cwd, model });
              this.event({ session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt: promptText(prompt, images) });
              resolve(sessionId);
            } else if (m.type === 'result' && sessionId) {
              this.#usage(sessionId, m, mainModel);
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

  // The context window of the session's model, and its running cost. modelUsage also lists
  // helper models (e.g. a small model for titles); the session's own model is the one to use.
  // A result from a crash can carry zeros, which aren't a real total.
  #usage(id, m, mainModel) {
    const usage = m.modelUsage ?? {};
    const main = usage[mainModel] ?? Object.values(usage).sort((a, b) => b.contextWindow - a.contextWindow)[0];
    const entry = this.owned.get(id);
    if (!entry) return;
    if (main?.contextWindow) entry.contextWindow = main.contextWindow;
    if (m.total_cost_usd > 0) {
      entry.costUsd = m.total_cost_usd;
      this.cost(id, m.total_cost_usd);
    }
  }

  // Sends a prompt, with any images. A session started here but no longer running (server
  // restarted, or ended) is resumed with it. Returns false for sessions not started here.
  async send(id, text, images = []) {
    const live = this.#live.get(id);
    if (live) {
      live.inbox.push(promptContent(text, images));
      this.event({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: promptText(text, images) });
      return true;
    }
    const owned = this.owned.get(id);
    if (!owned) return false;
    await this.start({ cwd: owned.cwd, model: owned.model, prompt: text, images, resume: id });
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
