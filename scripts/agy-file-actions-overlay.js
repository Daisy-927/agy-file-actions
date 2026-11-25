/*
 * AGY File Actions renderer overlay & DSH bridge adapter.
 *
 * Wraps the unmodified upstream `dsh-file-actions` client bundle with:
 * - Antigravity light/dark CSS variable mapping & canvas color-floor normalization
 * - Antigravity DOM carrier pre-detection (file:/// links preserving #L ranges,
 *   file:// images, artifact/tool chips, data-* attributes)
 * - Zero-polling Electron main-process RPC bridge (with HTTP fallback for CDP mode)
 * - Sandboxed Electron BrowserWindow preview adapter for "Open in browser"
 * - Bidirectional settings sync with the AGY File Actions Sidecar panel
 */
(function installAgyFileActionsOverlay() {
  'use strict';

  const VERSION = 'agy-file-actions-v1';
  const BUILD = '20261126-3';
  const SETTINGS_KEY = 'dsh-file-actions.settings.v1';
  const PREF_APPS_KEY = 'dsh-file-actions.preferred-apps.v1';
  const APPS_CACHE_KEY = 'dsh-file-actions.apps.v1';
  const DROP_MODE_KEY = 'agy-file-actions.drop-mode.v1';
  const CLIENT_ID = '@jidekaixin2dian/dsh-file-actions';

  const prev = globalThis.__AGY_FILE_ACTIONS_OVERLAY__;
  if (prev && prev.version === VERSION && prev.build === BUILD && document.documentElement?.getAttribute('data-dfa-ready') === '1') {
    prev.refresh?.();
    return;
  }
  if (prev) {
    try { prev.stop?.(); } catch {}
  }

  /* ─────────────────────────── Theme Adapter ─────────────────────────── */

  const THEME_STYLE_ID = 'agy-file-actions-theme-vars';
  const THEME_CSS = `
:root {
  --dsw-alias-bg-layer-1: var(--card, var(--background, #ffffff));
  --dsw-alias-bg-layer-2: var(--muted, rgba(127, 127, 127, 0.12));
  --dsw-alias-label-primary: var(--foreground, #1f2328);
  --dsw-alias-label-secondary: var(--secondary-foreground, var(--muted-foreground, #57606a));
  --dsw-alias-label-tertiary: var(--muted-foreground, #6e7781);
  --dsw-alias-border-l1: var(--border, rgba(127, 127, 127, 0.22));
  --dsw-alias-border-l2: var(--card-border, var(--border, rgba(127, 127, 127, 0.28)));
  --dsw-alias-interactive-bg-hover: var(--muted, rgba(127, 127, 127, 0.14));
  --dsw-alias-state-business-primary: var(--primary, #3b82f6);
  --dsw-alias-brand: var(--primary, #3b82f6);
  --dsw-focus-ring-color: var(--primary, #3b82f6);
  --dsw-alias-danger: #cf222e;
  --dsw-alias-state-error-primary: #cf222e;
  --dsw-font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
  --ds-font-family-code: var(--font-mono, Consolas, monospace);
  --dsw-radius-lg: 12px;
}
.dfa-menu {
  backdrop-filter: blur(12px);
}
`;

  function ensureThemeCss() {
    if (!document.head) return;
    let tag = document.getElementById(THEME_STYLE_ID);
    if (!tag) {
      tag = document.createElement('style');
      tag.id = THEME_STYLE_ID;
      document.head.appendChild(tag);
    }
    if (tag.textContent !== THEME_CSS) tag.textContent = THEME_CSS;
  }

  let colorSampleCtx = null;
  function resolveCssColorToRgb(cssColor) {
    if (!cssColor || cssColor === 'transparent' || cssColor === 'rgba(0, 0, 0, 0)') return '';
    try {
      if (!colorSampleCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        colorSampleCtx = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (!colorSampleCtx) return '';
      colorSampleCtx.clearRect(0, 0, 1, 1);
      colorSampleCtx.fillStyle = '#000000';
      colorSampleCtx.fillStyle = cssColor;
      colorSampleCtx.fillRect(0, 0, 1, 1);
      const data = colorSampleCtx.getImageData(0, 0, 1, 1).data;
      const alpha = +(data[3] / 255).toFixed(3);
      if (alpha === 0) return '';
      return alpha >= 0.99
        ? `rgb(${data[0]}, ${data[1]}, ${data[2]})`
        : `rgba(${data[0]}, ${data[1]}, ${data[2]}, ${alpha})`;
    } catch {
      return '';
    }
  }

  function syncThemeFloor() {
    if (!document.body) return;
    try {
      // Remove our inline override briefly so we read AGY's live CSS variable / card surface
      document.documentElement.style.removeProperty('--dsw-alias-bg-layer-1');
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;background:var(--card, var(--background, transparent))';
      document.body.appendChild(probe);
      let raw = getComputedStyle(probe).backgroundColor;
      probe.remove();
      let rgb = resolveCssColorToRgb(raw);
      if (!rgb || /rgba\([^)]+,\s*0(?:\.0+)?\)$/.test(rgb)) {
        raw = getComputedStyle(document.body).backgroundColor;
        rgb = resolveCssColorToRgb(raw);
      }
      if (!rgb) {
        const isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        rgb = isDark ? 'rgb(32, 33, 36)' : 'rgb(255, 255, 255)';
      }
      document.documentElement.style.setProperty('--dsw-alias-bg-layer-1', rgb);
    } catch {}
  }

  /* ─────────────────────────── RPC Transport ─────────────────────────── */

  const rpcState = {
    queue: [],
    waiter: null,
    inflight: new Map(),
    seq: 0
  };

  function getConversationId() {
    const match = String(location.pathname || '').match(/^\/c\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function callBackend(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = `r${++rpcState.seq}`;
      const timer = setTimeout(() => {
        if (rpcState.inflight.has(id)) {
          rpcState.inflight.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, timeoutMs);
      rpcState.inflight.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      rpcState.queue.push({
        id,
        method,
        params,
        conversationId: getConversationId(),
        pageUrl: location.href
      });
      if (rpcState.waiter) {
        const wake = rpcState.waiter;
        rpcState.waiter = null;
        wake(rpcState.queue.splice(0));
      }
    });
  }

  function installBridgeInterface() {
    globalThis.__AGY_FA_BRIDGE__ = {
      waitRequest() {
        if (rpcState.queue.length > 0) {
          return Promise.resolve(rpcState.queue.splice(0));
        }
        return new Promise((resolve) => {
          let settled = false;
          const finish = (batch) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (rpcState.waiter === finish) rpcState.waiter = null;
            resolve(batch);
          };
          const timer = setTimeout(() => finish([]), 25000);
          rpcState.waiter = finish;
        });
      },
      deliverResponse(id, ok, payload) {
        const entry = rpcState.inflight.get(id);
        if (!entry) return;
        rpcState.inflight.delete(id);
        if (ok) entry.resolve(payload);
        else entry.reject(new Error(typeof payload === 'string' ? payload : 'RPC failed'));
      },
      applyHostSettings(data) {
        applySettingsToLocalStorage(data, true);
      }
    };
  }

  function flushWaiterOnUnload() {
    if (rpcState.waiter) {
      const wake = rpcState.waiter;
      rpcState.waiter = null;
      wake([]);
    }
  }
  window.addEventListener('pagehide', flushWaiterOnUnload);
  window.addEventListener('beforeunload', flushWaiterOnUnload);

  /* ─────────────────────────── Settings Sync ─────────────────────────── */

  let lastSyncedSettingsJson = '';
  let lastSyncedPrefsJson = '';

  function normalizeDropPathMode(val) {
    return val === 'always' || val === 'off' ? val : 'default';
  }

  let currentDropPathMode = (() => {
    try {
      return normalizeDropPathMode(window.localStorage.getItem(DROP_MODE_KEY));
    } catch {
      return 'default';
    }
  })();

  function readLocalJson(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function applySettingsToLocalStorage(data, emitEvent = false) {
    if (!data || typeof data !== 'object') return;
    try {
      if (data.dropPathMode !== undefined) {
        currentDropPathMode = normalizeDropPathMode(data.dropPathMode);
        window.localStorage.setItem(DROP_MODE_KEY, currentDropPathMode);
      }
      if (data.clientSettings) {
        const nextStr = JSON.stringify(data.clientSettings);
        lastSyncedSettingsJson = nextStr;
        if (window.localStorage.getItem(SETTINGS_KEY) !== nextStr) {
          window.localStorage.setItem(SETTINGS_KEY, nextStr);
          if (emitEvent) window.dispatchEvent(new StorageEvent('storage', { key: SETTINGS_KEY }));
        }
      }
      if (data.preferredApps) {
        const nextPrefStr = JSON.stringify(data.preferredApps);
        lastSyncedPrefsJson = nextPrefStr;
        if (window.localStorage.getItem(PREF_APPS_KEY) !== nextPrefStr) {
          window.localStorage.setItem(PREF_APPS_KEY, nextPrefStr);
          if (emitEvent) window.dispatchEvent(new StorageEvent('storage', { key: PREF_APPS_KEY }));
        }
      }
      if (data.clearCache) {
        window.localStorage.removeItem(APPS_CACHE_KEY);
        if (emitEvent) window.dispatchEvent(new StorageEvent('storage', { key: APPS_CACHE_KEY }));
      }
    } catch {}
  }

  function pushLocalSettingsIfChanged() {
    try {
      const sRaw = window.localStorage.getItem(SETTINGS_KEY) || '';
      const pRaw = window.localStorage.getItem(PREF_APPS_KEY) || '';
      if (sRaw === lastSyncedSettingsJson && pRaw === lastSyncedPrefsJson) return;
      lastSyncedSettingsJson = sRaw;
      lastSyncedPrefsJson = pRaw;
      const clientSettings = readLocalJson(SETTINGS_KEY);
      const preferredApps = readLocalJson(PREF_APPS_KEY);
      void callBackend('saveSettings', {
        ...(clientSettings ? { clientSettings } : {}),
        ...(preferredApps ? { preferredApps } : {})
      }).catch(() => {});
    } catch {}
  }

  /* ─────────────────────── AGY DOM Pre-Detection ─────────────────────── */

  function decodeFileUriWithHash(rawHref) {
    const value = String(rawHref || '').trim();
    if (!value) return '';
    try {
      let targetUrl;
      if (/^file:\/\//i.test(value)) {
        targetUrl = new URL(value);
      } else if (/^(?:vscode-file|antigravity):\/\/file\//i.test(value)) {
        targetUrl = new URL(value.replace(/^(?:vscode-file|antigravity):\/\/file/i, 'file://'));
      } else {
        return '';
      }
      const host = String(targetUrl.hostname || '').toLowerCase();
      if (host && host !== 'localhost') {
        return '';
      }
      let fsPath = decodeURIComponent(targetUrl.pathname || '');
      if (/^\/[A-Za-z]:/.test(fsPath)) {
        fsPath = fsPath.slice(1);
      }
      if (!fsPath) return '';
      const hash = String(targetUrl.hash || '');
      if (/^#L\d+(?:-L?\d+)?$/i.test(hash)) {
        return `${fsPath}${hash}`;
      }
      return fsPath;
    } catch {
      return '';
    }
  }

  function decodeMediaRouteUrl(src) {
    if (!src) return '';
    try {
      const parsed = new URL(src, location.href);
      for (const key of ['path', 'file', 'filepath', 'uri', 'src']) {
        const val = parsed.searchParams.get(key);
        if (val) {
          if (/^file:\/\//i.test(val)) return decodeFileUriWithHash(val);
          const trimmed = String(val).trim();
          if (/^(?:[\\/]{2}|[\\/]\?[\\/]|[\\/]\.[\\/])/.test(trimmed)) return '';
          if (/^(?:[A-Za-z]:[\\/]|\/(?![\\/]))/.test(trimmed)) return trimmed;
        }
      }
      if (parsed.protocol === 'file:') return decodeFileUriWithHash(parsed.href);
    } catch {}
    return '';
  }

  function cleanChipText(raw, looksLikePathFn) {
    let text = String(raw || '').trim();
    if (!text || text.length > 512) return '';
    // Strip leading decorations (emoji/icons/bullets) while keeping leading ./ or / or drive letter
    text = text.replace(/^[^\p{L}\p{N}._~\\/-]+/u, '').trim();
    // Strip trailing diff counts like "foo.ts +12 -3" or "foo.ts +12"
    text = text.replace(/\s+[+-]\d+(?:\s+[+-]\d+)?$/, '').trim();
    // Strip leading tool-chip verb prefixes BEFORE looksLikePathFn, because
    // "Edited server.mjs" ends with ".mjs" and would otherwise pass extension check!
    const verbMatch = /^(?:Edited|Created|Wrote|Read|Viewed|Modified|Deleted|Updated|Opened|已编辑|已创建|已读取|已修改|查看)\s+(.+)$/i.exec(text);
    if (verbMatch) {
      const candidate = verbMatch[1].trim();
      if (looksLikePathFn(candidate)) return candidate;
    }
    if (looksLikePathFn(text)) return text;
    return '';
  }

  function stampPath(el, resolvedPath) {
    el.setAttribute('data-file-actions-path', resolvedPath);
    el.setAttribute('data-agy-fa-stamped', '1');
  }

  function clearStampedPath(el) {
    if (el && el.getAttribute?.('data-agy-fa-stamped') === '1') {
      el.removeAttribute('data-file-actions-path');
      el.removeAttribute('data-agy-fa-stamped');
    }
  }

  function enrichAgyTarget(target, internals) {
    if (!target || !target.closest) return;
    if (target.closest('[data-dfa-menu], .dfa-reference-overlay, .dfa-settings, .dfa-lightbox')) return;
    const looksLikePath = internals?.looksLikePath || ((v) => /[\\/]|\.[A-Za-z0-9]{1,10}$/.test(String(v || '')));

    // 1. Preserve #L10-L20 line ranges on file:/// (or vscode-file://) links
    const anchor = target.closest('a[href]');
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      const resolved = decodeFileUriWithHash(href);
      if (resolved) {
        stampPath(anchor, resolved);
        return;
      }
      clearStampedPath(anchor);
    }

    // 2. Explicit data-* attributes on AGY components
    const dataHolder = target.closest('[data-path], [data-file-path], [data-filepath], [data-uri]');
    if (dataHolder && (!dataHolder.hasAttribute('data-file-actions-path') || dataHolder.getAttribute('data-agy-fa-stamped') === '1')) {
      for (const attr of ['data-path', 'data-file-path', 'data-filepath', 'data-uri']) {
        const val = dataHolder.getAttribute(attr);
        if (!val) continue;
        const resolved = /^file:\/\//i.test(val) ? decodeFileUriWithHash(val) : val;
        if (resolved && looksLikePath(resolved)) {
          stampPath(dataHolder, resolved);
          return;
        }
      }
    }

    // 3. Images rendered from local file:// or query path
    const img = target.closest('img[src]') || target.closest('button, a')?.querySelector?.('img[src]');
    if (img && (!img.hasAttribute('data-file-actions-path') || img.getAttribute('data-agy-fa-stamped') === '1')) {
      const mediaPath = decodeMediaRouteUrl(img.getAttribute('src'));
      if (mediaPath) {
        stampPath(img, mediaPath);
        return;
      }
      clearStampedPath(img);
    }

    // 4. AGY file chips / artifact pills (especially when pointer hits an inner <svg> icon)
    const chip = target.closest('button, [role="button"], [role="link"]');
    if (chip && !chip.closest('[data-testid="agent-input-box"]')) {
      const canStamp = !chip.hasAttribute('data-file-actions-path') || chip.getAttribute('data-agy-fa-stamped') === '1';
      if (canStamp) {
        for (const attr of ['title', 'aria-label', 'data-href', 'data-url']) {
          const raw = chip.getAttribute(attr);
          if (!raw) continue;
          const fromUri = /^file:\/\//i.test(raw) ? decodeFileUriWithHash(raw) : '';
          const candidate = fromUri || cleanChipText(raw, looksLikePath);
          if (candidate) {
            stampPath(chip, candidate);
            return;
          }
        }
        // If pointer landed inside an icon (<svg>) or sub-span of a compact chip button
        if (target.closest('svg') || target === chip) {
          const rawText = chip.textContent || '';
          const candidate = cleanChipText(rawText, looksLikePath);
          if (candidate && rawText.trim().length <= 160) {
            stampPath(chip, candidate);
            return;
          }
        }
        clearStampedPath(chip);
      }
    }
  }

  /* ───────────────────── Electron Browser Preview Hook ───────────────────── */

  function base64ToUint8Array(b64) {
    const bin = atob(b64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  let browserPreviewPendingPath = '';
  let browserPreviewTimer = 0;
  let originalWindowOpen = null;

  function armBrowserPreviewIntercept(absPath) {
    browserPreviewPendingPath = absPath || '';
    clearTimeout(browserPreviewTimer);
    browserPreviewTimer = setTimeout(() => { browserPreviewPendingPath = ''; }, 1500);
  }

  function createVirtualPreviewWindow(absPath) {
    const fakeDoc = {
      createElement() {
        return {
          style: {},
          setAttribute() {},
          removeAttribute() {},
          addEventListener() {},
          appendChild() {},
          remove() {},
          srcdoc: '',
          src: '',
          textContent: '',
          type: ''
        };
      },
      body: {
        replaceChildren() {
          // Hand off to Main Process sandboxed BrowserWindow once readAllBytes finishes
          void callBackend('previewInBrowser', { path: absPath }).catch(() => {});
        }
      }
    };
    return { opener: null, close() {}, addEventListener() {}, document: fakeDoc };
  }

  function installWindowOpenHook() {
    if (originalWindowOpen) return;
    originalWindowOpen = window.open;
    window.open = function patchedWindowOpen(url, target, features) {
      if ((url === '' || url === 'about:blank') && target === '_blank' && browserPreviewPendingPath) {
        const absPath = browserPreviewPendingPath;
        browserPreviewPendingPath = '';
        return createVirtualPreviewWindow(absPath);
      }
      return originalWindowOpen.call(this, url, target, features);
    };
  }

  function uninstallWindowOpenHook() {
    if (!originalWindowOpen) return;
    window.open = originalWindowOpen;
    originalWindowOpen = null;
  }

  /* ─────────────────────── Drag-Drop Local Path Bridge ─────────────────────── */

  const DROP_WEB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
  const DROP_WEB_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp']);
  const DROP_CODE_TEXT_EXTS = new Set([
    'txt', 'csv', 'tsv', 'log', 'ini', 'cfg', 'conf', 'env', 'toml',
    'json', 'jsonc', 'jsonl', 'ndjson', 'md', 'markdown', 'mdx', 'html', 'htm',
    'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
    'py', 'xml', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'c', 'cc', 'cpp', 'cxx',
    'h', 'hh', 'hpp', 'swift', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
    'sql', 'yaml', 'yml', 'proto', 'graphql', 'gql', 'vue', 'svelte', 'astro',
    'lua', 'r', 'dart', 'scala', 'gradle'
  ]);
  const DROP_DOC_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
  const DROP_DOC_MIMES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]);
  const DROP_MEDIA_EXTS = new Set([
    'mp4', 'webm', 'wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'weba', 'zip'
  ]);
  const DROP_MEDIA_MIMES = new Set([
    'video/mp4', 'video/webm',
    'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave',
    'audio/mp3', 'audio/mpeg', 'audio/m4a', 'audio/mp4', 'audio/aac',
    'audio/ogg', 'audio/flac', 'audio/opus', 'audio/l16', 'audio/webm',
    'application/zip', 'application/x-zip-compressed', 'application/x-zip'
  ]);

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_TEXT_BYTES = 1 * 1024 * 1024;
  const MAX_DOC_BYTES = 10 * 1024 * 1024;
  const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
  const MAX_ATTACH_COUNT = 5;

  const DROP_DOT_TEXT_NAMES = new Set([
    '.env', '.gitignore', '.gitattributes', '.gitmodules', '.npmrc', '.yarnrc',
    '.editorconfig', '.dockerignore', '.nvmrc', '.browserslistrc', '.prettierrc', '.eslintrc', '.htaccess'
  ]);

  function getFileExtension(fileName) {
    const lower = String(fileName || '').trim().toLowerCase();
    if (!lower || lower.endsWith('.tar.gz')) return '';
    if (DROP_DOT_TEXT_NAMES.has(lower)) return 'txt';
    const dot = lower.lastIndexOf('.');
    return dot > 0 ? lower.slice(dot + 1) : '';
  }

  function isNativeWebImage(file) {
    const ext = getFileExtension(file?.name);
    if (DROP_WEB_IMAGE_EXTS.has(ext)) return true;
    const mime = String(file?.type || '').split(';')[0].trim().toLowerCase();
    return DROP_WEB_IMAGE_MIMES.has(mime);
  }

  function classifyNativeCategory(file) {
    if (isNativeWebImage(file)) return 'image';
    const ext = getFileExtension(file?.name);
    const mime = String(file?.type || '').split(';')[0].trim().toLowerCase();
    if (DROP_CODE_TEXT_EXTS.has(ext) || mime.startsWith('text/')) return 'code';
    if (DROP_DOC_EXTS.has(ext) || DROP_DOC_MIMES.has(mime)) return 'doc';
    if (DROP_MEDIA_EXTS.has(ext) || DROP_MEDIA_MIMES.has(mime) || mime.startsWith('audio/')) return 'media';
    return 'other';
  }

  function getLocalPathForDroppedFile(file) {
    try {
      if (typeof window.electronNative?.getPathForFile === 'function') {
        const resolved = window.electronNative.getPathForFile(file);
        if (typeof resolved === 'string' && resolved.trim()) return resolved.trim();
      }
      if (typeof file?.path === 'string' && file.path.trim()) return file.path.trim();
    } catch {}
    return '';
  }

  function classifyDroppedFiles(entries, mode = currentDropPathMode) {
    const activeMode = normalizeDropPathMode(mode);
    const items = [];
    let nativeAttachCount = 0;
    let nativeAttachBytes = 0;
    let nativeCodeCount = 0;
    let usePathCount = 0;

    for (const entry of entries || []) {
      const file = entry?.file;
      const absPath = String(entry?.absPath || '').trim();
      const isDir = Boolean(entry?.isDir);
      const size = Math.max(0, Number(file?.size || 0));

      if (activeMode === 'off' || !absPath) {
        items.push({ file, absPath, isDir, usePath: false, nativeKind: 'ignore' });
        continue;
      }

      const category = classifyNativeCategory(file);
      let usePath = false;
      let nativeKind = 'path';

      if (activeMode === 'always') {
        const fitsSmallImage = !isDir
          && category === 'image'
          && size <= MAX_IMAGE_BYTES
          && nativeAttachCount < MAX_ATTACH_COUNT
          && nativeAttachBytes + size <= MAX_MEDIA_BYTES;
        if (fitsSmallImage) {
          nativeKind = 'media';
          nativeAttachCount += 1;
          nativeAttachBytes += size;
        } else {
          usePath = true;
        }
      } else if (isDir) {
        nativeKind = 'code';
        nativeCodeCount += 1;
      } else if (category === 'code') {
        if (size <= MAX_TEXT_BYTES) {
          nativeKind = 'code';
          nativeCodeCount += 1;
        } else {
          usePath = true;
        }
      } else if (category === 'image' || category === 'doc' || category === 'media') {
        const perFileLimit = category === 'media' ? MAX_MEDIA_BYTES : MAX_IMAGE_BYTES;
        const limit = category === 'doc' ? MAX_DOC_BYTES : perFileLimit;
        if (size <= limit && nativeAttachCount < MAX_ATTACH_COUNT && nativeAttachBytes + size <= MAX_MEDIA_BYTES) {
          nativeKind = 'media';
          nativeAttachCount += 1;
          nativeAttachBytes += size;
        } else {
          usePath = true;
        }
      } else {
        usePath = true;
      }

      if (usePath) usePathCount += 1;
      items.push({ file, absPath, isDir, usePath, nativeKind });
    }

    // Synthetic DataTransfer clones lose Electron's webUtils.getPathForFile identity;
    // when code files are mixed with fallback files, convert them to paths too so none are lost.
    if (usePathCount > 0 && nativeCodeCount > 0) {
      for (const item of items) {
        if (!item.usePath && item.nativeKind === 'code' && item.absPath) {
          item.usePath = true;
          item.nativeKind = 'path';
          usePathCount += 1;
        }
      }
    }

    return {
      items,
      usePathCount,
      nativeMediaItems: items.filter((it) => !it.usePath && it.nativeKind === 'media' && it.file)
    };
  }

  function formatDroppedPath(rawPath) {
    const p = String(rawPath || '').trim();
    if (!p) return '';
    return /[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
  }

  function formatDroppedPaths(paths) {
    return (paths || []).map(formatDroppedPath).filter(Boolean).join('\n');
  }

  function findDropComposerTarget(eventTarget) {
    const el = eventTarget instanceof Element
      ? eventTarget
      : eventTarget instanceof Node
        ? eventTarget.parentElement
        : null;
    if (!el) return null;
    if (el.closest?.('input[type="file"], webview, [data-testid="builtin-browser-webview-pool"]')) {
      return null;
    }
    const scope = el.closest('[data-media-drop-scope]') || el.closest('[data-lexical-editor="true"]');
    if (!scope) return null;
    const editor = el.closest('[data-lexical-editor="true"], textarea, [contenteditable="true"]')
      || scope.querySelector('[data-lexical-editor="true"]')
      || scope.querySelector('textarea, [contenteditable="true"]');
    return editor ? { scope, editor } : null;
  }

  function placeCursorAtEnd(editorEl) {
    try {
      const sel = window.getSelection();
      if (!sel) return;
      if (sel.rangeCount > 0 && editorEl.contains(sel.anchorNode)) return;
      const range = document.createRange();
      range.selectNodeContents(editorEl);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    } catch {}
  }

  function getTextBeforeCursor(editorEl) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return editorEl.textContent || '';
      }
      const selRange = sel.getRangeAt(0);
      if (!editorEl.contains(selRange.startContainer)) {
        return editorEl.textContent || '';
      }
      const range = document.createRange();
      range.selectNodeContents(editorEl);
      range.setEnd(selRange.startContainer, selRange.startOffset);
      return range.toString();
    } catch {
      return editorEl.textContent || '';
    }
  }

  function insertPathsIntoComposer(editorEl, paths) {
    const body = formatDroppedPaths(paths);
    if (!editorEl || !body) return false;

    if (editorEl instanceof HTMLTextAreaElement || editorEl instanceof HTMLInputElement) {
      editorEl.focus({ preventScroll: true });
      const start = typeof editorEl.selectionStart === 'number' ? editorEl.selectionStart : editorEl.value.length;
      const end = typeof editorEl.selectionEnd === 'number' ? editorEl.selectionEnd : start;
      const prefix = start > 0 && !/\s$/.test(editorEl.value.slice(0, start)) ? '\n' : '';
      editorEl.setRangeText(`${prefix}${body}`, start, end, 'end');
      editorEl.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    editorEl.focus({ preventScroll: true });
    placeCursorAtEnd(editorEl);

    const beforeDomText = editorEl.textContent || '';
    const beforeCursor = getTextBeforeCursor(editorEl);
    const prefix = beforeCursor.length > 0 && !/\s$/.test(beforeCursor) ? '\n' : '';
    const payload = `${prefix}${body}`;

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', payload);
      const pasteEv = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      editorEl.dispatchEvent(pasteEv);
      // Lexical PASTE_COMMAND calls preventDefault() and commits in an async update(),
      // so rely on defaultPrevented as well as synchronous DOM delta to avoid double insertion.
      if (pasteEv.defaultPrevented || (editorEl.textContent || '') !== beforeDomText) {
        return true;
      }
    } catch {}

    try {
      if (document.execCommand?.('insertText', false, payload)) {
        return true;
      }
    } catch {}

    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(payload);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        editorEl.appendChild(document.createTextNode(payload));
      }
      editorEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload }));
      return true;
    } catch {
      return false;
    }
  }

  let dropBridgeCleanup = null;

  function installDropPathBridge() {
    if (dropBridgeCleanup) return;
    const syntheticDropEvents = new WeakSet();

    const canBridgeCurrentEnv = () => (
      currentDropPathMode !== 'off'
      && (
        typeof window.electronNative?.getPathForFile === 'function'
        || (typeof File !== 'undefined' && 'path' in File.prototype)
        || globalThis.__AGY_FA_TEST_ALLOW_DROP_PATH__ === true
      )
    );

    const onDragOverBubble = (ev) => {
      if (!canBridgeCurrentEnv()) return;
      const types = ev.dataTransfer?.types;
      if (!types || !Array.from(types).includes('Files')) return;
      if (!findDropComposerTarget(ev.target)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    };

    const onDropCapture = (ev) => {
      if (syntheticDropEvents.has(ev) || !canBridgeCurrentEnv()) return;
      const dt = ev.dataTransfer;
      if (!dt || !dt.files || dt.files.length === 0) return;
      if (Array.from(dt.types || []).includes('application/context-scope-item-cider')) return;

      const hit = findDropComposerTarget(ev.target);
      if (!hit) return;

      const fileItems = Array.from(dt.items || []).filter((it) => it.kind === 'file');
      const entries = Array.from(dt.files).map((file, idx) => ({
        file,
        absPath: getLocalPathForDroppedFile(file),
        isDir: Boolean(fileItems[idx]?.webkitGetAsEntry?.()?.isDirectory)
      }));

      const plan = classifyDroppedFiles(entries, currentDropPathMode);
      if (plan.usePathCount === 0) return;

      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();

      const dropTarget = ev.target;
      const pathStrings = plan.items.filter((it) => it.usePath && it.absPath).map((it) => it.absPath);

      if (plan.nativeMediaItems.length > 0 && dropTarget) {
        try {
          const filteredDt = new DataTransfer();
          for (const item of plan.nativeMediaItems) {
            filteredDt.items.add(item.file);
          }
          const relayEv = new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            clientX: ev.clientX,
            clientY: ev.clientY,
            dataTransfer: filteredDt
          });
          syntheticDropEvents.add(relayEv);
          dropTarget.dispatchEvent(relayEv);
        } catch {}
      } else {
        try {
          window.dispatchEvent(new Event('dragend'));
        } catch {}
      }

      if (pathStrings.length > 0) {
        insertPathsIntoComposer(hit.editor, pathStrings);
      }
    };

    document.addEventListener('dragover', onDragOverBubble, false);
    window.addEventListener('drop', onDropCapture, true);
    dropBridgeCleanup = () => {
      document.removeEventListener('dragover', onDragOverBubble, false);
      window.removeEventListener('drop', onDropCapture, true);
    };
  }

  /* ─────────────────────── Bootstrap & Mount ─────────────────────── */

  let cleanupPlugin = null;
  let preCaptureCleanup = null;
  let sessionCache = { id: '', cwd: '', fetchedAt: 0 };

  async function refreshSessionSnapshot() {
    const cid = getConversationId();
    if (!cid) return;
    try {
      const info = await callBackend('getSession', { conversationId: cid, pageUrl: location.href });
      if (info && info.cwd) {
        sessionCache = { id: info.id || cid, cwd: info.cwd, fetchedAt: Date.now() };
      }
    } catch {}
  }

  function startOverlay() {
    const factory = globalThis.__AGY_DSH_FILE_ACTIONS_FACTORY__;
    if (typeof factory !== 'function') {
      console.warn('[agy-file-actions] client factory not loaded');
      return;
    }

    ensureThemeCss();
    syncThemeFloor();
    installBridgeInterface();
    installWindowOpenHook();
    installDropPathBridge();

    const plugin = factory(() => {
      throw new Error('require unavailable in overlay');
    });
    const internals = plugin.__internals || {};

    // Hydrate initial session & settings synchronously/async
    void refreshSessionSnapshot();
    void callBackend('getSettings', {}).then((data) => {
      if (data) applySettingsToLocalStorage(data, true);
    }).catch(() => {});

    // Capture-phase DOM enricher runs BEFORE dsh-file-actions registers its capture listeners
    const onPreEvent = (ev) => {
      try {
        if (ev.type === 'contextmenu') syncThemeFloor();
        enrichAgyTarget(ev.target, internals);
      } catch {}
    };
    const onMenuActionCapture = (ev) => {
      const target = ev.target;
      if (!target || !target.closest) return;
      const item = target.closest('[data-dfa-item="browser"]');
      if (item) {
        const menu = item.closest('[data-dfa-menu]');
        const absPath = menu?.querySelector('.dfa-path')?.getAttribute('title') || '';
        if (absPath) armBrowserPreviewIntercept(absPath);
      }
    };
    const onMenuKeyCapture = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const menu = document.querySelector('[data-dfa-menu="1"]');
      if (!menu) return;
      const activeId = menu.getAttribute('aria-activedescendant');
      const focused = activeId ? document.getElementById(activeId) : menu.querySelector('[data-dfa-item][data-focus="true"]');
      if (focused?.getAttribute('data-dfa-item') === 'browser') {
        const absPath = menu.querySelector('.dfa-path')?.getAttribute('title') || '';
        if (absPath) armBrowserPreviewIntercept(absPath);
      }
    };
    const onAfterClick = () => {
      setTimeout(pushLocalSettingsIfChanged, 120);
    };

    document.addEventListener('contextmenu', onPreEvent, true);
    document.addEventListener('pointerover', onPreEvent, true);
    document.addEventListener('focusin', onPreEvent, true);
    document.addEventListener('click', onMenuActionCapture, true);
    document.addEventListener('keydown', onMenuKeyCapture, true);
    document.addEventListener('click', onAfterClick, false);

    preCaptureCleanup = () => {
      document.removeEventListener('contextmenu', onPreEvent, true);
      document.removeEventListener('pointerover', onPreEvent, true);
      document.removeEventListener('focusin', onPreEvent, true);
      document.removeEventListener('click', onMenuActionCapture, true);
      document.removeEventListener('keydown', onMenuKeyCapture, true);
      document.removeEventListener('click', onAfterClick, false);
    };

    const ctx = {
      effect(fn) {
        cleanupPlugin = fn();
      },
      locale: {
        language: {
          getSnapshot: () => navigator.language || 'zh-CN'
        }
      },
      sessions: {
        list: {
          getSnapshot: () => {
            const cid = getConversationId() || 'default';
            if (sessionCache.id !== cid || Date.now() - sessionCache.fetchedAt > 10000) {
              void refreshSessionSnapshot();
            }
            return {
              byId: {
                [cid]: {
                  id: cid,
                  cwd: sessionCache.cwd || '',
                  retainedBy: { mainView: 1 }
                }
              }
            };
          }
        }
      },
      remote: {
        session: {
          workspacePathApplications: async ({ path }) => {
            try {
              const res = await callBackend('applications', { path }, 10000);
              return res || { ok: false, error: { code: 'failed' } };
            } catch {
              return { ok: false, error: { code: 'failed' } };
            }
          },
          openWorkspacePath: async (req) => {
            try {
              const method = req?.action === 'reveal' ? 'reveal' : 'open';
              const res = await callBackend(method, { path: req?.path, appId: req?.application }, 10000);
              return res || { ok: false };
            } catch {
              return { ok: false };
            }
          }
        },
        workspaceFiles: {
          stat: async (sessionId, path) => {
            try {
              return await callBackend('stat', { sessionId, path }, 8000);
            } catch {
              return { ok: false, error: { code: 'probeFailed' } };
            }
          },
          list: async (sessionId, path) => {
            try {
              return await callBackend('list', { sessionId, path }, 8000);
            } catch {
              return { ok: false, error: { code: 'probeFailed' } };
            }
          },
          readBytes: async (sessionId, path, options) => {
            try {
              const res = await callBackend('readBytes', { sessionId, path, options }, 15000);
              if (res?.ok && res.value && typeof res.value.dataBase64 === 'string') {
                const { dataBase64, ...rest } = res.value;
                return { ok: true, value: { ...rest, data: base64ToUint8Array(dataBase64) } };
              }
              return res || { ok: false };
            } catch {
              return { ok: false };
            }
          }
        }
      }
    };

    plugin.apply(ctx);
  }

  function stop() {
    try { cleanupPlugin?.(); } catch {}
    cleanupPlugin = null;
    try { preCaptureCleanup?.(); } catch {}
    preCaptureCleanup = null;
    try { dropBridgeCleanup?.(); } catch {}
    dropBridgeCleanup = null;
    uninstallWindowOpenHook();
    flushWaiterOnUnload();
  }

  function refresh() {
    ensureThemeCss();
    syncThemeFloor();
    void refreshSessionSnapshot();
  }

  globalThis.__AGY_FILE_ACTIONS_OVERLAY__ = {
    version: VERSION,
    build: BUILD,
    refresh,
    stop,
    classifyDroppedFiles,
    formatDroppedPaths
  };
  startOverlay();
})();
