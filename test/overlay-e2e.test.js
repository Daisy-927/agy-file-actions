import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  discoverApplications,
  listDir,
  readFileBytes,
  statFile
} from '../scripts/windows-file-ops.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('open', () => {
      resolve({
        call(method, params = {}) {
          const id = ++seq;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP timeout: ${method}`));
            }, 8000);
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
      const msg = JSON.parse(String(ev.data));
      if (!msg.id) return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
      else entry.resolve(msg.result || {});
    });
    ws.addEventListener('error', reject);
  });
}

async function pollUntil(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw lastErr || new Error('Timed out waiting for condition');
}

async function rightClickSelector(cdp, selector) {
  const { result } = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
    returnByValue: true
  });
  const pt = result.value;
  assert.ok(pt, `Selector not found: ${selector}`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await new Promise((r) => setTimeout(r, 60));
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
}

test('E2E in headless Edge: right-click menu on inline code, file:///#L lines, chip svg, and web link', { skip: !fs.existsSync(EDGE_PATH) }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fa-e2e-'));
  const userDataDir = path.join(tmp, 'edge-profile');
  const wsDir = path.join(tmp, 'workspace');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });

  const jsonlPath = path.join(wsDir, 'sample-results.jsonl');
  const codePath = path.join(wsDir, 'server.mjs');
  const svgPath = path.join(wsDir, 'chart.svg');
  fs.writeFileSync(jsonlPath, '{"turn":1,"ok":true}\n{"turn":2,"ok":true}\n', 'utf8');
  fs.writeFileSync(codePath, 'const a = 1;\nconst target = 2;\nconst end = 3;\nconsole.log(target, end);\n', 'utf8');
  fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#4f8cff"/></svg>', 'utf8');

  const cid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const ctx = { id: cid, cwd: wsDir, roots: [wsDir] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === `/c/${cid}`) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  :root {
    --background: oklch(0.99 0 0);
    --card: oklch(1 0 0);
    --foreground: oklch(0.2 0 0);
    --muted: oklch(0.94 0 0);
    --muted-foreground: oklch(0.5 0 0);
    --border: oklch(0.88 0 0);
    --primary: oklch(0.55 0.2 255);
  }
  body { margin: 0; padding: 36px; font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif; background: var(--background); color: var(--foreground); }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid #ccc; border-radius: 6px; background: #fff; }
</style>
</head>
<body>
  <div data-testid="agent-response">
    <p>生成文件：<code id="inline-jsonl">sample-results.jsonl</code></p>
    <p>代码位置：<a id="file-lines" href="${pathToFileURL(codePath).href}#L2-L3">server.mjs#L2-L3</a></p>
    <p>交付芯片：<button id="chip-btn" class="chip" type="button"><svg id="chip-svg" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg><span>Edited server.mjs +4 -1</span></button></p>
    <p>图片预览：<img id="media-svg" src="${pathToFileURL(svgPath).href}" width="40" height="40" alt="chart.svg"></p>
    <p>外部文档：<a id="web-link" href="https://github.com/jidekaixin2dian/dsh-file-actions">dsh-file-actions</a></p>
  </div>
</body>
</html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/c/${cid}`;

  let edgeProc;
  let cdp;
  let pumpStop = false;

  try {
    edgeProc = spawn(
      EDGE_PATH,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        pageUrl
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    const wsBase = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Edge DevTools port timeout')), 10000);
      let buf = '';
      edgeProc.stderr.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });

    const parsedWs = new URL(wsBase);
    const targets = await pollUntil(async () => {
      const list = await (await fetch(`http://127.0.0.1:${parsedWs.port}/json/list`)).json();
      return list.find((t) => t.type === 'page' && t.url.includes(`/c/${cid}`));
    });
    cdp = await cdpClient(targets.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');

    // Wait until the real test page DOM has finished loading before injecting
    await pollUntil(async () => {
      const r = await cdp.call('Runtime.evaluate', {
        expression: `document.readyState === 'complete' && Boolean(document.querySelector('#inline-jsonl'))`,
        returnByValue: true
      });
      return r.result?.value;
    });

    const vendorSrc = fs.readFileSync(path.join(ROOT, 'vendor', 'dsh-file-actions-client.js'), 'utf8');
    const overlaySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'agy-file-actions-overlay.js'), 'utf8');
    const bundle = `
(() => {
  const prev = window.__ModuleLoader__;
  window.__ModuleLoader__ = { load(d) { globalThis.__AGY_DSH_FILE_ACTIONS_FACTORY__ = d.factory; } };
  try { ${vendorSrc} } finally { if (prev === undefined) delete window.__ModuleLoader__; else window.__ModuleLoader__ = prev; }
})();
${overlaySrc}
`;
    const evalRes = await cdp.call('Runtime.evaluate', { expression: bundle });
    assert.equal(evalRes.exceptionDetails, undefined, `Bundle eval failed: ${JSON.stringify(evalRes.exceptionDetails)}`);
    await pollUntil(async () => {
      const r = await cdp.call('Runtime.evaluate', {
        expression: `document.documentElement.getAttribute('data-dfa-ready') === '1'`,
        returnByValue: true
      });
      return r.result?.value;
    });

    // Run real RPC pump over CDP just like electron-overlay-loader.cjs does
    const pumpLoop = (async () => {
      while (!pumpStop) {
        const res = await cdp.call('Runtime.evaluate', {
          expression: `globalThis.__AGY_FA_BRIDGE__?.waitRequest()`,
          awaitPromise: true,
          returnByValue: true
        }).catch(() => null);
        const batch = res?.result?.value;
        if (!Array.isArray(batch)) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        for (const req of batch) {
          let payload;
          if (req.method === 'getSession') payload = { id: cid, cwd: wsDir, roots: [wsDir] };
          else if (req.method === 'getSettings') payload = { clientSettings: { menuMode: 'full', contextLines: 8, glass: 'on' }, preferredApps: {} };
          else if (req.method === 'saveSettings') payload = { ok: true };
          else if (req.method === 'stat') payload = await statFile(ctx, req.params.path);
          else if (req.method === 'list') payload = await listDir(ctx, req.params.path);
          else if (req.method === 'readBytes') payload = await readFileBytes(ctx, req.params.path, req.params.options || {});
          else if (req.method === 'applications') payload = { ok: true, value: await discoverApplications(req.params.path) };
          else payload = { ok: false };
          await cdp.call('Runtime.evaluate', {
            expression: `globalThis.__AGY_FA_BRIDGE__.deliverResponse(${JSON.stringify(req.id)}, true, ${JSON.stringify(payload)})`
          });
        }
      }
    })();

    // Give initial getSession a moment to hydrate
    await new Promise((r) => setTimeout(r, 300));

    // 1. Right-click inline <code> sample-results.jsonl
    await rightClickSelector(cdp, '#inline-jsonl');
    let lastMenuDebug = null;
    const menu1 = await pollUntil(async () => {
      const r = await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const m = document.querySelector('[data-dfa-menu="1"]');
          if (!m) return { noMenu: true, ready: document.documentElement.getAttribute('data-dfa-ready') };
          const items = [...m.querySelectorAll('[data-dfa-item]')].map(el => el.getAttribute('data-dfa-item'));
          return {
            name: m.querySelector('.dfa-name')?.textContent,
            path: m.querySelector('.dfa-path')?.textContent,
            size: m.querySelector('.dfa-size')?.textContent,
            status: m.querySelector('[data-dfa-item="status"]')?.textContent,
            floor: getComputedStyle(m).backgroundColor,
            items
          };
        })()`,
        returnByValue: true
      });
      lastMenuDebug = r.result?.value;
      return r.result?.value?.items?.includes('reveal') ? r.result.value : null;
    }).catch((err) => {
      throw new Error(`${err.message}; lastMenuDebug=${JSON.stringify(lastMenuDebug)}`);
    });
    assert.equal(menu1.name, 'sample-results.jsonl');
    assert.equal(menu1.path, 'sample-results.jsonl');
    assert.ok(menu1.items.includes('open'));
    assert.ok(menu1.items.includes('reveal'));
    assert.ok(menu1.items.includes('copyPath'));
    assert.ok(menu1.items.includes('copyContents'));
    assert.ok(menu1.items.includes('saveAs'));
    assert.match(menu1.floor, /^rgba?\(/);

    // Close with Escape
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });

    // 2. Right-click file:///...#L2-L3 link and open reference context preview
    await rightClickSelector(cdp, '#file-lines');
    const menu2 = await pollUntil(async () => {
      const r = await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const m = document.querySelector('[data-dfa-menu="1"]');
          if (!m) return null;
          const items = [...m.querySelectorAll('[data-dfa-item]')].map(el => el.getAttribute('data-dfa-item'));
          return items.includes('referencePreview') ? {
            name: m.querySelector('.dfa-name')?.textContent,
            loc: m.querySelector('.dfa-loc')?.textContent,
            items
          } : null;
        })()`,
        returnByValue: true
      });
      return r.result?.value;
    });
    assert.equal(menu2.name, 'server.mjs');
    assert.match(menu2.loc, /2.*3/);

    // Click referencePreview and verify highlighted lines
    await cdp.call('Runtime.evaluate', {
      expression: `document.querySelector('[data-dfa-item="referencePreview"]').click()`
    });
    const refLines = await pollUntil(async () => {
      const r = await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const sel = [...document.querySelectorAll('.dfa-reference-row[data-selected="true"] .dfa-reference-code')];
          return sel.length ? sel.map(n => n.textContent) : null;
        })()`,
        returnByValue: true
      });
      return r.result?.value;
    });
    assert.deepEqual(refLines, ['const target = 2;', 'const end = 3;']);
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });

    // 3. Right-click directly on <svg> icon inside chip button "Edited server.mjs +4 -1"
    await rightClickSelector(cdp, '#chip-svg');
    const menu3 = await pollUntil(async () => {
      const r = await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const m = document.querySelector('[data-dfa-menu="1"]');
          return m && m.querySelector('.dfa-name')?.textContent === 'server.mjs' ? m.querySelector('.dfa-name').textContent : null;
        })()`,
        returnByValue: true
      });
      return r.result?.value;
    });
    assert.equal(menu3, 'server.mjs');
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });

    // 4. Right-click file:// image -> verify thumbnail renders in .dfa-thumb
    await rightClickSelector(cdp, '#media-svg');
    const thumbOk = await pollUntil(async () => {
      const r = await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const m = document.querySelector('[data-dfa-menu="1"]');
          const img = m?.querySelector('.dfa-thumb img');
          return img && img.src.startsWith('blob:') ? { name: m.querySelector('.dfa-name')?.textContent, src: img.src } : null;
        })()`,
        returnByValue: true
      });
      return r.result?.value;
    });
    assert.equal(thumbOk.name, 'chart.svg');
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });

    // 5. Right-click external web link
    await rightClickSelector(cdp, '#web-link');
    const menu4 = await pollUntil(async () => {
      const r = await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const m = document.querySelector('[data-dfa-menu="1"]');
          if (!m) return null;
          const items = [...m.querySelectorAll('[data-dfa-item]')].map(el => el.getAttribute('data-dfa-item'));
          return items.includes('openLink') ? { title: m.querySelector('.dfa-name')?.textContent, items } : null;
        })()`,
        returnByValue: true
      });
      return r.result?.value;
    });
    assert.equal(menu4.title, 'github.com');
    assert.ok(menu4.items.includes('copyLink'));
    assert.ok(menu4.items.includes('copyMarkdown'));
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });

    // 6. Verify dark mode oklch(--card) produces a dark floor color
    await cdp.call('Runtime.evaluate', {
      expression: `document.documentElement.style.setProperty('--card', 'oklch(0.21 0.01 250)')`
    });
    await rightClickSelector(cdp, '#inline-jsonl');
    const darkBg = await pollUntil(async () => {
      const r = await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const m = document.querySelector('[data-dfa-menu="1"]');
          return m ? getComputedStyle(m).backgroundColor : null;
        })()`,
        returnByValue: true
      });
      return r.result?.value;
    });
    const mRgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(darkBg);
    assert.ok(mRgb, `Expected rgb() background in dark mode, got ${darkBg}`);
    assert.ok(Number(mRgb[1]) < 60 && Number(mRgb[2]) < 60 && Number(mRgb[3]) < 60, `Expected dark floor, got ${darkBg}`);

    pumpStop = true;
    await cdp.call('Runtime.evaluate', { expression: `globalThis.__AGY_FILE_ACTIONS_OVERLAY__?.stop?.()` }).catch(() => {});
    await pumpLoop.catch(() => {});
  } finally {
    pumpStop = true;
    try { cdp?.close(); } catch {}
    if (edgeProc?.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill.exe', ['/PID', String(edgeProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('exit', resolve);
        killer.on('error', resolve);
      });
    }
    try { server.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test('Sidecar server serves UI with CSRF token, blocks CORS/unauthenticated POSTs, removes /api/rpc, and enforces 413', async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fa-sidecar-'));
  const sidecarPort = 28932 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'sidecars', 'panel', 'server.mjs')], {
    env: {
      ...process.env,
      ANTIGRAVITY_SIDECAR_WEB_PORT: String(sidecarPort),
      ANTIGRAVITY_APP_DATA_DIR: tmpAppData
    },
    stdio: 'ignore',
    windowsHide: true
  });
  try {
    const base = `http://127.0.0.1:${sidecarPort}`;
    const health = await pollUntil(async () => {
      const r = await fetch(`${base}/api/health`);
      return r.ok ? r.json() : null;
    });
    assert.equal(health.ok, true);

    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get('access-control-allow-origin'), null);
    const html = await htmlRes.text();
    assert.match(html, /文件与链接操作/);
    const tokenMatch = /name="agy-fa-token" content="([0-9a-f]+)"/.exec(html);
    assert.ok(tokenMatch, 'Expected embedded CSRF token in ui.html');
    const token = tokenMatch[1];

    // /api/rpc must be completely removed
    const rpcRes = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AGY-FA-Token': token },
      body: JSON.stringify({ method: 'getSettings' })
    });
    assert.equal(rpcRes.status, 404);

    // Cross-site / foreign Origin must be rejected
    const crossSiteRes = await fetch(`${base}/api/status`, {
      headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }
    });
    assert.equal(crossSiteRes.status, 403);

    // POST without token must be rejected
    const noTokenRes = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSettings: { menuMode: 'compact' } })
    });
    assert.equal(noTokenRes.status, 403);

    // Oversized body (> 1 MiB) must return 413 Payload Too Large
    const tooLargeRes = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AGY-FA-Token': token },
      body: JSON.stringify({ pad: 'a'.repeat(1024 * 1024 + 64) })
    });
    assert.equal(tooLargeRes.status, 413);

    // Valid token succeeds
    const saved = await (await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AGY-FA-Token': token },
      body: JSON.stringify({ clientSettings: { menuMode: 'compact', contextLines: 16 } })
    })).json();
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.clientSettings.menuMode, 'compact');
    assert.equal(saved.settings.clientSettings.contextLines, 16);

    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.ok, true);
    assert.equal(status.settings.clientSettings.menuMode, 'compact');
  } finally {
    try { proc.kill(); } catch {}
    fs.rmSync(tmpAppData, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
