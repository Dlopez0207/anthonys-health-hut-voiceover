#!/usr/bin/env node
// Anthony's Health Hut - offline staging server (Phase 2, SPEC.md section "Staging server").
//
//   node fixed/staging/server.mjs [--refresh] [--offline] [--verbose]
//
//   http://localhost:4173  FIXED     live snapshot + editor-sim transforms + Head HTML (fixed/head-html.html) + /ada-files/*
//   http://localhost:4174  BASELINE  the same snapshot proxy with no changes
//
// Upstream: https://www.anthonyshealthhutlakeland.com (GET only, at most one live request per second, disk snapshot cache).
// Nothing but GET ever reaches the live origin: every other method is answered locally (the Duda contact form endpoint
// is mocked, everything else gets 204). See README.md for the full contract, flags and environment variables.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const SERVER_ID = 'ahh-staging';
const UPSTREAM = 'https://www.anthonyshealthhutlakeland.com';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXED_DIR = path.resolve(HERE, '..');
const P = {
  cache: path.join(HERE, 'cache'),
  logs: path.join(HERE, 'logs'),
  overrides: path.join(HERE, 'overrides'),
  menu: path.join(FIXED_DIR, 'menu'),
  // STAGING_HEAD_HTML / STAGING_EDITOR_SIM exist only to test the server itself on other ports; normal runs use the defaults.
  headHtml: path.resolve(process.env.STAGING_HEAD_HTML || path.join(FIXED_DIR, 'head-html.html')),
  editorSim: path.resolve(process.env.STAGING_EDITOR_SIM || path.join(FIXED_DIR, 'editor', 'editor-sim.mjs')),
};
P.editorDir = path.dirname(P.editorSim);

// Same user agents as baseline/browser.mjs (used when a client sends none, e.g. curl).
const DEFAULT_UA = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

const argv = process.argv.slice(2);
const env = process.env;
const OPTS = {
  refresh: argv.includes('--refresh'),
  offline: argv.includes('--offline') || env.STAGING_OFFLINE === '1',
  verbose: argv.includes('--verbose') || env.STAGING_VERBOSE === '1',
  ports: { fixed: Number(env.STAGING_FIXED_PORT || 4173), baseline: Number(env.STAGING_BASELINE_PORT || 4174) },
  // Hard floor of one live request per second, whatever the environment says.
  liveIntervalMs: Math.max(1000, Number(env.STAGING_LIVE_INTERVAL_MS || 1000)),
  formMockDefault: env.STAGING_FORM_MOCK === 'error' ? 'error' : 'success',
  editorOnError: env.STAGING_EDITOR_ON_ERROR === 'passthrough' ? 'passthrough' : 'fail',
  editorBust: env.STAGING_EDITOR_BUST === 'always' ? 'always' : 'stamp',
};

// The Duda runtime posts the contact form with fetch() to this path (duda-runtime.js, actualSubmitForm/getFormPath):
//   POST /_dm/s/rt/api/public/rt/site/<SiteAlias>/contactForm?hiddenCaptcha=<bool>&sendTracking=true
const FORM_ENDPOINT_RE = /^\/_dm\/s\/rt\/api\/public\/rt\/site\/[^/]+\/contactForm\/?$/;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const vlog = (...a) => { if (OPTS.verbose) log(...a); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = (s, n = 16) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------
function deviceFromUA(ua = '') { return /iPhone|Android|Mobile/i.test(ua) ? 'mobile' : 'desktop'; }

// Page-like = what Duda serves as a page (no file extension, not an API/runtime path). Pages are cached by path only:
// the query string is ignored for them (?mock=error and similar flags never reach the live origin).
function looksLikePage(pathname) {
  return !/^\/(_dm|__staging|api|ada-files)(\/|$)/.test(pathname) && !/\.[a-z0-9]{1,8}$/i.test(pathname);
}

// Absolute links to the live origin (https, http, protocol-relative, also JSON-escaped "https:\/\/") -> local origin.
// URL-encoded copies (e.g. a share link parameter) are not navigation targets and are left alone.
const ORIGIN_RE = /(https?:)?(\\?\/\\?\/)(?:www\.)?anthonyshealthhutlakeland\.com(?![\w-]|\.[a-z])/gi;
function rewriteOrigin(text, localHost) {
  return text.replace(ORIGIN_RE, (m, proto, slashes) => (proto ? 'http:' : '') + slashes + localHost);
}

function isTextual(ct = '') { return /^text\/|json|javascript|xml|ecmascript/i.test(ct); }

async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

function appendLog(name, obj) {
  fs.mkdirSync(P.logs, { recursive: true });
  fs.appendFile(path.join(P.logs, name), JSON.stringify(obj) + '\n', () => {});
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

function sanitizeSegment(seg) {
  const s = seg.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_');
  return (s === '' || s === '.' || s === '..') ? '_' : s;
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot cache:  cache/<desktop|mobile>/<path>.html + cache/<device>/meta.json   (pages)
//                  cache/assets/<device>/<hash>-<name> + cache/assets/<device>/meta.json   (same-origin non-HTML)
// ---------------------------------------------------------------------------------------------------------------
class MetaStore {
  constructor(file) { this.file = file; this.data = {}; this.chain = Promise.resolve(); }
  load() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
    return this;
  }
  get(key) { return this.data[key]; }
  usedFiles() { return new Map(Object.entries(this.data).filter(([, v]) => v.file).map(([k, v]) => [v.file.toLowerCase(), k])); }
  set(key, value) {
    this.data[key] = value;
    const snapshot = JSON.stringify(Object.fromEntries(Object.entries(this.data).sort(([a], [b]) => a.localeCompare(b))), null, 1);
    this.chain = this.chain.then(() => writeAtomic(this.file, snapshot)).catch(e => log('meta write failed', this.file, e.message));
    return this.chain;
  }
  count() { return Object.keys(this.data).length; }
}

const STORES = {};
for (const d of ['desktop', 'mobile']) {
  STORES[d] = {
    pages: new MetaStore(path.join(P.cache, d, 'meta.json')).load(),
    assets: new MetaStore(path.join(P.cache, 'assets', d, 'meta.json')).load(),
  };
}

function pageFileFor(device, key, store) {
  const [pathname, search = ''] = key.split(/\?(.*)/s);
  let rel = safeDecode(pathname).split('/').filter(Boolean).map(sanitizeSegment).join('/');
  if (!rel) rel = 'index';
  if (search) rel += `__q${sha(search, 10)}`;
  let file = `${device}/${rel}.html`;
  const owner = store.usedFiles().get(file.toLowerCase());
  if (owner && owner !== key) file = `${device}/${rel}__${sha(key, 10)}.html`; // e.g. "/x" vs "/x/"
  return file;
}

function assetFileFor(device, key) {
  const base = sanitizeSegment(safeDecode(key.split('?')[0].split('/').pop() || 'root')).slice(-60);
  return `assets/${device}/${sha(key)}-${base}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Live fetches: GET only, serialized, >= liveIntervalMs between request starts, identical requests coalesced.
// ---------------------------------------------------------------------------------------------------------------
let lastLiveStart = 0;
let liveChain = Promise.resolve();
const liveStats = { count: 0, last: null };
function liveSlot() {
  const turn = liveChain.then(async () => {
    const wait = lastLiveStart + OPTS.liveIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastLiveStart = Date.now();
  });
  liveChain = turn.catch(() => {});
  return turn;
}

const FORWARD_REQ_HEADERS = ['user-agent', 'accept', 'accept-language', 'sec-ch-ua-mobile'];
// Response headers kept from upstream (Set-Cookie and transport headers are dropped).
const KEEP_RES_HEADERS = ['content-type', 'cache-control', 'expires', 'last-modified', 'link', 'speculation-rules',
  'x-frame-options', 'x-content-type-options', 'content-security-policy', 'location', 'vary'];

async function fetchLive(upstreamPath, device, reqHeaders, reason) {
  await liveSlot();
  const headers = { 'accept-encoding': 'identity' }; // no cookies are ever forwarded
  for (const h of FORWARD_REQ_HEADERS) if (reqHeaders[h]) headers[h] = reqHeaders[h];
  if (!headers['user-agent']) headers['user-agent'] = DEFAULT_UA[device];
  const url = UPSTREAM + upstreamPath;
  const t0 = Date.now();
  const at = new Date(t0).toISOString();
  try {
    const res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
    const body = Buffer.from(await res.arrayBuffer());
    const kept = {};
    for (const h of KEEP_RES_HEADERS) { const v = res.headers.get(h); if (v != null) kept[h] = v; }
    liveStats.count++; liveStats.last = at;
    appendLog('live-requests.jsonl', { at, method: 'GET', url, device, ua: headers['user-agent'], status: res.status, bytes: body.length, ms: Date.now() - t0, reason });
    log(`LIVE GET ${upstreamPath} [${device}] -> ${res.status} ${body.length} B (${reason})`);
    return { status: res.status, headers: kept, body, ua: headers['user-agent'], at };
  } catch (e) {
    liveStats.count++; liveStats.last = at;
    appendLog('live-requests.jsonl', { at, method: 'GET', url, device, ua: headers['user-agent'], error: e.message, ms: Date.now() - t0, reason });
    log(`LIVE GET ${upstreamPath} [${device}] FAILED: ${e.message}`);
    throw e;
  }
}

const inflight = new Map();
const refreshedThisRun = new Set();

async function getEntry(device, pathname, search, reqHeaders) {
  const pageLike = looksLikePage(pathname);
  const key = pageLike ? pathname : pathname + search;
  const st = STORES[device];
  const id = `${device} ${key}`;
  const forceRefresh = reqHeaders['x-staging-refresh'] === '1' || (OPTS.refresh && !refreshedThisRun.has(id));
  const cached = st.pages.get(key) ? { store: 'pages', meta: st.pages.get(key) } : (st.assets.get(key) ? { store: 'assets', meta: st.assets.get(key) } : null);
  if (cached && !forceRefresh) return { ...cached, key, cache: 'hit' };
  if (OPTS.offline) {
    if (cached) return { ...cached, key, cache: 'hit-offline' };
    return { offlineMiss: true, key };
  }
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const reason = cached ? 'refresh' : 'miss';
    let live;
    try {
      live = await fetchLive(pageLike ? pathname : pathname + search, device, reqHeaders, reason);
    } catch (e) {
      if (cached) return { ...cached, key, cache: 'hit-stale' }; // refresh failed: keep serving the snapshot
      throw e;
    }
    refreshedThisRun.add(id);
    if (live.status >= 500 || live.status === 429) {
      return cached ? { ...cached, key, cache: 'hit-stale' } : { transient: live, key, cache: 'error' };
    }
    const ct = live.headers['content-type'] || '';
    const isHtml = /text\/html/i.test(ct);
    const storeName = (isHtml || (pageLike && live.status >= 300 && live.status < 400)) ? 'pages' : 'assets';
    const store = st[storeName];
    let file = null;
    if (live.body.length || isHtml) {
      file = storeName === 'pages' ? pageFileFor(device, key, store) : assetFileFor(device, key);
      await writeAtomic(path.join(P.cache, file), live.body);
    }
    const meta = { url: UPSTREAM + (pageLike ? pathname : pathname + search), file, status: live.status, contentType: ct,
      bytes: live.body.length, fetchedAt: live.at, ua: live.ua, device, headers: live.headers };
    await store.set(key, meta);
    return { store: storeName, meta, key, cache: reason };
  })();
  inflight.set(id, job);
  try { return await job; } finally { inflight.delete(id); }
}

// ---------------------------------------------------------------------------------------------------------------
// FIXED-mode transforms: editor-sim.mjs (dynamic import, cache-busted) + Head HTML injection
// ---------------------------------------------------------------------------------------------------------------
const EDITOR_STUB = `// Pass-through STUB created by fixed/staging/server.mjs because editor-sim.mjs did not exist yet.
// The real file (simulations of the Duda editor changes E1-E6, see SPEC.md) replaces this one; the server never
// overwrites an existing editor-sim.mjs. Contract used by the staging server on every FIXED (4173) HTML response:
//   export function transform(html, { path, device, mode }) -> html
//     html   = raw live snapshot (live-origin URLs not yet rewritten; the server localizes them afterwards)
//     path   = request pathname, e.g. "/" or "/contact-us"
//     device = "desktop" | "mobile"
//     mode   = "fixed"
export const STUB = true;

export function transform(html) {
  return html;
}
`;

function ensureEditorStub() {
  try {
    fs.mkdirSync(P.editorDir, { recursive: true });
    fs.writeFileSync(P.editorSim, EDITOR_STUB, { flag: 'wx' }); // 'wx' = fail if it exists: never overwrite
    log(`created pass-through stub ${P.editorSim}`);
    return 'created';
  } catch (e) {
    if (e.code === 'EEXIST') return 'exists';
    log('could not create editor-sim stub:', e.message);
    return 'error';
  }
}

async function editorStamp() {
  // Cache-busting key, recomputed on every request: latest mtime + size of every file under fixed/editor/.
  // Any edit to editor-sim.mjs (or a file next to it) changes the key, so the next request imports a fresh copy.
  if (OPTS.editorBust === 'always') return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const parts = [];
  const walk = async dir => {
    for (const d of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const f = path.join(dir, d.name);
      if (d.isDirectory()) await walk(f);
      else { const s = await fsp.stat(f).catch(() => null); if (s) parts.push(`${d.name}:${s.mtimeMs}:${s.size}`); }
    }
  };
  await walk(P.editorDir);
  return sha(parts.sort().join('|'), 12);
}

let editorCache = { url: null, mod: null };
async function loadEditor() {
  if (!fs.existsSync(P.editorSim)) return null;
  const url = `${pathToFileURL(P.editorSim).href}?v=${await editorStamp()}`;
  if (url !== editorCache.url) {
    const mod = await import(url);
    editorCache = { url, mod };
  }
  return editorCache.mod;
}

async function runEditor(html, ctx) {
  const mod = await loadEditor();
  if (!mod) return { html, status: 'missing' };
  if (typeof mod.transform !== 'function') throw new Error('editor-sim.mjs does not export transform(html, {path, device, mode})');
  const out = await mod.transform(html, ctx);
  if (typeof out !== 'string') throw new Error(`editor-sim transform returned ${typeof out}, expected a string`);
  return { html: out, status: mod.STUB === true ? 'stub' : 'applied' };
}

async function readHeadHtml() {
  try { return await fsp.readFile(P.headHtml, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// The real </head>: skip comments and raw-text elements. Duda pages contain the literal text "...INSIDE THE </HEAD>
// ELEMENT" in a comment (the site's existing Head HTML), which a naive search would hit first.
function findHeadClose(html) {
  const re = /<!--[\s\S]*?-->|<(script|style|textarea|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/head\s*>/gi;
  let m;
  while ((m = re.exec(html))) if (/^<\/head/i.test(m[0])) return m.index;
  return -1;
}

function injectHead(html, block) {
  const at = findHeadClose(html);
  if (at < 0) return { html, status: 'no-head-tag' };
  return { html: html.slice(0, at) + block + html.slice(at), status: 'injected' };
}

// ?mock=success-inline: drop data-success-page from .dmform-success so the runtime shows the inline success
// message instead of navigating to /thank-you (the live form's real setting). Opt-in, documented, both modes.
function stripSuccessPage(html) {
  return html.replace(/<div\b[^>]*\bclass="[^"]*\bdmform-success\b[^"]*"[^>]*>/g, tag => tag.replace(/\s+data-success-page="[^"]*"/, ''));
}

// ---------------------------------------------------------------------------------------------------------------
// Local endpoints: contact-form mock, other non-GET requests, /ada-files, health
// ---------------------------------------------------------------------------------------------------------------
const formLog = [];
const notForwarded = { count: 0, recent: [] };

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n <= limit) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function formMockMode(req) {
  const h = String(req.headers['x-staging-mock'] || '').toLowerCase();
  if (h === 'error' || h === 'success') return { mode: h, source: 'header x-staging-mock' };
  const ref = req.headers.referer || '';
  try {
    const q = new URL(ref).searchParams.get('mock');
    if (q === 'error') return { mode: 'error', source: 'page query ?mock=error' };
    if (q === 'success' || q === 'success-inline') return { mode: 'success', source: `page query ?mock=${q}` };
  } catch { /* no referer */ }
  return { mode: OPTS.formMockDefault, source: env.STAGING_FORM_MOCK ? 'env STAGING_FORM_MOCK' : 'default' };
}

async function handleFormMock(mode, req, res, u) {
  const body = (await readBody(req)).toString('utf8');
  const { mode: result, source } = formMockMode(req);
  const fields = Object.fromEntries(new URLSearchParams(body));
  const entry = {
    at: new Date().toISOString(), server: mode, method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams),
    contentType: req.headers['content-type'] || null, referer: req.headers.referer || null, result, resultSource: source,
    fields, bodyBytes: Buffer.byteLength(body),
  };
  formLog.push(entry); if (formLog.length > 200) formLog.shift();
  appendLog('form-mock.jsonl', entry);
  log(`FORM MOCK ${req.method} ${u.pathname}${u.search} -> ${result} (${source}) [not forwarded]`);
  const status = result === 'error' ? 500 : 200;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-staging-mock': result });
  res.end(JSON.stringify({ stagingMock: true, success: result !== 'error' }));
}

async function handleNotForwarded(mode, req, res, u) {
  const body = await readBody(req);
  notForwarded.count++;
  const entry = { at: new Date().toISOString(), server: mode, method: req.method, path: u.pathname + u.search, bytes: body.length };
  notForwarded.recent.push(entry); if (notForwarded.recent.length > 50) notForwarded.recent.shift();
  appendLog('not-forwarded.jsonl', entry);
  vlog(`NOT FORWARDED ${req.method} ${u.pathname}`);
  res.writeHead(204, { 'cache-control': 'no-store', 'x-staging': 'not-forwarded' });
  res.end();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.xml': 'application/xml' };

async function handleAdaFiles(req, res, u) {
  const rel = safeDecode(u.pathname.slice('/ada-files/'.length));
  for (const base of [P.overrides, P.menu]) { // staging/overrides wins over fixed/menu
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep)) continue;
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) continue;
    const body = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length, 'cache-control': 'no-store', 'x-staging-file': path.relative(FIXED_DIR, file).replace(/\\/g, '/') });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : `Not found in fixed/staging/overrides or fixed/menu: ${rel}\n`);
}

const STARTED_AT = new Date().toISOString();
let EDITOR_STUB_STATE = 'unknown';
async function health(mode, port) {
  const head = await fsp.stat(P.headHtml).catch(() => null);
  let editor = { present: fs.existsSync(P.editorSim) };
  if (mode === 'fixed' && editor.present) {
    try { const m = await loadEditor(); editor = { present: true, stub: m?.STUB === true, exportsTransform: typeof m?.transform === 'function' }; }
    catch (e) { editor = { present: true, error: e.message }; }
  }
  return {
    ok: true, server: SERVER_ID, version: VERSION, mode, port, pid: process.pid, startedAt: STARTED_AT, upstream: UPSTREAM,
    ports: OPTS.ports, refresh: OPTS.refresh, offline: OPTS.offline, liveIntervalMs: OPTS.liveIntervalMs,
    cache: Object.fromEntries(Object.entries(STORES).map(([d, s]) => [d, { pages: s.pages.count(), assets: s.assets.count() }])),
    liveRequests: liveStats,
    headHtml: mode === 'fixed' ? { present: !!head, bytes: head?.size ?? 0, mtime: head?.mtime ?? null } : 'not used',
    editorSim: mode === 'fixed' ? { ...editor, stubCreatedAtStart: EDITOR_STUB_STATE === 'created', onError: OPTS.editorOnError, bust: OPTS.editorBust } : 'not used',
    formMock: { endpoint: 'POST /_dm/s/rt/api/public/rt/site/<SiteAlias>/contactForm', default: OPTS.formMockDefault, recorded: formLog.length },
    notForwarded: { count: notForwarded.count },
  };
}

function sendJson(res, status, obj, method) {
  const body = Buffer.from(JSON.stringify(obj, null, 1));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
  res.end(method === 'HEAD' ? undefined : body);
}

function localHostFor(req, port) {
  const h = String(req.headers.host || '');
  return /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/i.test(h) && h.endsWith(`:${port}`) ? h : `localhost:${port}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------------------------------------------
async function handle(mode, port, req, res) {
  const u = new URL(req.url, `http://localhost:${port}`);
  const method = req.method.toUpperCase();
  const localHost = localHostFor(req, port);

  if (u.pathname === '/__staging/health') return sendJson(res, 200, await health(mode, port), method);
  if (u.pathname === '/__staging/form-log') return sendJson(res, 200, { server: SERVER_ID, entries: formLog }, method);
  if (u.pathname === '/__staging/not-forwarded') return sendJson(res, 200, { server: SERVER_ID, ...notForwarded }, method);

  if (method !== 'GET' && method !== 'HEAD') {
    if (method === 'POST' && FORM_ENDPOINT_RE.test(u.pathname)) return handleFormMock(mode, req, res, u);
    return handleNotForwarded(mode, req, res, u);
  }

  if (u.pathname.startsWith('/ada-files/')) {
    if (mode === 'fixed') return handleAdaFiles(req, res, u);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('/ada-files/ is only served by the FIXED server (4173).\n');
  }

  const device = deviceFromUA(req.headers['user-agent']);
  let entry;
  try {
    entry = await getEntry(device, u.pathname, u.search, req.headers);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(`Live fetch failed: ${e.message}\n`);
  }
  if (entry.offlineMiss) {
    res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-staging-cache': 'offline-miss' });
    return res.end(`Not in the snapshot cache (offline mode): ${device} ${entry.key}\n`);
  }
  if (entry.transient) {
    res.writeHead(entry.transient.status, { 'content-type': entry.transient.headers['content-type'] || 'text/plain', 'cache-control': 'no-store', 'x-staging-cache': 'not-cached' });
    return res.end(method === 'HEAD' ? undefined : entry.transient.body);
  }

  const meta = entry.meta;
  const base = {
    'x-staging-mode': mode, 'x-staging-device': device, 'x-staging-cache': entry.cache, 'x-staging-fetched-at': meta.fetchedAt,
  };

  if (meta.status >= 300 && meta.status < 400) {
    const loc = meta.headers?.location ? rewriteOrigin(meta.headers.location, localHost) : '/';
    res.writeHead(meta.status, { ...base, location: loc, 'cache-control': 'no-store' });
    return res.end();
  }

  let body = meta.file ? await fsp.readFile(path.join(P.cache, meta.file)) : Buffer.alloc(0);
  const ct = meta.contentType || 'application/octet-stream';
  const headers = { ...base, 'content-type': ct };

  if (/text\/html/i.test(ct)) {
    let html = body.toString('utf8');
    if (mode === 'fixed') {
      try {
        const ed = await runEditor(html, { path: u.pathname, device, mode: 'fixed' });
        html = ed.html; headers['x-staging-editor'] = ed.status;
      } catch (e) {
        log(`EDITOR-SIM ERROR on ${u.pathname} [${device}]: ${e.stack || e.message}`);
        headers['x-staging-editor'] = 'error';
        if (OPTS.editorOnError === 'fail') {
          res.writeHead(500, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(`fixed/editor/editor-sim.mjs failed on ${u.pathname} [${device}]:\n${e.stack || e.message}\n` +
            '(set STAGING_EDITOR_ON_ERROR=passthrough to serve the page without editor transforms)\n');
        }
      }
      const block = await readHeadHtml();
      if (block == null) headers['x-staging-head-html'] = 'missing';
      else { const r = injectHead(html, block); html = r.html; headers['x-staging-head-html'] = r.status; }
    }
    if (u.searchParams.get('mock') === 'success-inline') { html = stripSuccessPage(html); headers['x-staging-form'] = 'success-inline'; }
    html = rewriteOrigin(html, localHost);
    body = Buffer.from(html, 'utf8');
    for (const h of ['link', 'speculation-rules', 'x-frame-options', 'x-content-type-options', 'content-security-policy']) {
      if (meta.headers?.[h]) headers[h] = rewriteOrigin(meta.headers[h], localHost);
    }
    headers['cache-control'] = 'no-store'; // Head HTML / editor-sim edits must show on the next load
  } else {
    if (isTextual(ct)) body = Buffer.from(rewriteOrigin(body.toString('utf8'), localHost), 'utf8');
    headers['cache-control'] = meta.headers?.['cache-control'] || 'public, max-age=300';
  }
  headers['content-length'] = body.length;
  res.writeHead(meta.status, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------------------------------------------------------
// Startup: exit 0 if both ports are already served by this server; otherwise start what is missing.
// ---------------------------------------------------------------------------------------------------------------
// node:http (no keep-alive) rather than fetch: an open undici socket at process exit trips a libuv assertion on Windows.
function probe(host, port) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/__staging/health', agent: false, timeout: 2000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve(j?.server === SERVER_ID ? { state: 'ours', info: j } : { state: 'other' });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ state: 'other' }); });
    req.on('error', () => resolve({ state: 'unreachable' }));
  });
}

function listen(handler, port, host) {
  return new Promise(resolve => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 5000;
    s.once('error', error => resolve({ host, error }));
    s.listen(port, host, () => resolve({ host, server: s }));
  });
}

async function startMode(mode, port) {
  const handler = (req, res) => handle(mode, port, req, res).catch(e => {
    log(`ERROR ${req.method} ${req.url}: ${e.stack || e.message}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`staging server error: ${e.message}\n`);
  });
  const v4 = await listen(handler, port, '127.0.0.1');
  if (v4.error) return { mode, port, error: v4.error };
  const v6 = await listen(handler, port, '::1');
  if (v6.error && v6.error.code === 'EADDRINUSE') {
    v4.server.close();
    return { mode, port, error: new Error(`[::1]:${port} is used by another program (localhost could reach it instead of this server)`) };
  }
  if (v6.error) log(`note: IPv6 loopback not available for ${port} (${v6.error.code}); serving on 127.0.0.1 only`);
  return { mode, port, servers: [v4.server, v6.server].filter(Boolean) };
}

async function main() {
  const wanted = [['fixed', OPTS.ports.fixed], ['baseline', OPTS.ports.baseline]];
  const status = {};
  for (const [mode, port] of wanted) {
    const a = await probe('127.0.0.1', port);
    const b = a.state === 'ours' ? a : await probe('::1', port);
    status[mode] = a.state === 'ours' || b.state === 'ours' ? { state: 'ours', info: (a.info || b.info) } : (a.state === 'other' || b.state === 'other' ? { state: 'other' } : { state: 'free' });
    if (status[mode].state === 'ours' && status[mode].info?.mode !== mode) status[mode] = { state: 'other' };
  }
  if (wanted.every(([m]) => status[m].state === 'ours')) {
    console.log(`Staging server already running (pid ${status.fixed.info.pid}): FIXED http://localhost:${OPTS.ports.fixed}  BASELINE http://localhost:${OPTS.ports.baseline}. Nothing to do.`);
    process.exitCode = 0;
    return;
  }
  const busy = wanted.filter(([m]) => status[m].state === 'other');
  if (busy.length) {
    console.error(`Port(s) ${busy.map(([, p]) => p).join(', ')} already used by another program (not this staging server). Free them and retry.`);
    process.exitCode = 1;
    return;
  }

  EDITOR_STUB_STATE = ensureEditorStub();
  fs.mkdirSync(P.overrides, { recursive: true });
  fs.mkdirSync(P.logs, { recursive: true });

  const started = [];
  for (const [mode, port] of wanted) {
    if (status[mode].state === 'ours') { log(`${mode.toUpperCase()} already served on ${port} by pid ${status[mode].info.pid}; not starting it again`); continue; }
    const r = await startMode(mode, port);
    if (r.error) {
      console.error(`Could not start ${mode.toUpperCase()} on ${port}: ${r.error.message}`);
      for (const s of started.flatMap(x => x.servers)) s.close();
      process.exitCode = 1;
      return;
    }
    started.push(r);
  }
  log(`Staging server v${VERSION} pid ${process.pid}`);
  for (const r of started) log(`  ${r.mode.toUpperCase().padEnd(8)} http://localhost:${r.port}`);
  log(`  upstream ${UPSTREAM} (GET only, >= ${OPTS.liveIntervalMs} ms between live requests${OPTS.offline ? ', OFFLINE: cache only' : ''}${OPTS.refresh ? ', --refresh: each cached URL refetched once' : ''})`);
  log(`  cache ${P.cache}  pages desktop=${STORES.desktop.pages.count()} mobile=${STORES.mobile.pages.count()}`);
  log(`  editor-sim: ${EDITOR_STUB_STATE === 'created' ? 'pass-through stub created' : 'existing file used'}; head-html: ${fs.existsSync(P.headHtml) ? 'present' : 'missing (nothing injected)'}`);

  const shutdown = async sig => {
    log(`${sig}: closing`);
    for (const s of started.flatMap(x => x.servers)) s.close();
    await Promise.all(Object.values(STORES).flatMap(s => [s.pages.chain, s.assets.chain]));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

await main();
