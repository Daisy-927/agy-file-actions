import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import {
  buildSpawnArgs,
  detectRuntimeLoaderStatus,
  discoverApplications,
  expandWinEnv,
  isAbsoluteFsPath,
  isBlockedNetworkOrDevicePath,
  isPidAlive,
  launchApplication,
  listDir,
  listRecentFiles,
  parseCommandTemplate,
  parseRegOutput,
  parseWorkspaceUris,
  parseWslUncPath,
  parseWslUri,
  readFileBytes,
  resolveCandidatePaths,
  resolveConversationContext,
  revealInExplorer,
  statFile
} from '../scripts/windows-file-ops.mjs';

test('parseRegOutput parses keys and values', () => {
  const sample = `
HKEY_CLASSES_ROOT\\WorkBuddy.md\\shell\\open\\command
    (Default)    REG_SZ    "D:\\Tools\\WorkBuddy.exe" "%1"

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.png\\UserChoice
    ProgId    REG_SZ    AppX4mntx4h978m1v9gtzv0ewksfd6pmwsre
`;
  const parsed = parseRegOutput(sample);
  assert.equal(parsed.keys.length, 2);
  assert.equal(parsed.values.length, 2);
  assert.equal(parsed.values[0].name, '(Default)');
  assert.equal(parsed.values[0].value, '"D:\\Tools\\WorkBuddy.exe" "%1"');
  assert.equal(parsed.values[1].value, 'AppX4mntx4h978m1v9gtzv0ewksfd6pmwsre');
});

test('expandWinEnv and parseCommandTemplate extract exe and args', () => {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const expanded = expandWinEnv('%SystemRoot%\\system32\\notepad.exe');
  assert.equal(expanded.toLowerCase(), `${sysRoot.toLowerCase()}\\system32\\notepad.exe`);

  const quoted = parseCommandTemplate('"C:\\Program Files\\VS Code\\Code.exe" "--reuse-window" "%1"');
  assert.equal(quoted.exe, 'C:\\Program Files\\VS Code\\Code.exe');
  assert.equal(quoted.argsTemplate, '"--reuse-window" "%1"');

  const unquoted = parseCommandTemplate('%SystemRoot%\\system32\\NOTEPAD.EXE %1');
  assert.equal(unquoted.exe.toLowerCase(), `${sysRoot.toLowerCase()}\\system32\\notepad.exe`);
  assert.equal(unquoted.argsTemplate, '%1');
});

test('resolveConversationContext reads workspace_uris and brain dir from SQLite', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fa-test-'));
  try {
    const wsDir = path.join(tmp, 'workspace');
    const brainBase = path.join(tmp, 'brain');
    const cid = '11111111-2222-3333-4444-555555555555';
    const brainCidDir = path.join(brainBase, cid);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(path.join(brainCidDir, 'scratch'), { recursive: true });

    const dbPath = path.join(tmp, 'conversation_summaries.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT)');
    db.prepare('INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)')
      .run(cid, JSON.stringify([pathToFileURL(wsDir).href]));
    db.close();

    const ctx = resolveConversationContext(cid, `https://127.0.0.1:7255/c/${cid}`, {
      summariesDbPath: dbPath,
      brainDir: brainBase,
      fallbackRoot: wsDir
    });
    assert.equal(ctx.id, cid);
    assert.equal(ctx.cwd.toLowerCase(), wsDir.toLowerCase());
    assert.equal(ctx.outsideProject, false);
    assert.ok(ctx.roots.some((r) => r.toLowerCase() === wsDir.toLowerCase()));
    assert.ok(ctx.roots.some((r) => r.toLowerCase() === brainCidDir.toLowerCase()));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('statFile, listDir, readFileBytes, and listRecentFiles work across workspace and brain roots', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fa-fs-'));
  try {
    const wsDir = path.join(tmp, 'ws');
    const brainDir = path.join(tmp, 'brain');
    fs.mkdirSync(path.join(wsDir, 'sub'), { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });
    const dataPath = path.join(wsDir, 'sample-results.jsonl');
    const artPath = path.join(brainDir, 'task.md');
    fs.writeFileSync(dataPath, 'line1\nline2\nline3\n', 'utf8');
    fs.writeFileSync(artPath, '# Task\n', 'utf8');

    const ctx = { id: 'c1', cwd: wsDir, brainDir, roots: [wsDir, brainDir] };

    const st1 = await statFile(ctx, 'sample-results.jsonl');
    assert.equal(st1.ok, true);
    assert.equal(st1.value.absolutePath, dataPath);
    assert.equal(st1.value.bytes, Buffer.byteLength('line1\nline2\nline3\n'));

    const st2 = await statFile(ctx, 'task.md');
    assert.equal(st2.ok, true);
    assert.equal(st2.value.absolutePath, artPath);

    const stDir = await statFile(ctx, 'sub');
    assert.equal(stDir.ok, false);
    assert.equal(stDir.error.code, 'is-directory');

    const listed = await listDir(ctx, '.');
    assert.equal(listed.ok, true);
    assert.ok(listed.value.entries.some((e) => e.name === 'sample-results.jsonl' && e.type === 'file'));
    assert.ok(listed.value.entries.some((e) => e.name === 'sub' && e.type === 'directory'));

    const read1 = await readFileBytes(ctx, 'sample-results.jsonl', { range: { offset: 0, length: 6 } });
    assert.equal(read1.ok, true);
    assert.equal(read1.value.eof, false);
    assert.equal(Buffer.from(read1.value.dataBase64, 'base64').toString('utf8'), 'line1\n');

    const read2 = await readFileBytes(ctx, 'sample-results.jsonl', { range: { offset: 6, length: 100 } });
    assert.equal(read2.ok, true);
    assert.equal(read2.value.eof, true);
    assert.equal(Buffer.from(read2.value.dataBase64, 'base64').toString('utf8'), 'line2\nline3\n');

    const recent = await listRecentFiles(ctx, 10);
    assert.ok(recent.some((f) => f.name === 'sample-results.jsonl'));
    assert.ok(recent.some((f) => f.name === 'task.md'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveCandidatePaths normalizes /C:/ and ~/ paths', () => {
  const c1 = resolveCandidatePaths('/C:/foo/bar.txt', ['D:\\ws']);
  assert.equal(c1[0], path.normalize('C:\\foo\\bar.txt'));

  const c2 = resolveCandidatePaths('~/notes.md', ['D:\\ws']);
  assert.equal(c2[0], path.join(os.homedir(), 'notes.md'));
});

test('discoverApplications returns real Windows apps quickly for .jsonl and .md', async () => {
  const t0 = Date.now();
  const jsonlApps = await discoverApplications('C:\\temp\\sample.jsonl');
  const mdApps = await discoverApplications('C:\\temp\\sample.md');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `discoverApplications took too long: ${elapsed}ms`);
  assert.ok(jsonlApps.length > 0, 'Expected at least one Windows app for .jsonl');
  assert.ok(mdApps.length > 0, 'Expected at least one Windows app for .md');
});

test('blocks UNC network paths, device paths, and remote file:// URIs', async () => {
  assert.equal(isBlockedNetworkOrDevicePath('\\\\evil\\share\\secret.txt'), true);
  assert.equal(isBlockedNetworkOrDevicePath('//evil/share/secret.txt'), true);
  assert.equal(isBlockedNetworkOrDevicePath('\\\\?\\C:\\Windows\\win.ini'), true);
  assert.equal(isBlockedNetworkOrDevicePath('\\\\.\\pipe\\test'), true);
  assert.equal(isBlockedNetworkOrDevicePath('file://evil/share/secret.txt'), true);
  assert.equal(isBlockedNetworkOrDevicePath('file:///C:/workspace/a.txt'), false);
  assert.equal(isBlockedNetworkOrDevicePath('file://localhost/C:/workspace/a.txt'), false);

  assert.equal(isAbsoluteFsPath('\\\\evil\\share\\secret.txt'), false);
  assert.equal(isAbsoluteFsPath('//evil/share/secret.txt'), false);
  assert.equal(isAbsoluteFsPath('C:\\workspace\\a.txt'), true);

  assert.deepEqual(resolveCandidatePaths('\\\\evil\\share\\secret.txt', ['D:\\ws']), []);
  assert.deepEqual(resolveCandidatePaths('//evil/share/secret.txt', ['D:\\ws']), []);
  assert.deepEqual(resolveCandidatePaths('file://evil/share/secret.txt', ['D:\\ws']), []);

  assert.equal(await launchApplication('\\\\evil\\share\\secret.txt'), false);
  assert.equal(await revealInExplorer('//evil/share/secret.txt'), false);
});

test('buildSpawnArgs preserves literal $ sequences in Windows file paths', () => {
  const weirdPath = 'C:\\work\\price$$1$&test$\'file.txt';
  assert.deepEqual(buildSpawnArgs('"--open=%1"', weirdPath), [`--open=${weirdPath}`]);
  assert.deepEqual(buildSpawnArgs('%1', weirdPath), [weirdPath]);
});

test('allowlists valid WSL UNC paths & URIs while keeping remote SMB UNC and traversal escapes blocked', () => {
  assert.equal(isBlockedNetworkOrDevicePath('\\\\wsl.localhost\\Ubuntu\\home\\alice\\app.ts'), false);
  assert.equal(isBlockedNetworkOrDevicePath('//wsl.localhost/Ubuntu/home/alice/app.ts'), false);
  assert.equal(isBlockedNetworkOrDevicePath('\\\\wsl$\\Ubuntu-22.04\\etc\\hosts'), false);
  assert.equal(isBlockedNetworkOrDevicePath('file://wsl.localhost/Ubuntu/home/alice/app.ts'), false);
  assert.equal(isBlockedNetworkOrDevicePath('file://wsl$/Ubuntu/home/alice/app.ts'), false);
  assert.equal(isBlockedNetworkOrDevicePath('vscode-remote://wsl+Ubuntu/home/alice/proj'), false);
  assert.equal(isBlockedNetworkOrDevicePath('vscode-file://vscode-remote/wsl+Ubuntu/home/alice/app.ts#L5'), false);

  // Spoofed/generic UNC, bare distro traversal, and non-WSL remote hosts stay blocked
  assert.equal(isBlockedNetworkOrDevicePath('\\\\wsl.localhost.evil.com\\share\\a.txt'), true);
  assert.equal(isBlockedNetworkOrDevicePath('\\\\wsl.localhost\\..\\c$\\Windows\\win.ini'), true);
  assert.equal(isBlockedNetworkOrDevicePath('\\\\wsl.localhost'), true);
  assert.equal(isBlockedNetworkOrDevicePath('file://wsl.localhost.evil/Ubuntu/a.txt'), true);
  assert.equal(isBlockedNetworkOrDevicePath('\\\\127.0.0.1\\c$\\Windows\\win.ini'), true);

  assert.equal(isAbsoluteFsPath('\\\\wsl.localhost\\Ubuntu\\home\\alice\\app.ts'), true);
  assert.equal(isAbsoluteFsPath('vscode-remote://wsl+Ubuntu/home/alice/proj'), true);

  // Traversal must clamp cleanly inside the distro instead of escaping to another share
  const clamped = parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\..\\..\\other\\file.txt');
  assert.equal(clamped?.distro, 'Ubuntu');
  assert.equal(clamped?.winPath, '\\\\wsl.localhost\\Ubuntu\\other\\file.txt');

  const parsedRemote = parseWslUri('vscode-file://vscode-remote/wsl%2BUbuntu-22.04/home/alice/app.ts#L12');
  assert.equal(parsedRemote?.distro, 'Ubuntu-22.04');
  assert.equal(parsedRemote?.winPath, '\\\\wsl.localhost\\Ubuntu-22.04\\home\\alice\\app.ts');
  assert.equal(parsedRemote?.hash, '#L12');
});

test('maps WSL remote workspaces, /home/... paths, /mnt/<drive>/..., and clamped relative paths', () => {
  const mappedUris = parseWorkspaceUris(['vscode-remote://wsl+Ubuntu/home/alice/repo'], { existsSync: () => false });
  assert.equal(mappedUris[0], '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo');

  const mappedDollar = parseWorkspaceUris(
    ['vscode-remote://wsl+Ubuntu-20.04/home/alice/repo'],
    { existsSync: (p) => p.startsWith('\\\\wsl$\\') }
  );
  assert.equal(mappedDollar[0], '\\\\wsl$\\Ubuntu-20.04\\home\\alice\\repo');

  const wslCtx = {
    id: 'wsl-cid',
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo',
    roots: ['\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'],
    wsl: { host: 'wsl.localhost', distro: 'Ubuntu', mountRoot: '\\\\wsl.localhost\\Ubuntu' }
  };

  const homeCandidates = resolveCandidatePaths('/home/alice/repo/src/index.ts', wslCtx.roots, wslCtx);
  assert.equal(homeCandidates[0], '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\src\\index.ts');

  const mntCandidates = resolveCandidatePaths('/mnt/e/work/notes.md', wslCtx.roots, wslCtx);
  assert.equal(mntCandidates[0], 'E:\\work\\notes.md');
  assert.ok(mntCandidates.includes('\\\\wsl.localhost\\Ubuntu\\mnt\\e\\work\\notes.md'));

  const clampedRel = resolveCandidatePaths('..\\..\\..\\etc\\passwd', wslCtx.roots, wslCtx);
  assert.equal(clampedRel[0], '\\\\wsl.localhost\\Ubuntu\\etc\\passwd');

  // POSIX file:///home/... and ~/... in active WSL session
  const filePosixCandidates = resolveCandidatePaths('file:///home/alice/repo/src/index.ts', wslCtx.roots, wslCtx);
  assert.equal(filePosixCandidates[0], '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\src\\index.ts');

  const tildeCandidates = resolveCandidatePaths('~/notes.md', wslCtx.roots, wslCtx);
  assert.equal(tildeCandidates[0], '\\\\wsl.localhost\\Ubuntu\\home\\alice\\notes.md');
  assert.ok(tildeCandidates.includes(path.join(os.homedir(), 'notes.md')));

  // wsl:// URI, plain POSIX workspace URI, and /mnt/<drive> workspace URI with default distro fallback
  assert.equal(isBlockedNetworkOrDevicePath('wsl://Ubuntu/home/alice/app.ts'), false);
  const wslSchemeUris = parseWorkspaceUris(
    ['wsl://Ubuntu/home/alice/repo', 'file:///home/alice/proj', '/home/alice/other', 'file:///mnt/d/work'],
    { defaultWslDistro: 'Ubuntu', existsSync: () => false }
  );
  assert.equal(wslSchemeUris[0], '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo');
  assert.equal(wslSchemeUris[1], '\\\\wsl.localhost\\Ubuntu\\home\\alice\\proj');
  assert.equal(wslSchemeUris[2], '\\\\wsl.localhost\\Ubuntu\\home\\alice\\other');
  assert.equal(wslSchemeUris[3], 'D:\\work');
});

test('detectRuntimeLoaderStatus validates PID liveness and live CDP reachability accurately', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fa-status-'));
  const directFile = path.join(tmp, 'direct_loader_status.json');
  const cdpFile = path.join(tmp, 'cdp_loader_status.json');
  const portFile = path.join(tmp, 'DevToolsActivePort');

  let cdpServer;
  try {
    assert.equal(isPidAlive(process.pid), true);

    // 1. Stale direct_loader_status.json from an exited process must NOT report active
    fs.writeFileSync(directFile, JSON.stringify({ active: true, pid: 99999999, stage: 'attached' }), 'utf8');
    const staleStatus = await detectRuntimeLoaderStatus({
      statusFile: directFile,
      cdpStatusFile: cdpFile,
      portFiles: [portFile],
      isPidAlive: () => false
    });
    assert.equal(staleStatus.active, false);
    assert.equal(staleStatus.stale, true);
    assert.equal(staleStatus.reason, 'process-exited');

    // 2. Live Electron process reports active
    const liveElectron = await detectRuntimeLoaderStatus({
      statusFile: directFile,
      cdpStatusFile: cdpFile,
      portFiles: [portFile],
      isPidAlive: (pid) => pid === 99999999
    });
    assert.equal(liveElectron.active, true);
    assert.equal(liveElectron.mode, 'electron');

    // 3. Stale Electron + reachable CDP port without injector -> cdp-unattached
    cdpServer = http.createServer((req, res) => {
      if (req.url === '/json/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 't1', type: 'page', url: 'https://127.0.0.1:7255/c/abc' }]));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => cdpServer.listen(0, '127.0.0.1', r));
    const port = cdpServer.address().port;
    fs.writeFileSync(portFile, `${port}\n/devtools/browser/test\n`, 'utf8');

    const unattached = await detectRuntimeLoaderStatus({
      statusFile: directFile,
      cdpStatusFile: cdpFile,
      portFiles: [portFile],
      isPidAlive: () => false
    });
    assert.equal(unattached.active, false);
    assert.equal(unattached.mode, 'cdp-unattached');
    assert.equal(unattached.cdpReady, true);
    assert.equal(unattached.cdpPort, port);

    // 4. Live CDP injector PID + reachable CDP endpoint -> active CDP
    fs.writeFileSync(cdpFile, JSON.stringify({ active: true, pid: process.pid, cdpUrl: `http://127.0.0.1:${port}`, stage: 'attached' }), 'utf8');
    const cdpLive = await detectRuntimeLoaderStatus({
      statusFile: directFile,
      cdpStatusFile: cdpFile,
      portFiles: [portFile],
      isPidAlive: (pid) => pid === process.pid
    });
    assert.equal(cdpLive.active, true);
    assert.equal(cdpLive.mode, 'cdp');
    assert.equal(cdpLive.cdpPort, port);

    // 5. Stale cdp_loader_status.json with old dead port must NOT shadow fresh DevToolsActivePort
    fs.writeFileSync(cdpFile, JSON.stringify({ active: true, pid: 99999998, cdpUrl: 'http://127.0.0.1:1', stage: 'attached' }), 'utf8');
    const recoveredFromPortFile = await detectRuntimeLoaderStatus({
      statusFile: directFile,
      cdpStatusFile: cdpFile,
      portFiles: [portFile],
      isPidAlive: () => false
    });
    assert.equal(recoveredFromPortFile.active, false);
    assert.equal(recoveredFromPortFile.mode, 'cdp-unattached');
    assert.equal(recoveredFromPortFile.cdpReady, true);
    assert.equal(recoveredFromPortFile.cdpPort, port);

    // 6. Fallback endpoint probing works when DevToolsActivePort does not exist
    const fallbackStatus = await detectRuntimeLoaderStatus({
      statusFile: directFile,
      cdpStatusFile: path.join(tmp, 'missing_cdp.json'),
      portFiles: [path.join(tmp, 'missing_port')],
      fallbackEndpoints: [`http://127.0.0.1:${port}`],
      isPidAlive: () => false
    });
    assert.equal(fallbackStatus.active, false);
    assert.equal(fallbackStatus.mode, 'cdp-unattached');
    assert.equal(fallbackStatus.cdpReady, true);
    assert.equal(fallbackStatus.cdpPort, port);

    // 7. Live CDP injector in waiting stage (no conversation tab open yet) reports active waiting
    fs.writeFileSync(cdpFile, JSON.stringify({ active: false, pid: process.pid, cdpUrl: `http://127.0.0.1:${port}`, stage: 'waiting' }), 'utf8');
    const cdpWaiting = await detectRuntimeLoaderStatus({
      statusFile: directFile,
      cdpStatusFile: cdpFile,
      portFiles: [portFile],
      isPidAlive: (pid) => pid === process.pid
    });
    assert.equal(cdpWaiting.active, true);
    assert.equal(cdpWaiting.mode, 'cdp');
    assert.equal(cdpWaiting.stage, 'waiting');
    assert.equal(cdpWaiting.cdpPort, port);
  } finally {
    try { cdpServer?.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
