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

**Dashboard sessions (Agent SDK)**
- They run your installed `~/.local/bin/claude` with your Claude login. The monitor removes `ANTHROPIC_API_KEY` from their environment, and the page shows which credential the SDK reports. You chose this on 2026-11-04 for **personal use only**. Anthropic's terms say products built on the SDK should use an API key, so switch to one before sharing the monitor with anyone.
- Keep `@anthropic-ai/claude-agent-sdk` pinned to the version matching the installed CLI (0.3.318 ↔ 2.1.318). It's installed with `--omit=optional`, so the SDK uses the installed `claude` instead of a bundled copy.
- Never resume a session that's open in a terminal. Without forking, both write into one transcript. That's why only sessions started from the page take replies.
- A server restart stops their Claude processes. Your next message resumes them, with the model they were started on.
- The model list and the signed-in account (`supportedModels()`, `accountInfo()`) come from a Claude Code process that's never sent a prompt, loads no settings, and saves no transcript (no usage, no stray session). They're re-read after 5 minutes, so a `/login` account switch shows up.
- Dashboard sessions always use whatever account Claude Code is signed into on that Mac; the monitor has no login of its own.
- Rename writes one `custom-title` line to the transcript (the SDK's `renameSession`, as `/rename` does). It works for any session, Warp ones included.

**Security**
- The server listens on 127.0.0.1 only and checks the `Host` header. Every page action (Allow/Deny, answers, new session, send, remove, Go to Warp) needs the per-run token and a same-origin `Origin`. Hook endpoints reject requests that carry an `Origin`.
- Each Allow answers one request only. No permission rules are ever written.
- Transcript and reply text goes into the page as text only. The Markdown renderer builds elements and never uses `innerHTML`.
