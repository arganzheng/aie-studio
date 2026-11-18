import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeLastActivity, lastMessageAt } from '../session-activity.js';

const line = (o: object) => JSON.stringify(o);
const T1 = '2026-11-18T01:00:00.000Z';
const T2 = '2026-11-18T02:00:00.000Z';

describe('lastMessageAt', () => {
  it('takes the last user / assistant record and ignores bookkeeping after it', () => {
    const text = [
      line({ type: 'user', timestamp: T1, message: {} }),
      line({ type: 'assistant', timestamp: T2, message: {} }),
      line({ type: 'ai-title', aiTitle: 'x', sessionId: 's' }),
      line({ type: 'atis-latch', atis: '', sessionId: 's' }),
      line({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-18T09:00:00.000Z' }),
    ].join('\n') + '\n';
    expect(lastMessageAt(text)).toBe(Date.parse(T2));
  });

  it('skips sidechain records and a torn last line', () => {
    const text = [
      line({ type: 'user', timestamp: T1 }),
      line({ type: 'assistant', timestamp: T2, isSidechain: true }),
      '{"type":"assistant","timestamp":"2026-11-18T',
    ].join('\n');
    expect(lastMessageAt(text)).toBe(Date.parse(T1));
  });

  it('returns null when there is no message', () => {
    expect(lastMessageAt('')).toBeNull();
    expect(lastMessageAt(line({ type: 'ai-title', aiTitle: 'x' }) + '\n')).toBeNull();
  });
});

describe('claudeLastActivity', () => {
  let home: string;
  const prev = process.env.CLAUDE_CONFIG_DIR;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-'));
    process.env.CLAUDE_CONFIG_DIR = home;
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('reads the transcript under the encoded cwd and falls back to mtime', async () => {
    const cwd = '/work/my.proj';
    const dir = path.join(home, 'projects', '-work-my-proj');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    // A big filler record before the message forces the tail window to grow.
    const filler = line({ type: 'user', timestamp: T1, message: { content: 'x'.repeat(200_000) } });
    await fs.writeFile(file, [filler, line({ type: 'ai-title', aiTitle: 't' })].join('\n') + '\n');
    expect(await claudeLastActivity(cwd, 's1', 42)).toBe(Date.parse(T1));
    // Appending bookkeeping (what a resume does) doesn't move it.
    await fs.appendFile(file, line({ type: 'atis-latch', atis: '' }) + '\n');
    expect(await claudeLastActivity(cwd, 's1', 43)).toBe(Date.parse(T1));
    // A new message does.
    await fs.appendFile(file, line({ type: 'assistant', timestamp: T2 }) + '\n');
    expect(await claudeLastActivity(cwd, 's1', 44)).toBe(Date.parse(T2));
    expect(await claudeLastActivity(cwd, 'missing', 7)).toBe(7);
  });
});
