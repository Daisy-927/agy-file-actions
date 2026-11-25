import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);
const USER_HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

export const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR
  ? path.resolve(process.env.ANTIGRAVITY_APP_DATA_DIR)
  : path.join(USER_HOME, '.gemini', 'antigravity');
export const SUMMARIES_DB_PATH = path.join(APP_DATA_DIR, 'conversation_summaries.db');
export const BRAIN_DIR = path.join(APP_DATA_DIR, 'brain');
export const PLUGIN_DATA_DIR = path.join(APP_DATA_DIR, 'plugin_data', 'agy-file-actions');
export const SETTINGS_FILE = path.join(PLUGIN_DATA_DIR, 'settings.json');
export const STATUS_FILE = path.join(PLUGIN_DATA_DIR, 'direct_loader_status.json');

const TEXT_LIKE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.json', '.jsonl', '.ndjson', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.log', '.csv', '.tsv',
  '.xml', '.svg', '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs',
  '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.c',
  '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.vue', '.svelte', '.diff', '.patch', ''
]);
const BROWSER_EXTS = new Set([
  '.html', '.htm', '.xhtml', '.svg', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.bmp', '.ico', '.avif', '.mp4', '.m4v', '.mov', '.webm', '.ogv', '.mp3', '.wav',
  '.ogg', '.md', '.txt', '.json', '.jsonl'
]);

const FRIENDLY_NAMES = new Map([
  ['antigravity.exe', 'Antigravity'],
  ['code.exe', 'Visual Studio Code'],
  ['code - insiders.exe', 'Visual Studio Code - Insiders'],
  ['cursor.exe', 'Cursor'],
  ['windsurf.exe', 'Windsurf'],
  ['zed.exe', 'Zed'],
  ['notepad++.exe', 'Notepad++'],
  ['notepad.exe', '记事本 (Notepad)'],
  ['sublime_text.exe', 'Sublime Text'],
  ['typora.exe', 'Typora'],
  ['obsidian.exe', 'Obsidian'],
  ['workbuddy.exe', 'WorkBuddy'],
  ['msedge.exe', 'Microsoft Edge'],
  ['chrome.exe', 'Google Chrome'],
  ['firefox.exe', 'Mozilla Firefox'],
  ['potplayermini64.exe', 'PotPlayer'],
  ['vlc.exe', 'VLC Media Player'],
  ['bandizip.exe', 'Bandizip'],
  ['7zfm.exe', '7-Zip'],
  ['winword.exe', 'Microsoft Word'],
  ['excel.exe', 'Microsoft Excel'],
  ['powerpnt.exe', 'Microsoft PowerPoint'],
  ['mspaint.exe', '画图 (Paint)'],
  ['wt.exe', 'Windows Terminal']
]);

const iconCache = new Map();
const verifiedApps = new Map();
let cachedAppPaths = null;
let cachedAppPathsAt = 0;

export function ensurePluginDataDir() {
  try {
    fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
  } catch {}
}

function normalizeDropPathMode(val) {
  return val === 'always' || val === 'off' ? val : 'default';
}

export function loadSettings() {
  const defaults = {
    clientSettings: { menuMode: 'full', contextLines: 8, glass: 'on' },
    preferredApps: {},
    dropPathMode: 'default',
    updatedAt: 0
  };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const cs = parsed?.clientSettings || {};
      return {
        clientSettings: {
          menuMode: cs.menuMode === 'compact' ? 'compact' : 'full',
          contextLines: [4, 8, 16].includes(Number(cs.contextLines)) ? Number(cs.contextLines) : 8,
          glass: cs.glass === 'off' ? 'off' : 'on'
        },
        preferredApps: parsed?.preferredApps && typeof parsed.preferredApps === 'object' && !Array.isArray(parsed.preferredApps)
          ? parsed.preferredApps
          : {},
        dropPathMode: normalizeDropPathMode(parsed?.dropPathMode),
        updatedAt: Number(parsed?.updatedAt || 0)
      };
    }
  } catch {}
  return defaults;
}

export function saveSettings(patch) {
  ensurePluginDataDir();
  const current = loadSettings();
  const next = {
    clientSettings: patch?.clientSettings
      ? {
          menuMode: patch.clientSettings.menuMode === undefined
            ? current.clientSettings.menuMode
            : (patch.clientSettings.menuMode === 'compact' ? 'compact' : 'full'),
          contextLines: [4, 8, 16].includes(Number(patch.clientSettings.contextLines))
            ? Number(patch.clientSettings.contextLines)
            : current.clientSettings.contextLines,
          glass: patch.clientSettings.glass === undefined
            ? current.clientSettings.glass
            : (patch.clientSettings.glass === 'off' ? 'off' : 'on')
        }
      : current.clientSettings,
    preferredApps: patch?.preferredApps && typeof patch.preferredApps === 'object' && !Array.isArray(patch.preferredApps)
      ? patch.preferredApps
      : current.preferredApps,
    dropPathMode: patch?.dropPathMode !== undefined
      ? normalizeDropPathMode(patch.dropPathMode)
      : current.dropPathMode,
    updatedAt: Date.now()
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function isBlockedNetworkOrDevicePath(rawPath) {
  const cleaned = String(rawPath || '').trim().replace(/^['"]+|['"]+$/g, '');
  if (!cleaned) return false;
  // Block Windows UNC paths (\\host\share, //host/share), extended/device paths (\\?\, \\.\)
  if (/^(?:[\\/]{2}|[\\/]\?[\\/]|[\\/]\.[\\/])/.test(cleaned)) {
    return true;
  }
  // Block non-file URI schemes (e.g. ms-msdt:, search-ms:, http:) while preserving Windows drive letters (C:\)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(cleaned) && !/^file:/i.test(cleaned)) {
    return true;
  }
  if (/^file:/i.test(cleaned)) {
    try {
      const parsed = new URL(cleaned);
      const host = String(parsed.hostname || '').toLowerCase();
      if (host && host !== 'localhost') return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function isAbsoluteFsPath(value) {
  if (isBlockedNetworkOrDevicePath(value)) return false;
  return /^(?:[A-Za-z]:[\\/]|\/(?![\\/]))/.test(String(value || '').trim());
}

export function sanitizeConversationId(conversationId) {
  const raw = String(conversationId || '').trim();
  if (!raw || raw.includes('..') || /[\\/]/.test(raw)) return '';
  return raw;
}

function parseWorkspaceUris(rawUris) {
  let uris = [];
  if (Array.isArray(rawUris)) {
    uris = rawUris;
  } else if (typeof rawUris === 'string' && rawUris.trim()) {
    try {
      const parsed = JSON.parse(rawUris);
      if (Array.isArray(parsed)) uris = parsed;
    } catch {}
  }
  const result = [];
  for (const uri of uris) {
    if (typeof uri !== 'string' || !uri.trim()) continue;
    try {
      const fsPath = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
      if (fsPath) result.push(path.normalize(fsPath));
    } catch {}
  }
  return result;
}

function readConversationWorkspaces(conversationId, dbPath = SUMMARIES_DB_PATH) {
  const cid = sanitizeConversationId(conversationId);
  if (!cid || !fs.existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare('SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?')
      .get(cid);
    return row ? parseWorkspaceUris(row.workspace_uris) : [];
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

export function resolveConversationContext(conversationId, pageUrl = '', options = {}) {
  const cid = sanitizeConversationId(conversationId);
  const dbPath = options.summariesDbPath || SUMMARIES_DB_PATH;
  const brainBase = options.brainDir || BRAIN_DIR;
  const workspacePaths = readConversationWorkspaces(cid, dbPath);

  let projectParam = '';
  if (pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      projectParam = parsed.searchParams.get('project') || '';
    } catch {}
  }
  if (projectParam && projectParam !== 'outside-of-project' && isAbsoluteFsPath(projectParam)) {
    const norm = path.normalize(projectParam);
    if (!workspacePaths.some((p) => p.toLowerCase() === norm.toLowerCase())) {
      workspacePaths.unshift(norm);
    }
  }

  const preferredWorkspace = workspacePaths.find(
    (p) => !/[\\/]\.gemini([\\/]|$)/i.test(p) && !/[\\/]AppData[\\/]Local[\\/]Temp([\\/]|$)/i.test(p)
  ) || workspacePaths[0] || '';

  const brainDir = cid ? path.join(brainBase, cid) : '';
  const brainScratchDir = brainDir ? path.join(brainDir, 'scratch') : '';
  const envDefaultWs = process.env.AGY_DEFAULT_WORKSPACE || '';
  const scratchFallback = path.join(APP_DATA_DIR, 'scratch');
  const fallbackRoot = options.fallbackRoot
    || (envDefaultWs && fs.existsSync(envDefaultWs) ? envDefaultWs : '')
    || (fs.existsSync(scratchFallback) ? scratchFallback : '');

  const primaryCwd = preferredWorkspace
    || (brainDir && fs.existsSync(brainDir) ? brainDir : '')
    || fallbackRoot
    || USER_HOME;

  const rawRoots = [
    primaryCwd,
    ...workspacePaths,
    brainDir,
    brainScratchDir,
    fallbackRoot
  ].filter(Boolean);

  const seen = new Set();
  const roots = [];
  for (const r of rawRoots) {
    const norm = path.normalize(r);
    const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.existsSync(norm) && fs.statSync(norm).isDirectory()) {
        roots.push(norm);
      }
    } catch {}
  }

  return {
    id: cid || 'default',
    cwd: primaryCwd,
    roots,
    brainDir: brainDir && fs.existsSync(brainDir) ? brainDir : '',
    outsideProject: !preferredWorkspace
  };
}

export function resolveCandidatePaths(rawPath, roots = []) {
  let cleaned = String(rawPath || '').trim().replace(/^['"]+|['"]+$/g, '');
  if (!cleaned || isBlockedNetworkOrDevicePath(cleaned)) return [];

  if (cleaned === '~' || cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
    cleaned = path.join(USER_HOME, cleaned.slice(1).replace(/^[\\/]+/, ''));
  }

  // Handle /C:/foo style paths extracted from URLs
  if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }

  if (isAbsoluteFsPath(cleaned)) {
    return [path.normalize(cleaned)];
  }

  const rel = cleaned.replace(/^\.[\\/]+/, '');
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    const candidate = path.resolve(root, rel);
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(candidate);
    }
  }
  return out;
}

export async function statFile(ctx, rawPath) {
  const candidates = resolveCandidatePaths(rawPath, ctx?.roots || []);
  if (!candidates.length) return { ok: false, error: { code: 'not-found' } };

  let lastErrorCode = 'not-found';
  let sawDir = false;
  for (const candidate of candidates) {
    try {
      const st = await fs.promises.stat(candidate);
      if (st.isDirectory()) {
        sawDir = true;
        continue;
      }
      if (st.isFile()) {
        return {
          ok: true,
          value: {
            absolutePath: candidate,
            bytes: st.size,
            version: `${Math.trunc(st.mtimeMs)}:${st.size}`
          }
        };
      }
    } catch (err) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        lastErrorCode = 'denied';
      }
    }
  }
  if (sawDir) return { ok: false, error: { code: 'is-directory' } };
  return { ok: false, error: { code: lastErrorCode } };
}

export async function listDir(ctx, rawPath) {
  const candidates = resolveCandidatePaths(rawPath, ctx?.roots || []);
  if (!candidates.length) return { ok: false, error: { code: 'not-found' } };

  for (const candidate of candidates) {
    try {
      const st = await fs.promises.stat(candidate);
      if (!st.isDirectory()) continue;
      const dirents = await fs.promises.readdir(candidate, { withFileTypes: true });
      const maxEntries = 300;
      const truncated = dirents.length > maxEntries;
      const entries = dirents.slice(0, maxEntries).map((d) => ({
        name: d.name,
        type: d.isDirectory() ? 'directory' : d.isSymbolicLink() ? 'symlink' : 'file'
      }));
      return {
        ok: true,
        value: { path: candidate, entries, truncated }
      };
    } catch (err) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        return { ok: false, error: { code: 'denied' } };
      }
    }
  }
  return { ok: false, error: { code: 'not-found' } };
}

export async function readFileBytes(ctx, rawPath, options = {}) {
  const candidates = resolveCandidatePaths(rawPath, ctx?.roots || []);
  const offset = Math.max(0, Math.floor(Number(options?.range?.offset || 0)));
  const maxChunk = 2 * 1024 * 1024;
  const length = Math.min(maxChunk, Math.max(1, Math.floor(Number(options?.range?.length || maxChunk))));

  for (const candidate of candidates) {
    let fh;
    try {
      fh = await fs.promises.open(candidate, 'r');
      const stBefore = await fh.stat();
      if (!stBefore.isFile()) continue;
      const remaining = Math.max(0, stBefore.size - offset);
      const toRead = Math.min(length, remaining);
      const buf = Buffer.allocUnsafe(toRead);
      let bytesRead = 0;
      if (toRead > 0) {
        const res = await fh.read(buf, 0, toRead, offset);
        bytesRead = res.bytesRead;
      }
      const stAfter = await fh.stat();
      const version = `${Math.trunc(stAfter.mtimeMs)}:${stAfter.size}`;
      return {
        ok: true,
        value: {
          dataBase64: buf.subarray(0, bytesRead).toString('base64'),
          offset,
          bytes: stAfter.size,
          eof: offset + bytesRead >= stAfter.size,
          version,
          absolutePath: candidate
        }
      };
    } catch {
      // Try next candidate
    } finally {
      try { await fh?.close(); } catch {}
    }
  }
  return { ok: false, error: { code: 'not-found' } };
}

export async function listRecentFiles(ctx, limit = 30) {
  const roots = [];
  if (ctx?.brainDir) roots.push({ label: 'Artifacts', root: ctx.brainDir });
  if (ctx?.cwd && ctx.cwd !== ctx.brainDir) roots.push({ label: 'Workspace', root: ctx.cwd });

  const skipDirs = new Set(['node_modules', '.git', '.system_generated', 'dist', 'build', 'out', 'target']);
  const results = [];
  const seen = new Set();

  async function walk(dir, rootLabel, rootPath, depth) {
    if (depth > 2) return;
    let dirents;
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.name.startsWith('.') && d.name !== '.env') continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!skipDirs.has(d.name.toLowerCase())) {
          await walk(full, rootLabel, rootPath, depth + 1);
        }
      } else if (d.isFile()) {
        const key = full.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const st = await fs.promises.stat(full);
          results.push({
            name: d.name,
            relativePath: path.relative(rootPath, full).replace(/\\/g, '/'),
            absolutePath: full,
            source: rootLabel,
            bytes: st.size,
            mtimeMs: st.mtimeMs
          });
        } catch {}
      }
    }
  }

  for (const item of roots) {
    await walk(item.root, item.label, item.root, 0);
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);
}

/* ──────────────────────── Windows Registry & App Discovery ──────────────────────── */

async function runRegQuery(args) {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', ...args], {
      timeout: 2500,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return stdout || '';
  } catch {
    return '';
  }
}

export function parseRegOutput(text) {
  const keys = [];
  const values = [];
  let currentKey = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^HKEY_/i.test(line)) {
      currentKey = line.trim();
      keys.push(currentKey);
      continue;
    }
    const m = /^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line);
    if (m) {
      values.push({
        key: currentKey,
        name: m[1].trim(),
        type: m[2].trim(),
        value: m[3].trim()
      });
    }
  }
  return { keys, values };
}

export function expandWinEnv(str) {
  return String(str || '').replace(/%([^%]+)%/g, (full, name) => {
    const upper = name.toUpperCase();
    for (const [k, v] of Object.entries(process.env)) {
      if (k.toUpperCase() === upper && v !== undefined) return v;
    }
    return full;
  });
}

export function parseCommandTemplate(commandRaw) {
  const expanded = expandWinEnv(String(commandRaw || '').trim());
  if (!expanded) return null;
  let exe = '';
  let rest = '';
  if (expanded.startsWith('"')) {
    const close = expanded.indexOf('"', 1);
    if (close > 1) {
      exe = expanded.slice(1, close).trim();
      rest = expanded.slice(close + 1).trim();
    }
  } else {
    const exeMatch = /^(.+?\.exe)(?:\s+(.*))?$/i.exec(expanded);
    if (exeMatch) {
      exe = exeMatch[1].trim();
      rest = (exeMatch[2] || '').trim();
    } else {
      const parts = expanded.split(/\s+/);
      exe = parts[0];
      rest = parts.slice(1).join(' ');
    }
  }
  if (!exe) return null;
  return { exe, argsTemplate: rest, raw: expanded };
}

export function buildSpawnArgs(argsTemplate, absPath) {
  const raw = String(argsTemplate || '').trim();
  if (!raw) return [absPath];
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  let replaced = false;
  while ((m = re.exec(raw))) {
    let tok = m[1] !== undefined ? m[1] : m[2];
    if (/%[1lL]\b/.test(tok) || tok === '%*') {
      tok = tok.replace(/%[1lL*]/g, () => absPath);
      replaced = true;
    }
    if (tok !== '') tokens.push(tok);
  }
  if (!replaced) tokens.push(absPath);
  return tokens;
}

function friendlyNameForExe(exePath, registryName = '') {
  const cleanReg = String(registryName || '').trim();
  if (cleanReg && !/^@/.test(cleanReg) && !/^ms-resource:/i.test(cleanReg)) {
    return cleanReg;
  }
  const base = path.basename(exePath).toLowerCase();
  if (FRIENDLY_NAMES.has(base)) return FRIENDLY_NAMES.get(base);
  return path.basename(exePath, path.extname(exePath));
}

function friendlyNameForUwp(progId, appValues) {
  const appName = appValues.find((v) => v.name === 'ApplicationName')?.value || '';
  const pkgId = appValues.find((v) => v.name === 'PackageId')?.value
    || appValues.find((v) => v.name === 'AppUserModelID')?.value
    || appName
    || progId;
  const lower = String(pkgId).toLowerCase();
  if (lower.includes('windows.photos')) return '照片 (Photos)';
  if (lower.includes('windowsnotepad')) return '记事本 (Notepad)';
  if (lower.includes('paint')) return '画图 (Paint)';
  if (lower.includes('zunevideo') || lower.includes('mediaplayer')) return '媒体播放器';
  if (lower.includes('zunemusic')) return '媒体播放器 (音乐)';
  if (lower.includes('screensketch')) return '截图工具';
  if (appName && !appName.startsWith('@') && !appName.startsWith('ms-resource:')) return appName;
  const exeVal = appValues.find((v) => v.name === 'PackageRelativeExecutable')?.value;
  return exeVal ? path.basename(exeVal, path.extname(exeVal)) : progId;
}

async function loadAppPathsIndex() {
  if (cachedAppPaths && Date.now() - cachedAppPathsAt < 5 * 60 * 1000) {
    return cachedAppPaths;
  }
  const map = new Map();
  const hives = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'
  ];
  const outputs = await Promise.all(hives.map((h) => runRegQuery([h, '/s'])));
  for (const out of outputs) {
    const { values } = parseRegOutput(out);
    for (const row of values) {
      if (row.name !== '(Default)' || !row.value) continue;
      const keyBase = path.basename(row.key).toLowerCase();
      const exe = expandWinEnv(row.value.replace(/^"|"$/g, ''));
      if (exe && /\.exe$/i.test(exe) && fs.existsSync(exe)) {
        map.set(keyBase, exe);
      }
    }
  }

  // Also ensure well-known installed local user editors (not always in HKLM App Paths)
  const localApps = [
    process.env.ANTIGRAVITY_EXE || '',
    process.env.ANTIGRAVITY_INSTALL_DIR ? path.join(process.env.ANTIGRAVITY_INSTALL_DIR, 'Antigravity.exe') : '',
    path.join(path.dirname(process.execPath), 'Antigravity.exe'),
    path.join(USER_HOME, 'AppData', 'Local', 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'Antigravity.exe'),
    path.join(USER_HOME, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    path.join(USER_HOME, 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe')
  ];
  for (const candidate of localApps) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const keyBase = path.basename(candidate).toLowerCase();
        if (!map.has(keyBase)) map.set(keyBase, candidate);
      }
    } catch {}
  }

  cachedAppPaths = map;
  cachedAppPathsAt = Date.now();
  return map;
}

async function resolveProgIdApp(progId, isDefault, appPathsMap) {
  if (!progId || progId === '(value not set)') return null;
  const out = await runRegQuery([`HKCR\\${progId}`, '/s']);
  if (!out) return null;
  const { values } = parseRegOutput(out);

  const cmdRow = values.find(
    (v) => /\\shell\\open\\command$/i.test(v.key) && v.name === '(Default)' && v.value
  );
  if (cmdRow) {
    const parsed = parseCommandTemplate(cmdRow.value);
    if (parsed) {
      let exe = parsed.exe;
      if (!fs.existsSync(exe)) {
        const fallback = appPathsMap.get(path.basename(exe).toLowerCase());
        if (fallback) exe = fallback;
      }
      if (fs.existsSync(exe)) {
        const friendlyRow = values.find(
          (v) => v.name === 'FriendlyAppName' || v.name === 'ApplicationName'
        );
        return {
          exePath: exe,
          argsTemplate: parsed.argsTemplate,
          name: friendlyNameForExe(exe, friendlyRow?.value),
          default: isDefault,
          progId
        };
      }
    }
  }

  // Only include UWP AppX handlers when they are the system default (opened via shell.openPath)
  if (isDefault && (/^AppX/i.test(progId) || values.some((v) => v.name === 'DelegateExecute'))) {
    return {
      exePath: '',
      argsTemplate: '',
      name: friendlyNameForUwp(progId, values),
      default: true,
      uwpDefault: true,
      progId
    };
  }
  return null;
}

async function resolveExeApp(exeName, isDefault, appPathsMap) {
  const clean = String(exeName || '').trim();
  if (!clean || !/\.exe$/i.test(clean)) return null;
  const out = await runRegQuery([`HKCR\\Applications\\${clean}`, '/s']);
  const { values } = parseRegOutput(out);
  const cmdRow = values.find(
    (v) => /\\shell\\open\\command$/i.test(v.key) && v.name === '(Default)' && v.value
  );
  let exe = '';
  let argsTemplate = '';
  if (cmdRow) {
    const parsed = parseCommandTemplate(cmdRow.value);
    if (parsed) {
      exe = parsed.exe;
      argsTemplate = parsed.argsTemplate;
    }
  }
  if (!exe || !fs.existsSync(exe)) {
    exe = appPathsMap.get(clean.toLowerCase()) || '';
  }
  if (!exe || !fs.existsSync(exe)) return null;

  const friendlyRow = values.find((v) => v.name === 'FriendlyAppName');
  return {
    exePath: exe,
    argsTemplate,
    name: friendlyNameForExe(exe, friendlyRow?.value),
    default: isDefault
  };
}

async function getIconDataUrl(exePath, getFileIconFn) {
  if (!exePath || typeof getFileIconFn !== 'function') return null;
  const key = exePath.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);
  try {
    const img = await getFileIconFn(exePath);
    const dataUrl = img && typeof img.toDataURL === 'function' ? img.toDataURL() : null;
    iconCache.set(key, dataUrl || null);
    return dataUrl || null;
  } catch {
    iconCache.set(key, null);
    return null;
  }
}

export async function discoverApplications(absPath, options = {}) {
  if (process.platform !== 'win32') return [];
  const ext = path.extname(String(absPath || '')).toLowerCase();
  const appPathsMap = await loadAppPathsIndex();

  const queries = ext
    ? [
        runRegQuery([`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`]),
        runRegQuery([`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\OpenWithProgids`]),
        runRegQuery([`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\OpenWithList`]),
        runRegQuery([`HKCR\\${ext}`]),
        runRegQuery([`HKCR\\${ext}\\OpenWithProgids`]),
        runRegQuery([`HKCR\\${ext}\\OpenWithList`]),
        runRegQuery([`HKCR\\SystemFileAssociations\\${ext}\\OpenWithList`]),
        runRegQuery([`HKCR\\SystemFileAssociations\\${ext}\\OpenWithProgids`])
      ]
    : [];

  if (TEXT_LIKE_EXTS.has(ext)) {
    queries.push(
      runRegQuery(['HKCR\\SystemFileAssociations\\text\\OpenWithList']),
      runRegQuery(['HKCR\\SystemFileAssociations\\text\\OpenWithProgids'])
    );
  }

  const regOutputs = await Promise.all(queries);
  let defaultProgId = '';
  const progIds = new Set();
  const exeNames = new Set();

  for (const out of regOutputs) {
    const { keys, values } = parseRegOutput(out);
    for (const row of values) {
      if (/\\UserChoice$/i.test(row.key) && row.name === 'ProgId' && row.value) {
        defaultProgId = row.value;
        progIds.add(row.value);
      } else if (/\\OpenWithProgids$/i.test(row.key) && row.name && row.name !== '(Default)') {
        progIds.add(row.name);
      } else if (/\\OpenWithList$/i.test(row.key) && row.value && /\.exe$/i.test(row.value)) {
        exeNames.add(row.value);
      } else if (ext && row.key.toLowerCase().endsWith(`\\${ext}`) && row.name === '(Default)' && row.value && row.value !== '(value not set)') {
        if (!defaultProgId) defaultProgId = row.value;
        progIds.add(row.value);
      }
    }
    for (const k of keys) {
      if (/\\OpenWithList\\[^\\]+\.exe$/i.test(k)) {
        exeNames.add(path.basename(k));
      }
    }
  }

  const resolved = await Promise.all([
    ...[...progIds].slice(0, 12).map((pid) => resolveProgIdApp(pid, pid === defaultProgId, appPathsMap)),
    ...[...exeNames].slice(0, 12).map((exe) => resolveExeApp(exe, false, appPathsMap))
  ]);

  // Add well-known installed editors / browsers matching file kind so Open With is always useful
  const extraExes = [];
  if (TEXT_LIKE_EXTS.has(ext) || !ext) {
    extraExes.push('Antigravity.exe', 'Code.exe', 'Cursor.exe', 'notepad++.exe', 'notepad.exe');
  }
  if (BROWSER_EXTS.has(ext)) {
    extraExes.push('msedge.exe', 'chrome.exe');
  }
  for (const exeKey of extraExes) {
    const exePath = appPathsMap.get(exeKey.toLowerCase());
    if (exePath) {
      resolved.push({
        exePath,
        argsTemplate: '',
        name: friendlyNameForExe(exePath),
        default: false
      });
    }
  }

  const byId = new Map();
  for (const entry of resolved) {
    if (!entry) continue;
    const id = entry.exePath
      ? `exe:${entry.exePath.toLowerCase()}`
      : `uwp:${entry.progId}`;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { id, ...entry });
    } else if (entry.default && !existing.default) {
      existing.default = true;
    }
  }

  const items = [...byId.values()];
  await Promise.all(
    items.map(async (item) => {
      item.icon = item.exePath ? await getIconDataUrl(item.exePath, options.getFileIcon) : null;
      verifiedApps.set(item.id, {
        exePath: item.exePath,
        argsTemplate: item.argsTemplate || '',
        uwpDefault: item.uwpDefault === true
      });
    })
  );

  return items.map(({ id, name, default: isDefault, icon }) => ({
    id,
    name,
    default: Boolean(isDefault),
    icon: icon || null
  }));
}

export async function launchApplication(absPath, appId, shellApi) {
  if (!absPath || isBlockedNetworkOrDevicePath(absPath)) return false;
  if (!appId) {
    if (shellApi && typeof shellApi.openPath === 'function') {
      const errMsg = await shellApi.openPath(path.normalize(absPath));
      return errMsg === '';
    }
    return false;
  }

  let target = verifiedApps.get(appId);
  if (!target) {
    await discoverApplications(absPath);
    target = verifiedApps.get(appId);
  }
  if (!target) return false;

  if (target.uwpDefault) {
    if (shellApi && typeof shellApi.openPath === 'function') {
      const errMsg = await shellApi.openPath(path.normalize(absPath));
      return errMsg === '';
    }
    return false;
  }

  if (!target.exePath || !fs.existsSync(target.exePath)) return false;
  const args = buildSpawnArgs(target.argsTemplate, path.normalize(absPath));
  try {
    const child = spawn(target.exePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function revealInExplorer(absPath, shellApi) {
  if (!absPath || isBlockedNetworkOrDevicePath(absPath)) return false;
  const normalized = path.normalize(absPath);
  try {
    if (shellApi && typeof shellApi.showItemInFolder === 'function') {
      shellApi.showItemInFolder(normalized);
      return true;
    }
  } catch {}
  if (process.platform === 'win32') {
    try {
      // Windows explorer.exe treats unescaped commas in `/select,<path>` as argument separators
      const args = normalized.includes(',') ? [path.dirname(normalized)] : [`/select,${normalized}`];
      const child = spawn('explorer.exe', args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return true;
    } catch {}
  }
  return false;
}
