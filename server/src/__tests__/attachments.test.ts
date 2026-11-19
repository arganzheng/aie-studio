import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ATTACHMENT_TTL_MS, planAttachment, sweepAttachments } from '../attachments.js';

describe('planAttachment', () => {
  it('puts each attachment in a directory of its own under the user', () => {
    expect(planAttachment('/r', 'u1', 'notes.pdf', 'ab12')).toEqual({ dirAbs: '/r/u1/ab12', abs: '/r/u1/ab12/notes.pdf' });
    expect(planAttachment('/r', 'u1', 'a.txt').dirAbs).not.toBe(planAttachment('/r', 'u1', 'a.txt').dirAbs);
  });
  it('refuses names that are not a plain basename, and odd owners', () => {
    for (const bad of ['', '.', '..', 'a/b', '../x']) expect(() => planAttachment('/r', 'u1', bad, 'ab')).toThrow('invalid file name');
    expect(() => planAttachment('/r', '../u', 'a.txt', 'ab')).toThrow();
  });
});

describe('sweepAttachments', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'att-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function put(uid: string, id: string, ageMs: number, now: number) {
    const dir = path.join(root, uid, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'f.txt'), 'x');
    const t = new Date(now - ageMs);
    await fs.utimes(dir, t, t);
  }
  it('removes what is older than the limit and keeps the rest', async () => {
    const now = Date.now();
    await put('u1', 'old', ATTACHMENT_TTL_MS + 60_000, now);
    await put('u1', 'new', 60_000, now);
    await put('u2', 'old', ATTACHMENT_TTL_MS * 2, now);
    expect(await sweepAttachments(root, now)).toBe(2);
    expect(await fs.readdir(path.join(root, 'u1'))).toEqual(['new']);
    // A user with nothing left loses the directory too.
    expect(await fs.readdir(root)).toEqual(['u1']);
  });
  it('is quiet when there is nothing there', async () => {
    expect(await sweepAttachments(path.join(root, 'missing'))).toBe(0);
  });
});
