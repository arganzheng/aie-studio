// Model: server.TerminalBridge / web.TerminalPanel. A real login zsh on a PTY,
// one per Terminal tab in the side panel, streamed over the `terminal` duplex
// channel (/ws/terminal, or HTTP where WebSockets are blocked).
//
// Opt-in: a user gets a shell only with settings.terminal on (off by default),
// and AIE_TERMINAL=off turns the feature off for everyone. Turning the setting
// off ends that user's shells.
//
// Lifetime: the PTY is keyed by (user, tab id) and outlives its WebSocket —
// a reload or a flaky phone connection reattaches and replays the recent
// output. It ends when the shell exits, the tab is closed (client sends
// `kill`), or nobody has been attached for TERMINAL_IDLE_MS.
//
// Shell guard: zsh starts with a ZDOTDIR of ours that sources the user's own
// startup files unchanged, then wraps the accept-line widgets so every line is
// checked by server.ShellGuard (POST /internal/shell-guard) before it runs.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { getUserId } from './auth.js';
import { getProject, getSettings } from './store.js';
import { duplexRoute } from './duplex.js';
import { checkCommand } from './shell-guard.js';
import { shellEnv, shellPath } from './shell-exec.js';

const CONFIG_DIR = process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide');
const ZDOTDIR = path.join(CONFIG_DIR, 'terminal-zdotdir');
export const TERMINAL_IDLE_MS = Number(process.env.AIE_TERMINAL_IDLE_MS) || 2 * 60 * 60_000;
export const SCROLLBACK_LIMIT = 256 * 1024;
const MAX_TERMINALS_PER_USER = 20;
const PING_INTERVAL_MS = 30_000;

// Token the in-shell guard presents; per server process, never leaves the box.
const GUARD_TOKEN = randomBytes(24).toString('hex');

type TermEntry = {
  key: string;
  uid: string;
  pty: pty.IPty;
  // Recent output for replay on reattach (bounded, oldest dropped).
  scrollback: string;
  clients: Set<WebSocket>;
  idleTimer?: NodeJS.Timeout;
};

const terms = new Map<string, TermEntry>();

export function appendScrollback(buf: string, chunk: string, limit = SCROLLBACK_LIMIT): string {
  const next = buf + chunk;
  if (next.length <= limit) return next;
  // Cut at a line boundary when one is near, so replay doesn't start mid
  // escape sequence more often than it has to.
  let cut = next.length - limit;
  const nl = next.indexOf('\n', cut);
  if (nl !== -1 && nl - cut < 4096) cut = nl + 1;
  return next.slice(cut);
}

// pnpm unpacks node-pty's prebuilt spawn-helper without the exec bit, which
// makes every spawn fail with "posix_spawnp failed". Restore it once.
function fixSpawnHelper() {
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('node-pty/package.json'));
    for (const p of [
      path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(root, 'build', 'Release', 'spawn-helper'),
    ]) {
      if (!nodeFs.existsSync(p)) continue;
      const mode = nodeFs.statSync(p).mode;
      if ((mode & 0o111) !== 0o111) nodeFs.chmodSync(p, mode | 0o755);
    }
  } catch {}
}

// zsh resolves $ZDOTDIR before each startup file, so every file of ours
// switches to the user's dir, sources their file, and switches back. After
// .zlogin (the last one for a login shell) ZDOTDIR stays the user's so
// nested shells behave normally.
export const ZSH_FILES: Record<string, string> = {
  '.zshenv': `_aie_zdotdir=$ZDOTDIR
ZDOTDIR=\${AIE_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
AIE_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$_aie_zdotdir
`,
  '.zprofile': `ZDOTDIR=$AIE_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zprofile ]] && source $ZDOTDIR/.zprofile
ZDOTDIR=$_aie_zdotdir
`,
  // /etc/zshrc ran with our ZDOTDIR and may have pointed HISTFILE into it.
  '.zshrc': `[[ $HISTFILE == $_aie_zdotdir/.zsh_history ]] && HISTFILE=$AIE_USER_ZDOTDIR/.zsh_history
ZDOTDIR=$AIE_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
ZDOTDIR=$_aie_zdotdir
`,
  '.zlogin': `ZDOTDIR=$AIE_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zlogin ]] && source $ZDOTDIR/.zlogin
source $_aie_zdotdir/guard.zsh
unset _aie_zdotdir
`,
  // Wraps every widget that runs the buffer. Whatever accept-line was before
  // (builtin or a plugin's wrapper) is kept and called when the line passes.
  // Fails open if the server can't be reached — then the terminal is gone too.
  'guard.zsh': `_aie_guard_widget() {
  emulate -L zsh
  if [[ -n \${BUFFER//[[:space:]]/} && -n $AIE_GUARD_URL ]]; then
    local verdict
    verdict=$(print -rn -- "$BUFFER" | command curl -s --max-time 3 \\
      -H "X-Aie-Guard: $AIE_GUARD_TOKEN" -H 'Content-Type: text/plain' \\
      --data-binary @- "$AIE_GUARD_URL" 2>/dev/null)
    if [[ -n $verdict ]]; then
      zle -I
      print -r -- $'\\e[1;31m'"⛔ aie-studio 已拦截：$verdict"$'\\e[0m'
      print -r -- $'\\e[2m'"   $BUFFER"$'\\e[0m'
      print -s -- "$BUFFER"
      BUFFER=''
      return 0
    fi
  fi
  zle _aie_orig_$WIDGET
}
() {
  local w
  for w in accept-line accept-and-hold accept-line-and-down-history accept-and-infer-next-history; do
    zle -A $w _aie_orig_$w 2>/dev/null || continue
    zle -N $w _aie_guard_widget
  done
}
`,
};

function writeZdotdir() {
  nodeFs.mkdirSync(ZDOTDIR, { recursive: true });
  for (const [name, body] of Object.entries(ZSH_FILES)) {
    nodeFs.writeFileSync(path.join(ZDOTDIR, name), body);
  }
}

function send(socket: WebSocket, msg: unknown) {
  try { socket.send(JSON.stringify(msg)); } catch {}
}

function broadcast(entry: TermEntry, msg: unknown) {
  const raw = JSON.stringify(msg);
  for (const c of entry.clients) { try { c.send(raw); } catch {} }
}

function kill(entry: TermEntry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  terms.delete(entry.key);
  try { entry.pty.kill('SIGHUP'); } catch {}
  for (const c of entry.clients) { try { c.close(); } catch {} }
  entry.clients.clear();
}

function clampSize(n: unknown, fallback: number, max: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : fallback;
}

function spawnTerm(key: string, uid: string, cwd: string, cols: number, rows: number, guardUrl: string): TermEntry {
  const userZdotdir = process.env.ZDOTDIR || os.homedir();
  const p = pty.spawn(shellPath(), ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: shellEnv({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'aie-studio',
      ZDOTDIR,
      AIE_USER_ZDOTDIR: userZdotdir,
      AIE_GUARD_URL: guardUrl,
      AIE_GUARD_TOKEN: GUARD_TOKEN,
    }),
  });
  const entry: TermEntry = { key, uid, pty: p, scrollback: '', clients: new Set() };
  p.onData((d) => {
    entry.scrollback = appendScrollback(entry.scrollback, d);
    broadcast(entry, { type: 'output', data: d });
  });
  p.onExit(({ exitCode, signal }) => {
    if (terms.get(key) !== entry) return;
    broadcast(entry, { type: 'exit', code: exitCode, signal: signal ?? null });
    kill(entry);
  });
  terms.set(key, entry);
  return entry;
}

// Model: server.TerminalBridge — is the Terminal open to this user?
export function terminalAllowed(settings: { terminal?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AIE_TERMINAL !== 'off' && settings.terminal === true;
}

// End every shell of one user (the setting was turned off), or one tab's.
export function killTerminals(uid: string, tabId?: string): number {
  let n = 0;
  for (const e of [...terms.values()]) {
    if (e.uid === uid && (tabId === undefined || e.key === `${uid}:${tabId}`)) { kill(e); n++; }
  }
  return n;
}

function scheduleIdleKill(entry: TermEntry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.clients.size === 0) kill(entry);
  }, TERMINAL_IDLE_MS);
  entry.idleTimer.unref();
}

export function registerTerminalRoutes(app: FastifyInstance, opts: { port: number }) {
  fixSpawnHelper();
  try { writeZdotdir(); } catch (err) { app.log.warn({ err }, 'terminal: could not write zsh startup files; shell guard disabled'); }
  const guardUrl = `http://127.0.0.1:${opts.port}/internal/shell-guard`;

  // Called by guard.zsh inside our own PTYs only: loopback + per-process token.
  // Empty body = allowed; otherwise "<rule>: <reason>".
  app.post('/internal/shell-guard', async (req, reply) => {
    const ip = req.ip;
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!loopback || req.headers['x-aie-guard'] !== GUARD_TOKEN) return reply.code(403).send('');
    const line = typeof req.body === 'string' ? req.body : '';
    const v = checkCommand(line);
    if (v.blocked) req.log.info({ rule: v.ruleId }, 'terminal: shell guard blocked a command');
    return reply.type('text/plain').send(v.blocked ? `${v.ruleId}: ${v.reason}` : '');
  });

  // Closing a Terminal tab ends its shell.
  app.delete<{ Params: { tab: string } }>('/api/terminal/:tab', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    return { killed: killTerminals(uid, req.params.tab) };
  });

  duplexRoute<{ project?: string; tab?: string; cols?: string; rows?: string }>(
    app,
    '/ws/terminal',
    async (socket, req) => {
      const uid = getUserId(req as any);
      const fail = (message: string) => { send(socket, { type: 'error', message }); try { socket.close(); } catch {} };
      if (!uid) return fail('unauthorized');
      if (!terminalAllowed(await getSettings(uid))) return fail(process.env.AIE_TERMINAL === 'off' ? 'The Terminal is turned off on this server.' : 'The Terminal is off. Turn it on in Settings → Terminal.');
      const tabId = String(req.query.tab ?? '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tabId)) return fail('tab id required');
      const project = req.query.project ? await getProject(uid, req.query.project) : null;
      if (!project) return fail('project required or not found');
      const cols = clampSize(req.query.cols, 80, 500);
      const rows = clampSize(req.query.rows, 24, 200);

      const key = `${uid}:${tabId}`;
      let entry = terms.get(key);
      const reattached = !!entry;
      if (!entry) {
        const mine = [...terms.values()].filter((t) => t.uid === uid).length;
        if (mine >= MAX_TERMINALS_PER_USER) return fail(`too many open terminals (max ${MAX_TERMINALS_PER_USER}) — close one first`);
        try {
          entry = spawnTerm(key, uid, project.path, cols, rows, guardUrl);
        } catch (err) {
          return fail(`could not start shell: ${String((err as Error).message ?? err)}`);
        }
      } else {
        try { entry.pty.resize(cols, rows); } catch {}
      }
      const e = entry;
      if (e.idleTimer) { clearTimeout(e.idleTimer); e.idleTimer = undefined; }
      e.clients.add(socket);
      send(socket, { type: 'started', reattached, cwd: project.path });
      if (reattached && e.scrollback) send(socket, { type: 'output', data: e.scrollback });

      let alive = true;
      const pingTimer = setInterval(() => {
        if (!alive) { try { socket.terminate(); } catch {} return; }
        alive = false;
        try { socket.ping(); } catch {}
      }, PING_INTERVAL_MS);
      socket.on('pong', () => { alive = true; });

      socket.on('message', (raw: Buffer | string) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg?.type === 'input' && typeof msg.data === 'string') {
          try { e.pty.write(msg.data); } catch {}
        } else if (msg?.type === 'resize') {
          try { e.pty.resize(clampSize(msg.cols, 80, 500), clampSize(msg.rows, 24, 200)); } catch {}
        } else if (msg?.type === 'kill') {
          kill(e);
        } else if (msg?.type === 'ping') {
          send(socket, { type: 'pong' });
        }
      });

      socket.on('close', () => {
        clearInterval(pingTimer);
        e.clients.delete(socket);
        if (e.clients.size === 0 && terms.get(key) === e) scheduleIdleKill(e);
      });
    },
  );
}
