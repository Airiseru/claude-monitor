// Runs the monitor server at login with macOS launchd, restarting it if it stops.
//   node service.mjs              install and start (also starts at every login)
//   node service.mjs --uninstall  stop and remove: no more starting at login
//   node service.mjs --stop       stop until the next login or --start
//   node service.mjs --start      start again after --stop
//   node service.mjs --restart    restart, e.g. after updating the monitor's code
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

const isRunning = () => launchctl('print', `${DOMAIN}/${LABEL}`);

function requireInstalled() {
  if (existsSync(PLIST)) return;
  console.error('The login service isn’t installed. Run `npm run service:install` first, or use `npm start`.');
  process.exit(1);
}

function stop() {
  requireInstalled();
  console.log(launchctl('bootout', `${DOMAIN}/${LABEL}`)
    ? 'Stopped. It starts again at your next login, or with `npm run service:start`.'
    : 'It wasn’t running.');
}

function start() {
  requireInstalled();
  if (isRunning()) return console.log('Already running: http://localhost:4747');
  if (!launchctl('bootstrap', DOMAIN, PLIST)) {
    console.error(`Couldn’t start it. Check ${LOG}.`);
    process.exit(1);
  }
  console.log('Started: http://localhost:4747');
}

function restart() {
  requireInstalled();
  if (!isRunning()) return start();
  if (!launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`)) {
    console.error(`Couldn’t restart it. Check ${LOG}.`);
    process.exit(1);
  }
  console.log('Restarted: http://localhost:4747');
}

const command = { '--uninstall': uninstall, '--stop': stop, '--start': start, '--restart': restart }[process.argv[2]];
(command ?? install)();
