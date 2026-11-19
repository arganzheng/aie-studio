import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Model: server.SessionAttachments — files the user hands to a session from
// the prompt input (the ＋ button). They are not part of the project: they
// live under the config directory, the prompt names them by absolute path
// and the agent reads them with its own tools. Each upload gets a directory
// of its own, so two files of the same name never collide. Old ones are
// swept: an attachment matters for the conversation that got it, not forever.

export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ATTACHMENT_SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

export function attachmentsRoot(): string {
  return path.join(process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide'), 'uploads');
}

// Pure: where one attachment goes — <root>/<uid>/<id>/<name>, name a plain
// basename.
export function planAttachment(root: string, uid: string, name: string, id = randomBytes(8).toString('hex')) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes(path.sep) || name.includes('\0')) {
    throw Object.assign(new Error('invalid file name'), { code: 400 });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(uid) || !/^[a-f0-9]+$/.test(id)) throw Object.assign(new Error('invalid attachment owner'), { code: 400 });
  const dirAbs = path.join(root, uid, id);
  return { dirAbs, abs: path.join(dirAbs, name) };
}

// Delete every attachment directory last touched more than `ttl` ago, and a
// user's directory once it is empty. Returns how many were removed.
export async function sweepAttachments(root: string, now = Date.now(), ttl = ATTACHMENT_TTL_MS): Promise<number> {
  let removed = 0;
  const users = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const u of users) {
    if (!u.isDirectory()) continue;
    const userDir = path.join(root, u.name);
    const items = await fs.readdir(userDir, { withFileTypes: true }).catch(() => []);
    let left = items.length;
    for (const it of items) {
      const p = path.join(userDir, it.name);
      const st = await fs.stat(p).catch(() => null);
      if (!st || now - st.mtimeMs <= ttl) continue;
      await fs.rm(p, { recursive: true, force: true }).catch(() => {});
      removed++;
      left--;
    }
    if (left === 0) await fs.rmdir(userDir).catch(() => {});
  }
  return removed;
}

// Sweep now and then on a timer for as long as the server runs.
export function startAttachmentSweep(log: (msg: string) => void = () => {}): void {
  const run = () => void sweepAttachments(attachmentsRoot())
    .then((n) => { if (n > 0) log(`removed ${n} attachment${n === 1 ? '' : 's'} older than ${ATTACHMENT_TTL_MS / 86_400_000} days`); })
    .catch(() => {});
  run();
  setInterval(run, ATTACHMENT_SWEEP_EVERY_MS).unref();
}
