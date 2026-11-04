# Claude Monitor — plan

A local web page that shows every running Claude Code session at a glance, puts the ones that need you at the top, lets you answer permission prompts with a click, and brings Warp to the front (showing which tab) for anything that needs typing.

Status: plan only, nothing built. Written 2026-11-04 against Claude Code 2.1.318, Node 24.

## Scope

In:
- Session list: title, project folder, git branch, status (working / needs you / idle / ended), context used %, last activity
- "Needs you" queue: permission prompts with **Allow** / **Deny**; questions and idle sessions with **Go to tab**
- Session detail: latest prompt, what it's doing now, timeline of edits and commands, files touched with diffs

Out (for now): typing prompts or answers from the browser, starting or stopping sessions, "always allow" rules, history beyond what the transcripts keep (30 days by default).

## Data sources

| Need | Source | Notes |
|---|---|---|
| Live status | Hooks: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd` | `Notification.notification_type` separates `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input` |
| Permission clicks | `PermissionRequest` hook | Returns `hookSpecificOutput.decision.behavior` = `allow` / `deny`. Deny rules in settings still win |
| Context % | Status line JSON, `context_window.used_percentage` | Supported field. Can be null right after `/compact` |
| Title, timeline, files, diffs | Transcript `~/.claude/projects/<dir>/<session>.jsonl` (path comes in every hook as `transcript_path`) | **Undocumented format that changes between versions.** Kept in one parser module that skips unknown lines |
| Go to tab | `open -a Warp`, plus the session's tab title and folder on the card | Warp can't be told to switch to a specific tab (see Risks), so you click the tab yourself |

## How it fits together

```
claude sessions ──hooks (http POST)──▶ server (127.0.0.1:4747) ──SSE──▶ browser page
      │                                   ▲  │
      └─status line wrapper─▶ status/<id>.json  └─ open -a Warp (go to tab)
      └─transcript .jsonl ◀── read on demand ─┘
```

- **Server:** one Node process using only built-in modules (`http`, `fs`, `child_process`). No framework, no build step. State lives in memory and is rebuilt from recent transcripts when the server starts.
- **Page:** one HTML file with plain JS, updated live over Server-Sent Events.
- **Hooks:** observer hooks are `command` hooks with `async: true` that `curl` the event to the server (2 s limit). Async means they can never slow a session, which matters given the hanging hook seen in Phase 0. Phase 2's `PermissionRequest` hook is a blocking `command` hook (`curl` to `/permission`, printing the server's decision). A `type: "http"` hook was tried first, but Claude Code 2.1.318 sometimes didn't send it at all. All of these are added **next to** the existing caveman hooks. If the server is down they fail quietly and Claude carries on as normal.
- **Status line:** a small wrapper saves the stdin JSON to `~/.claude-monitor/status/<session_id>.json`, then pipes the same JSON into the existing `python3 ~/.claude/statusline.py`, so your status line looks the same as now.

## Permission clicks (the delicate part)

1. A session asks for permission, the `PermissionRequest` hook POSTs it to the server, and the server holds the request open.
2. If no dashboard tab is open, the server replies immediately with an empty body. Nothing changes for the session.
3. If a dashboard is open, the prompt appears in "Needs you". **Allow** or **Deny** is sent back as the hook's response. The terminal shows its normal prompt the whole time, so you can answer in either place and the first answer wins.
4. The hook isn't told when you answer in the terminal. The server drops the pending item when that session's next event arrives (`PostToolUse`, `PermissionDenied`, `Stop`, `UserPromptSubmit`) or when the hook's connection closes. Allow and Deny on a dropped item do nothing.
5. The wait can be long (the hook timeout is set to 10 min), because the terminal prompt never disappears.

**What this covers:** only the classic prompts (WebFetch, edits outside allowed folders, tools without a rule). Your last 14 days had about 16 of these. **Sandbox prompts** ("Network request outside of sandbox", commands that need to run outside the sandbox) don't fire `PermissionRequest`. They arrive as `Notification` with `notification_type: permission_prompt`, so the dashboard lists them in "Needs you" with **Go to tab** but can't answer them.

### Phase 0 results (2026-11-04, Claude Code 2.1.318)

Ran a throwaway session against a spike settings file (since deleted) with WebFetch prompts:
- Allow: fetch ran, and the terminal said "Allowed by PermissionRequest".
- Deny: blocked, and Claude received the deny message.
- No decision: the terminal prompt stayed up and accepted terminal input.
- Terminal answer while the hook was still waiting: the tool ran right away, and the hook kept running in the background.
- The terminal prompt shows about 6 s after `PermissionRequest`, together with `Notification(permission_prompt)`.
- **Not verified:** the hook timing out. My script's next prompt answered the leftover dialog, so that round never made its own request. Verified in Phase 2 (below).

### Phase 2 results (2026-11-04)

Ran a live session against a test server (wait shortened to 20 s), with an open dashboard connection:
1. Allow from the dashboard: the terminal said "Allowed by PermissionRequest hook".
2. Deny: Claude received "Denied from Claude Monitor".
3. Answered in the terminal: the held request was released within about 3 s, the session went back to waiting, and a late dashboard click got 409.
4. No click before the wait ran out: the server answered with no decision, and the terminal prompt still worked.
5. Server stopped: the terminal prompt worked as normal, with no hook error shown.
- Side finding: in one run, another `UserPromptSubmit` hook (not the spike's) hung for over a minute. The monitor's observer hooks must be async so they never add to that.

## Security

- Listens on `127.0.0.1` only.
- Allow and Deny need a random per-run token that is embedded in the page, plus a matching `Origin` / `Host` check, so another website open in your browser can't approve tool calls through localhost.
- Each click answers one request only. No permission rules are ever written.
- `npm run hooks:install` backs up `~/.claude/settings.json` before adding the hooks and status line wrapper. `npm run hooks:uninstall` removes exactly those entries. You run both yourself; Claude's sandbox can't write that file, which is correct.

## Phases

Each phase is checked end to end before the next one starts.

0. **Spike. Done 2026-11-04,** results above.
1. **Read-only monitor. Done 2026-11-04,** confirmed by you. Server, observer hooks, status line wrapper, transcript parser, session list and detail. Check: open 2–3 sessions in Warp and confirm the statuses, context %, and file lists match what the terminals show.
2. **Needs you + Allow/Deny. Done 2026-11-04,** confirmed by you. Check: trigger WebFetch prompts in one session. Approve one from the browser, deny one, answer one in the terminal (it must leave "Needs you"), and let one time out. Trigger a sandbox prompt and confirm it shows as "Needs you" with no Allow/Deny buttons. Close the dashboard and confirm prompts behave exactly as before.
3. **Go to tab. Built 2026-11-04,** pending your check. The **Go to Warp** button runs `open -a Warp`, and the card shows the session's title and folder so you can pick the tab. Check: with 3 sessions open, each card's title and folder match its Warp tab.

### Added after the plan (2026-11-04, pending your check)

- **Claude's reply** to the last prompt (its text after the last tool call), in the detail view and on cards that aren't working.
- **Remove sessions** from the list: × on a card, **Clear** on a section, or **Remove from list** in the detail view. A removed session comes back on its next event.
- **Hide/show the sidebar,** remembered per browser. While hidden, the button shows how many sessions need you.
- **Desktop notifications** when a session needs you or finishes a turn, only while the dashboard isn't focused.
- **State kept across restarts** in `~/.claude-monitor/state.json`. A turn that finished while the server was down shows as waiting.
- **Login service** (`npm run service:install`, launchd), restarting the server if it stops.
- The `spike/` folder is deleted.

## Risks

- The transcript format can change with any Claude Code update. Only the detail view depends on it; status, context %, and permissions use supported hooks and status line fields.
- The status line refreshes only when the session updates, so context % on an idle session is the last known value.
- "Go to tab" can't switch to the exact tab. Warp has no AppleScript support, and its tab control CLI (`warpctrl`) is switched off on Stable: as of 2026-11-04, build 0.2026.10.14 shows no Settings → Scripting page, and running the binary as `warpctrl` doesn't enter control mode. If Warp turns it on later, `warpctrl tab activate` could make the button jump straight to the tab.
- Running alongside the caveman hooks: order and timing between the two are untested and get checked in Phase 1.
