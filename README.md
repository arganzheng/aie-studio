# aie-studio

A browser-based workbench for driving AI coding agents (Claude Code, Devin CLI) on a remote machine. Open it from a phone or laptop, pick a project directory, and chat with the agent while browsing and previewing the files it touches.

## Features

- **Agent tabs** — run multiple Claude Code / Devin sessions side by side, each pinned to a project directory; resume previous sessions
- **`!` shell commands** — `!cmd` in a Claude (SDK) chat runs a shell command in the project directory; Claude sees its output with your next message, like Claude Code's bash mode. Obviously destructive commands are refused (see *Shell guard*)
- **File browser & viewer** — tree view of the project, preview of text, Markdown, images, PDFs
- **Sessions & groups** — one sidebar view for every session: open sessions sit under their cmux-style tab group (switch, rename, drag to reorder or move tabs between groups), the rest under History; search, filter, archive
- **Subagent tree** — a Claude session that spawned subagents (its Agent tool) gets a caret and a `⑂ 2/3` badge in the Sessions list; expand it to see each subagent with its status, click one to follow its conversation live in a read-only tab, and stop a running one without stopping the session.
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
