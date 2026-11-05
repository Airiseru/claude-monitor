// Claude Code facts read through the Claude Agent SDK: the signed-in account, the models it
// offers, and renaming a session. Sessions themselves run in tmux (terminals.mjs).
import { query, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from './terminals.mjs';

export const CLAUDE = process.env.CLAUDE_MONITOR_CLAUDE ?? join(homedir(), '.local', 'bin', 'claude');

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
