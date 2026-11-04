// Phase 0 spike: logs every hook event, and holds PermissionRequest open until a
// decision file appears (or the wait runs out). Throwaway — not part of the app.
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const WAIT_MS = 45_000; // longer than the hook's 30 s timeout, so "no answer" tests the timeout
const decisionFile = join(dir, 'decision');
const log = (entry) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
log({ phase: 'received', input });

if (input.hook_event_name !== 'PermissionRequest') process.exit(0);

const started = Date.now();
while (Date.now() - started < WAIT_MS) {
  if (existsSync(decisionFile)) {
    const choice = readFileSync(decisionFile, 'utf8').trim();
    unlinkSync(decisionFile);
    log({ phase: 'decided', choice, waitedMs: Date.now() - started });
    if (choice === 'allow' || choice === 'deny') {
      const decision = choice === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied from the monitor spike' };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
    }
    process.exit(0); // "pass" (or anything else): no decision, terminal prompt takes over
  }
  await new Promise((r) => setTimeout(r, 500));
}
log({ phase: 'gave-up', waitedMs: Date.now() - started });
