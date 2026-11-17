import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getUserId } from './auth.js';

// Claude subscription quota (the data behind the CLI's `/usage` panel).
//
// We ask the Agent SDK for it through a short-lived query that never sends a
// prompt: the usage control request only hits the claude.ai usage endpoint,
// so no model call is made and no tokens are spent. The process is closed as
// soon as the answer arrives. Independent of any open chat tab, so the badge
// works before the first message.
//
// The SDK method is marked experimental; everything that touches its shape is
// confined to mapUsage() so a rename/reshape breaks in one place.

const CACHE_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 30_000;

export type ClaudeQuotaWindow = {
  key: string;            // 'five_hour' | 'seven_day' | 'model:<name>' | ...
  label: string;          // human label, e.g. "5-hour", "Weekly · Fable"
  short: string;          // badge label, e.g. "5h", "wk", "Fable"
  usedPercent: number;    // 0-100
  resetAt: string | null; // ISO 8601
};
export type ClaudeUsage = {
  ok: true;
  plan: string | null;
  windows: ClaudeQuotaWindow[];
  fetchedAt: string;
};
type ClaudeUsageError = { ok: false; error: string };

function pct(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function windowOf(
  key: string, label: string, short: string,
  w: { utilization?: unknown; resets_at?: unknown } | null | undefined,
): ClaudeQuotaWindow | null {
  const used = pct(w?.utilization);
  if (used === null) return null;
  return { key, label, short, usedPercent: used, resetAt: typeof w?.resets_at === 'string' ? w.resets_at : null };
}

export function mapUsage(u: any): ClaudeUsage | ClaudeUsageError {
  if (!u?.rate_limits_available || !u?.rate_limits) return { ok: false, error: 'not_available' };
  const rl = u.rate_limits;
  const windows = [
    windowOf('five_hour', '5-hour', '5h', rl.five_hour),
    windowOf('seven_day', 'Weekly', 'wk', rl.seven_day),
    windowOf('seven_day_opus', 'Weekly · Opus', 'Opus', rl.seven_day_opus),
    windowOf('seven_day_sonnet', 'Weekly · Sonnet', 'Sonnet', rl.seven_day_sonnet),
    ...(Array.isArray(rl.model_scoped) ? rl.model_scoped : []).map((m: any) => {
      const name = String(m?.display_name ?? '').trim();
      return name ? windowOf(`model:${name}`, `Weekly · ${name}`, name, m) : null;
    }),
  ].filter((w): w is ClaudeQuotaWindow => w !== null);
  return {
    ok: true,
    plan: typeof u.subscription_type === 'string' ? u.subscription_type : null,
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchUsage(): Promise<ClaudeUsage | ClaudeUsageError> {
  // Input stream that stays open (and empty) until we close it.
  let release: () => void = () => {};
  const idle = new Promise<void>((r) => { release = r; });
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> { await idle; }

  const q = query({
    prompt: noPrompt(),
    options: {
      cwd: os.homedir(),
      settingSources: [],     // don't run the user's hooks / status line for a quota probe
      persistSession: false,  // and don't leave an empty session transcript behind
      pathToClaudeCodeExecutable: process.env.REMOTE_IDE_SDK_CLAUDE_PATH || undefined,
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const usage = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), UPSTREAM_TIMEOUT_MS); }),
    ]);
    return mapUsage(usage);
  } finally {
    if (timer) clearTimeout(timer);
    release();
    try { q.close(); } catch {}
  }
}

// Process-wide cache: the CLI's credentials are per-host, so every remote-ide
// user sees the same account's quota (same as devin-usage.ts).
let cache: { value: ClaudeUsage | ClaudeUsageError; at: number } | null = null;
let inFlight: Promise<ClaudeUsage | ClaudeUsageError> | null = null;

export async function getClaudeUsage(refresh = false): Promise<ClaudeUsage | ClaudeUsageError> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (!inFlight) {
    inFlight = fetchUsage()
      .then((v) => { cache = { value: v, at: Date.now() }; return v; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

export function registerClaudeUsageRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>('/api/claude/usage', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    try {
      return await getClaudeUsage(req.query.refresh === '1');
    } catch (e: any) {
      return reply.code(502).send({ ok: false, error: String(e?.message ?? e) });
    }
  });
}
