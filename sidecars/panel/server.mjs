import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STATUS_FILE,
  isBlockedNetworkOrDevicePath,
  launchApplication,
  listRecentFiles,
  loadSettings,
  resolveConversationContext,
  revealInExplorer,
  saveSettings
} from '../../scripts/windows-file-ops.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML_FILE = path.join(__dirname, 'ui.html');
const PORT = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '18932', 10);
const SIDECAR_TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        const err = new Error('Payload Too Large');
        err.statusCode = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch {
        const err = new Error('Invalid JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function isAllowedOrigin(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  if (origin === `http://${host}`) return true;
  const pluginOrigin = /^plugin:\/\/agy-file-actions--panel-(\d+)$/.exec(origin);
  if (pluginOrigin && Number(pluginOrigin[1]) === Number(host.split(':').at(-1))) {
    return true;
  }
  return false;
}

function hasValidToken(req) {
  const provided = String(req.headers['x-agy-fa-token'] || '');
  if (!provided || provided.length !== SIDECAR_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(SIDECAR_TOKEN, 'utf8'));
  } catch {
    return false;
  }
}

function readLoaderStatus() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return { active: false };
    const parsed = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { active: false };
  } catch {
    return { active: false };
  }
}

function isInsideAnyRoot(absPath, roots) {
  if (!absPath || isBlockedNetworkOrDevicePath(absPath)) return false;
  let realTarget;
  try {
    realTarget = fs.realpathSync.native(absPath);
    if (!fs.statSync(realTarget).isFile()) return false;
  } catch {
    return false;
  }
  const normTarget = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
  return (roots || []).some((root) => {
    try {
      const realRoot = fs.realpathSync.native(root).replace(/[\\/]+$/, '');
      const normRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
      return normTarget === normRoot || normTarget.startsWith(`${normRoot}${path.sep}`);
    } catch {
      return false;
    }
  });
}

async function openFallback(absPath) {
  if (!absPath) return false;
  if (process.platform === 'win32') {
    try {
      const child = spawn('explorer.exe', [path.normalize(absPath)], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

const shellFallback = {
  openPath: async (absPath) => ((await openFallback(absPath)) ? '' : 'failed')
};

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
      sendJson(res, 403, { ok: false, error: 'Forbidden host' });
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      // Allow top-level / iframe document navigation from Antigravity's https loopback shell,
      // while blocking cross-site programmatic fetch() attempts on the HTML page.
      if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] === 'cors') {
        sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
        return;
      }
      const rawHtml = fs.readFileSync(UI_HTML_FILE, 'utf8');
      const html = rawHtml.replace('__AGY_FA_TOKEN__', SIDECAR_TOKEN);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors https://127.0.0.1:* http://127.0.0.1:* https://localhost:* http://localhost:*"
      });
      res.end(html);
      return;
    }

    if (!isAllowedOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, pid: process.pid, loader: readLoaderStatus() });
      return;
    }

    if (url.pathname === '/api/status') {
      if (!hasValidToken(req)) {
        sendJson(res, 403, { ok: false, error: 'Invalid or missing token' });
        return;
      }
      const loader = readLoaderStatus();
      const cid = url.searchParams.get('conversationId') || loader.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
      const ctx = resolveConversationContext(cid, loader.url || '');
      const recentFiles = await listRecentFiles(ctx, 25);
      sendJson(res, 200, {
        ok: true,
        loader,
        session: { id: ctx.id, cwd: ctx.cwd, roots: ctx.roots, brainDir: ctx.brainDir, outsideProject: ctx.outsideProject },
        settings: loadSettings(),
        recentFiles
      });
      return;
    }

    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') {
        if (!hasValidToken(req)) {
          sendJson(res, 403, { ok: false, error: 'Invalid or missing token' });
          return;
        }
        sendJson(res, 200, { ok: true, settings: loadSettings() });
        return;
      }
      if (req.method === 'POST') {
        if (!hasValidToken(req)) {
          sendJson(res, 403, { ok: false, error: 'Invalid or missing token' });
          return;
        }
        const body = await readJsonBody(req);
        const saved = saveSettings(body);
        sendJson(res, 200, { ok: true, settings: saved });
        return;
      }
    }

    if (url.pathname === '/api/action' && req.method === 'POST') {
      if (!hasValidToken(req)) {
        sendJson(res, 403, { ok: false, error: 'Invalid or missing token' });
        return;
      }
      const body = await readJsonBody(req);
      const absPath = String(body?.path || '');
      const loader = readLoaderStatus();
      const cid = loader.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
      const ctx = resolveConversationContext(cid, loader.url || '');
      if (!absPath || !fs.existsSync(absPath) || !isInsideAnyRoot(absPath, ctx.roots)) {
        sendJson(res, 403, { ok: false, error: 'Path outside active session roots or not found' });
        return;
      }
      if (body.action === 'reveal') {
        const ok = await revealInExplorer(absPath, shellFallback);
        sendJson(res, 200, { ok });
        return;
      }
      if (body.action === 'open') {
        const ok = await launchApplication(absPath, body.appId, shellFallback);
        sendJson(res, 200, { ok });
        return;
      }
      sendJson(res, 400, { ok: false, error: 'Unknown action' });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    const code = Number(err?.statusCode) || 500;
    sendJson(res, code, { ok: false, error: err?.message || 'Internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agy-file-actions] Sidecar listening on http://127.0.0.1:${PORT}`);
});
