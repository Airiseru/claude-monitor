// Runs the monitor server at login with macOS launchd, restarting it if it stops.
// `node service.mjs` installs and starts it; `node service.mjs --uninstall` stops and removes it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const LABEL = 'com.claude-monitor.server';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), '.claude-monitor', 'server.log');
const DOMAIN = `gui/${userInfo().uid}`;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(...args) {
  try {
    execFileSync('/bin/launchctl', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function install() {
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(homedir(), '.claude-monitor'), { recursive: true });
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(import.meta.dirname, 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(import.meta.dirname)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`);
  launchctl('bootout', `${DOMAIN}/${LABEL}`); // replace a previous install, if any
  if (!launchctl('bootstrap', DOMAIN, PLIST)) {
    console.error(`launchctl couldn't start ${LABEL}. Check ${LOG}.`);
    process.exit(1);
  }
  console.log('Claude Monitor now starts at login: http://localhost:4747');
  console.log(`Log: ${LOG}. Stop any \`npm start\` you have running; the service owns port 4747 now.`);
}

function uninstall() {
  const wasRunning = launchctl('bootout', `${DOMAIN}/${LABEL}`);
  const hadPlist = existsSync(PLIST);
  if (hadPlist) rmSync(PLIST);
  console.log(wasRunning || hadPlist ? 'Removed the login service. Use `npm start` to run the monitor by hand.' : 'Nothing to remove.');
}

if (process.argv.includes('--uninstall')) uninstall();
else install();
