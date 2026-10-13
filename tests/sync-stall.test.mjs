import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/lib/sync/operator.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
vm.runInNewContext(code, { module, exports: module.exports, console, window: { setTimeout: () => 1, clearTimeout: noop },
  require: id => id === 'obsidian' ? { normalizePath: x => x, TFile: class {}, Platform: {} }
    : id.includes('helpers') ? { dump: noop }
    : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: noop }) } }
    : id.includes('i18n') ? { $: k => k } : {} });
const { isSyncStalled, SYNC_STALL_RESTART_MS } = module.exports;

const mk = () => ({
  noteSyncTasks: { completed: 1, failed: 0 }, fileSyncTasks: { completed: 5, failed: 0 },
  folderSyncTasks: { completed: 0 }, configSyncTasks: { completed: 0 },
  uploadedChunksCount: 0, downloadedChunksCount: 0,
  progressTracker: { getOverallPct: () => 40 },
  concurrencyLimiter: { activeKeys: new Set(), queue: [] },
  fileDownloadSessions: new Map(), isSyncRequesting: false,
});
const t0 = 1_000_000;
const p = mk();
assert.equal(isSyncStalled(p, 'ctx', t0), false, 'first observation only records the baseline');
assert.equal(isSyncStalled(p, 'ctx', t0 + SYNC_STALL_RESTART_MS - 1), false);
assert.equal(isSyncStalled(p, 'ctx', t0 + SYNC_STALL_RESTART_MS + 1), true, 'idle and unchanged past the limit');

// Progress resets the clock
p.fileSyncTasks.completed++;
assert.equal(isSyncStalled(p, 'ctx', t0 + 2 * SYNC_STALL_RESTART_MS), false);
assert.equal(isSyncStalled(p, 'ctx', t0 + 2 * SYNC_STALL_RESTART_MS + 1000), false);

// Work in flight is never a stall, however long it takes
const q = mk();
q.concurrencyLimiter.activeKeys.add('upload_x');
isSyncStalled(q, 'ctx2', t0);
assert.equal(isSyncStalled(q, 'ctx2', t0 + 10 * SYNC_STALL_RESTART_MS), false);
q.concurrencyLimiter.activeKeys.clear();
q.fileDownloadSessions.set('s', {});
assert.equal(isSyncStalled(q, 'ctx2', t0 + 10 * SYNC_STALL_RESTART_MS), false);

// A new context starts a fresh baseline
const r = mk();
isSyncStalled(r, 'a', t0);
assert.equal(isSyncStalled(r, 'b', t0 + 10 * SYNC_STALL_RESTART_MS), false);
console.log('sync stall watchdog tests passed');
