import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Route-level coverage for server.DeleteEntry (auc-134); auth + project
// lookup are mocked so only the fs route is exercised.
let root = '';
vi.mock('../auth.js', () => ({ getUserId: () => 'u1' }));
vi.mock('../store.js', () => ({
  getProject: async (_uid: string, id: string) =>
    id === 'p1' ? { id: 'p1', name: 'p1', path: root } : null,
}));

const { registerFsRoutes } = await import('../fs.js');

let app: FastifyInstance;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rid-delete-'));
  await fs.mkdir(path.join(root, 'full'));
  await fs.writeFile(path.join(root, 'full', 'keep.txt'), 'x');
  await fs.mkdir(path.join(root, 'empty'));
  await fs.writeFile(path.join(root, 'gone.txt'), 'x');
  await fs.writeFile(path.join(root, 'target.txt'), 'x');
  await fs.symlink(path.join(root, 'target.txt'), path.join(root, 'link'));
  await fs.symlink(path.join(root, 'missing'), path.join(root, 'dangling'));
  app = Fastify();
  registerFsRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});

const del = (q: Record<string, string>) =>
  app.inject({ method: 'DELETE', url: `/api/fs/entry?${new URLSearchParams(q).toString()}` });

const exists = (rel: string) => fs.lstat(path.join(root, rel)).then(() => true, () => false);

describe('DELETE /api/fs/entry', () => {
  it('deletes a file', async () => {
    const r = await del({ project: 'p1', path: 'gone.txt' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ path: 'gone.txt' });
    expect(await exists('gone.txt')).toBe(false);
  });

  it('deletes an empty directory', async () => {
    expect((await del({ project: 'p1', path: 'empty' })).statusCode).toBe(200);
    expect(await exists('empty')).toBe(false);
  });

  it('refuses a non-empty directory with 409 and leaves it intact (rule-457)', async () => {
    const r = await del({ project: 'p1', path: 'full' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/not empty/);
    expect(await exists('full/keep.txt')).toBe(true);
  });

  it('unlinks symlinks without touching their target (rule-458)', async () => {
    expect((await del({ project: 'p1', path: 'link' })).statusCode).toBe(200);
    expect(await exists('link')).toBe(false);
    expect(await exists('target.txt')).toBe(true);
    // A dangling symlink still "exists" for deletion purposes.
    expect((await del({ project: 'p1', path: 'dangling' })).statusCode).toBe(200);
    expect(await exists('dangling')).toBe(false);
  });

  it('404s for a missing entry, 400s for the root and escapes, 404s for an unknown project', async () => {
    expect((await del({ project: 'p1', path: 'nope' })).statusCode).toBe(404);
    expect((await del({ project: 'p1', path: '.' })).statusCode).toBe(400);
    expect((await del({ project: 'p1', path: '../x' })).statusCode).toBe(400);
    expect((await del({ project: 'nope', path: 'x' })).statusCode).toBe(404);
  });
});
