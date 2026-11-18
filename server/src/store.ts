import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ensureUser } from './users.js';

export type Project = {
  id: string;
  name: string;
  path: string;
  // Archived projects keep all their data but are hidden from the project
  // picker (model: entity Project.archived / web.ArchiveProject). Absent = false.
  archived?: boolean;
  createdAt: number;
};

export type Tab =
  | { id: string; type: 'file'; path: string }
  | { id: string; type: 'session'; resumeId?: string; title?: string }
  | { id: string; type: 'claude-sdk'; resumeId?: string; title?: string }
  | { id: string; type: 'devin'; resumeId?: string; title?: string };

// Review (model: entity Batch / Comment). A Batch collects Comments until the
// user sends the whole batch to a session as one prompt. A Comment may quote
// text from a session message; `anchor` is a panel-defined message anchor.
// TabRef: which tab a comment was written in (model: Comment.tab) —
// session/devin key = resumeId, file key = path, other kinds key = type.
export type TabRef = { type: string; key: string };
export type Comment = {
  id: string;
  text: string;
  createdAt: number;
  quote?: string;
  tab?: TabRef;
  anchor?: string;
};
export type Batch = {
  id: string;
  name: string;
  status: 'draft' | 'sent';
  comments: Comment[];
  createdAt: number;
  sentAt?: number;
};
export const MAX_QUOTE_LENGTH = 2000;
// Model: entity Bookmark — a ☆ on a session message: tab = the session, anchor
// = the panel's message anchor, label = the first 80 chars of the message.
export type Bookmark = {
  id: string;
  label: string;
  tab: TabRef;
  anchor: string;
  createdAt: number;
};
export const MAX_BOOKMARK_LABEL_LENGTH = 80;

export type ProjectWorkspace = {
  tabs: Tab[];
  batches: Batch[];
  bookmarks: Bookmark[];
};

export type Workspace = {
  projects: Record<string, ProjectWorkspace>;
};

export type Settings = {
  sendKey: 'enter' | 'cmd-enter' | 'shift-enter';
  theme: 'dark' | 'light' | 'dim';
  fontScale: 'small' | 'normal' | 'large' | 'xlarge' | 'huge' | 'xhuge';
  // claude CLI --model arg. '' = no override (claude CLI default).
  // Aliases: 'opus' | 'sonnet' | 'haiku'. Also accepts full model IDs.
  model: string;
  // claude CLI --effort arg. '' = no override (claude picks per-model default).
  effort: string;
  // Devin ACP model id. '' = let Devin pick its default.
  devinModel?: string;
  // Devin ACP mode id (bypass / accept-edits / ask / plan) applied to new
  // sessions via session/set_mode. '' = Devin's default (Code = accept-edits).
  devinMode?: string;
  // devin CLI version dir under ~/.local/share/devin/cli/_versions to spawn.
  // '' = auto (current symlink → newest installed → PATH). See devin-versions.ts.
  devinVersion?: string;
  // Client-only toggles, stored verbatim (server never reads them).
  showStderr?: boolean;
  // One-click rich copy of a reply (web.RichCopy). Default off.
  richCopy?: boolean;
  // Right-hand Review panel (web.ReviewPanel). Default off.
  review?: boolean;
  // Model: Session.children — give Claude (SDK) sessions the tools to open
  // and message child sessions. Default on (absent = on).
  childSessionTools?: boolean;
  // How many children of one session may work at once, and how deep child
  // sessions may nest (child-sessions.ts childLimits: defaults 10 and 2).
  childMaxRunning?: number;
  childMaxDepth?: number;
};

const DEFAULT_SETTINGS: Settings = {
  sendKey: 'cmd-enter',
  theme: 'dark',
  fontScale: 'normal',
  model: '',
  effort: '',
  devinModel: '',
  devinMode: '',
  devinVersion: '',
};

const CONFIG_DIR =
  process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide');
const USERS_DIR = path.join(CONFIG_DIR, 'users');

function userDir(uid: string): string { return path.join(USERS_DIR, uid); }
function projectsFile(uid: string): string { return path.join(userDir(uid), 'projects.json'); }
function workspaceFile(uid: string): string { return path.join(userDir(uid), 'workspace.json'); }
function settingsFile(uid: string): string { return path.join(userDir(uid), 'settings.json'); }
function sessionMetaFile(uid: string): string { return path.join(userDir(uid), 'session-meta.json'); }
function owedReportsFile(uid: string): string { return path.join(userDir(uid), 'child-reports.json'); }
function heldReportsFile(uid: string): string { return path.join(userDir(uid), 'child-reports-held.json'); }
function childTermsFile(uid: string): string { return path.join(userDir(uid), 'child-terms.json'); }

// Legacy single-user file locations — used only for the one-shot migration
// into the per-user tree on first start after the multi-user upgrade.
const LEGACY_PROJECTS = path.join(CONFIG_DIR, 'projects.json');
const LEGACY_WORKSPACE = path.join(CONFIG_DIR, 'workspace.json');
const LEGACY_SETTINGS = path.join(CONFIG_DIR, 'settings.json');

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e: any) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

// Serialize writes per destination path. Two concurrent writes to the same
// `file` used to share `file + '.tmp'`: both `writeFile` calls opened the tmp
// with O_TRUNC on independent fds and interleaved their writes, producing a
// "shorter payload + tail of longer payload" concatenation that then got
// renamed onto the real file. Reproduced in the wild when per-project PUT
// races the whole-workspace PUT from unload flush across browser windows.
const writeLocks = new Map<string, Promise<void>>();

async function writeJson(file: string, data: unknown) {
  const prev = writeLocks.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  });
  const guarded = next.catch(() => {});
  writeLocks.set(file, guarded);
  try {
    await next;
  } finally {
    if (writeLocks.get(file) === guarded) writeLocks.delete(file);
  }
}

export async function listProjects(uid: string): Promise<Project[]> {
  return readJson<Project[]>(projectsFile(uid), []);
}

export async function addProject(uid: string, input: { path: string; name?: string }): Promise<Project> {
  const abs = path.resolve(input.path.replace(/^~/, os.homedir()));
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) throw new Error('path is not a directory');
  const projects = await listProjects(uid);
  const existing = projects.find((p) => p.path === abs);
  if (existing) return existing;
  const project: Project = {
    id: randomUUID(),
    name: input.name?.trim() || path.basename(abs),
    path: abs,
    createdAt: Date.now(),
  };
  projects.push(project);
  await writeJson(projectsFile(uid), projects);
  return project;
}

export async function deleteProject(uid: string, id: string): Promise<void> {
  const projects = await listProjects(uid);
  const next = projects.filter((p) => p.id !== id);
  await writeJson(projectsFile(uid), next);
  const ws = await getWorkspace(uid);
  if (ws.projects[id]) {
    delete ws.projects[id];
    await writeJson(workspaceFile(uid), ws);
  }
}

// Model: server.UpdateProject — whitelisted fields only; null when the
// project does not exist. Never touches the workspace.
export async function updateProject(
  uid: string,
  id: string,
  patch: { archived?: boolean },
): Promise<Project | null> {
  const projects = await listProjects(uid);
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const next: Project = { ...projects[idx] };
  if (typeof patch.archived === 'boolean') {
    if (patch.archived) next.archived = true;
    else delete next.archived;
  }
  projects[idx] = next;
  await writeJson(projectsFile(uid), projects);
  return next;
}

// Model: server.ReorderProjects — `ids` must be a permutation of every
// project id the user has; the array order *is* the display order.
export async function reorderProjects(uid: string, ids: unknown): Promise<Project[]> {
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new Error('ids must be a string array');
  const projects = await listProjects(uid);
  const byId = new Map(projects.map((p) => [p.id, p]));
  if (ids.length !== projects.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
    throw new Error('ids must list every project exactly once');
  }
  const next = (ids as string[]).map((id) => byId.get(id)!);
  await writeJson(projectsFile(uid), next);
  return next;
}

export async function getProject(uid: string, id: string): Promise<Project | null> {
  const projects = await listProjects(uid);
  return projects.find((p) => p.id === id) ?? null;
}

// Canonical per-project slot shape: tabs, batches, bookmarks. Legacy fields
// are dropped: activeTabId (per-browser in localStorage now) and the removed
// tab Groups (`groups`, and `groupId` on each tab) — every tab of an old
// Group simply shows in the project's one tab bar.
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// Model: server.PutWorkspace — keep only well-formed batches / comments.
// Batch ids are unique per project; Comment ids are unique across all of the
// project's batches. Optional Comment fields that don't validate are dropped
// without dropping the Comment.
export function normalizeBatches(raw: unknown): Batch[] {
  const out: Batch[] = [];
  const seenBatches = new Set<string>();
  const seenComments = new Set<string>();
  for (const b of Array.isArray(raw) ? raw : []) {
    const { id, name, status } = (b ?? {}) as any;
    if (!nonEmptyString(id) || typeof name !== 'string' || seenBatches.has(id)) continue;
    if (status !== 'draft' && status !== 'sent') continue;
    seenBatches.add(id);
    const comments: Comment[] = [];
    for (const c of Array.isArray((b as any).comments) ? (b as any).comments : []) {
      const cid = c?.id;
      if (!nonEmptyString(cid) || typeof c.text !== 'string' || seenComments.has(cid)) continue;
      seenComments.add(cid);
      const comment: Comment = {
        id: cid,
        text: c.text,
        createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
      };
      if (typeof c.quote === 'string' && c.quote) comment.quote = c.quote.slice(0, MAX_QUOTE_LENGTH);
      if (nonEmptyString(c.tab?.type) && nonEmptyString(c.tab?.key)) {
        comment.tab = { type: c.tab.type, key: c.tab.key };
        if (nonEmptyString(c.anchor)) comment.anchor = c.anchor;
      }
      comments.push(comment);
    }
    const batch: Batch = {
      id,
      name,
      status,
      comments,
      createdAt: typeof (b as any).createdAt === 'number' ? (b as any).createdAt : Date.now(),
    };
    if (status === 'sent' && typeof (b as any).sentAt === 'number') batch.sentAt = (b as any).sentAt;
    out.push(batch);
  }
  return out;
}

// Model: server.PutWorkspace rule-445 / entity Bookmark rule-435. Drop any
// bookmark missing a non-empty id / label / anchor or a well-formed tab;
// dedupe by id; clamp the label; backfill createdAt.
export function normalizeBookmarks(raw: unknown): Bookmark[] {
  const out: Bookmark[] = [];
  const seen = new Set<string>();
  for (const b of Array.isArray(raw) ? raw : []) {
    const { id, label, anchor, tab, createdAt } = (b ?? {}) as any;
    if (!nonEmptyString(id) || !nonEmptyString(label) || !nonEmptyString(anchor) || seen.has(id)) continue;
    if (!nonEmptyString(tab?.type) || !nonEmptyString(tab?.key)) continue;
    seen.add(id);
    out.push({
      id,
      label: label.slice(0, MAX_BOOKMARK_LABEL_LENGTH),
      tab: { type: tab.type, key: tab.key },
      anchor,
      createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
    });
  }
  return out;
}

export function normalizeProjectWorkspace(pw: unknown): ProjectWorkspace {
  const raw = (pw ?? {}) as { tabs?: unknown; batches?: unknown; bookmarks?: unknown };
  const tabs = (Array.isArray(raw.tabs) ? raw.tabs : []).map((t) => {
    if (!t || typeof t !== 'object' || !('groupId' in t)) return t as Tab;
    const { groupId: _gone, ...rest } = t as Record<string, unknown>;
    return rest as Tab;
  });
  return { tabs, batches: normalizeBatches(raw.batches), bookmarks: normalizeBookmarks(raw.bookmarks) };
}

export async function getWorkspace(uid: string): Promise<Workspace> {
  // Strip any legacy active fields lurking in the file — schema dropped them
  // (they're now per-browser in localStorage).
  const raw = await readJson<any>(workspaceFile(uid), { projects: {} });
  const projects: Record<string, ProjectWorkspace> = {};
  for (const [id, pw] of Object.entries(raw?.projects ?? {})) {
    projects[id] = normalizeProjectWorkspace(pw);
  }
  return { projects };
}

export async function putWorkspace(uid: string, ws: Workspace): Promise<Workspace> {
  const clean: Workspace = {
    projects: Object.fromEntries(
      Object.entries(ws.projects ?? {}).map(([id, pw]) => [id, normalizeProjectWorkspace(pw)]),
    ),
  };
  await writeJson(workspaceFile(uid), clean);
  return clean;
}

// Per-project workspace update. Merges just one project's slot into the
// existing workspace file, so concurrent writes from multiple browser windows
// on different projects can't clobber each other's tab lists.
export async function putProjectWorkspace(
  uid: string,
  projectId: string,
  pw: ProjectWorkspace,
): Promise<ProjectWorkspace> {
  const existing = await getWorkspace(uid);
  const clean = normalizeProjectWorkspace(pw);
  existing.projects[projectId] = clean;
  await writeJson(workspaceFile(uid), existing);
  return clean;
}

// Rewrite every existing workspace.json through putWorkspace so the on-disk
// shape matches the current schema. Lazy migration via getWorkspace strips
// legacy `activeProjectId` / `activeTabId` only when a write happens, so users
// who haven't touched the app since the schema change still have stale fields
// in their file. Called once at server startup.
export async function sanitizeAllWorkspaces(): Promise<{ rewritten: number }> {
  let rewritten = 0;
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await fs.readdir(USERS_DIR, { withFileTypes: true });
  } catch {
    return { rewritten };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = workspaceFile(e.name);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch { continue; }
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch { continue; }
    const hasLegacyTop = 'activeProjectId' in (parsed ?? {});
    const hasLegacyNested = Object.values(parsed?.projects ?? {})
      .some((p) => p && typeof p === 'object' && 'activeTabId' in (p as any));
    if (!hasLegacyTop && !hasLegacyNested) continue;
    await putWorkspace(e.name, parsed);
    rewritten++;
  }
  return { rewritten };
}

export async function getSettings(uid: string): Promise<Settings> {
  const stored = await readJson<Partial<Settings>>(settingsFile(uid), {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function putSettings(uid: string, s: Settings): Promise<Settings> {
  const merged = { ...DEFAULT_SETTINGS, ...s };
  await writeJson(settingsFile(uid), merged);
  return merged;
}

// One-shot migration: if pre-multi-user files exist at the legacy paths and
// no users have been provisioned yet, create a default user named "eric"
// (password from REMOTE_IDE_PASSWORD env, falling back to a placeholder that
// forces a manual passwd reset) and move the existing state under that user.
// Idempotent — safe to call on every startup.
export async function migrateLegacyIfNeeded(): Promise<void> {
  const usersJson = path.join(CONFIG_DIR, 'users.json');
  const hasUsers = await fs.access(usersJson).then(() => true, () => false);
  const hasLegacy = await fs.access(LEGACY_PROJECTS).then(() => true, () => false);
  if (hasUsers || !hasLegacy) return;

  const password = process.env.REMOTE_IDE_PASSWORD;
  if (!password || password.length < 6) {
    // Refuse to migrate with a weak / missing password — the user would be
    // locked out of the migrated data. Surface the problem instead.
    throw new Error(
      'Legacy single-user state exists but REMOTE_IDE_PASSWORD is missing or <6 chars. ' +
      'Set it in .env then restart, or remove the legacy files manually.',
    );
  }

  const user = await ensureUser('eric', password);
  await fs.mkdir(userDir(user.id), { recursive: true });

  for (const [src, dst] of [
    [LEGACY_PROJECTS, projectsFile(user.id)],
    [LEGACY_WORKSPACE, workspaceFile(user.id)],
    [LEGACY_SETTINGS, settingsFile(user.id)],
  ] as const) {
    const exists = await fs.access(src).then(() => true, () => false);
    if (!exists) continue;
    const dstExists = await fs.access(dst).then(() => true, () => false);
    if (dstExists) continue; // user already populated, don't overwrite
    await fs.rename(src, dst);
  }
  // eslint-disable-next-line no-console
  console.log(`[remote-ide] migrated legacy single-user state → users/${user.id} (name=eric)`);
}

// Model: entity SessionMeta — what the Sessions list remembers about sessions
// on top of the agents' own stores: which ones the user archived (hidden from
// the list, nothing deleted) and display titles for sessions whose own store
// we don't write to (Devin). Keys are "<kind>:<sessionId>".
// parents (model: Session.parent): child session key → the session id of the
// session it was opened under ("New child session"). A child is a full
// session of its own; the link only places it in the Sessions tree.
// agentSpawned: child keys the parent's agent opened itself (spawn tool).
// Only those report the user's interventions back to the parent — a child
// the user opened by hand is unknown to the parent agent.
// groups: child key → the label its parent's agent filed it under when it
// opened several children as one batch (the Sessions tree nests them).
export type SessionMeta = { archived: string[]; titles: Record<string, string>; parents: Record<string, string>; agentSpawned: string[]; groups: Record<string, string> };

export function normalizeSessionMeta(raw: unknown): SessionMeta {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { archived?: unknown; titles?: unknown; parents?: unknown; agentSpawned?: unknown; groups?: unknown };
  const archived = Array.isArray(r.archived) ? [...new Set(r.archived.filter((k): k is string => typeof k === 'string'))] : [];
  const titles: Record<string, string> = {};
  if (r.titles && typeof r.titles === 'object') {
    for (const [k, v] of Object.entries(r.titles as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) titles[k] = v.trim();
    }
  }
  const parents: Record<string, string> = {};
  if (r.parents && typeof r.parents === 'object') {
    for (const [k, v] of Object.entries(r.parents as Record<string, unknown>)) {
      // A session is never its own parent.
      if (typeof v === 'string' && v && !k.endsWith(`:${v}`)) parents[k] = v;
    }
  }
  // Only linked children can be agent-spawned.
  const agentSpawned = Array.isArray(r.agentSpawned) ? [...new Set(r.agentSpawned.filter((k): k is string => typeof k === 'string' && k in parents))] : [];
  const groups: Record<string, string> = {};
  if (r.groups && typeof r.groups === 'object') {
    for (const [k, v] of Object.entries(r.groups as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim() && k in parents) groups[k] = v.trim().slice(0, 60);
    }
  }
  return { archived, titles, parents, agentSpawned, groups };
}

// Pure: the meta after `childKey` was opened as a child of session `parentId`.
// Refused (meta returned as is) when it would make a session its own
// ancestor.
export function setParent(meta: SessionMeta, childKey: string, parentId: string): SessionMeta {
  const kind = childKey.slice(0, childKey.indexOf(':'));
  const childId = childKey.slice(childKey.indexOf(':') + 1);
  const seen = new Set<string>([childId]);
  for (let p: string | undefined = parentId; p; p = meta.parents[`${kind}:${p}`]) {
    if (seen.has(p)) return meta;
    seen.add(p);
  }
  return { ...meta, parents: { ...meta.parents, [childKey]: parentId } };
}

// Model: Session.children — the reports child sessions still owe their
// parents, kept on disk so a server crash mid-turn doesn't leave a parent
// waiting for ever: on the next start each one is delivered as "interrupted".
// Keyed by the child's session id.
export type OwedReport = {
  parentId: string;
  projectId: string;
  cwd: string;
  title: string;
  // The parent's agent asked for the turn (spawn / send).
  requested: boolean;
  // What the user typed into the child during the turn.
  notes: string[];
};
export type OwedReports = Record<string, OwedReport>;

export function normalizeOwedReports(raw: unknown): OwedReports {
  const out: OwedReports = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, any>)) {
    if (!v || typeof v !== 'object' || typeof v.parentId !== 'string' || !v.parentId || typeof v.cwd !== 'string' || typeof v.projectId !== 'string') continue;
    out[id] = {
      parentId: v.parentId,
      projectId: v.projectId,
      cwd: v.cwd,
      title: typeof v.title === 'string' ? v.title : '',
      requested: v.requested === true,
      notes: Array.isArray(v.notes) ? v.notes.filter((n: unknown): n is string => typeof n === 'string') : [],
    };
  }
  return out;
}
export async function getOwedReports(uid: string): Promise<OwedReports> {
  return normalizeOwedReports(await readJson<unknown>(owedReportsFile(uid), {}));
}
export async function putOwedReports(uid: string, reports: OwedReports): Promise<void> {
  await writeJson(owedReportsFile(uid), normalizeOwedReports(reports));
}
// Model: Session.children "wait for all" — reports a parent asked to receive
// together, kept until its last working child has finished. Keyed by the
// parent's session id; on disk so a restart delivers what was collected.
export type HeldReports = Record<string, { projectId: string; cwd: string; reports: string[] }>;
export function normalizeHeldReports(raw: unknown): HeldReports {
  const out: HeldReports = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, any>)) {
    if (!v || typeof v !== 'object' || typeof v.projectId !== 'string' || typeof v.cwd !== 'string') continue;
    out[id] = { projectId: v.projectId, cwd: v.cwd, reports: Array.isArray(v.reports) ? v.reports.filter((x: unknown): x is string => typeof x === 'string') : [] };
  }
  return out;
}
export async function getHeldReports(uid: string): Promise<HeldReports> {
  return normalizeHeldReports(await readJson<unknown>(heldReportsFile(uid), {}));
}
export async function putHeldReports(uid: string, held: HeldReports): Promise<void> {
  await writeJson(heldReportsFile(uid), normalizeHeldReports(held));
}

// Model: Session.children — what a parent's agent set for a child when it
// opened it: the shape its answers must have. Keyed by
// the child's session id; on disk because it must hold again whenever the
// child's process is started anew.
export type ChildTerms = { resultSchema?: Record<string, unknown> };
export type ChildTermsMap = Record<string, ChildTerms>;
export const MAX_RESULT_SCHEMA_CHARS = 20_000;
export function normalizeChildTerms(raw: unknown): ChildTermsMap {
  const out: ChildTermsMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue;
    const t: ChildTerms = {};
    if (v.resultSchema && typeof v.resultSchema === 'object' && !Array.isArray(v.resultSchema)
      && JSON.stringify(v.resultSchema).length <= MAX_RESULT_SCHEMA_CHARS) t.resultSchema = v.resultSchema;
    if (t.resultSchema) out[id] = t;
  }
  return out;
}
export async function getChildTerms(uid: string): Promise<ChildTermsMap> {
  return normalizeChildTerms(await readJson<unknown>(childTermsFile(uid), {}));
}
export async function putChildTerms(uid: string, terms: ChildTermsMap): Promise<void> {
  await writeJson(childTermsFile(uid), normalizeChildTerms(terms));
}

export async function listUserIds(): Promise<string[]> {
  try { return (await fs.readdir(USERS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

export async function getSessionMeta(uid: string): Promise<SessionMeta> {
  return normalizeSessionMeta(await readJson<unknown>(sessionMetaFile(uid), {}));
}

export async function putSessionMeta(uid: string, meta: SessionMeta): Promise<SessionMeta> {
  const clean = normalizeSessionMeta(meta);
  await writeJson(sessionMetaFile(uid), clean);
  return clean;
}
