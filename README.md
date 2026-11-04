# Claude Monitor

A local dashboard for your running Claude Code sessions: which ones need you, what each is doing, Claude's latest reply, how much context it has used, and the files and commands it touched. You can answer permission prompts from the page. See `PLAN.md` for the design and test results.

Needs Node 22+. No dependencies.

```
npm run hooks:install       # adds hooks + status line wrapper to ~/.claude/settings.json (backs it up first)
npm run service:install     # starts the server now and at every login: http://localhost:4747
npm test

npm run service:stop        # stop until the next login (or service:start)
npm run service:start       # start again after stopping
npm run service:restart     # restart, e.g. after updating the monitor's code
npm run service:uninstall   # stop for good: no more starting at login

npm start                   # or run the server by hand instead of the login service
npm run hooks:uninstall     # removes exactly what hooks:install added, restores your status line
```

- Observer hooks run in the background and give up after 2 s, so a stopped server never slows a session. The permission hook waits for a click only while a dashboard tab is open; the terminal prompt stays usable the whole time.
- Running sessions pick up the hooks without a restart.
- State lives in `~/.claude-monitor/`: status line snapshots, `state.json` (live statuses and removed sessions, kept across restarts), and `server.log` when run as a service. The server listens on 127.0.0.1 only.
- The login service runs the Node at the path you installed it with. If you switch Node versions (nvm), run `npm run service:install` again.
- "Go to Warp" brings Warp to the front; Warp can't be told to switch to a specific tab from outside.
