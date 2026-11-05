// Claude Code sessions running in tmux, so they're real terminal sessions you can open in Warp
// (`tmux -L claude-monitor attach -t <name>`) and the monitor can also type messages into.
// They all run in the monitor's own tmux server (socket "claude-monitor", settings in
// tmux.conf), started either from the page or by bin/claude in a terminal.
//
// Which Claude session runs in which pane: Claude Code writes ~/.claude/sessions/<pid>.json
// with its session id, and a pane's process is Claude Code itself, so the pane's pid finds it.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SOCKET = process.env.CLAUDE_MONITOR_TMUX_SOCKET || 'claude-monitor'; // tests use their own
const TMUX_PATHS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
// CLAUDE_MONITOR_TMUX overrides where tmux is; set to an empty string, it means "not installed".
export const findTmux = () => process.env.CLAUDE_MONITOR_TMUX ?? TMUX_PATHS.find((p) => existsSync(p)) ?? null;

// Keys the page may press in a session's terminal (for Claude Code's menus and dialogs).
export const KEYS = {
  enter: 'Enter', escape: 'Escape', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  tab: 'Tab', 'shift-tab': 'BTab', 1: '1', 2: '2', 3: '3', 4: '4',
};

// Shown in the page while Claude Code asks whether to trust a folder it hasn't seen before.
const TRUST_PROMPT = /trust this folder/i;
const PASTE_SETTLE_MS = 250; // let Claude Code take in a paste before Enter submits it
const SUBMIT_CHECK_MS = 700;  // then how long it gets to clear its input box

// Whether a message is still in Claude Code's input box: the last line starting with the
// prompt mark (❯) is the box, and a submitted message only shows above it.
export function stillInPrompt(screenText, message) {
  const first = message.split('\n')[0].trim().slice(0, 40);
  const box = screenText.split('\n').findLast((l) => l.startsWith('❯'));
  return Boolean(first && box?.includes(first));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The environment for tmux and the Claude processes it starts: your login, not an API key,
// and none of the markers a parent Claude Code or tmux session sets.
export function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'ANTHROPIC_API_KEY' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'TMUX' || k === 'TMUX_PANE') delete env[k];
  }
  return env;
}

export class Terminals {
  #panes = new Map(); // session id -> { pane, pid, name, trust }: running in tmux right now
  // session id -> { cwd, model, here }: every session started here (here: true) or seen running
  // in this tmux server. Kept across restarts, so a message can resume one that has stopped.
  owned = new Map();

  // tmux: path to tmux (null: not installed). claude: path to Claude Code. home: where
  // ~/.claude is. conf: tmux.conf. changed(): which sessions are running, or a trust prompt, changed.
  constructor({ tmux = findTmux(), claude, home, conf, socket = SOCKET, shell = process.env.SHELL || '/bin/zsh', changed = () => {} }) {
    Object.assign(this, { tmux, claude, home, conf, socket, shell, changed });
  }

  get available() { return Boolean(this.tmux); }

  #run(args, input) {
    return new Promise((resolve, reject) => {
      const child = execFile(this.tmux, ['-L', this.socket, '-f', this.conf, ...args], { env: childEnv() }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message)); else resolve(stdout);
      });
      child.stdin.end(input ?? '');
    });
  }

  async #sessionOf(pid) {
    const info = await readFile(join(this.home, '.claude', 'sessions', `${pid}.json`), 'utf8').then(JSON.parse).catch(() => null);
    return typeof info?.sessionId === 'string' ? info : null;
  }

  // Re-reads which sessions are running in tmux. Called every couple of seconds.
  async refresh() {
    if (!this.tmux) return;
    const out = await this.#run(['list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{session_name}']).catch(() => ''); // no server: none
    const byPane = new Map([...this.#panes].map(([id, p]) => [p.pane, id]));
    const next = new Map();
    for (const line of out.split('\n').filter(Boolean)) {
      const [pane, pid, name] = line.split(' ');
      const info = await this.#sessionOf(pid);
      // Until Claude Code writes its session file (e.g. while it asks about trusting the
      // folder), a pane started here keeps the id it was started with.
      const id = info?.sessionId ?? byPane.get(pane);
      if (!id) continue;
      const trust = !info && TRUST_PROMPT.test(await this.#run(['capture-pane', '-p', '-t', pane]).catch(() => ''));
      next.set(id, { pane, pid: Number(pid), name, trust });
      if (!this.owned.has(id)) this.owned.set(id, { cwd: info?.cwd ?? null, model: null, here: false });
    }
    const key = (m) => JSON.stringify([...m].map(([id, p]) => [id, p.pane, p.trust]).sort());
    const changed = key(next) !== key(this.#panes);
    this.#panes = next;
    if (changed) this.changed();
  }

  isLive(id) { return this.#panes.has(id); }
  needsTrust(id) { return Boolean(this.#panes.get(id)?.trust); }
  attachCommand(id) {
    const p = this.#panes.get(id);
    return p ? `tmux -L ${this.socket} attach -t ${p.name}` : null;
  }

  // Whether a Claude Code process outside this tmux server has the session open (a Warp tab,
  // say). Such a session must never be resumed here too: both would write one transcript.
  async openElsewhere(id) {
    const dir = join(this.home, '.claude', 'sessions');
    for (const file of await readdir(dir).catch(() => [])) {
      if (!file.endsWith('.json')) continue;
      const pid = Number(file.slice(0, -5));
      const info = await this.#sessionOf(pid);
      if (info?.sessionId !== id || this.#panes.get(id)?.pid === pid) continue;
      try { process.kill(pid, 0); return true; } catch { /* not running: a leftover file */ }
    }
    return false;
  }

  // Starts Claude Code in a new tmux session, through your login shell so it has the PATH a
  // terminal would. A new session gets its id up front (--session-id, `id` or a fresh one);
  // resume picks one up again. The prompt, if any, is Claude Code's first prompt. Resolves with the session id.
  async start({ cwd, prompt = '', model = null, resume = null, id: newId = null }) {
    if (!this.tmux) throw new Error('tmux isn’t installed. Install it with: brew install tmux');
    const id = resume ?? newId ?? randomUUID();
    let name = `claude-${id.slice(0, 8)}`;
    if (await this.#run(['has-session', '-t', `=${name}`]).then(() => true, () => false)) name += `-${randomUUID().slice(0, 4)}`;
    const args = [
      ...(model ? ['--model', model] : []),
      ...(resume ? ['--resume', id] : ['--session-id', id]),
      ...(prompt ? ['--', prompt] : []),
    ];
    const out = await this.#run(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', '-P', '-F', '#{pane_id} #{pane_pid}',
      '--', this.shell, '-l', '-c', 'exec "$0" "$@"', this.claude, ...args]);
    const [pane, pid] = out.trim().split(' ');
    this.#panes.set(id, { pane, pid: Number(pid), name, trust: false });
    this.owned.set(id, { ...this.owned.get(id), cwd, model: model ?? this.owned.get(id)?.model ?? null, here: this.owned.get(id)?.here ?? !resume });
    this.changed();
    return id;
  }

  #pane(id) {
    const p = this.#panes.get(id);
    if (!p) throw new Error('This session isn’t running in tmux');
    return p.pane;
  }

  // Types a message into the session and submits it. It goes in as one paste (bracketed, so
  // its new lines don't submit early), as when you paste into the terminal.
  // Then checks it left the input box: if it's still there, Enter didn't reach the prompt, so
  // it presses Enter once more (harmless on an empty prompt) and throws if that fails too.
  async send(id, text) {
    const pane = this.#pane(id);
    const buffer = `monitor-${randomUUID().slice(0, 8)}`;
    await this.#run(['load-buffer', '-b', buffer, '-'], text);
    await this.#run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane]);
    for (let attempt = 0; attempt < 2; attempt++) {
      await sleep(PASTE_SETTLE_MS);
      await this.#run(['send-keys', '-t', pane, 'Enter']);
      await sleep(SUBMIT_CHECK_MS);
      if (!stillInPrompt(await this.#run(['capture-pane', '-p', '-t', pane]).catch(() => ''), text)) return;
    }
    throw new Error('Claude Code didn’t take the message: it’s still in the input box. Check the Terminal tab.');
  }

  async key(id, key) {
    if (!Object.hasOwn(KEYS, key)) throw new Error('Unknown key');
    await this.#run(['send-keys', '-t', this.#pane(id), KEYS[key]]);
  }

  // What the terminal shows right now, as text.
  async screen(id) {
    return (await this.#run(['capture-pane', '-p', '-t', this.#pane(id)])).replace(/\s+$/, '');
  }

  // Stops Claude Code by closing its pane.
  async end(id) {
    await this.#run(['kill-pane', '-t', this.#pane(id)]).catch(() => {});
    this.#panes.delete(id);
    this.changed();
  }
}
