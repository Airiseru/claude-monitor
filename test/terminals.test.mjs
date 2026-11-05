// Tests of terminals.mjs against a real tmux server (its own socket, killed afterwards), with
// a stand-in for Claude Code: a script that records its arguments and what's typed into it,
// and writes the ~/.claude/sessions/<pid>.json file Claude Code would. Skipped without tmux.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { findTmux, stillInPrompt, Terminals } from '../terminals.mjs';

const tmux = findTmux();
const root = mkdtempSync(join(tmpdir(), 'claude-monitor-tmux-'));
const home = join(root, 'home');
const work = join(root, 'work');
const log = join(root, 'log.txt');
const fake = join(root, 'claude');
const socket = `claude-monitor-test-${process.pid}`;
let changes = 0;
let terminals;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}
const logText = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };

before(() => {
  if (!tmux) return;
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  // The stand-in. A prompt of "TRUST" acts out Claude Code's folder-trust question: it shows
  // the question and writes no session file until answered.
  writeFileSync(fake, `#!/bin/bash
id=""
while [ $# -gt 0 ]; do
  case "$1" in --session-id|--resume) id="$2"; shift 2 ;; --model) shift 2 ;; --) shift; break ;; *) break ;; esac
done
printf 'START %s %s\\n' "$id" "$*" >> "$FAKE_LOG"
if [ "$1" = TRUST ]; then echo "Is this a project you trust? Yes, I trust this folder"; read -r answer; fi
mkdir -p "$FAKE_HOME/.claude/sessions"
printf '{"sessionId":"%s","cwd":"%s"}' "$id" "$PWD" > "$FAKE_HOME/.claude/sessions/$$.json"
printf '\\e[?2004h'   # bracketed paste on, as Claude Code has it
stty -echo
exec cat >> "$FAKE_LOG"
`);
  chmodSync(fake, 0o755);
  process.env.FAKE_HOME = home;
  process.env.FAKE_LOG = log;
  terminals = new Terminals({ tmux, claude: fake, home, conf: join(import.meta.dirname, '..', 'tmux.conf'), socket, shell: '/bin/sh', changed: () => { changes++; } });
});

after(() => {
  if (tmux) { try { execFileSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ } }
  rmSync(root, { recursive: true, force: true });
});

test('starts Claude Code in tmux with its session id, model and first prompt', { skip: !tmux && 'tmux not installed' }, async () => {
  const id = await terminals.start({ cwd: work, prompt: '-starts with a dash', model: 'haiku' });
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.ok(terminals.isLive(id));
  assert.equal(terminals.attachCommand(id), `tmux -L ${socket} attach -t claude-${id.slice(0, 8)}`);
  assert.deepEqual(terminals.owned.get(id), { cwd: work, model: 'haiku', here: true });
  await waitFor(() => logText().includes(`START ${id} -starts with a dash`), 'the first prompt, as one argument');
  await terminals.refresh(); // finds it again through its session file
  assert.ok(terminals.isLive(id));
  assert.ok(changes > 0);
  await terminals.end(id);
});

test('a message goes in as one bracketed paste, then Enter', { skip: !tmux && 'tmux not installed' }, async () => {
  const id = await terminals.start({ cwd: work });
  await waitFor(() => logText().includes(`START ${id}`), 'start');
  await sleep(200);
  await terminals.send(id, 'line one\nline two');
  await waitFor(() => logText().includes('\x1b[201~'), 'the end of the paste');
  const text = logText();
  assert.match(text, /\x1b\[200~line one\nline two\x1b\[201~\n/);
  await terminals.key(id, 'escape');
  await assert.rejects(terminals.key(id, 'C-c'), /Unknown key/);
  assert.equal(typeof await terminals.screen(id), 'string');
  await terminals.end(id);
  assert.ok(!terminals.isLive(id));
  await assert.rejects(terminals.send(id, 'hi'), /isn’t running/);
});

test('notices the folder-trust question, and a session that stopped', { skip: !tmux && 'tmux not installed' }, async () => {
  const id = await terminals.start({ cwd: work, prompt: 'TRUST' });
  await waitFor(async () => { await terminals.refresh(); return terminals.needsTrust(id); }, 'the trust question');
  await terminals.key(id, 'enter');
  await waitFor(async () => { await terminals.refresh(); return !terminals.needsTrust(id) && terminals.isLive(id); }, 'trust answered');
  // Stopped from outside (its tmux session closed): gone at the next refresh.
  execFileSync(tmux, ['-L', socket, 'kill-session', '-t', `claude-${id.slice(0, 8)}`]);
  await terminals.refresh();
  assert.ok(!terminals.isLive(id));
});

test('resumes with --resume, and knows when a session is open elsewhere', { skip: !tmux && 'tmux not installed' }, async () => {
  const id = await terminals.start({ cwd: work, prompt: 'first' });
  await terminals.end(id);
  await terminals.start({ cwd: work, prompt: 'again', resume: id });
  await waitFor(() => logText().includes(`START ${id} again`), 'resume');
  assert.equal(terminals.owned.get(id).here, true, 'still counts as started here');
  await terminals.end(id);

  const sessions = join(home, '.claude', 'sessions');
  writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ sessionId: 'open-in-warp' })); // a running process
  writeFileSync(join(sessions, '999999.json'), JSON.stringify({ sessionId: 'long-gone' }));          // a leftover file
  assert.equal(await terminals.openElsewhere('open-in-warp'), true);
  assert.equal(await terminals.openElsewhere('long-gone'), false);
});

test('a message counts as sent once it has left Claude Code’s input box', () => {
  const box = (input) => `❯ Say hi\n⏺ Hi\n────────\n❯ ${input}\n────────\n  Haiku · ctx 5%`;
  assert.equal(stillInPrompt(box('Say bye\n  /tmp/a.png'), 'Say bye\n/tmp/a.png'), true);
  assert.equal(stillInPrompt(box(''), 'Say bye'), false);
  assert.equal(stillInPrompt(box(''), 'Say hi'), false, 'the same text earlier in the conversation doesn’t count');
});
