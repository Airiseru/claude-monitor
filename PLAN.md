# Claude Monitor — plan

What's left to build, and the findings any future change has to respect. Everything already built is described in `README.md` and the git history.

## Ideas not built yet

1. **Jump to the exact Warp tab.** Today "Go to Warp" only brings Warp to the front. Warp's tab-control CLI (`warpctrl tab list` / `tab activate`) would do it, but it's switched off on Warp Stable: as of 2026-11-04, build 0.2026.10.14 has no Settings → Scripting page, and running the binary as `warpctrl` doesn't enter control mode. Revisit when Warp turns it on for Stable; matching a session to its tab needs the tab's folder or title from `tab list`.

## Findings and constraints

**Hooks (Claude Code 2.1.318)**
- Observer hooks must be `async` command hooks. In testing, another `UserPromptSubmit` hook hung for over a minute, and blocking hooks would add to that.
- The permission hook must be a blocking **`command`** hook (`curl` to `/permission`). A `type: "http"` hook was tried first, and Claude Code sometimes didn't send it at all.
- While the permission hook waits, the terminal shows its own prompt, and the first answer wins. The hook isn't told about a terminal answer, so held requests are released on that tool's `PostToolUse` / `PermissionDenied` (matching tool and input) or when the turn ends. `PreToolUse` and `Notification` can arrive after the request they belong to, so they must not release it.
- **Sandbox prompts** ("Network request outside of sandbox", commands outside the sandbox) don't fire `PermissionRequest`. They only arrive as `Notification` with `notification_type: permission_prompt`, so the page can flag them but not answer them.
- Most prompts never reach you: over 14 days, about 16 of roughly 4,100 permission decisions were yours, compared with 43 questions and 621 "finished, waiting" moments.

**Transcripts**
- A subagent's transcript is `<session>/subagents/agent-<id>.jsonl`, every entry marked as a sidechain, plus `agent-<id>.meta.json` with its type, description, `finished`, and the parent's Agent `toolUseId`. That id is how its work is attached to the parent's timeline.
- `~/.claude/projects/<dir>/<session>.jsonl` is an internal format that changes between versions. Only the detail view, titles, and Claude's reply depend on it, and the parser skips lines it doesn't understand. Status, context %, cost, and permissions come from hooks and the status line.
- A reply is split over several entries, one content block each, each carrying a `stop_reason`. The reply to a prompt is the text after the last tool call, and `end_turn` marks a finished turn.

**Sessions in tmux** (replaced Agent SDK sessions on 2026-11-05; see commit af5cc93 for how those worked)
- Sessions started from the page, and terminal sessions started through `bin/claude`, run real Claude Code in the monitor's own tmux server (socket `claude-monitor`, settings in `tmux.conf`), so your own tmux setup is untouched. You open one in Warp with `tmux -L claude-monitor attach -t <name>`; the page types messages into it.
- A pane is matched to its session through `~/.claude/sessions/<pid>.json`, which Claude Code writes with its session id; the pane's process is Claude Code itself. Page-started sessions get their id up front with `--session-id`.
- Messages go in as one bracketed paste, then Enter, so new lines don't submit early. The monitor then checks the screen: if the message is still in the input box (the last line starting with `❯`), it presses Enter once more, then reports a failure instead of "Sent". On 2026-11-05 one session ignored Enter twice and the cause wasn't found; it was the only one showing the wide "files changed" side panel.
- Sending is refused while the session needs you: typing into a menu or dialog would pick options in it. The Terminal tab shows the screen and has buttons for the keys menus need.
- A terminal can't take image data, so images are saved under `~/.claude-monitor/uploads/<session>/` and their paths go after the text, as when you drag an image into the terminal. Those paths show as "[n images]" in the page.
- A stopped session resumes on the next message in a new tmux session, with `--resume`. Never resume one a Claude Code process outside this tmux server still has open: both would write into one transcript.
- They're real terminal sessions, so the status line runs for them: context %, cost and usage limits come from it, as for any terminal session.
- Claude Code asks whether to trust a folder it hasn't seen before. The page shows that as needing you, answered in the Terminal tab.
- tmux sessions keep running when the server stops or restarts; the server finds them again.
- The Agent SDK is still used for the model list and signed-in account (`supportedModels()`, `accountInfo()`, from a process that's never sent a prompt and saves nothing; re-read after 5 minutes) and for rename (`renameSession`, one `custom-title` line, as `/rename` writes). Keep `@anthropic-ai/claude-agent-sdk` pinned to the installed CLI's version (0.3.318 ↔ 2.1.318), installed with `--omit=optional`.
- Spend per day (Insights) adds up how much each session's running total grew. The last total per session is kept in `state.json` for 30 days, so a restart or a resume doesn't count anything twice.

**Security**
- The server listens on 127.0.0.1 only and checks the `Host` header. Every page action (Allow/Deny, answers, new session, send, remove, Go to Warp) needs the per-run token and a same-origin `Origin`. Hook endpoints reject requests that carry an `Origin`.
- Each Allow answers one request only. No permission rules are ever written.
- Transcript and reply text goes into the page as text only. The Markdown renderer builds elements and never uses `innerHTML`.
