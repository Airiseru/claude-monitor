// Adds the monitor's hooks and status line wrapper to ~/.claude/settings.json, after backing it
// up. `node install.mjs --uninstall` removes exactly those entries and restores the original
// status line. Existing hooks (caveman etc.) are never touched.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SETTINGS = join(homedir(), '.claude', 'settings.json');
const MONITOR_HOME = join(homedir(), '.claude-monitor');
const SAVED_STATUSLINE = join(MONITOR_HOME, 'original-statusline.json');
const MARK = 'claude-monitor'; // every command added here contains this; it's how uninstall finds them

// Observer hooks only: async, so they can't slow a session down, and curl gives up after 2 s.
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionDenied', 'Notification', 'Stop', 'SessionEnd'];
const HOOK_COMMAND = `curl -s -m 2 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4747/hook >/dev/null 2>&1; true # ${MARK}`;

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const isOurs = (group) => (group?.hooks ?? []).some((h) => String(h.command ?? '').includes(MARK));

function readSettings() {
  return existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
}

function writeSettings(settings) {
  const backup = `${SETTINGS}.bak-${MARK}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, backup);
  const tmp = `${SETTINGS}.tmp-${MARK}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, SETTINGS);
  if (existsSync(backup)) console.log(`Backed up settings to ${backup}`);
}

function install() {
  const settings = readSettings();
  settings.hooks ??= {};
  for (const event of EVENTS) {
    const groups = settings.hooks[event] ?? [];
    if (!groups.some(isOurs)) groups.push({ hooks: [{ type: 'command', command: HOOK_COMMAND, async: true }] });
    settings.hooks[event] = groups;
  }

  const current = settings.statusLine;
  if (!String(current?.command ?? '').includes(MARK)) {
    mkdirSync(MONITOR_HOME, { recursive: true });
    writeFileSync(SAVED_STATUSLINE, JSON.stringify(current ?? null, null, 2) + '\n');
    const wrapper = `${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dirname, 'statusline.mjs'))}`;
    settings.statusLine = {
      ...(current ?? {}),
      type: 'command',
      command: current?.command ? `${wrapper} ${shellQuote(current.command)}` : wrapper,
    };
  }

  writeSettings(settings);
  console.log(`Installed hooks for ${EVENTS.length} events and the status line wrapper.`);
  console.log('Running sessions pick this up automatically. Start the server with: npm start');
}

function uninstall() {
  const settings = readSettings();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;

  if (String(settings.statusLine?.command ?? '').includes(MARK)) {
    const original = existsSync(SAVED_STATUSLINE) ? JSON.parse(readFileSync(SAVED_STATUSLINE, 'utf8')) : null;
    if (original) settings.statusLine = original;
    else delete settings.statusLine;
    rmSync(SAVED_STATUSLINE, { force: true });
  }

  writeSettings(settings);
  console.log('Removed the monitor hooks and restored the original status line.');
}

if (process.argv.includes('--uninstall')) uninstall();
else install();
