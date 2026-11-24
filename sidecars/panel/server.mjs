import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STATUS_FILE,
  discoverApplications,
  launchApplication,
  listDir,
  listRecentFiles,
  loadSettings,
  readFileBytes,
  resolveCandidatePaths,
  resolveConversationContext,
  revealInExplorer,
  saveSettings,
  statFile
} from '../../scripts/windows-file-ops.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML_FILE = path.join(__dirname, 'ui.html');
const PORT = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '18932', 10);

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
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

async function openFallback(absPath) {
  if (!absPath) return false;
  if (process.platform === 'win32') {
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', absPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
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
  openPath: async (absPath) => ((await openFallback(absPath)) ? '' : 'failed'),
  showItemInFolder: (absPath) => {
    if (process.platform === 'win32') {
      const child = spawn('explorer.exe', [`/select,${path.normalize(absPath)}`], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }
  }
};

async function handleRpc(body) {
  const method = body?.method;
  const params = body?.params || {};
  const cid = body?.conversationId || params?.sessionId || readLoaderStatus().conversationId || '';
  const pageUrl = body?.pageUrl || '';
  const ctx = resolveConversationContext(cid, pageUrl);

  if (method === 'getSession') {
    return { id: ctx.id, cwd: ctx.cwd, roots: ctx.roots, outsideProject: ctx.outsideProject };
  }
  if (method === 'getSettings') {
    return loadSettings();
  }
  if (method === 'saveSettings') {
    return saveSettings(params);
  }
  if (method === 'stat') {
    return statFile(ctx, params.path);
  }
  if (method === 'list') {
    return listDir(ctx, params.path);
  }
  if (method === 'readBytes') {
    return readFileBytes(ctx, params.path, params.options || {});
  }
  if (method === 'applications') {
    const st = await statFile(ctx, params.path);
    const absPath = st.ok ? st.value.absolutePath : (resolveCandidatePaths(params.path, ctx.roots)[0] || params.path);
    return { ok: true, value: await discoverApplications(absPath) };
  }
  if (method === 'open') {
    const st = await statFile(ctx, params.path);
    const absPath = st.ok ? st.value.absolutePath : (resolveCandidatePaths(params.path, ctx.roots)[0] || params.path);
    const ok = await launchApplication(absPath, params.appId, shellFallback);
    return ok ? { ok: true, value: { opened: true } } : { ok: false };
  }
  if (method === 'reveal') {
    const st = await statFile(ctx, params.path);
    const absPath = st.ok ? st.value.absolutePath : (resolveCandidatePaths(params.path, ctx.roots)[0] || params.path);
    const ok = await revealInExplorer(absPath, shellFallback);
    return ok ? { ok: true, value: { revealed: true } } : { ok: false };
  }
  throw new Error(`Unsupported RPC method: ${method}`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(UI_HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, pid: process.pid, loader: readLoaderStatus() });
      return;
    }

    if (url.pathname === '/api/status') {
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
        sendJson(res, 200, { ok: true, settings: loadSettings() });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const saved = saveSettings(body);
        sendJson(res, 200, { ok: true, settings: saved });
        return;
      }
    }

    if (url.pathname === '/api/action' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const absPath = String(body?.path || '');
      if (!absPath || !fs.existsSync(absPath)) {
        sendJson(res, 404, { ok: false, error: 'File not found' });
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

    if (url.pathname === '/api/rpc' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await handleRpc(body);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err?.message || 'Internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agy-file-actions] Sidecar listening on http://127.0.0.1:${PORT}`);
});
