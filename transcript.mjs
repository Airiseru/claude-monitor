// Reads a Claude Code session transcript (.jsonl). The format is internal and changes between
// Claude Code versions, so every field is optional and lines that don't fit are skipped.
import { describeTool, oneLine, EDIT_TOOLS } from './tools.mjs';

const MAX_DIFF = 4000;
const MAX_RESPONSE = 20_000;

// A subagent's own transcript marks every entry as a sidechain; pass { sidechain: true } to
// read one. A session's main transcript skips them.
export function parseTranscript(text, { sidechain = false } = {}) {
  const t = {
    title: null, lastPrompt: null, cwd: null, branch: null, model: null, contextTokens: null,
    startedAt: null, updatedAt: null, timeline: [], files: new Map(),
    lastResponse: null,  // Claude's reply to the last prompt: its text after the last tool call
    lastResponseAt: null,
    turnEnded: false,    // Claude finished replying to the last prompt
  };
  let customTitle = null, aiTitle = null;
  let reply = [];        // text blocks since the last prompt or tool call
  const toolItems = new Map(); // tool_use id -> timeline item

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || Boolean(e.isSidechain) !== sidechain) continue;

    if (e.timestamp) { t.startedAt ??= e.timestamp; t.updatedAt = e.timestamp; }
    if (e.cwd) t.cwd = e.cwd;
    if (e.gitBranch && e.gitBranch !== 'HEAD') t.branch = e.gitBranch; // HEAD: not a git repo, or detached
    if (e.type === 'custom-title' && e.customTitle) customTitle = e.customTitle;
    if (e.type === 'ai-title' && e.aiTitle) aiTitle = e.aiTitle;

    const m = e.message;
    if (!m || typeof m !== 'object') continue;

    if (e.type === 'user' && e.isCompactSummary) {
      t.timeline.push({ ts: e.timestamp, kind: 'note', text: 'Context compacted: earlier conversation summarized' });
    } else if (e.type === 'user' && !e.isMeta) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b?.type === 'text') {
          const p = classifyPrompt(b.text);
          if (p) {
            t.timeline.push({ ts: e.timestamp, ...p });
            if (p.kind === 'prompt') {
              t.lastPrompt = p.text;
              t.lastResponse = t.lastResponseAt = null;
              t.turnEnded = false;
              reply = [];
            }
          }
        } else if (b?.type === 'tool_result' && b.is_error) {
          const item = toolItems.get(b.tool_use_id);
          if (item) item.error = true;
        }
      }
    }

    if (e.type === 'assistant') {
      if (m.model && m.model !== '<synthetic>') t.model = m.model;
      const u = m.usage;
      if (u) t.contextTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      // A reply is split over several entries, one content block each, each with a stop_reason.
      if (m.stop_reason) t.turnEnded = m.stop_reason === 'end_turn';
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'text' && b.text?.trim()) {
          reply.push(b.text.trim());
          t.lastResponse = reply.join('\n\n').slice(0, MAX_RESPONSE);
          t.lastResponseAt = e.timestamp;
        }
        if (b?.type !== 'tool_use') continue;
        reply = []; // text before a tool call is narration, not the reply
        t.lastResponse = t.lastResponseAt = null;
        const input = b.input ?? {};
        const item = { ts: e.timestamp, kind: 'tool', id: b.id, tool: b.name, text: describeTool(b.name, input) };
        if (b.name === 'Bash' && input.command) item.command = String(input.command).slice(0, MAX_DIFF);
        t.timeline.push(item);
        toolItems.set(b.id, item);

        const path = input.file_path ?? input.notebook_path;
        if (EDIT_TOOLS.has(b.name) && path) {
          item.file = path;
          const f = t.files.get(path) ?? { path, edits: [] };
          f.edits.push({ ts: e.timestamp, tool: b.name, item, ...diffOf(b.name, input) });
          t.files.set(path, f);
        }
      }
    }
  }

  t.title = customTitle ?? aiTitle;
  // Edits whose tool call failed didn't change the file; mark them once all results are in.
  for (const f of t.files.values()) {
    for (const edit of f.edits) { edit.failed = Boolean(edit.item.error); delete edit.item; }
  }
  return t;
}

// Classifies a user message as it was typed:
//   { kind: 'prompt' }  - text for Claude, including a slash command with arguments
//   { kind: 'command' } - a bare slash command (/clear, /context) or a `!` shell command
//   null                - wrappers that aren't typed input (command output, task notices)
export function classifyPrompt(raw) {
  let s = String(raw ?? '');
  if (/^\s*<(local-command-|bash-std|task-notification|system-reminder)/.test(s)) return null;
  const cmd = s.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = oneLine(s.match(/<command-args>([^<]*)<\/command-args>/)?.[1], 2000);
    return args ? { kind: 'prompt', text: `${cmd[1]} ${args}` } : { kind: 'command', text: cmd[1] };
  }
  const bash = s.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return { kind: 'command', text: `! ${oneLine(bash[1], 2000)}` };
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return s ? { kind: 'prompt', text: s.slice(0, 4000) } : null;
}

function diffOf(tool, input) {
  const cut = (s) => (s == null ? null : String(s).slice(0, MAX_DIFF));
  switch (tool) {
    case 'Edit': return { before: cut(input.old_string), after: cut(input.new_string) };
    case 'MultiEdit': return {
      before: cut((input.edits ?? []).map((e) => e.old_string).join('\n…\n')),
      after: cut((input.edits ?? []).map((e) => e.new_string).join('\n…\n')),
    };
    case 'Write': return { before: null, after: cut(input.content) };
    case 'NotebookEdit': return { before: null, after: cut(input.new_source) };
    default: return { before: null, after: null };
  }
}
