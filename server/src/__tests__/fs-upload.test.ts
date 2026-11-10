import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Route-level coverage for server.UploadFile (auc-133): auth + project
// lookup are mocked so the test exercises only the fs route itself.
let root = '';
vi.mock('../auth.js', () => ({ getUserId: () => 'u1' }));
vi.mock('../store.js', () => ({
  getProject: async (_uid: string, id: string) =>
    id === 'p1' ? { id: 'p1', name: 'p1', path: root } : null,
}));

const { registerFsRoutes, UPLOAD_MAX_BYTES } = await import('../fs.js');

let app: FastifyInstance;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rid-upload-'));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'old.txt'), 'old');
  app = Fastify();
  registerFsRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});

function upload(q: Record<string, string>, body: Buffer | string, headers: Record<string, string> = {}) {
  const qs = new URLSearchParams(q).toString();
  return app.inject({
    method: 'POST',
    url: `/api/fs/upload?${qs}`,
    headers: { 'content-type': 'application/octet-stream', ...headers },
    payload: body,
  });
}

describe('POST /api/fs/upload', () => {
  it('writes the raw body to dir/name and returns stat info', async () => {
    const r = await upload({ project: 'p1', dir: 'docs', name: 'new.bin' }, Buffer.from([1, 2, 3]));
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.path).toBe('docs/new.bin');
    expect(j.size).toBe(3);
    expect(await fs.readFile(path.join(root, 'docs', 'new.bin'))).toEqual(Buffer.from([1, 2, 3]));
    // rule-451: no temp file left behind
    const names = await fs.readdir(path.join(root, 'docs'));
    expect(names.filter((n) => n.includes('.upload-'))).toEqual([]);
  });

  it('uploads to the project root when dir is empty', async () => {
    const r = await upload({ project: 'p1', dir: '', name: 'top.txt' }, 'hi');
    expect(r.statusCode).toBe(200);
    expect(r.json().path).toBe('top.txt');
  });

  it('refuses to overwrite unless overwrite=1 (rule-450)', async () => {
    const r1 = await upload({ project: 'p1', dir: 'docs', name: 'old.txt' }, 'new');
    expect(r1.statusCode).toBe(409);
    expect(await fs.readFile(path.join(root, 'docs', 'old.txt'), 'utf8')).toBe('old');
    const r2 = await upload({ project: 'p1', dir: 'docs', name: 'old.txt', overwrite: '1' }, 'new');
    expect(r2.statusCode).toBe(200);
    expect(await fs.readFile(path.join(root, 'docs', 'old.txt'), 'utf8')).toBe('new');
  });

  it('never replaces a directory, even with overwrite=1', async () => {
    const r = await upload({ project: 'p1', dir: '', name: 'docs', overwrite: '1' }, 'x');
    expect(r.statusCode).toBe(400);
    expect((await fs.stat(path.join(root, 'docs'))).isDirectory()).toBe(true);
  });

  it('rejects bad names, missing dirs and escapes (rule-448)', async () => {
    expect((await upload({ project: 'p1', dir: '', name: '../evil' }, 'x')).statusCode).toBe(400);
    expect((await upload({ project: 'p1', dir: '', name: 'a/b' }, 'x')).statusCode).toBe(400);
    expect((await upload({ project: 'p1', dir: '..', name: 'a' }, 'x')).statusCode).toBe(400);
    expect((await upload({ project: 'p1', dir: 'nope', name: 'a' }, 'x')).statusCode).toBe(400);
    expect((await upload({ project: 'p1', dir: 'docs/old.txt', name: 'a' }, 'x')).statusCode).toBe(400);
  });

  it('rejects an oversized declared length with 413 (rule-449)', async () => {
    const r = await upload(
      { project: 'p1', dir: '', name: 'big.bin' },
      'x',
      { 'content-length': String(UPLOAD_MAX_BYTES + 1) },
    );
    expect(r.statusCode).toBe(413);
    await expect(fs.stat(path.join(root, 'big.bin'))).rejects.toThrow();
  });

  it('404s for an unknown project', async () => {
    expect((await upload({ project: 'nope', dir: '', name: 'a' }, 'x')).statusCode).toBe(404);
  });
});
