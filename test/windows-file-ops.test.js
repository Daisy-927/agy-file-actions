import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  discoverApplications,
  expandWinEnv,
  isAbsoluteFsPath,
  isBlockedNetworkOrDevicePath,
  launchApplication,
  listDir,
  listRecentFiles,
  parseCommandTemplate,
  parseRegOutput,
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
