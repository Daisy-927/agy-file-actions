/*
 * Optional CDP fallback injector for AGY File Actions.
 *
 * Useful when running Antigravity with `--remote-debugging-port` without
 * modifying `resources/app/index.cjs` or installing `DWrite.dll`.
 *
 * Usage:
 *   node --no-warnings ./scripts/runtime-injector.mjs
 *   node --no-warnings ./scripts/runtime-injector.mjs --once
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  CDP_STATUS_FILE,
  SETTINGS_FILE,
  discoverApplications,
  isBlockedNetworkOrDevicePath,
  launchApplication,
  listDir,
  loadSettings,
  readFileBytes,
  resolveCandidatePaths,
  resolveConversationContext,
  revealInExplorer,
  saveSettings,
  statFile
} from './windows-file-ops.mjs';
import { createPreviewServer } from './preview-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const VENDOR_CLIENT_FILE = path.join(ROOT_DIR, 'vendor', 'dsh-file-actions-client.js');
const OVERLAY_FILE = path.join(ROOT_DIR, 'scripts', 'agy-file-actions-overlay.js');
const USER_HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const PORT_FILES = [
  process.env.AGY_CDP_PORT_FILE,
  path.join(USER_HOME, 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'),
  path.join(USER_HOME, '.gemini', 'antigravity', 'DevToolsActivePort')
].filter(Boolean);
const ONCE = process.argv.includes('--once');
const POLL_MS = Math.max(500, Number(process.env.AGY_RUNTIME_POLL_MS || 1500));
const ATTACHED = new Map();

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function readDevtoolsAddresses() {
  const configured = String(process.env.AGY_CDP_URL || '').trim();
  if (configured) {
    const parsed = new URL(configured);
    if (!isLoopbackHost(parsed.hostname) || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('AGY_CDP_URL must point to a local http(s) endpoint');
    }
    return [configured.replace(/\/$/, '')];
  }
  const candidates = [];
  const seen = new Set();
  const push = (u) => {
    const clean = String(u || '').replace(/\/$/, '');
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      candidates.push(clean);
    }
  };
  for (const file of PORT_FILES) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) push(`http://127.0.0.1:${port}`);
    } catch {}
  }
  push('http://127.0.0.1:9222');
  return candidates;
}

function getBundle() {
  const vendorSrc = fs.readFileSync(VENDOR_CLIENT_FILE, 'utf8');
  const overlaySrc = fs.readFileSync(OVERLAY_FILE, 'utf8');
  return `
(() => {
  const prevLoader = window.__ModuleLoader__;
  window.__ModuleLoader__ = {
    load(def) { globalThis.__AGY_DSH_FILE_ACTIONS_FACTORY__ = def.factory; }
  };
  try {
${vendorSrc}
  } finally {
    if (prevLoader === undefined) delete window.__ModuleLoader__;
    else window.__ModuleLoader__ = prevLoader;
  }
})();
${overlaySrc}
//# sourceURL=agy-file-actions-bundle.js
`;
}

function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(wsUrl);
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || !isLoopbackHost(endpoint.hostname)) {
      reject(new Error('CDP target must be loopback'));
      return;
    }
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('open', () => {
      resolve({
        call(method, params = {}, timeoutMs = 30000) {
          const id = ++seq;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP timeout: ${method}`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (v) => { clearTimeout(timer); res(v); },
              reject: (e) => { clearTimeout(timer); rej(e); }
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { ws.close(); } catch {} }
      });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (!msg.id) return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
      else entry.resolve(msg.result || {});
    });
    ws.addEventListener('error', () => reject(new Error('CDP socket error')));
  });
}

const shellFallback = {
  openPath: async (absPath) => {
    if (process.platform !== 'win32') return 'unsupported';
    try {
      const child = spawn('explorer.exe', [path.normalize(absPath)], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return '';
    } catch (err) {
      return err?.message || 'failed';
    }
  }
};

function writeCdpStatus(extra = {}) {
  try {
    fs.mkdirSync(path.dirname(CDP_STATUS_FILE), { recursive: true });
    fs.writeFileSync(
      CDP_STATUS_FILE,
      JSON.stringify({ active: true, mode: 'cdp', pid: process.pid, updatedAt: new Date().toISOString(), ...extra }, null, 2),
      'utf8'
    );
  } catch {}
}

function resolveExistingCandidate(rawPath, ctx) {
  const candidates = resolveCandidatePaths(rawPath, ctx?.roots || [], ctx);
  if (!candidates.length) return '';
  return candidates.find((c) => fs.existsSync(c)) || candidates[0] || '';
}

function openPreviewUrlInBrowser(previewUrl) {
  if (!/^https?:\/\/127\.0\.0\.1:\d+\//i.test(String(previewUrl || ''))) return false;
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [previewUrl], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  }
  return false;
}

const previewServer = createPreviewServer();

export async function handleRpc(req, targetUrl = '', options = {}) {
  const method = req?.method;
  const params = req?.params || {};
  const cid = req?.conversationId || params?.sessionId || '';
  const pageUrl = targetUrl || req?.pageUrl || '';
  const ctx = resolveConversationContext(cid, pageUrl);
  const shellApi = options.shell || shellFallback;

  if (method === 'getSession') return { id: ctx.id, cwd: ctx.cwd, roots: ctx.roots, outsideProject: ctx.outsideProject, wsl: ctx.wsl };
  if (method === 'getSettings') return loadSettings();
  if (method === 'saveSettings') return saveSettings(params);
  if (method === 'stat') return statFile(ctx, params.path);
  if (method === 'list') return listDir(ctx, params.path);
  if (method === 'readBytes') return readFileBytes(ctx, params.path, params.options || {});
  if (method === 'applications') {
    const st = await statFile(ctx, params.path);
    const absPath = st.ok ? st.value.absolutePath : resolveExistingCandidate(params.path, ctx);
    if (!absPath) return { ok: true, value: [] };
    return { ok: true, value: await discoverApplications(absPath) };
  }
  if (method === 'open') {
    const st = await statFile(ctx, params.path);
    const absPath = st.ok ? st.value.absolutePath : resolveExistingCandidate(params.path, ctx);
    if (!absPath) return { ok: false, error: { code: 'invalid-path' } };
    const ok = await launchApplication(absPath, params.appId, shellApi);
    return ok ? { ok: true, value: { opened: true } } : { ok: false };
  }
  if (method === 'previewInBrowser') {
    const st = await statFile(ctx, params.path);
    const absPath = st.ok ? st.value.absolutePath : resolveExistingCandidate(params.path, ctx);
    if (!absPath || isBlockedNetworkOrDevicePath(absPath) || !fs.existsSync(absPath)) {
      return { ok: false };
    }
    const item = await previewServer.registerItem(absPath);
    if (!item) return { ok: false };
    const opened = options.openUrl ? await options.openUrl(item.previewUrl) : openPreviewUrlInBrowser(item.previewUrl);
    return opened ? { ok: true, value: { opened: true, previewUrl: item.previewUrl } } : { ok: false };
  }
  if (method === 'reveal') {
    const st = await statFile(ctx, params.path);
    const absPath = st.ok ? st.value.absolutePath : resolveExistingCandidate(params.path, ctx);
    if (!absPath) return { ok: false, error: { code: 'invalid-path' } };
    const ok = await revealInExplorer(absPath, shellApi);
    return ok ? { ok: true, value: { revealed: true } } : { ok: false };
  }
  throw new Error(`Unknown RPC method: ${method}`);
}

export async function closePreviewServer() {
  await previewServer.close();
}

const LIVE_SESSIONS = new Set();

function startSettingsWatcher() {
  const settingsDir = path.dirname(SETTINGS_FILE);
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let timer = null;
    const watcher = fs.watch(settingsDir, (_event, filename) => {
      if (filename && String(filename).toLowerCase() !== 'settings.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const latest = loadSettings();
        const expr = `globalThis.__AGY_FA_BRIDGE__?.applyHostSettings(${JSON.stringify(latest)})`;
        for (const cdp of LIVE_SESSIONS) {
          void cdp.call('Runtime.evaluate', { expression: expr }).catch(() => {});
        }
      }, 150);
    });
    watcher.unref?.();
  } catch {}
}

async function attachTarget(target, baseUrl) {
  const cdp = await cdpSession(target.webSocketDebuggerUrl);
  LIVE_SESSIONS.add(cdp);
  await cdp.call('Runtime.enable');
  await cdp.call('Runtime.evaluate', { expression: getBundle() });
  const cidMatch = /\/c\/([^/?#]+)/.exec(target.url || '');
  writeCdpStatus({
    active: true,
    stage: 'attached',
    cdpUrl: baseUrl,
    url: target.url || '',
    conversationId: cidMatch ? decodeURIComponent(cidMatch[1]) : ''
  });
  console.log(`[agy-file-actions] CDP attached: ${target.id} ${target.url}`);

  if (ONCE) {
    LIVE_SESSIONS.delete(cdp);
    writeCdpStatus({ active: false, stage: 'once-detached', cdpUrl: baseUrl });
    cdp.close();
    return;
  }

  try {
    while (ATTACHED.has(target.id)) {
      const res = await cdp.call(
        'Runtime.evaluate',
        {
          expression: `globalThis.__AGY_FA_BRIDGE__?.waitRequest()`,
          awaitPromise: true,
          returnByValue: true
        },
        30000
      );
      const batch = res?.result?.value;
      if (!Array.isArray(batch) || batch.length === 0) continue;
      await Promise.allSettled(
        batch.map(async (req) => {
          if (!req?.id) return;
          try {
            const payload = await handleRpc(req, target.url);
            await cdp.call('Runtime.evaluate', {
              expression: `globalThis.__AGY_FA_BRIDGE__?.deliverResponse(${JSON.stringify(req.id)}, true, ${JSON.stringify(payload)})`
            });
          } catch (err) {
            await cdp.call('Runtime.evaluate', {
              expression: `globalThis.__AGY_FA_BRIDGE__?.deliverResponse(${JSON.stringify(req.id)}, false, ${JSON.stringify(err?.message || 'error')})`
            }).catch(() => {});
          }
        })
      );
    }
  } finally {
    LIVE_SESSIONS.delete(cdp);
    ATTACHED.delete(target.id);
    if (ATTACHED.size === 0) {
      writeCdpStatus({ active: false, stage: 'idle', cdpUrl: baseUrl });
    }
    cdp.close();
  }
}

function isConversationTarget(target) {
  if (!target || target.type !== 'page') return false;
  try {
    const url = new URL(target.url || '');
    return ['http:', 'https:'].includes(url.protocol) && isLoopbackHost(url.hostname) && /^\/c\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

async function scanOnce() {
  const addresses = readDevtoolsAddresses();
  let baseUrl = '';
  let targetList = null;
  for (const candidate of addresses) {
    try {
      const listRes = await fetch(`${candidate}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (!listRes.ok) continue;
      const parsed = await listRes.json();
      if (Array.isArray(parsed)) {
        baseUrl = candidate;
        targetList = parsed;
        break;
      }
    } catch {}
  }
  if (!baseUrl || !targetList) return;
  const targets = targetList.filter(isConversationTarget);
  const liveIds = new Set(targets.map((t) => t.id));
  for (const id of ATTACHED.keys()) {
    if (!liveIds.has(id)) ATTACHED.delete(id);
  }
  if (targets.length === 0 && ATTACHED.size === 0 && !ONCE) {
    writeCdpStatus({ active: false, stage: 'waiting', cdpUrl: baseUrl });
  }
  for (const target of targets) {
    if (ATTACHED.has(target.id)) continue;
    ATTACHED.set(target.id, true);
    void attachTarget(target, baseUrl).catch(() => ATTACHED.delete(target.id));
  }
}

function registerExitStatusReset() {
  const onStop = () => {
    writeCdpStatus({ active: false, stage: 'stopped' });
  };
  process.once('exit', onStop);
  process.once('SIGINT', () => { onStop(); process.exit(0); });
  process.once('SIGTERM', () => { onStop(); process.exit(0); });
}

async function main() {
  registerExitStatusReset();
  if (ONCE) {
    await scanOnce();
    return;
  }
  startSettingsWatcher();
  console.log(`[agy-file-actions] CDP runtime injector polling every ${POLL_MS}ms`);
  while (true) {
    try { await scanOnce(); } catch {}
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[agy-file-actions] ${err.message}`);
    process.exitCode = 1;
  });
}
