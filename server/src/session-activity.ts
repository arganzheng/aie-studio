import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Model: server.ListAllSessions — a Claude session's "last activity" for the
// Sessions list is the time of its last conversation message, not the
// transcript's mtime. Merely resuming a session makes the CLI append
// bookkeeping records (ai-title, atis-latch, mode, …), which bumped the mtime
// and moved an untouched session to the top of the list on every open.

// Records that are the conversation itself; everything else is bookkeeping.
const MESSAGE_TYPES = new Set(['user', 'assistant']);

// The timestamp (ms) of the last main-thread user / assistant record in a
// transcript's text, or null if there is none. A torn last line (the CLI is
// mid-write) is skipped.
export function lastMessageAt(text: string): number | null {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end).trim();
    end = start - 1;
    if (!line || !line.includes('"timestamp"')) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || !MESSAGE_TYPES.has(rec.type) || rec.isSidechain === true) continue;
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Same encoding as subagents.encodeProjectDir.
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

type Cached = { mtimeMs: number; size: number; at: number | null };
const cache = new Map<string, Cached>();
const MAX_CACHE = 5000;

const FIRST_CHUNK = 64 * 1024;

// Read the file's tail, growing the window until a message turns up or the
// whole file has been read (a huge last record, e.g. a pasted image).
async function scanTail(file: string, size: number): Promise<number | null> {
  const fh = await fs.open(file, 'r');
  try {
    let len = Math.min(size, FIRST_CHUNK);
    for (;;) {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      let text = buf.toString('utf8');
      // Drop the (probably partial) first line unless we read from the start.
      if (len < size) text = text.slice(text.indexOf('\n') + 1);
      const at = lastMessageAt(text);
      if (at !== null || len === size) return at;
      len = Math.min(size, len * 4);
    }
  } finally {
    await fh.close();
  }
}

// Last-message time of a Claude session, or `fallback` (the transcript's
// mtime) when the transcript can't be read or holds no message yet.
export async function claudeLastActivity(cwd: string, sessionId: string, fallback: number): Promise<number> {
  const real = await fs.realpath(cwd).catch(() => cwd);
  for (const c of new Set([real, cwd])) {
    const file = path.join(configDir(), 'projects', encodeProjectDir(c), `${sessionId}.jsonl`);
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.at ?? fallback;
    const at = await scanTail(file, st.size).catch(() => null);
    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, at });
    return at ?? fallback;
  }
  return fallback;
}
