import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
const errors = [];
const helpers = { dump: noop, dumpError: m => errors.push(String(m)),
  hashContent: x => x, hashArrayBuffer: async () => 'h', hashFileAsync: async () => 'h',
  getPluginDir: () => '.plugin', sleep: async () => {}, isPathExcluded: () => false,
  getSafeCtime: x => x ?? 0, isLargeBinarySyncRisk: () => false, describeBinarySyncLimit: () => '1GB',
  showSyncNotice: noop, checkAndNotifyCaseConflict: () => false, logMemorySnapshot: noop,
  vaultDelete: async () => {} };
const logs = { addLog: noop, addOrUpdateLog: noop, logReceivedMessage: noop };
function load(file, extra = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console,
    window: { setTimeout: fn => { fn(); return 1; }, clearTimeout: noop },
    ...globals,
    require: id => id === 'obsidian' ? { normalizePath: x => x, TFile: class {}, TAbstractFile: class {}, Platform: { isMobile: false } }
      : id.includes('helpers') ? helpers
      : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => logs } }
      : id.includes('file_cloud_preview') ? { FileCloudPreview: { isRestrictedType: () => false } }
      : id.includes('http_api_service') ? { HttpApiService: class {} }
      : extra[id] || {} });
  return module.exports;
}

const op = load('src/lib/sync/operator_file.ts');

function makePlugin() {
  const completed = [];
  const sent = [];
  return {
    settings: { syncEnabled: true, vault: 'test', concurrencyControlEnabled: true, maxConcurrentUploads: 5 },
    fileDownloadSessions: new Map(),
    pendingFileDeleteAcks: new Set(),
    fileSyncTasks: { failed: 0, completed: 0, needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0 },
    recordSyncCompleted: (type, page) => completed.push([type, page]),
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: noop },
    localStorageManager: { getMetadata: () => 0, setMetadata: noop, savePending: noop },
    app: { vault: { adapter: { exists: async () => true, mkdir: async () => {}, rmdir: async () => {}, write: async () => {} } } },
    websocket: { isOpen: true, SendMessage: (action, data) => { sent.push([action, data]); return Promise.resolve(); } },
    completedCalls: completed, sent
  };
}

// A temp session as created by receiveFileSyncUpdate / the reaper: keyed `temp_<path>`,
// empty sessionId until the first chunk arrives.
function tempSession(path, { retries = 0, lastActivityAt, totalChunks = 0 } = {}) {
  return { path, sessionId: '', totalChunks, size: 10, ctime: 1, mtime: 1, lastTime: 0,
    pageIndex: 2, initialSlotKey: `download_${path}`, lastActivityAt, downloadRetries: retries,
    pathHash: 'h', chunks: new Map() };
}

{ // Fix A: a failed temp session must leave the map; failure accounting runs exactly once.
  const p = makePlugin();
  p.fileDownloadSessions.set('temp_a.md', tempSession('a.md', { retries: 2, lastActivityAt: Date.now() - 31000 }));
  await op.reapStalledDownloads(p);
  assert.equal(p.fileDownloadSessions.size, 0, 'failed temp session must be removed from the map');
  assert.equal(p.fileSyncTasks.failed, 1);
  assert.deepEqual(p.completedCalls, [['file', 2]]);
  // checkSyncCompletion ticks every 100ms; the old bug re-failed the leaked zombie on every tick.
  for (let i = 0; i < 10; i++) await op.reapStalledDownloads(p);
  assert.equal(p.fileDownloadSessions.size, 0);
  assert.equal(p.fileSyncTasks.failed, 1, 'zombie must not be failed again');
  assert.equal(p.completedCalls.length, 1, 'failure accounting must run exactly once');
}

{ // Fix B: zero-chunk sessions are re-requested (cheap) up to the retry bound.
  const p = makePlugin();
  p.fileDownloadSessions.set('temp_b.md', tempSession('b.md', { retries: 0, lastActivityAt: Date.now() - 31000 }));
  await op.reapStalledDownloads(p);
  assert.equal(p.fileDownloadSessions.size, 1, 're-request keeps a fresh temp session');
  const [key, s] = Array.from(p.fileDownloadSessions.entries())[0];
  assert.equal(key, 'temp_b.md');
  assert.equal(s.downloadRetries, 1);
  assert.ok(p.sent.some(([a]) => a === 'FileChunkDownload'), 're-request must send FileChunkDownload');
}

{ // Fix B: partial progress is only stalled after the long threshold, and never re-requested.
  const p = makePlugin();
  const s = { path: 'p.md', sessionId: 'S-partial', totalChunks: 8, size: 80, ctime: 1, mtime: 1, lastTime: 0,
    lastActivityAt: Date.now() - 40000, downloadRetries: 0, pathHash: 'h', downloadedChunks: new Set([1]) };
  p.fileDownloadSessions.set('S-partial', s);
  await op.reapStalledDownloads(p);
  assert.equal(p.fileDownloadSessions.size, 1, 'slow-but-live transfer must not be killed at the short threshold');
  assert.equal(p.sent.length, 0);
  s.lastActivityAt = Date.now() - 6 * 60 * 1000;
  await op.reapStalledDownloads(p);
  assert.equal(p.fileDownloadSessions.size, 0, 'long-silent partial download must be failed');
  assert.equal(p.fileSyncTasks.failed, 1);
  assert.ok(!p.sent.some(([a]) => a === 'FileChunkDownload'), 'partial progress must not be re-requested from chunk 0');
}

{ // Fix D: late chunks of a superseded stream are dropped, not resurrected as duplicates.
  const p = makePlugin();
  p.fileDownloadSessions.set('S-live', { path: 'c.md', sessionId: 'S-live', totalChunks: 4, size: 40, ctime: 1, mtime: 1, lastTime: 0, lastActivityAt: Date.now(), chunks: new Map() });
  await op.receiveFileSyncChunkDownload({ path: 'c.md', sessionId: 'S-stale', totalChunks: 4, chunkSize: 10, size: 40, ctime: 1, mtime: 1 }, p);
  assert.equal(p.fileDownloadSessions.size, 1, 'superseded stream must not resurrect a duplicate session');
  assert.ok(!p.fileDownloadSessions.has('S-stale'));
  // A genuinely new path (e.g. after reconnect) still creates its session.
  await op.receiveFileSyncChunkDownload({ path: 'd.md', sessionId: 'S-new', totalChunks: 2, chunkSize: 10, size: 20, ctime: 1, mtime: 1 }, p);
  assert.ok(p.fileDownloadSessions.has('S-new'), 'fresh download must still be created');
}

{ // Fix D: a duplicate FileSyncUpdate for an in-flight path starts no second session.
  const p = makePlugin();
  p.fileDownloadSessions.set('S-live', { path: 'e.md', sessionId: 'S-live', totalChunks: 4, size: 40, ctime: 1, mtime: 1, lastTime: 0, lastActivityAt: Date.now(), chunks: new Map() });
  await op.receiveFileSyncUpdate({ path: 'e.md', contentHash: 'h', ctime: 1, mtime: 1, lastTime: 1, size: 40, pathHash: 'h' }, p);
  assert.equal(p.fileDownloadSessions.size, 1, 'duplicate FileSyncUpdate must not start a second session');
  assert.ok(!p.sent.some(([a]) => a === 'FileChunkDownload'), 'no new download request for an in-flight file');
}

console.log('PASS: stalled-download reaper (zombie removal, single accounting, two-tier thresholds, superseded-stream drop, duplicate-request guard)');
