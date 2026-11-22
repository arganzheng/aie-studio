import { execFile } from 'node:child_process';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getUserId } from './auth.js';
import { getProject } from './store.js';
import { realPath } from './worktrees.js';

// Model: web.PreviewView / server.Preview — a dev server running on this
// machine (Vite on 5173, Next on 3000, …) shown in the side panel, from
// wherever aie-studio itself is opened (a phone, a tunnel). Everything goes
// through aie-studio's own address under /preview/<port>/ and its login:
//
// - HTTP and WebSocket requests under /preview/<port>/… are forwarded to
//   localhost:<port>/… — loopback only, IPv4 or IPv6 (dev servers often
//   listen on ::1 only) — never to aie-studio's own ports.
// - A page uses absolute paths (/src/main.ts, /@vite/client) that would hit
//   aie-studio. A service worker scoped to /preview/<port>/ (registered by a
//   boot page the tab opens first) puts the prefix back on every same-origin
//   request the page makes.
// - A script put at the top of every forwarded HTML page takes the prefix
//   off the address (history.replaceState), so the app's router sees its own
//   paths; prefixes WebSocket URLs (hot reload; a service worker never sees
//   those); and names the window `aie-preview:<port>`. A full reload or link
//   then lands on aie-studio's index.html, whose first script sees that name
//   and goes back under /preview/<port>/ (web/index.html).

export const PREVIEW_ROOT = '/preview/';
const AIE = '__aie';
const AUTH_COOKIE = 'ride_session';

// Pure: /preview/<port>/<rest> → the port and the rest (with its query).
// `bare`: just /preview/<port> with no slash after it.
export function previewTarget(url: string): { port: number; rest: string; bare: boolean } | null {
  const m = /^\/preview\/(\d{1,5})(\/[^]*)?$/.exec(url.split('#', 1)[0]);
  if (!m) {
    const q = /^\/preview\/(\d{1,5})(\?[^]*)$/.exec(url);
    if (q) return valid(Number(q[1])) ? { port: Number(q[1]), rest: '/' + q[2], bare: true } : null;
    return null;
  }
  const port = Number(m[1]);
  if (!valid(port)) return null;
  return { port, rest: m[2] ?? '/', bare: m[2] === undefined };
}
function valid(port: number): boolean { return port >= 1024 && port <= 65535; }

export function prefixOf(port: number): string { return `${PREVIEW_ROOT}${port}`; }

// Pure: an upstream Location header, as the browser must follow it.
export function rewriteLocation(loc: string, port: number): string {
  const p = prefixOf(port);
  if (loc.startsWith('/') && !loc.startsWith('//')) return loc.startsWith(p + '/') ? loc : p + loc;
  try {
    const u = new URL(loc);
    if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') && Number(u.port || 80) === port) {
      return p + u.pathname + u.search + u.hash;
    }
  } catch {}
  return loc;
}

// Pure: a Cookie header without aie-studio's own login cookie (the app has
// no business with it).
export function forwardCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header.split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith(`${AUTH_COOKIE}=`));
  return kept.length ? kept.join('; ') : undefined;
}

// Pure: the HTML with our script first in <head> (or first of all).
export function injectIntoHtml(html: string, tag: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doc = /<html(\s[^>]*)?>/i.exec(html);
  if (doc) return html.slice(0, doc.index + doc[0].length) + tag + html.slice(doc.index + doc[0].length);
  return tag + html;
}

// ---- what the browser runs ----

export function bootHtml(port: number): string {
  const p = prefixOf(port);
  return `<!doctype html><meta charset="utf-8"><title>Preview :${port}</title>
<style>body{font:13px -apple-system,system-ui,sans-serif;color:#888;background:transparent;margin:24px}</style>
<p id="m">Starting the preview of port ${port}…</p>
<script>
(async function () {
  var p = ${JSON.stringify(p)};
  var to = new URLSearchParams(location.search).get('to') || '/';
  if (to.charAt(0) !== '/') to = '/' + to;
  window.name = 'aie-preview:' + ${port};
  try {
    if (!('serviceWorker' in navigator)) throw new Error('this browser has no service workers (a private window?)');
    var reg = await navigator.serviceWorker.register(p + '/${AIE}/sw.js', { scope: p + '/' });
    var w = reg.installing || reg.waiting || reg.active;
    if (w && w.state !== 'activated') await new Promise(function (ok) { w.addEventListener('statechange', function () { if (w.state === 'activated') ok(); }); });
  } catch (e) {
    document.getElementById('m').textContent = 'The preview needs a service worker: ' + (e && e.message || e);
    return;
  }
  location.replace(p + to);
})();
</script>`;
}

export function swJs(port: number): string {
  const p = prefixOf(port);
  return `// aie-studio preview of port ${port}: puts ${p} back on the page's own requests.
var P = ${JSON.stringify(p)};
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (u.pathname === P || u.pathname.indexOf(P + '/') === 0) return;
  if (e.request.mode === 'navigate') return;
  e.respondWith(forward(e.request, P + u.pathname + u.search));
});
async function forward(req, url) {
  var init = { method: req.method, headers: req.headers, credentials: 'include', cache: req.cache === 'only-if-cached' ? 'default' : req.cache, redirect: 'follow' };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.blob();
  return fetch(url, init);
}
`;
}

export function injectJs(port: number): string {
  const p = prefixOf(port);
  return `(function () {
  var P = ${JSON.stringify(p)};
  window.name = 'aie-preview:' + ${port};
  var l = window.location;
  if (l.pathname === P || l.pathname.indexOf(P + '/') === 0) {
    try { history.replaceState(history.state, '', (l.pathname.slice(P.length) || '/') + l.search + l.hash); } catch (e) {}
  }
  var WS = window.WebSocket;
  if (WS && !WS.__aiePreview) {
    var Patched = function (url, protocols) {
      try {
        var u = new URL(url, l.href);
        if (u.host === l.host && u.pathname.indexOf(P + '/') !== 0) { u.pathname = P + u.pathname; url = u.toString(); }
      } catch (e) {}
      return protocols === undefined ? new WS(url) : new WS(url, protocols);
    };
    Patched.prototype = WS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { Patched[k] = WS[k]; });
    Patched.__aiePreview = true;
    window.WebSocket = Patched;
  }
})();
`;
}

// ---- forwarding ----

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);

function upstreamHeaders(req: http.IncomingMessage, port: number, ws: boolean): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (!ws && HOP.has(k)) continue;
    out[k] = v;
  }
  // Dev servers check the host (Vite's allowedHosts) and origin.
  out.host = `localhost:${port}`;
  if (out.origin) out.origin = `http://localhost:${port}`;
  if (typeof out.referer === 'string') {
    try { const r = new URL(out.referer); out.referer = `http://localhost:${port}${r.pathname.replace(new RegExp(`^${prefixOf(port)}(?=/|$)`), '') || '/'}${r.search}`; } catch { delete out.referer; }
  }
  const cookie = forwardCookie(req.headers.cookie);
  if (cookie) out.cookie = cookie; else delete out.cookie;
  // Plain bodies, so HTML can have the script put in.
  out['accept-encoding'] = 'identity';
  delete out['x-forwarded-for'];
  return out;
}

function sendSmallPage(res: http.ServerResponse, status: number, title: string, text: string) {
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title><style>html{background:#1e1e1e}body{font:14px -apple-system,system-ui,sans-serif;color:#aaa;margin:24px;line-height:1.6}code{color:#ddd;background:#2d2d2d;padding:1px 4px;border-radius:3px}</style><h3 style="color:#e6e6e6">${title}</h3><p>${text}</p>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Up to `max` characters of a response body, then stop reading it.
function readSome(r: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    r.setEncoding('utf8');
    r.on('data', (c: string) => { text += c; if (text.length >= max) { r.destroy(); resolve(text.slice(0, max)); } });
    r.on('end', () => resolve(text));
    r.on('error', () => resolve(text));
    r.on('close', () => resolve(text));
  });
}

function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, port: number, rest: string) {
  const up = http.request({ host: 'localhost', port, method: req.method, path: rest, headers: upstreamHeaders(req, port, false) }, (ur) => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(ur.headers)) {
      if (v === undefined || HOP.has(k)) continue;
      if (k === 'x-frame-options' || k === 'content-security-policy' || k === 'content-security-policy-report-only') continue;
      headers[k] = v;
    }
    if (typeof headers.location === 'string') headers.location = rewriteLocation(headers.location, port);
    if (Array.isArray(headers['set-cookie'])) headers['set-cookie'] = headers['set-cookie'].map((c) => c.replace(/;\s*domain=[^;]*/i, ''));
    const type = String(ur.headers['content-type'] ?? '');
    const status = ur.statusCode ?? 200;
    // Model: web.PreviewView — opening something that is not a page shows why,
    // not a blank frame: an error answered in plain text / JSON, or an empty page.
    const navigate = req.headers['sec-fetch-mode'] === 'navigate';
    if (navigate && status >= 400 && !/^text\/html/i.test(type)) {
      readSome(ur, 600).then((text) => sendSmallPage(res, status, `Port ${port} answered ${status}: this is not a web page`,
        `${text.trim() ? `It said: <code>${escapeHtml(text.trim().slice(0, 300))}</code><br>` : ''}It may be an API or a tool's internal port. Pick a dev server of your project (for example <code>pnpm dev</code>'s port) in ＋ → Preview.`));
      return;
    }
    if (/^text\/html/i.test(type) && req.method !== 'HEAD') {
      const chunks: Buffer[] = [];
      ur.on('data', (c: Buffer) => chunks.push(c));
      ur.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (navigate && !raw.trim() && !ur.headers['content-encoding']) {
          sendSmallPage(res, status, `Port ${port} sent an empty page`, 'It answered, but with nothing to show. It may be a tool\'s internal port rather than a web page.');
          return;
        }
        const html = injectIntoHtml(raw, `<script src="${prefixOf(port)}/${AIE}/inject.js"></script>`);
        delete headers['content-length'];
        delete headers['content-encoding'];
        headers['cache-control'] = 'no-store';
        res.writeHead(ur.statusCode ?? 200, headers);
        res.end(html);
      });
      ur.on('error', () => res.destroy());
      return;
    }
    res.writeHead(ur.statusCode ?? 200, headers);
    ur.pipe(res);
  });
  up.on('error', (e: NodeJS.ErrnoException) => {
    if (res.headersSent) { res.destroy(); return; }
    if (e.code === 'ECONNREFUSED') sendSmallPage(res, 502, `Nothing is running on port ${port}`, 'Start the dev server (or ask the agent to), then reload this tab.');
    else sendSmallPage(res, 502, `Port ${port} did not answer`, String(e.message));
  });
  req.pipe(up);
}

function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, port: number, rest: string) {
  const up = http.request({ host: 'localhost', port, method: req.method, path: rest, headers: upstreamHeaders(req, port, true) });
  up.on('upgrade', (ur, us, uhead) => {
    const lines = [`HTTP/1.1 ${ur.statusCode ?? 101} ${ur.statusMessage ?? 'Switching Protocols'}`];
    for (let i = 0; i < ur.rawHeaders.length; i += 2) lines.push(`${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (uhead?.length) socket.write(uhead);
    if (head?.length) us.write(head);
    us.pipe(socket);
    socket.pipe(us);
    us.on('error', () => socket.destroy());
    socket.on('error', () => us.destroy());
    us.on('close', () => socket.destroy());
    socket.on('close', () => us.destroy());
  });
  up.on('response', (ur) => {
    // Refused the upgrade: pass its answer on and close.
    socket.write(`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\nconnection: close\r\n\r\n`);
    socket.destroy();
  });
  up.on('error', () => { try { socket.write('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'); } catch {} socket.destroy(); });
  up.end();
}

// The socket and head @fastify/websocket stashed on an upgrade request
// (its symbols 'ws-socket' and 'ws-head').
function upgradeParts(raw: http.IncomingMessage): { socket: Duplex; head: Buffer } | null {
  let socket: Duplex | null = null;
  let head: Buffer = Buffer.alloc(0);
  for (const s of Object.getOwnPropertySymbols(raw)) {
    if (s.description === 'ws-socket') socket = (raw as any)[s];
    else if (s.description === 'ws-head' && Buffer.isBuffer((raw as any)[s])) head = (raw as any)[s];
  }
  return socket ? { socket, head } : null;
}

// ---- dev servers listening on this machine ----

export type ListeningPort = { port: number; pid: number; command: string; cwd: string | null; inProject: boolean; title?: string };

// Model: web.PreviewView launcher — only ports that serve a web page are worth
// offering: a monitoring endpoint (cloudflared's), a debugger port (Chrome's)
// or an API answers, but there is nothing to look at. Pure: does this answer
// to `GET /` look like a page? A redirect counts (dev servers send you to
// /login or /app), and so does a sign-in page (401 / 403). A 404 or other
// error at the root does not: there is no page to land on.
export function looksLikePage(status: number, contentType: string, bodyStart: string): boolean {
  if (status >= 300 && status < 400) return true;
  if (!/^text\/html/i.test(contentType) || !bodyStart.trim()) return false;
  return (status >= 200 && status < 300) || status === 401 || status === 403;
}

// Pure: the page's <title>, if it has one.
export function pageTitle(html: string): string | undefined {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const t = m?.[1].replace(/\s+/g, ' ').trim()
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return t ? t.slice(0, 120) : undefined;
}

const PROBE_MS = 1500;
const PROBE_BYTES = 16 * 1024;

// GET / on the port, as the preview would (same host); null = not a page.
function probePage(port: number): Promise<{ title?: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { title?: string } | null) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host: 'localhost', port, path: '/', headers: { accept: 'text/html,*/*;q=0.8', 'user-agent': 'aie-studio-preview-probe' }, timeout: PROBE_MS }, (res) => {
      const type = String(res.headers['content-type'] ?? '');
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.destroy(); finish({}); return; }
      if (!/^text\/html/i.test(type)) { res.destroy(); finish(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; if (body.length >= PROBE_BYTES) { res.destroy(); finish(looksLikePage(status, type, body) ? { title: pageTitle(body) } : null); } });
      res.on('end', () => finish(looksLikePage(status, type, body) ? { title: pageTitle(body) } : null));
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

// Pure: `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → port, pid, command.
export function parseLsof(out: string): Array<{ port: number; pid: number; command: string }> {
  const found = new Map<number, { port: number; pid: number; command: string }>();
  let pid = 0;
  let command = '';
  for (const line of out.split('\n')) {
    const t = line[0];
    const v = line.slice(1);
    if (t === 'p') pid = Number(v);
    else if (t === 'c') command = v;
    else if (t === 'n') {
      const m = /:(\d+)$/.exec(v);
      if (!m) continue;
      const host = v.slice(0, v.length - m[0].length);
      // Reachable from 127.0.0.1: loopback or every interface.
      if (!['*', '127.0.0.1', 'localhost', '[::1]', '[::]', '0.0.0.0'].includes(host)) continue;
      const port = Number(m[1]);
      if (valid(port) && !found.has(port)) found.set(port, { port, pid, command });
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (_e, out) => resolve(String(out ?? ''))));
}

async function cwdOf(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  const text = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

// ---- routes ----

export function registerPreviewRoutes(app: FastifyInstance, opts: { ownPorts: number[] }) {
  const own = new Set(opts.ownPorts.filter((p) => p > 0));

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith(PREVIEW_ROOT)) return;
    const t = previewTarget(req.url);
    if (!t) return;
    const raw = req.raw;
    const upgrade = String(raw.headers.upgrade ?? '').toLowerCase() === 'websocket' ? upgradeParts(raw) : null;
    const deny = (status: number, title: string, text: string) => {
      reply.hijack();
      if (upgrade) { upgrade.socket.write(`HTTP/1.1 ${status} ${title}\r\nconnection: close\r\n\r\n`); upgrade.socket.destroy(); return; }
      sendSmallPage(reply.raw, status, title, text);
    };
    if (!getUserId(req)) return deny(401, 'Log in to aie-studio first', 'The preview goes through aie-studio and needs its login.');
    if (own.has(t.port)) return deny(403, `Port ${t.port} is aie-studio itself`, 'Pick the port of the app you want to see.');
    if (upgrade) { reply.hijack(); proxyUpgrade(raw, upgrade.socket, upgrade.head, t.port, t.rest); return; }
    const p = prefixOf(t.port);
    if (t.bare) { reply.hijack(); reply.raw.writeHead(302, { location: `${p}${t.rest === '/' ? '/' : t.rest}` }); reply.raw.end(); return; }
    const path = t.rest.split('?', 1)[0];
    if (path === `/${AIE}/boot`) { reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); reply.raw.end(bootHtml(t.port)); return; }
    if (path === `/${AIE}/sw.js`) { reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'service-worker-allowed': `${p}/` }); reply.raw.end(swJs(t.port)); return; }
    if (path === `/${AIE}/inject.js`) { reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); reply.raw.end(injectJs(t.port)); return; }
    reply.hijack();
    proxyHttp(raw, reply.raw, t.port, t.rest);
  });

  // Dev servers listening on this machine that a preview could show; those
  // started from inside the project come first.
  app.get<{ Querystring: { project?: string } }>('/api/preview/ports', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = req.query.project ? await getProject(uid, req.query.project) : null;
    const root = project ? await realPath(project.path).catch(() => project.path) : null;
    const listening = parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])).filter((l) => !own.has(l.port) && l.pid !== process.pid);
    const cwds = await cwdOf([...new Set(listening.map((l) => l.pid))]);
    // One port per number (a server on both IPv4 and IPv6 is listed twice).
    const seen = new Set<number>();
    const unique = listening.filter((l) => !seen.has(l.port) && seen.add(l.port));
    const pages = await Promise.all(unique.map((l) => probePage(l.port)));
    const ports: ListeningPort[] = [];
    unique.forEach((l, i) => {
      const page = pages[i];
      if (!page) return;
      const cwd = cwds.get(l.pid) ?? null;
      ports.push({ ...l, cwd, inProject: !!(root && cwd && (cwd === root || cwd.startsWith(root + '/'))), ...(page.title ? { title: page.title } : {}) });
    });
    ports.sort((a, b) => Number(b.inProject) - Number(a.inProject) || a.port - b.port);
    return { ports, hidden: unique.length - ports.length };
  });
}
