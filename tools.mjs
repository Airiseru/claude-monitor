// One-line descriptions of tool calls, shared by live hook events and transcript timelines.
import { basename } from 'node:path';

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export const oneLine = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function questionText(input) {
  const q = input?.questions?.[0]?.question;
  return q ? oneLine(q, 500) : 'Asked you a question';
}

export function describeTool(name, input) {
  const i = input ?? {};
  const file = i.file_path ?? i.notebook_path;
  switch (name) {
    case 'Bash': return oneLine(i.description || i.command);
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return file ? `${name} ${basename(file)}` : name;
    case 'Grep': return `Search for ${oneLine(i.pattern)}`;
    case 'Glob': return `Find files ${oneLine(i.pattern)}`;
    case 'WebFetch': return `Fetch ${oneLine(i.url)}`;
    case 'WebSearch': return `Web search: ${oneLine(i.query)}`;
    case 'Agent': case 'Task': return `Agent: ${oneLine(i.description)}`;
    case 'AskUserQuestion': return questionText(i);
    default: return name;
  }
}
