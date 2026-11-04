// Status line wrapper: saves the status JSON Claude Code sends (context %, model) for the
// monitor, then passes the same JSON to your original status line command, so the terminal
// looks unchanged. Usage (set by install.mjs): node statusline.mjs '<original command>'
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(process.env.CLAUDE_MONITOR_HOME ?? join(homedir(), '.claude-monitor'), 'status');
const original = process.argv[2];

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const { session_id: id } = JSON.parse(raw);
  if (typeof id === 'string' && /^[\w-]+$/.test(id)) {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${id}.json.tmp`);
    writeFileSync(tmp, raw);
    renameSync(tmp, join(dir, `${id}.json`)); // atomic, so the server never reads half a file
  }
} catch {
  // Never let the monitor break the status line.
}

if (original) {
  const child = spawn(original, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(raw);
  child.on('exit', (code) => process.exit(code ?? 0));
}
