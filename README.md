# aie-studio

A browser-based workbench for driving AI coding agents (Claude Code, Devin CLI) on a remote machine. Open it from a phone or laptop, pick a project directory, and chat with the agent while browsing and previewing the files it touches.

## Features

- **Agent tabs** — run multiple Claude Code / Devin sessions side by side, each pinned to a project directory; resume previous sessions
- **`!` shell commands** — `!cmd` in a Claude (SDK) chat runs a shell command in the project directory; Claude sees its output with your next message, like Claude Code's bash mode. Obviously destructive commands are refused (see *Shell guard*)
- **Side panel & Changes** — the right-hand column is a workspace with its own tabs, "+" (or ⌥T) for a new tab, Maximize (cover the chat area) and Collapse; on phones it is a drawer. **Changes** shows what a checkout changed since its branch left the main branch — commits, uncommitted edits and new files — or only what is uncommitted, file by file with line numbers, refreshing itself every few seconds while visible. By default it follows the session you are in, including a child session's worktree; the "+" launcher lists the project and every worktree with branch, commits and uncommitted count. Select diff lines to add them to the chat with the file and line span. Under the branch line, the branch's **pull request** (via the server's `gh` login): state, review, conflicts and CI checks counted by outcome — click for each check with a link to its run; failed checks open the list by themselves. Review (when on) is one of its tabs
- **Automations** — project menu → ⏱ Automations (or ⌘K "Automations"): "when <trigger>, do <action>". Triggers: a schedule (cron, in the server's time; presets for every hour / every day / weekdays) or a webhook (a secret URL — POST JSON or text to it; a new URL on demand). Actions: start a new Claude session in a project with the prompt (model and its own worktree optional), or write the prompt into an existing session. `{{date}}` and `{{body}}` (the webhook's body) fill in. Runs are ordinary sessions ("⏱ name · date" in Sessions, alerts and push when they end); the dialog has Run now and the recent runs, each opening its session. Missed schedules are not made up after a restart; a webhook called again within 5 s gets 429. `AIE_AUTOMATIONS=off` stops the scheduler
- **Plan strip** — when the agent keeps a task list (Claude's `TodoWrite` / `TaskCreate` / `TaskUpdate`, Devin's plan), a line above the chat shows progress and the step in progress, however far the chat has scrolled; tap it for the whole list. It survives a reload, even when the list was written long before the part of the chat that is loaded. Recent claude CLIs leave the task-list tools off; aie-studio turns them on for the Claude sessions it starts (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`), switchable in Settings → Claude → Task list
- **Sending while Claude works** — in a Claude (SDK) session, Send during a turn puts the message into the running turn (Claude reads it at its next step). The ▾ next to Send offers two more: **Interrupt and send** stops what Claude is doing right away, even mid-command, and sends the message as soon as it has stopped; **Send after this turn** puts it in a queue above the input, where you can edit it, drop it (×) or send it now, and everything queued goes out as one message when the turn ends. The queue is kept by the server, so it still goes out with the page closed, survives a reload and shows on every device. A question or form Claude is waiting on still takes what you type as the answer
- **Command palette** — ⌘K / Ctrl+K (or ⌕ in the tab bar, on phones too) searches every session of every project, archived ones included, plus the projects and a few actions (new Claude / Devin session, side panel, settings); Enter opens it, switching project if needed. ⌥J / ⌥K move to the next / previous tab
- **File browser & viewer** — tree view of the project, preview of text, Markdown, images, PDFs
- **Sessions** — one sidebar view for every session, newest first; sessions open in a tab are marked, and opening or closing a tab never moves a row; search, filter, archive. The ◔ button switches from one section per project to one group per status across every project — Needs you, Working, Ready to review, Other — each row naming its project
- **Subagent tree** — a Claude session that spawned subagents (its Agent tool) gets a caret and a `⑂ 2/3` badge in the Sessions list; expand it to see each subagent with its status, click one to follow its conversation live in a read-only tab, and stop a running one without stopping the session.
- **Child sessions** — "New child session" on a Claude session's menu starts a full Claude session filed under it in the Sessions tree (next to its subagents): its own process, prompt and model, so you can talk to it directly. Deleting the parent leaves its children as ordinary sessions. Claude can open them too: every Claude (SDK) session has `spawn_child_session` / `send_to_child_session` / `list_child_sessions` tools, and a child's answer is delivered back into the parent's conversation (waking the parent if it isn't running). When you type into a child that Claude opened, the parent is told what you said along with the child's answer, so it can adjust its plan. The parent can stop a child (`stop_child_session`); stopping one child yourself tells its parent, "Stop with child sessions" stops the whole tree quietly, and a child cut off by a server crash is reported as interrupted on the next start. A child can work in its own git worktree and branch (`.claude/worktrees/<name>`, branch `child/<name>`) so parallel edits don't collide: Claude asks for it with `isolation: "worktree"`, you with "New child session in a worktree"; the child's report says what to merge, and deleting the child removes the worktree when nothing would be lost. A child starts with context: one you open gets a summary of its parent ("Includes context from parent", previewable, removable with ×) sent with your first message; one Claude opens gets a `background` Claude writes for it. Claude can ask to hear from several children at once (`wait_for_child_sessions`: one message when the last finishes) and label a batch with `group`, which the tree shows as one node with a done/total count. Switch the tools off in Settings → Features → Child sessions.
- **Push notifications** — Settings → Features → Push notifications sends every "finished" / "needs you" alert to the devices you turn it on for, through the browsers' push services, so they arrive with aie-studio closed (a locked phone, a closed tab). Clicking one opens the session. Needs HTTPS; on iPhone / iPad add the app to the Home Screen first (iOS 16.4+). "Send a test" checks a device; devices the push service no longer knows are dropped by themselves. The server's VAPID key pair is made on first use (`<config dir>/vapid.json`); `AIE_PUSH_SUBJECT` overrides its contact URL
- **Export** — render a chat or file to PNG/PDF via headless Chrome
- **Multi-user** — password login per user; state stored per user under `~/.config/remote-ide/`
- **PWA** — installable on iOS/Android home screen

## Requirements

- Node.js >= 20, pnpm 11 (`corepack enable`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI on `PATH` (`claude`), and/or Devin CLI (`devin`)
- Chrome / Chromium for export (optional; set `CHROME_EXECUTABLE` if not auto-detected)

## Quick start

```bash
pnpm install
pnpm --filter web build          # server serves web/dist statically
pnpm --filter server adduser me  # create a login (interactive password prompt)
pnpm --filter server start       # http://0.0.0.0:9991
```

Development with hot reload:

```bash
pnpm dev                         # server (tsx watch) + web (vite) in parallel
```

## Configuration

Environment variables (a `.env` at the repo root is loaded automatically):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9991` | HTTP/WebSocket listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `REMOTE_IDE_CONFIG_DIR` | `~/.config/remote-ide` | Users, projects, sessions, caches |
| `CHROME_EXECUTABLE` | auto-detect | Chrome binary for export |
| `CLAUDE_CODE_MODEL_CATALOG_URL` | built-in | Override the Claude model catalog source |

Expose the port through your own reverse proxy / tunnel with TLS — the server itself speaks plain HTTP.

## Shell guard

`!` commands are checked before they run; the guard refuses `sudo`/`su`, recursive `rm`/`chmod`/`chown` on `/`, system dirs, `~` or `.`, disk formatting, shutdown/reboot, killing all processes or `node`, fork bombs and force-pushes to `main`/`master`. This catches slips; it is **not** a security boundary (scripts, aliases or encoded strings get around it).

Tune it in `<config dir>/shell-guard.json` (read on every check, no restart needed):

```json
{
  "disable": ["git-force-push"],
  "rules": [{ "id": "no-prod", "pattern": "kubectl .*--context=prod", "reason": "use the prod runbook" }]
}
```

Built-in rule ids: `sudo`, `rm-critical`, `perm-critical`, `disk`, `power`, `kill-all`, `fork-bomb`, `git-force-push`.

## Layout

```
server/   Fastify + WebSocket backend; spawns agent CLIs, serves web/dist
web/      React + Vite frontend
```

## Running as a service (macOS)

Use a launchd agent that runs `pnpm --filter server start` from the repo root with `KeepAlive`. Note that native build scripts (`esbuild`, `sharp`) must be allow-listed in `pnpm-workspace.yaml` (`allowBuilds`) or pnpm 11 will refuse to start.

## License

MIT
