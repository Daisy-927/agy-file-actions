import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const PREVIEW_MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  mdx: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
  jsonl: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg'
};

export function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function createPreviewServer({ maxItems = 40 } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const items = new Map();
  let server = null;
  let port = 0;

  function verifyToken(provided) {
    const raw = String(provided || '');
    if (raw.length !== token.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(raw, 'utf8'), Buffer.from(token, 'utf8'));
    } catch {
      return false;
    }
  }

  function ensureStarted() {
    if (server && port) return Promise.resolve(port);
    return new Promise((resolve, reject) => {
      const nextServer = http.createServer((req, res) => {
        const baseHeaders = {
          'Cache-Control': 'no-store, max-age=0',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        };
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          if (!verifyToken(url.searchParams.get('token'))) {
            res.writeHead(403, baseHeaders);
            res.end('Forbidden');
            return;
          }
          const id = url.searchParams.get('id') || '';
          const entry = items.get(id);
          if (!entry || !fs.existsSync(entry.absPath)) {
            res.writeHead(404, baseHeaders);
            res.end('Not found');
            return;
          }
          const ext = path.extname(entry.absPath).slice(1).toLowerCase();
          const mime = PREVIEW_MIME[ext] || 'application/octet-stream';
          const isActiveHtmlOrSvg = ['html', 'htm', 'xhtml', 'svg'].includes(ext);

          if (url.pathname === '/preview') {
            if (!isActiveHtmlOrSvg) {
              const rawUrl = `/raw?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`;
              res.writeHead(302, { ...baseHeaders, Location: rawUrl });
              res.end();
              return;
            }
            const trusted = url.searchParams.get('trusted') === '1';
            const rawUrl = `/raw?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}${trusted ? '&trusted=1' : ''}`;
            const trustedUrl = `/preview?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}&trusted=1`;
            const bannerText = trusted
              ? '已启用脚本与联网，仅对此预览有效'
              : '安全预览：脚本与外部资源已关闭';
            const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(path.basename(entry.absPath))}</title>
<style>body{margin:0;font:14px system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.bar{position:fixed;inset:0 0 auto;height:50px;box-sizing:border-box;padding:8px 14px;display:flex;gap:12px;align-items:center;background:#f2f2f2;color:#222;border-bottom:1px solid #ddd}
.trust-btn{display:inline-block;padding:5px 10px;border-radius:6px;border:1px solid #bbb;background:#fff;color:#222;text-decoration:none;cursor:pointer;font:inherit}
iframe{position:fixed;top:50px;left:0;width:100%;height:calc(100% - 50px);border:0;background:#fff}</style></head>
<body><div class="bar"><span>${bannerText}</span>${trusted ? '' : `<a class="trust-btn" href="${escapeHtml(trustedUrl)}" rel="noreferrer noopener" referrerpolicy="no-referrer">信任此文件，启用脚本与联网</a>`}</div>
<iframe sandbox="${trusted ? 'allow-scripts allow-forms allow-downloads allow-popups' : ''}" referrerpolicy="no-referrer" src="${escapeHtml(rawUrl)}"></iframe></body></html>`;
            res.writeHead(200, {
              ...baseHeaders,
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'"
            });
            res.end(html);
            return;
          }

          if (url.pathname === '/raw') {
            const st = fs.statSync(entry.absPath);
            if (!st.isFile()) {
              res.writeHead(404, baseHeaders);
              res.end('Not found');
              return;
            }
            if (st.size > 64 * 1024 * 1024) {
              res.writeHead(413, baseHeaders);
              res.end('File too large (>64 MiB)');
              return;
            }
            const headers = {
              ...baseHeaders,
              'Content-Type': mime,
              'Content-Length': st.size
            };
            if (isActiveHtmlOrSvg && url.searchParams.get('trusted') !== '1') {
              headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; form-action 'none'; base-uri 'none'";
            }
            res.writeHead(200, headers);
            fs.createReadStream(entry.absPath).pipe(res);
            return;
          }

          res.writeHead(404, baseHeaders);
          res.end('Not found');
        } catch {
          res.writeHead(500, baseHeaders);
          res.end('Preview error');
        }
      });
      nextServer.once('error', reject);
      nextServer.listen(0, '127.0.0.1', () => {
        const addr = nextServer.address();
        server = nextServer;
        port = addr.port;
        resolve(port);
      });
    });
  }

  async function registerItem(absPath) {
    if (!absPath || !fs.existsSync(absPath)) return null;
    const listenPort = await ensureStarted();
    const id = crypto.randomBytes(12).toString('hex');
    if (items.size >= maxItems) {
      const oldest = items.keys().next().value;
      items.delete(oldest);
    }
    items.set(id, { absPath: path.resolve(absPath), createdAt: Date.now() });
    const previewUrl = `http://127.0.0.1:${listenPort}/preview?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`;
    return { id, port: listenPort, previewUrl };
  }

  function unregisterItem(id) {
    if (id) items.delete(id);
  }

  async function close() {
    items.clear();
    if (!server) return;
    const target = server;
    server = null;
    port = 0;
    await new Promise((resolve) => {
      target.close(() => resolve());
      target.closeAllConnections?.();
    });
  }

  return {
    ensureStarted,
    registerItem,
    unregisterItem,
    close
  };
}
