# Claude Monitor

A local dashboard for your running Claude Code sessions: which ones need you, what each is doing, how much context it has used, and the files and commands it touched. See `PLAN.md` for the design and phases.

Needs Node 22+. No dependencies.

```
npm run hooks:install     # adds hooks + status line wrapper to ~/.claude/settings.json (backs it up first)
npm start                 # http://localhost:4747
npm run hooks:uninstall   # removes exactly what install added, restores your status line
npm test
```

- Hooks run in the background and give up after 2 s, so a stopped server never slows a session.
- Running sessions pick up the hooks without a restart. Sessions from the last 24 hours show from their transcripts, as "no live activity" until their next event.
- State lives in memory plus `~/.claude-monitor/` (status line snapshots). Nothing leaves your machine; the server listens on 127.0.0.1 only.
- `spike/` is the Phase 0 throwaway test and can be deleted.
