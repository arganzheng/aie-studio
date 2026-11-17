// Model: server.ShellGuard. Refuses obviously destructive command lines sent
// with `!` from a chat input.
//
// This is a guard rail against slips (a stray `rm -rf ~`, a `sudo` you meant
// to run elsewhere), NOT a security boundary: anything can be hidden in a
// script, an alias or an encoded string. Rules work on the typed line only.
//
// Rules: the built-in set below, minus ids listed in `disable`, plus extra
// regex rules from <config>/shell-guard.json:
//   { "disable": ["git-force-push"],
//     "rules": [{ "id": "no-prod", "pattern": "kubectl .*--context=prod", "reason": "…" }] }
// Extra patterns are tested against every simple command of the line (after
// wrapper stripping, see `segments`).
import nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type GuardVerdict = { blocked: false } | { blocked: true; ruleId: string; reason: string };

type Segment = { text: string; argv: string[] };
type BuiltinRule = { id: string; reason: string; test: (seg: Segment, line: string) => boolean };
export type CustomRule = { id: string; pattern: string; reason?: string };
export type GuardConfig = { disable?: string[]; rules?: CustomRule[] };

const CONFIG_DIR = process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide');
export const GUARD_CONFIG_FILE = path.join(CONFIG_DIR, 'shell-guard.json');

// Wrappers that run their arguments as the real command.
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env', 'caffeinate']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);

function unquote(t: string): string {
  return t.replace(/^["']+|["']+$/g, '');
}

// Split a command line into simple commands. Ignores quoting on purpose:
// over-splitting a quoted `;` only makes the guard stricter, never looser.
export function segments(line: string): Segment[] {
  const out: Segment[] = [];
  for (const part of line.split(/\$\(|[;&|\n()`{}]+/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map(unquote).filter(Boolean);
    // Leading VAR=value assignments and wrapper commands (plus their flags /
    // `nice -n 5`-style values) are not the command being run.
    let i = 0;
    for (;;) {
      const w = words[i];
      if (w === undefined) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
      if (WRAPPERS.has(base(w))) {
        i++;
        while (words[i]?.startsWith('-')) i += words[i] === '-n' ? 2 : 1;
        continue;
      }
      break;
    }
    const argv = words.slice(i);
    if (argv.length === 0) continue;
    argv[0] = base(argv[0]);
    out.push({ text: argv.join(' '), argv });
  }
  return out;
}

// `/bin/rm` and `\rm` are still rm.
function base(cmd: string): string {
  return cmd.replace(/^\\/, '').replace(/^.*\//, '') || cmd;
}

const flags = (argv: string[]) => argv.slice(1).filter((a) => a.startsWith('-'));
const operands = (argv: string[]) => argv.slice(1).filter((a) => !a.startsWith('-'));
const recursive = (argv: string[]) =>
  flags(argv).some((f) => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)));

// Targets whose recursive removal / permission change wrecks the machine,
// the home directory or the whole project.
function isCriticalTarget(t: string): boolean {
  const p = t.replace(/\/+$/, '') || '/';
  if (p === '/' || p === '/*') return true;
  if (/^\/[^/]+\/?\*?$/.test(t)) return true; // a top-level dir: /usr, /Users, /etc/*
  if (/^(~|\$HOME|\$\{HOME\})(\/\*?)?$/.test(t)) return true;
  if (p === os.homedir() || p === `${os.homedir()}/*`) return true;
  if (['.', '..', '*', './*', '../*', '.*'].includes(p)) return true;
  return false;
}

export const BUILTIN_RULES: BuiltinRule[] = [
  {
    id: 'sudo',
    reason: '提权命令（sudo / su / doas）不通过 aie-studio 执行',
    test: ({ argv }) => ['sudo', 'su', 'doas'].includes(argv[0]),
  },
  {
    id: 'rm-critical',
    reason: '递归删除根目录、系统目录、家目录或整个当前目录',
    test: ({ argv }) => argv[0] === 'rm' && recursive(argv) && operands(argv).some(isCriticalTarget),
  },
  {
    id: 'perm-critical',
    reason: '递归修改根目录、系统目录或家目录的权限 / 属主',
    test: ({ argv }) =>
      ['chmod', 'chown', 'chgrp'].includes(argv[0]) && recursive(argv) && operands(argv).some(isCriticalTarget),
  },
  {
    id: 'disk',
    reason: '格式化 / 擦除磁盘',
    test: ({ argv, text }) =>
      /^(mkfs|newfs)/.test(argv[0]) ||
      argv[0] === 'fdisk' ||
      (argv[0] === 'dd' && argv.some((a) => /^of=\/dev\//.test(a))) ||
      (argv[0] === 'diskutil' && /^(erase|partition|zero|random|secure|reformat)/i.test(argv[1] ?? '')) ||
      (argv[0] === 'diskutil' && argv[1] === 'apfs' && /^delete/i.test(argv[2] ?? '')) ||
      />\s*\/dev\/r?(disk|sd)/.test(text),
  },
  {
    id: 'power',
    reason: '关机 / 重启机器',
    test: ({ argv }) =>
      ['shutdown', 'reboot', 'halt', 'poweroff'].includes(argv[0]) ||
      (argv[0] === 'systemctl' && ['poweroff', 'reboot', 'halt'].includes(argv[1] ?? '')),
  },
  {
    id: 'kill-all',
    reason: '杀掉所有进程或所有 node 进程（会连带杀掉 aie-studio 本身）',
    test: ({ argv }) =>
      // `kill -9 -1` / `kill -- -1`: pid -1 = every process the user owns.
      (argv[0] === 'kill' && argv.length >= 3 && argv[argv.length - 1] === '-1') ||
      (['killall', 'pkill'].includes(argv[0]) && operands(argv).some((a) => /^(node|tsx)$/.test(a))),
  },
  {
    id: 'fork-bomb',
    reason: 'fork 炸弹',
    test: (_seg, line) => /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(line),
  },
  {
    id: 'git-force-push',
    reason: '强制推送到 main / master',
    test: ({ argv }) =>
      argv[0] === 'git' &&
      argv[1] === 'push' &&
      (flags(argv).some((f) => f === '-f' || f.startsWith('--force') || (/^-[^-]/.test(f) && f.includes('f'))) ||
        operands(argv).some((a) => /^\+/.test(a))) &&
      operands(argv).some((a) => /(^|[:+/])(main|master)$/.test(a)),
  },
];

export function loadGuardConfig(file = GUARD_CONFIG_FILE): GuardConfig {
  try {
    const raw = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as GuardConfig) : {};
  } catch {
    return {};
  }
}

// `-c '…'` / `eval …` bodies are checked as command lines of their own.
function nestedBodies(argv: string[]): string[] {
  if (argv[0] === 'eval') return [argv.slice(1).join(' ')];
  if (SHELLS.has(argv[0])) {
    const i = argv.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (i >= 0) return [argv.slice(i + 1).join(' ')];
  }
  return [];
}

export function checkCommand(line: string, config: GuardConfig = loadGuardConfig(), depth = 0): GuardVerdict {
  const disabled = new Set(config.disable ?? []);
  const custom: Array<{ id: string; re: RegExp; reason: string }> = [];
  for (const r of config.rules ?? []) {
    if (!r || typeof r.pattern !== 'string') continue;
    try {
      custom.push({ id: String(r.id || r.pattern), re: new RegExp(r.pattern), reason: r.reason || `matches rule ${r.id || r.pattern}` });
    } catch {
      // Invalid regex in the user's config: skip it rather than break every `!` command.
    }
  }
  for (const seg of segments(line)) {
    for (const rule of BUILTIN_RULES) {
      if (!disabled.has(rule.id) && rule.test(seg, line)) return { blocked: true, ruleId: rule.id, reason: rule.reason };
    }
    for (const rule of custom) {
      if (rule.re.test(seg.text)) return { blocked: true, ruleId: rule.id, reason: rule.reason };
    }
    if (depth < 3) {
      for (const body of nestedBodies(seg.argv)) {
        const v = checkCommand(body, config, depth + 1);
        if (v.blocked) return v;
      }
    }
  }
  return { blocked: false };
}
