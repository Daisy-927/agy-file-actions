'use strict';

/*
 * AGY File Actions Electron main-process overlay loader.
 *
 * Loaded side-by-side from <Antigravity>/resources/app/index.cjs before
 * app.asar starts. Leaves app.asar untouched and coexists with other
 * loaders (such as agy-model-inspector).
 */
(function initAgyFileActionsElectronLoader() {
  if (
    !process.versions ||
    !process.versions.electron ||
    (process.env.ELECTRON_RUN_AS_NODE && process.env.ELECTRON_RUN_AS_NODE !== '0') ||
    (process.type && process.type !== 'browser') ||
    (Array.isArray(process.argv) && process.argv.some((a) => typeof a === 'string' && a.startsWith('--type=')))
  ) {
    return;
  }

  if (globalThis.__AGY_FILE_ACTIONS_ELECTRON_LOADER_INIT__) return;
  globalThis.__AGY_FILE_ACTIONS_ELECTRON_LOADER_INIT__ = true;

  // Tell sidecar not to spawn CDP fallback injector when direct Electron loader is active
  process.env.AGY_FILE_ACTIONS_DIRECT_LOADER = '1';

  const fs = require('node:fs');
  const Module = require('node:module');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');

  const ROOT_DIR = path.resolve(__dirname, '..');
  const VENDOR_CLIENT_FILE = path.join(ROOT_DIR, 'vendor', 'dsh-file-actions-client.js');
  const OVERLAY_FILE = path.join(ROOT_DIR, 'scripts', 'agy-file-actions-overlay.js');
  const OPS_MODULE_URL = pathToFileURL(path.join(ROOT_DIR, 'scripts', 'windows-file-ops.mjs')).href;
  const PREVIEW_MODULE_URL = pathToFileURL(path.join(ROOT_DIR, 'scripts', 'preview-server.mjs')).href;
  const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR
    ? path.resolve(process.env.ANTIGRAVITY_APP_DATA_DIR)
    : path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity');
  const STATUS_FILE = path.join(APP_DATA_DIR, 'plugin_data', 'agy-file-actions', 'direct_loader_status.json');
  const SETTINGS_FILE = path.join(APP_DATA_DIR, 'plugin_data', 'agy-file-actions', 'settings.json');

  let opsPromise = null;
  function getOps() {
    if (!opsPromise) opsPromise = import(OPS_MODULE_URL);
    return opsPromise;
  }

  function writeStatus(extra = {}) {
    try {
      fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
      fs.writeFileSync(
        STATUS_FILE,
        JSON.stringify({ active: true, mode: 'electron', pid: process.pid, updatedAt: new Date().toISOString(), ...extra }, null, 2),
        'utf8'
      );
    } catch {}
  }
  writeStatus({ stage: 'loaded' });

  let cachedBundle = { vendorMtime: -1, overlayMtime: -1, source: '' };
  function getBundleSource() {
    const vStat = fs.statSync(VENDOR_CLIENT_FILE);
    const oStat = fs.statSync(OVERLAY_FILE);
    if (cachedBundle.vendorMtime !== vStat.mtimeMs || cachedBundle.overlayMtime !== oStat.mtimeMs || !cachedBundle.source) {
      const vendorSrc = fs.readFileSync(VENDOR_CLIENT_FILE, 'utf8');
      const overlaySrc = fs.readFileSync(OVERLAY_FILE, 'utf8');
      const source = `
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
      cachedBundle = { vendorMtime: vStat.mtimeMs, overlayMtime: oStat.mtimeMs, source };
    }
    return cachedBundle;
  }

  function isLoopbackHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  function extractConversationId(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      if (!isLoopbackHost(parsed.hostname)) return '';
      const match = parsed.pathname.match(/^\/c\/([^/]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch {
      return '';
    }
  }

  async function execInMainFrame(wc, code) {
    if (!wc || wc.isDestroyed?.()) return null;
    const frame = wc.mainFrame;
    if (frame && typeof frame.executeJavaScript === 'function') {
      return frame.executeJavaScript(code, true);
    }
    if (typeof wc.executeJavaScript === 'function') {
      return wc.executeJavaScript(code, true);
    }
    return null;
  }

  /* ───────────────────── Sandboxed Browser Preview ───────────────────── */

  let previewServerPromise = null;
  function getPreviewServer() {
    if (!previewServerPromise) {
      previewServerPromise = import(PREVIEW_MODULE_URL).then((mod) => mod.createPreviewServer());
    }
    return previewServerPromise;
  }

  async function openSandboxedPreviewWindow(electronMod, absPath) {
    if (!electronMod?.BrowserWindow || !absPath) return false;
    const ops = await getOps();
    if (ops.isBlockedNetworkOrDevicePath(absPath) || !fs.existsSync(absPath)) return false;
    const preview = await getPreviewServer();
    const item = await preview.registerItem(absPath);
    if (!item) return false;

    const win = new electronMod.BrowserWindow({
      width: 1020,
      height: 760,
      title: path.basename(absPath),
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => { preview.unregisterItem(item.id); });
    await win.loadURL(item.previewUrl);
    return true;
  }

  /* ───────────────────── RPC Dispatch (Main Process) ───────────────────── */

  let electronRef = null;

  function resolveExistingCandidate(ops, rawPath, ctx) {
    const candidates = ops.resolveCandidatePaths(rawPath, ctx?.roots || [], ctx);
    if (!candidates.length) return '';
    return candidates.find((c) => fs.existsSync(c)) || candidates[0] || '';
  }

  async function handleRpcRequest(req) {
    const ops = await getOps();
    const method = req?.method;
    const params = req?.params || {};
    const cid = req?.conversationId || params?.sessionId || '';
    const pageUrl = req?.pageUrl || '';
    const ctx = ops.resolveConversationContext(cid, pageUrl);

    if (method === 'getSession') {
      return { id: ctx.id, cwd: ctx.cwd, roots: ctx.roots, outsideProject: ctx.outsideProject, wsl: ctx.wsl };
    }
    if (method === 'getSettings') {
      return ops.loadSettings();
    }
    if (method === 'saveSettings') {
      return ops.saveSettings(params);
    }
    if (method === 'stat') {
      return ops.statFile(ctx, params.path);
    }
    if (method === 'list') {
      return ops.listDir(ctx, params.path);
    }
    if (method === 'readBytes') {
      return ops.readFileBytes(ctx, params.path, params.options || {});
    }
    if (method === 'applications') {
      const statRes = await ops.statFile(ctx, params.path);
      const absPath = statRes.ok ? statRes.value.absolutePath : resolveExistingCandidate(ops, params.path, ctx);
      if (!absPath) return { ok: true, value: [] };
      const apps = await ops.discoverApplications(absPath, {
        getFileIcon: electronRef?.app?.getFileIcon
          ? (exePath) => electronRef.app.getFileIcon(exePath, { size: 'small' })
          : undefined
      });
      return { ok: true, value: apps };
    }
    if (method === 'open') {
      const statRes = await ops.statFile(ctx, params.path);
      const absPath = statRes.ok ? statRes.value.absolutePath : resolveExistingCandidate(ops, params.path, ctx);
      if (!absPath) return { ok: false, error: { code: 'invalid-path' } };
      const ok = await ops.launchApplication(absPath, params.appId, electronRef?.shell);
      return ok ? { ok: true, value: { opened: true } } : { ok: false, error: { code: 'open-failed' } };
    }
    if (method === 'reveal') {
      const statRes = await ops.statFile(ctx, params.path);
      const absPath = statRes.ok ? statRes.value.absolutePath : resolveExistingCandidate(ops, params.path, ctx);
      if (!absPath) return { ok: false, error: { code: 'invalid-path' } };
      const ok = await ops.revealInExplorer(absPath, electronRef?.shell);
      return ok ? { ok: true, value: { revealed: true } } : { ok: false, error: { code: 'reveal-failed' } };
    }
    if (method === 'previewInBrowser') {
      const statRes = await ops.statFile(ctx, params.path);
      const absPath = statRes.ok ? statRes.value.absolutePath : resolveExistingCandidate(ops, params.path, ctx);
      if (!absPath) return { ok: false };
      const ok = await openSandboxedPreviewWindow(electronRef, absPath);
      return { ok };
    }
    throw new Error(`Unknown RPC method: ${method}`);
  }

  /* ───────────────────── WebContents Attachment ───────────────────── */

  const hookedWebContents = new WeakSet();
  const hookedApps = new WeakSet();
  const activeAttached = new Set();

  let lastSettingsMtime = 0;
  try {
    if (fs.existsSync(SETTINGS_FILE)) lastSettingsMtime = fs.statSync(SETTINGS_FILE).mtimeMs;
  } catch {}

  let settingsSyncTimer = null;
  async function syncSettingsIfChanged() {
    try {
      if (!fs.existsSync(SETTINGS_FILE)) return;
      const mtime = fs.statSync(SETTINGS_FILE).mtimeMs;
      if (mtime === lastSettingsMtime) return;
      lastSettingsMtime = mtime;
      const ops = await getOps();
      const data = ops.loadSettings();
      const expr = `globalThis.__AGY_FA_BRIDGE__?.applyHostSettings?.(${JSON.stringify(data)})`;
      for (const wc of activeAttached) {
        if (!wc.isDestroyed?.()) void execInMainFrame(wc, expr).catch(() => {});
      }
    } catch {}
  }

  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const watcher = fs.watch(path.dirname(SETTINGS_FILE), (_ev, filename) => {
      if (filename && String(filename) !== 'settings.json') return;
      if (settingsSyncTimer) clearTimeout(settingsSyncTimer);
      settingsSyncTimer = setTimeout(() => {
        settingsSyncTimer = null;
        void syncSettingsIfChanged();
      }, 120);
      settingsSyncTimer.unref?.();
    });
    watcher.unref?.();
  } catch {
    setInterval(() => void syncSettingsIfChanged(), 3000).unref();
  }

  function hookWebContents(wc) {
    if (!wc || typeof wc !== 'object' || hookedWebContents.has(wc)) return;
    if (wc.isDestroyed?.()) return;
    if (wc.getType?.() === 'webview') return;
    hookedWebContents.add(wc);

    const state = {
      injectedVersionKey: '',
      lastUrl: '',
      loopRunning: false,
      disposed: false
    };

    async function ensureInjected() {
      if (state.disposed || wc.isDestroyed?.()) return false;
      const url = wc.getURL?.() || '';
      const cid = extractConversationId(url);
      if (!cid) {
        activeAttached.delete(wc);
        state.lastUrl = url;
        return false;
      }
      const bundle = getBundleSource();
      const versionKey = `${bundle.vendorMtime}:${bundle.overlayMtime}`;
      const isReady = await execInMainFrame(
        wc,
        `Boolean(globalThis.__AGY_FILE_ACTIONS_OVERLAY__ && document.documentElement?.getAttribute('data-dfa-ready') === '1')`
      ).catch(() => false);

      if (!isReady || state.injectedVersionKey !== versionKey || state.lastUrl !== url) {
        await execInMainFrame(wc, bundle.source);
        state.injectedVersionKey = versionKey;
        state.lastUrl = url;
        writeStatus({ stage: 'attached', url, conversationId: cid });
      }
      activeAttached.add(wc);
      return true;
    }

    async function runRpcPump() {
      if (state.loopRunning) return;
      state.loopRunning = true;
      try {
        while (!state.disposed && !wc.isDestroyed?.()) {
          const url = wc.getURL?.() || '';
          if (!extractConversationId(url)) break;
          const ok = await ensureInjected();
          if (!ok) break;
          const batch = await execInMainFrame(wc, `globalThis.__AGY_FA_BRIDGE__?.waitRequest()`).catch(() => null);
          if (!Array.isArray(batch)) {
            await new Promise((r) => setTimeout(r, 350));
            continue;
          }
          if (batch.length === 0) continue;
          await Promise.allSettled(
            batch.map(async (req) => {
              if (!req || !req.id) return;
              try {
                const res = await handleRpcRequest(req);
                await execInMainFrame(
                  wc,
                  `globalThis.__AGY_FA_BRIDGE__?.deliverResponse(${JSON.stringify(req.id)}, true, ${JSON.stringify(res)})`
                );
              } catch (err) {
                await execInMainFrame(
                  wc,
                  `globalThis.__AGY_FA_BRIDGE__?.deliverResponse(${JSON.stringify(req.id)}, false, ${JSON.stringify(err?.message || 'error')})`
                ).catch(() => {});
              }
            })
          );
        }
      } catch {
        // Navigation or page teardown; onNav will re-arm if still a conversation page
      } finally {
        state.loopRunning = false;
      }
    }

    function onNav() {
      if (state.disposed || wc.isDestroyed?.()) return;
      const url = wc.getURL?.() || '';
      const cid = extractConversationId(url);
      if (cid) {
        if (state.loopRunning && url !== state.lastUrl) {
          state.lastUrl = url;
          void execInMainFrame(wc, `globalThis.__AGY_FILE_ACTIONS_OVERLAY__?.refresh?.()`).catch(() => {});
          writeStatus({ stage: 'attached', url, conversationId: cid });
        }
        void runRpcPump();
      } else {
        state.lastUrl = url;
        activeAttached.delete(wc);
      }
    }

    wc.on?.('dom-ready', onNav);
    wc.on?.('did-finish-load', onNav);
    wc.on?.('did-navigate', onNav);
    wc.on?.('did-navigate-in-page', onNav);
    wc.once?.('destroyed', () => {
      state.disposed = true;
      activeAttached.delete(wc);
    });

    if (extractConversationId(wc.getURL?.() || '') && !wc.isLoadingMainFrame?.()) {
      void runRpcPump();
    }
  }

  function attachAll(app, webContentsApi) {
    if (app && !hookedApps.has(app)) {
      hookedApps.add(app);
      app.on?.('web-contents-created', (_ev, wc) => hookWebContents(wc));
    }
    try {
      for (const wc of webContentsApi?.getAllWebContents?.() || []) {
        hookWebContents(wc);
      }
    } catch {}
  }

  function tryAttachElectron(electronMod) {
    if (globalThis.__AGY_FILE_ACTIONS_ELECTRON_ATTACHED__) return true;
    if (!electronMod || typeof electronMod !== 'object' || !electronMod.app) return false;
    globalThis.__AGY_FILE_ACTIONS_ELECTRON_ATTACHED__ = true;
    electronRef = electronMod;

    attachAll(electronMod.app, electronMod.webContents);
    electronMod.app.once?.('will-quit', () => {
      writeStatus({ active: false, stage: 'stopped' });
    });
    void electronMod.app.whenReady().then(() => {
      attachAll(electronMod.app, electronMod.webContents);
    });
    return true;
  }

  let initialElectron = null;
  try {
    initialElectron = require('electron');
  } catch {}

  if (!tryAttachElectron(initialElectron)) {
    const origLoad = Module._load;
    let restored = false;
    function restoreLoad() {
      if (!restored && Module._load === wrappedLoad) {
        Module._load = origLoad;
        restored = true;
      }
    }
    function wrappedLoad(request) {
      const exported = origLoad.apply(this, arguments);
      if (request === 'electron' && tryAttachElectron(exported)) {
        restoreLoad();
      }
      return exported;
    }
    Module._load = wrappedLoad;

    setImmediate(() => {
      if (globalThis.__AGY_FILE_ACTIONS_ELECTRON_ATTACHED__) {
        restoreLoad();
        return;
      }
      try {
        if (tryAttachElectron(require('electron'))) restoreLoad();
      } catch {}
    });
  }
})();
