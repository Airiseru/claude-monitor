// Reads a Claude Code session transcript (.jsonl). The format is internal and changes between
// Claude Code versions, so every field is optional and lines that don't fit are skipped.
import { open, stat } from 'node:fs/promises';
import { describeTool, oneLine, EDIT_TOOLS } from './tools.mjs';

const MAX_DIFF = 4000;
const MAX_RESPONSE = 20_000;

// A subagent's own transcript marks every entry as a sidechain; pass { sidechain: true } to
// read one. A session's main transcript skips them.
export function parseTranscript(text, options) {
  const reader = new TranscriptReader(options);
  reader.push(text);
  return reader.result();
}

// Follows a transcript file. Transcripts are append-only, so each read() parses only the bytes
// added since the last one; a line still being written (no newline yet) waits for the next
// read. A file that shrank or was replaced is read again from the start. Reads take turns, so
// the same bytes are never parsed twice.
export class TranscriptFile {
  #path;
  #options;
  #reader = null;
  #ino = null;
  #offset = 0;
  #seen = null;   // `${mtimeMs}|${size}` at the last read
  #data = null;
  #reading = Promise.resolve();

  constructor(path, options) { this.#path = path; this.#options = options; }

  // The result of the last read(), or null before the first one finishes. For callers that
  // can't wait, like building the session list.
  get latest() { return this.#data; }

  read() {
    const next = this.#reading.catch(() => {}).then(() => this.#readNew());
    this.#reading = next;
    return next;
  }

  async #readNew() {
    const st = await stat(this.#path);
    const seen = `${st.mtimeMs}|${st.size}`;
    if (this.#data && this.#seen === seen) return this.#data;
    if (!this.#reader || this.#ino !== st.ino || st.size < this.#offset) {
      this.#reader = new TranscriptReader(this.#options);
      this.#ino = st.ino;
      this.#offset = 0;
      this.#data = null;
    }
    if (st.size > this.#offset) {
      const file = await open(this.#path, 'r');
      try {
        const buf = Buffer.alloc(st.size - this.#offset);
        const { bytesRead } = await file.read(buf, 0, buf.length, this.#offset);
        const end = bytesRead ? buf.lastIndexOf(0x0a, bytesRead - 1) + 1 : 0; // just past the last complete line
        if (end > 0) {
          this.#reader.push(buf.toString('utf8', 0, end));
          this.#offset += end;
          this.#data = null;
        }
      } finally {
        await file.close();
      }
    }
    this.#data ??= this.#reader.result();
    this.#seen = seen;
    return this.#data;
  }
}

// Reads a transcript a piece at a time, so an append-only file can be followed without
// re-reading it: push() each new run of complete lines, then result() for the summary so far.
export class TranscriptReader {
  #sidechain;
  #t = {
    title: null, lastPrompt: null, cwd: null, branch: null, model: null, contextTokens: null,
    startedAt: null, updatedAt: null, timeline: [], files: new Map(),
    lastResponse: null,  // Claude's reply to the last prompt: its text after the last tool call
    lastResponseAt: null,
    turnEnded: false,    // Claude finished replying to the last prompt
    messages: [],        // the conversation: { role: 'user' | 'assistant', ts, text }
  };
  #customTitle = null;
  #aiTitle = null;
  #reply = [];           // text blocks since the last prompt or tool call
  #said = null;          // Claude's chat message still being added to (no tool call since)
  #toolItems = new Map(); // tool_use id -> timeline item

  constructor({ sidechain = false } = {}) { this.#sidechain = sidechain; }

  push(text) {
    for (const line of text.split('\n')) this.#line(line);
  }

  // The transcript read so far. Its timeline and messages are shared with the reader, so later
  // push() calls can still add to them; callers use a result right away and then drop it.
  result() {
    const t = this.#t;
    return {
      ...t,
      title: this.#customTitle ?? this.#aiTitle,
      // Edits whose tool call failed didn't change the file.
      files: new Map([...t.files].map(([path, f]) => [path, {
        path, edits: f.edits.map(({ item, ...edit }) => ({ ...edit, failed: Boolean(item.error) })),
      }])),
    };
  }

  #line(line) {
    const t = this.#t;
    const sidechain = this.#sidechain;
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (!e || typeof e !== 'object' || Boolean(e.isSidechain) !== sidechain) return;

    if (e.timestamp) { t.startedAt ??= e.timestamp; t.updatedAt = e.timestamp; }
    if (e.cwd) t.cwd = e.cwd;
    if (e.gitBranch && e.gitBranch !== 'HEAD') t.branch = e.gitBranch; // HEAD: not a git repo, or detached
    if (e.type === 'custom-title' && e.customTitle) this.#customTitle = e.customTitle;
    if (e.type === 'ai-title' && e.aiTitle) this.#aiTitle = e.aiTitle;

    const m = e.message;
    if (!m || typeof m !== 'object') return;

    if (e.type === 'user' && e.isCompactSummary) {
      t.timeline.push({ ts: e.timestamp, kind: 'note', text: 'Context compacted: earlier conversation summarized' });
    } else if (e.type === 'user' && !e.isMeta) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      const images = blocks.filter((b) => b?.type === 'image').length; // pasted or attached with the prompt
      let asked = null; // the prompt this entry adds to the chat, if any
      for (const b of blocks) {
        if (b?.type === 'text') {
          const p = classifyPrompt(b.text);
          if (p) {
            t.timeline.push({ ts: e.timestamp, ...p });
            if (p.kind === 'prompt') {
              t.messages.push(asked = { role: 'user', ts: e.timestamp, text: p.text });
              this.#said = null;
              t.lastPrompt = p.text;
              t.lastResponse = t.lastResponseAt = null;
              t.turnEnded = false;
              this.#reply = [];
            }
          }
        } else if (b?.type === 'tool_result' && b.is_error) {
          const item = this.#toolItems.get(b.tool_use_id);
          if (item) item.error = true;
        }
      }
      if (images && asked) asked.images = images;
      else if (images) { // images with no text
        const text = `[${images} image${images > 1 ? 's' : ''}]`;
        t.timeline.push({ ts: e.timestamp, kind: 'prompt', text });
        t.messages.push({ role: 'user', ts: e.timestamp, text: '', images });
        this.#said = null;
        t.lastPrompt = text;
        t.lastResponse = t.lastResponseAt = null;
        t.turnEnded = false;
        this.#reply = [];
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
          this.#reply.push(b.text.trim());
          if (this.#said) this.#said.text = `${this.#said.text}\n\n${b.text.trim()}`.slice(0, MAX_RESPONSE);
          else t.messages.push(this.#said = { role: 'assistant', ts: e.timestamp, text: b.text.trim().slice(0, MAX_RESPONSE) });
          t.lastResponse = this.#reply.join('\n\n').slice(0, MAX_RESPONSE);
          t.lastResponseAt = e.timestamp;
        }
        if (b?.type !== 'tool_use') continue;
        this.#reply = []; // text before a tool call is narration, not the reply
        this.#said = null;
        t.lastResponse = t.lastResponseAt = null;
        const input = b.input ?? {};
        const item = { ts: e.timestamp, kind: 'tool', id: b.id, tool: b.name, text: describeTool(b.name, input) };
        if (b.name === 'Bash' && input.command) item.command = String(input.command).slice(0, MAX_DIFF);
        t.timeline.push(item);
        this.#toolItems.set(b.id, item);

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
