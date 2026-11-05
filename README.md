# Claude Monitor

A local dashboard for your Claude Code sessions: which ones need you, what each is doing, Claude's latest reply, context used and cost, and the files and commands it touched. You can answer permission prompts and Claude's questions from the page, and start sessions there (picking the folder and model) that you reply to from the browser. Those sessions run in tmux, so you can also open them in Warp. Search and filter the list, rename sessions, and see what each subagent did. You can send them images too (paste or drop them into the message box). **Insights** in the header opens a popup listing sessions that look stuck or are near a full context window, and what you've spent per day at API prices. See `PLAN.md` for what's next and the constraints behind the design.

Needs Node 22+ and tmux (`brew install tmux`). One dependency, the Claude Agent SDK, for the model list, account and rename:

```
npm install --omit=optional    # uses your installed ~/.local/bin/claude instead of a bundled copy
```

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
- Sessions started from the page run your installed `claude` with your Claude login in the monitor's own tmux server. The page shows each one's attach command (`tmux -L claude-monitor attach -t <name>`) to open it in Warp; Ctrl-b d leaves it running.
- To make sessions you start in Warp take messages from the page too, add `alias claude="$HOME/Documents/claude-monitor/bin/claude"` to `~/.zshrc`. It runs `claude` inside that tmux server and looks the same; scripts, `-p`, `--help` and subcommands run plain `claude`. Other Warp sessions stay monitor-only.
