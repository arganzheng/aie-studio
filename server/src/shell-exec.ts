// Model: server.RunBangCommand. Runs a `!command` typed in a chat input, the
// way Claude Code's bash mode does: one non-interactive shell in the project
// directory, the user's zsh config loaded (-l -i) so PATH / nvm / aliases
// match their terminal, stdin closed so a prompt for input fails fast instead
// of hanging (interactive commands need a real terminal).
import { spawn } from 'node:child_process';
import { checkCommand } from './shell-guard.js';

export const BANG_TIMEOUT_MS = 2 * 60_000;
// Same cap as Claude Code applies to bash output it hands the model.
export const BANG_OUTPUT_LIMIT = 30_000;

export type BangResult = {
  command: string;
  stdout: string;
  stderr: string;
  code: number | null;
  // Set when the command never ran / was cut short.
  blocked?: string;
  timedOut?: boolean;
  interrupted?: boolean;
};

export function truncateOutput(s: string, limit = BANG_OUTPUT_LIMIT): string {
  if (s.length <= limit) return s;
  const cut = s.length - limit;
  return `${s.slice(0, limit)}\n… [${cut} more characters truncated]`;
}

export function shellPath(): string {
  return process.env.AIE_BANG_SHELL || '/bin/zsh';
}

export function shellEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  // ~/.zshrc may auto-start a multiplexer (herdr) on interactive shells;
  // inside aie-studio that would hide the shell behind another TUI.
  env.NO_HERDR = '1';
  env.AIE_STUDIO = '1';
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return { ...env, ...extra };
}

export type RunningBang = { promise: Promise<BangResult>; interrupt: () => void };

export function runBang(command: string, cwd: string, timeoutMs = BANG_TIMEOUT_MS): RunningBang {
  const verdict = checkCommand(command);
  if (verdict.blocked) {
    const result: BangResult = { command, stdout: '', stderr: '', code: null, blocked: `${verdict.ruleId}: ${verdict.reason}` };
    return { promise: Promise.resolve(result), interrupt: () => {} };
  }
  // detached: own process group, so timeout / Stop kills the whole pipeline.
  const child = spawn(shellPath(), ['-l', '-i', '-c', command], {
    cwd,
    env: shellEnv({ TERM: 'dumb', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  // Keep a little past the cap so truncateOutput can say how much was cut,
  // without buffering an unbounded stream.
  const keep = BANG_OUTPUT_LIMIT * 4;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { if (stdout.length < keep) stdout += d; });
  child.stderr.on('data', (d: string) => { if (stderr.length < keep) stderr += d; });
  let timedOut = false;
  let interrupted = false;
  const killGroup = () => {
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
  };
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
  const promise = new Promise<BangResult>((resolve) => {
    const finish = (code: number | null, err?: Error) => {
      clearTimeout(timer);
      resolve({
        command,
        stdout: truncateOutput(stripTrailingNewline(stdout)),
        stderr: truncateOutput(stripTrailingNewline(err ? `${stderr}${err.message}` : stderr)),
        code,
        ...(timedOut ? { timedOut } : {}),
        ...(interrupted ? { interrupted } : {}),
      });
    };
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
  return { promise, interrupt: () => { interrupted = true; killGroup(); } };
}

function stripTrailingNewline(s: string): string {
  return s.replace(/\n+$/, '');
}

function escapeTag(s: string): string {
  // The model sees these inside pseudo-XML tags; keep a stray closing tag in
  // the output from ending the block early.
  return s.replace(/<\/(bash-(?:input|stdout|stderr))>/g, '<\\/$1>');
}

// Claude Code records a `!` command as two user-message texts: the input,
// then stdout/stderr. We carry the same tags into the next prompt so the
// model reads them exactly as it would in the CLI.
export function bangContextBlocks(r: BangResult): string[] {
  let stderr = r.stderr;
  if (r.blocked) stderr = `Blocked by aie-studio shell guard (${r.blocked})`;
  else if (r.timedOut) stderr = `${stderr}${stderr ? '\n' : ''}Command timed out after ${BANG_TIMEOUT_MS / 1000}s`;
  else if (r.interrupted) stderr = `${stderr}${stderr ? '\n' : ''}Command interrupted by user`;
  else if (r.code !== 0 && r.code !== null) stderr = `${stderr}${stderr ? '\n' : ''}Exit code ${r.code}`;
  return [
    `<bash-input>${escapeTag(r.command)}</bash-input>`,
    `<bash-stdout>${escapeTag(r.stdout)}</bash-stdout><bash-stderr>${escapeTag(stderr)}</bash-stderr>`,
  ];
}
