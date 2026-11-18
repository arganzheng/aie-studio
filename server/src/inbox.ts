import { DatabaseSync } from 'node:sqlite';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import type { SessionEvent } from './notify.js';

// Model: server.Inbox — every "finished / needs you" notification a user got,
// kept in SQLite so it survives restarts and reads the same on every device
// (web.Inbox). One row per session: a newer event for the same session
// replaces the row and makes it unread again, so a busy session doesn't bury
// the list. Pop-up cards (web.SessionAlerts) stay as they were; this is the
// record behind them.

export type InboxItem = SessionEvent & { readAt: number | null };

// Per user: at most this many rows, none older than KEEP_MS.
export const KEEP_MAX = 500;
export const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
export const SUMMARY_MAX = 200;

// Same family rule as web sessionAlerts.alertKey: the two Claude tab kinds
// drive the same sessions; Devin's ids are their own namespace.
export function sessionKey(e: Pick<SessionEvent, 'projectId' | 'tabType' | 'sessionId' | 'id'>): string {
  return `${e.projectId}:${e.tabType === 'devin' ? 'devin' : 'claude'}:${e.sessionId ?? e.id}`;
}

// One line of plain text for the list: markdown markers and runs of
// whitespace collapsed, cut at SUMMARY_MAX.
export function toSummary(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

// The first question of an AskUserQuestion input (Claude's ask form).
export function askSummary(input: unknown): string | null {
  const q = (input as any)?.questions?.[0]?.question;
  return toSummary(q);
}

type Row = {
  id: string; kind: string; tab_type: string; project_id: string; session_id: string | null;
  title: string | null; summary: string | null; at: number; read_at: number | null;
};

function fromRow(r: Row): InboxItem {
  return {
    id: r.id,
    kind: r.kind as InboxItem['kind'],
    tabType: r.tab_type as InboxItem['tabType'],
    projectId: r.project_id,
    sessionId: r.session_id,
    title: r.title,
    summary: r.summary,
    at: r.at,
    readAt: r.read_at,
  };
}

export class InboxStore {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS notifications (
        uid         TEXT NOT NULL,
        session_key TEXT NOT NULL,
        id          TEXT NOT NULL,
        kind        TEXT NOT NULL,
        tab_type    TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        session_id  TEXT,
        title       TEXT,
        summary     TEXT,
        at          INTEGER NOT NULL,
        read_at     INTEGER,
        PRIMARY KEY (uid, session_key)
      );
      CREATE INDEX IF NOT EXISTS notifications_by_time ON notifications (uid, at DESC);
    `);
  }

  // Store `e` as the session's newest notification, unread.
  add(uid: string, e: SessionEvent): void {
    this.db.prepare(`
      INSERT INTO notifications (uid, session_key, id, kind, tab_type, project_id, session_id, title, summary, at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (uid, session_key) DO UPDATE SET
        id = excluded.id, kind = excluded.kind, tab_type = excluded.tab_type,
        session_id = excluded.session_id,
        title = COALESCE(excluded.title, notifications.title),
        summary = COALESCE(excluded.summary, notifications.summary),
        at = excluded.at, read_at = NULL
    `).run(uid, sessionKey(e), e.id, e.kind, e.tabType, e.projectId, e.sessionId, e.title, e.summary ?? null, e.at);
    this.prune(uid, e.at);
  }

  prune(uid: string, now: number): void {
    this.db.prepare('DELETE FROM notifications WHERE uid = ? AND at < ?').run(uid, now - KEEP_MS);
    this.db.prepare(`
      DELETE FROM notifications WHERE uid = ? AND session_key NOT IN (
        SELECT session_key FROM notifications WHERE uid = ? ORDER BY at DESC LIMIT ?
      )
    `).run(uid, uid, KEEP_MAX);
  }

  // Newest first. `before` pages back through older rows.
  list(uid: string, opts: { unreadOnly?: boolean; before?: number; limit?: number } = {}): InboxItem[] {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const rows = this.db.prepare(`
      SELECT * FROM notifications
      WHERE uid = ? AND at < ? ${opts.unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY at DESC LIMIT ?
    `).all(uid, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as Row[];
    return rows.map(fromRow);
  }

  unreadCount(uid: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE uid = ? AND read_at IS NULL').get(uid) as { n: number };
    return Number(r.n);
  }

  // Mark read by notification id, by session, or everything. Returns how
  // many rows changed (0 = nothing to tell other pages).
  markRead(uid: string, target: { ids?: string[]; sessions?: string[]; all?: boolean }, now: number): number {
    if (target.all) {
      return Number(this.db.prepare('UPDATE notifications SET read_at = ? WHERE uid = ? AND read_at IS NULL').run(now, uid).changes);
    }
    let n = 0;
    const byId = this.db.prepare('UPDATE notifications SET read_at = ? WHERE uid = ? AND id = ? AND read_at IS NULL');
    const byKey = this.db.prepare('UPDATE notifications SET read_at = ? WHERE uid = ? AND session_key = ? AND read_at IS NULL');
    for (const id of target.ids ?? []) n += Number(byId.run(now, uid, id).changes);
    for (const key of target.sessions ?? []) n += Number(byKey.run(now, uid, key).changes);
    return n;
  }

  remove(uid: string, ids: string[]): number {
    const stmt = this.db.prepare('DELETE FROM notifications WHERE uid = ? AND id = ?');
    let n = 0;
    for (const id of ids) n += Number(stmt.run(uid, id).changes);
    return n;
  }

  clear(uid: string): number {
    return Number(this.db.prepare('DELETE FROM notifications WHERE uid = ?').run(uid).changes);
  }

  close(): void { this.db.close(); }
}

let shared: InboxStore | null = null;
let openFailed = false;

export function inboxDbPath(): string {
  const dir = process.env.REMOTE_IDE_CONFIG_DIR || nodePath.join(nodeOs.homedir(), '.config', 'remote-ide');
  return nodePath.join(dir, 'notifications.db');
}

// The process-wide store, opened on first use. Null if SQLite can't open the
// file: notifications then still pop up, they just aren't kept.
export function inbox(): InboxStore | null {
  if (shared || openFailed) return shared;
  try {
    shared = new InboxStore(inboxDbPath());
  } catch (e) {
    console.error('[inbox] cannot open notifications.db:', e);
    openFailed = true;
    return null;
  }
  return shared;
}
