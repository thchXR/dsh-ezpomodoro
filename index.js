/**
 * Host half of dsh-ezpomodoro.
 *
 * The clock, its chimes and the player live in the Client module. This half
 * adds one read-only loopback route, because the browser cannot read Bilibili's
 * favorites API directly (api.bilibili.com sends no CORS headers):
 *
 *   GET /plugin/pomodoro/fav?media_id=<id>
 *     -> { ok: true, mediaId, title, total, truncated, items: [{ bvid, title, duration }] }
 *     -> { ok: false, message }
 *
 * The address is a 收藏夹 id: the "ml<digits>" id in
 * https://www.bilibili.com/list/ml<id>, also accepted as the bare number.
 * Results are cached in memory for ten minutes so switching sources or
 * re-starting the timer does not hammer the upstream API.
 *
 * The second duty of this half is the macOS menu bar item (NSStatusItem). It
 * lives in a small Swift helper (menubar/menubar.swift) that this module
 * compiles on demand and spawns once, talking to it over line-delimited JSON
 * on stdio. The clock itself never leaves the browser: the Client posts the
 * current title on every tick and reads the clicked menu items back.
 *
 *   POST /plugin/pomodoro/menubar
 *     body { running: boolean, title: string, labels: { toggle, reset, panel } }
 *     -> { ok: true }
 *     -> { ok: false, reason, message }   (unsupported / no-toolchain / compile-failed)
 *
 *   GET /plugin/pomodoro/menubar/commands
 *     -> { ok: true, actions: ['toggle' | 'reset' | 'panel', ...] }
 *
 * The commands route takes the queue away, so each click is delivered once.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-ezpomodoro';

/** Required service: the route registry. */
export const inject = ['webServer'];

/** Route owned by this plugin. */
const FAV_ROUTE = '/plugin/pomodoro/fav';

const UPSTREAM = 'https://api.bilibili.com/x/v3/fav/resource/list';
const PAGE_SIZE = 20;
const MAX_ITEMS = 100;
const MAX_PAGES = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 8;
const UPSTREAM_TIMEOUT_MS = 8000;

/** Menu bar routes owned by this plugin. */
const MENUBAR_ROUTE = '/plugin/pomodoro/menubar';
const COMMANDS_ROUTE = MENUBAR_ROUTE + '/commands';

/** Package root, used to find the bundled Swift source. */
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const HELPER_SOURCE = path.join(PACKAGE_ROOT, 'menubar', 'menubar.swift');
const HELPER_CACHE_DIR = path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'storages', 'dsh-ezpomodoro');
const HELPER_BIN = path.join(HELPER_CACHE_DIR, 'menubar');

const COMPILE_TIMEOUT_MS = 60 * 1000;
const COMPILE_OUTPUT_LIMIT = 800;
const BODY_LIMIT = 64 * 1024;
const TITLE_LIMIT = 64;
const LABEL_LIMIT = 32;
const ACTION_LIMIT = 32;
const PENDING_LIMIT = 8;
const STDERR_LINES = 8;
const RESTART_LIMIT = 5;
const RESTART_BASE_MS = 3000;
const RESTART_MAX_MS = 30000;
const STOP_GRACE_MS = 500;
const STOP_KILL_MS = 2000;

/** mediaId -> { at, payload } */
const cache = new Map();

/** Last failed build, kept until the Swift source changes. */
let buildFailure = null;

/** Queued menu bar actions, drained by the commands route. */
let actions = [];

/** Live helper process, or null when none is running. */
let helper = null;

/** Commands written before the helper reported ready. */
let pending = [];

/** Consecutive restarts since the last ready event. */
let restartCount = 0;

/** Pending restart timer, or null. */
let restartTimer = null;

/** Set on dispose; stops restarts and new spawns. */
let disposed = false;

/** Whether the request arrived on a loopback Host. */
function loopbackHost(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  if (host.startsWith('[')) return host.startsWith('[::1]');
  const name = host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost';
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload) + '\n');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Headers that keep Bilibili from treating the request as a bot probe. */
function upstreamHeaders() {
  return {
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    referer: 'https://www.bilibili.com/',
    accept: 'application/json',
  };
}

/** Fetch one page of a favorites folder. */
async function fetchPage(mediaId, page) {
  const url = UPSTREAM + '?media_id=' + encodeURIComponent(mediaId) + '&pn=' + String(page) + '&ps=' + String(PAGE_SIZE) + '&platform=web';
  const response = await fetch(url, {
    headers: upstreamHeaders(),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Bilibili returned HTTP ' + String(response.status));
  const body = await response.json();
  if (body === null || typeof body !== 'object') throw new Error('Bilibili returned a malformed payload');
  if (body.code !== 0) throw new Error(typeof body.message === 'string' && body.message !== '' ? body.message : 'Bilibili error ' + String(body.code));
  return body.data;
}

/** Append the playable videos of one page. */
function pushMedia(items, data) {
  const medias = data !== null && typeof data === 'object' && Array.isArray(data.medias) ? data.medias : [];
  for (const media of medias) {
    if (items.length >= MAX_ITEMS) return;
    if (media === null || typeof media !== 'object') continue;
    const bvid = typeof media.bvid === 'string' ? media.bvid : '';
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue;
    const duration = Number(media.duration);
    items.push({
      bvid,
      title: String(media.title === undefined ? bvid : media.title).slice(0, 120),
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    });
  }
}

/** Read a folder: info plus up to MAX_ITEMS playable videos, cached. */
async function collectFavorites(mediaId) {
  const cached = cache.get(mediaId);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload;

  const first = await fetchPage(mediaId, 1);
  if (first === null || typeof first !== 'object' || first.info === undefined || first.info === null) {
    throw new Error('收藏夹不存在，或需要登录才能查看');
  }
  const info = first.info;
  const total = Number.isFinite(Number(info.media_count)) ? Number(info.media_count) : 0;
  const items = [];
  pushMedia(items, first);

  const pages = Math.min(MAX_PAGES, Math.ceil(Math.min(total, MAX_ITEMS) / PAGE_SIZE));
  for (let page = 2; page <= pages && items.length < MAX_ITEMS; page += 1) {
    const data = await fetchPage(mediaId, page);
    pushMedia(items, data);
    const medias = data !== null && typeof data === 'object' && Array.isArray(data.medias) ? data.medias : [];
    if (medias.length < PAGE_SIZE) break;
  }

  const payload = {
    ok: true,
    mediaId,
    title: String(info.title === undefined ? '收藏夹' : info.title),
    total,
    truncated: total > items.length,
    items,
  };

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(mediaId, { at: Date.now(), payload });
  return payload;
}

/** Serve the favorites route. */
async function serveFavorites(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, message: 'method not allowed' });
    return;
  }
  if (!loopbackHost(req)) {
    sendJson(res, 403, { ok: false, message: 'loopback only' });
    return;
  }
  let requested = '';
  try {
    requested = new URL(req.url === undefined ? '/' : req.url, 'http://localhost').searchParams.get('media_id') || '';
  } catch (error) {
    sendJson(res, 400, { ok: false, message: 'bad request' });
    return;
  }
  if (!/^[0-9]{4,20}$/.test(requested)) {
    sendJson(res, 400, { ok: false, message: 'media_id must be the numeric favorites id' });
    return;
  }
  try {
    sendJson(res, 200, await collectFavorites(requested));
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** mtime of a path in milliseconds, or null when it does not exist. */
function mtimeOf(target) {
    try {
        return statSync(target).mtimeMs;
    } catch {
        return null;
    }
}

/** Keep the tail of the compiler output, small enough to show in a response. */
function trimCompilerOutput(stdout, stderr) {
    const lines = String(stderr || '') + '\n' + String(stdout || '');
    const kept = lines
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .slice(-6);
    return kept.join(' | ').slice(0, COMPILE_OUTPUT_LIMIT);
}

/** Record a build failure against the source mtime that produced it. */
function rememberFailure(mtimeMs, reason, message) {
    buildFailure = { mtimeMs, reason, message };
    return { ok: false, reason, message };
}

/**
 * Resolve the helper binary, compiling it when missing or out of date.
 * A failure is remembered until menubar.swift changes, so a missing toolchain
 * costs one attempt per source revision instead of one per tick.
 */
function ensureBinary() {
    const override = process.env.DSH_POMODORO_HELPER_BIN;
    if (typeof override === 'string' && override !== '') {
        // Test hook and troubleshooting path: run a prebuilt helper instead.
        return { ok: true, bin: override };
    }

    const sourceMtime = mtimeOf(HELPER_SOURCE);
    if (buildFailure !== null && buildFailure.mtimeMs === sourceMtime) {
        return { ok: false, reason: buildFailure.reason, message: buildFailure.message };
    }

    const binMtime = mtimeOf(HELPER_BIN);
    if (binMtime !== null && (sourceMtime === null || binMtime >= sourceMtime)) {
        return { ok: true, bin: HELPER_BIN };
    }
    if (sourceMtime === null) {
        return rememberFailure(sourceMtime, 'compile-failed', 'menubar/menubar.swift is missing');
    }

    // swiftc's default clang module cache can be unwritable (sandboxed or
    // headless hosts), so keep it inside our own storage directory.
    const moduleCache = path.join(HELPER_CACHE_DIR, 'swift-module-cache');
    try {
        mkdirSync(moduleCache, { recursive: true });
    } catch (error) {
        return rememberFailure(sourceMtime, 'compile-failed', 'cannot create the cache directory: ' + String(error));
    }

    const built = spawnSync('swiftc', ['-O', '-module-cache-path', moduleCache, HELPER_SOURCE, '-o', HELPER_BIN], {
        timeout: COMPILE_TIMEOUT_MS,
        encoding: 'utf8',
    });
    if (built.error !== undefined && built.error !== null) {
        if (built.error.code === 'ENOENT') return rememberFailure(sourceMtime, 'no-toolchain', 'swiftc is not installed');
        return rememberFailure(sourceMtime, 'compile-failed', String(built.error.message) + ' ' + trimCompilerOutput(built.stdout, built.stderr));
    }
    if (built.status !== 0) {
        const output = trimCompilerOutput(built.stdout, built.stderr);
        return rememberFailure(sourceMtime, 'compile-failed', output === '' ? 'swiftc exited with ' + String(built.status) : output);
    }

    buildFailure = null;
    return { ok: true, bin: HELPER_BIN };
}

/** Append one menu bar action, dropping the oldest when the queue is full. */
function pushAction(action) {
    if (actions.length >= ACTION_LIMIT) actions.shift();
    actions.push(action);
}

/** Take the queued actions and clear the queue. */
function takeActions() {
    const taken = actions;
    actions = [];
    return taken;
}

/** Write one command line to the helper's stdin. */
function sendCommand(record, command) {
    try {
        record.proc.stdin.write(JSON.stringify(command) + '\n');
    } catch (error) {
        console.error('[dsh-ezpomodoro] menu bar helper write failed: ' + String(error));
    }
}

/** Queue a command until the helper reports ready. */
function post(command) {
    if (disposed) return;
    if (helper !== null && helper.ready) {
        sendCommand(helper, command);
        return;
    }
    if (pending.length >= PENDING_LIMIT) pending.shift();
    pending.push(command);
}

/** Hand the queued commands to a helper that just became ready. */
function flushPending(record) {
    const queued = pending;
    pending = [];
    for (const command of queued) sendCommand(record, command);
}

/** Handle one stdout line of the helper protocol. */
function handleLine(record, line) {
    const text = line.trim();
    if (text === '') return;
    let message;
    try {
        message = JSON.parse(text);
    } catch {
        return;
    }
    if (message === null || typeof message !== 'object') return;

    if (message.event === 'ready') {
        record.ready = true;
        restartCount = 0;
        flushPending(record);
        return;
    }
    if (message.event === 'action') {
        const action = message.action;
        if (action === 'toggle' || action === 'reset' || action === 'panel') pushAction(action);
        return;
    }
    if (message.event === 'error') {
        console.warn('[dsh-ezpomodoro] menu bar helper error: ' + String(message.message));
    }
}

/** Arm one restart with exponential backoff, up to RESTART_LIMIT in a row. */
function scheduleRestart(bin, code, signal) {
    if (restartCount >= RESTART_LIMIT) {
        console.warn('[dsh-ezpomodoro] menu bar helper exited (' + String(code) + '/' + String(signal) + '); not restarting');
        return;
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** restartCount, RESTART_MAX_MS);
    restartCount += 1;
    restartTimer = setTimeout(() => {
        restartTimer = null;
        if (disposed) return;
        startHelper(bin);
    }, delay);
    restartTimer.unref();
}

/** Spawn the helper when none is running. */
function startHelper(bin) {
    if (disposed || helper !== null) return helper;

    let proc;
    try {
        proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
        console.error('[dsh-ezpomodoro] menu bar helper spawn failed: ' + String(error));
        return null;
    }

    const record = { proc, ready: false, buffer: '', stderr: [], timers: [] };
    helper = record;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
        record.buffer += chunk;
        let index = record.buffer.indexOf('\n');
        while (index !== -1) {
            handleLine(record, record.buffer.slice(0, index));
            record.buffer = record.buffer.slice(index + 1);
            index = record.buffer.indexOf('\n');
        }
        if (record.buffer.length > 8192) record.buffer = '';
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
            const text = line.trim();
            if (text === '') continue;
            record.stderr.push(text);
            if (record.stderr.length > STDERR_LINES) record.stderr.shift();
        }
    });

    proc.stdin.on('error', () => {});
    proc.on('error', (error) => {
        console.error('[dsh-ezpomodoro] menu bar helper error: ' + String(error));
    });
    proc.on('exit', (code, signal) => {
        for (const timer of record.timers) clearTimeout(timer);
        record.timers = [];
        if (helper === record) helper = null;
        if (record.stderr.length > 0) {
            console.warn('[dsh-ezpomodoro] menu bar helper stderr: ' + record.stderr.join(' | '));
        }
        if (disposed) return;
        scheduleRestart(bin, code, signal);
    });

    return record;
}

/** Clear the lifecycle state so a reloaded plugin can start the helper again. */
function resetHelper() {
    disposed = false;
    restartCount = 0;
    actions = [];
    pending = [];
}

/** Quit the helper: send quit, wait briefly, then SIGTERM and SIGKILL. */
function stopHelper() {
    disposed = true;
    if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    pending = [];
    const record = helper;
    helper = null;
    if (record === null) return;

    const proc = record.proc;
    try {
        proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
        proc.stdin.end();
    } catch {
        // The helper is already gone.
    }
    const alive = () => proc.exitCode === null && proc.signalCode === null;
    record.timers.push(
        setTimeout(() => {
            if (alive()) proc.kill('SIGTERM');
        }, STOP_GRACE_MS),
    );
    record.timers.push(
        setTimeout(() => {
            if (alive()) proc.kill('SIGKILL');
        }, STOP_KILL_MS),
    );
}

/** Truncate to a number of characters, not UTF-16 units. */
function clip(text, limit) {
    const points = Array.from(text);
    return points.length <= limit ? text : points.slice(0, limit).join('');
}

/** Read a request body, refusing anything above the limit. */
function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                const error = new Error('payload too large');
                error.code = 'too-large';
                reject(error);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** Validate and clip a show/hide body, or null when the shape is wrong. */
function parseShowPayload(raw) {
    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        return null;
    }
    if (body === null || typeof body !== 'object') return null;
    if (typeof body.running !== 'boolean') return null;
    if (typeof body.title !== 'string') return null;
    const labels = body.labels;
    if (labels === null || typeof labels !== 'object') return null;
    if (typeof labels.toggle !== 'string' || typeof labels.reset !== 'string' || typeof labels.panel !== 'string') return null;
    return {
        running: body.running,
        title: clip(body.title, TITLE_LIMIT),
        labels: {
            toggle: clip(labels.toggle, LABEL_LIMIT),
            reset: clip(labels.reset, LABEL_LIMIT),
            panel: clip(labels.panel, LABEL_LIMIT),
        },
    };
}

/** Push the posted state into the helper. */
async function showMenuBar(req, res) {
    if (process.platform !== 'darwin') {
        sendJson(res, 200, { ok: false, reason: 'unsupported', message: 'the menu bar helper is macOS only' });
        return;
    }

    let raw;
    try {
        raw = await readBody(req, BODY_LIMIT);
    } catch (error) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined;
        const tooLarge = code === 'too-large';
        sendJson(res, tooLarge ? 413 : 400, {
            ok: false,
            reason: tooLarge ? 'too-large' : 'bad-request',
            message: error instanceof Error ? error.message : String(error),
        });
        return;
    }

    const payload = parseShowPayload(raw);
    if (payload === null) {
        sendJson(res, 400, {
            ok: false,
            reason: 'bad-request',
            message: 'body must be { running: boolean, title: string, labels: { toggle, reset, panel } }',
        });
        return;
    }

    const binary = ensureBinary();
    if (!binary.ok) {
        sendJson(res, 200, { ok: false, reason: binary.reason, message: binary.message });
        return;
    }

    const record = startHelper(binary.bin);
    if (record === null) {
        sendJson(res, 200, { ok: false, reason: 'spawn-failed', message: 'could not start the menu bar helper' });
        return;
    }

    if (payload.running) post({ cmd: 'show', title: payload.title, labels: payload.labels });
    else post({ cmd: 'hide' });

    sendJson(res, 200, { ok: true });
}

/** Serve the menu bar prefix: show/hide plus the action queue. */
async function serveMenuBar(req, res) {
    if (!loopbackHost(req)) {
        sendJson(res, 403, { ok: false, message: 'loopback only' });
        return;
    }

    let pathname;
    try {
        pathname = new URL(req.url === undefined ? '/' : req.url, 'http://localhost').pathname;
    } catch {
        sendJson(res, 400, { ok: false, message: 'bad request' });
        return;
    }

    if (pathname === COMMANDS_ROUTE || pathname === COMMANDS_ROUTE + '/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, message: 'method not allowed' });
            return;
        }
        sendJson(res, 200, { ok: true, actions: takeActions() });
        return;
    }

    if (pathname === MENUBAR_ROUTE || pathname === MENUBAR_ROUTE + '/') {
        if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, message: 'method not allowed' });
            return;
        }
        await showMenuBar(req, res);
        return;
    }

    sendJson(res, 404, { ok: false, message: 'not found' });
}

/**
 * Register both routes for this plugin's lifetime, and own the helper process.
 * @param ctx - the host plugin context carrying webServer.
 */
export function apply(ctx) {
  resetHelper();
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: FAV_ROUTE, handler: serveFavorites }),
    'dsh-ezpomodoro: favorites route',
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: MENUBAR_ROUTE, handler: serveMenuBar }),
    'dsh-ezpomodoro: menu bar route',
  );
  ctx.effect(() => stopHelper, 'dsh-ezpomodoro: menu bar helper');
}

export default { name, inject, apply };
