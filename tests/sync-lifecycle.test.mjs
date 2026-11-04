import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
let now = 1_000_000, timerId = 0;
const timers = new Map();
const window = {
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
  clearTimeout(id) { timers.delete(id); }, clearInterval: noop,
};
class ClockDate extends Date { static now() { return now; } }
function advance(ms) {
  const end = now + ms;
  while (true) {
    const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    now = next[1].at;
    timers.delete(next[0]);
    next[1].fn();
  }
  now = end;
}
function load(source, requireStub = () => ({}), extra = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
  } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: requireStub,
    window, Date: ClockDate, console, WebSocket: { OPEN: 1 }, ...extra });
  return module.exports;
}
const { SyncProgressTracker } = load(fs.readFileSync('src/lib/sync/sync_progress_tracker.ts', 'utf8'),
  () => ({ dump: noop }));
const logs = [];
const { checkSyncCompletion, handleSync } = load(fs.readFileSync('src/lib/sync/operator.ts', 'utf8'), id => {
  if (id === 'obsidian') return { normalizePath: x => x, TFile: class {}, Platform: {} };
  if (id.includes('helpers')) return { dump: noop, showSyncNotice: noop };
  if (id.includes('sync_log_manager')) return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: x => logs.push(x) }) } };
  if (id.includes('i18n')) return { $: key => key };
  if (id === './operator_file') return { sweepStalledDownloadSessions: noop };
  return {};
});

// Run the actual mobile banner component with tiny React state/effect stubs.
const view = fs.readFileSync('src/views/sync-log-view.tsx', 'utf8');
const start = view.indexOf('const SyncProgressBanner = ');
const end = view.indexOf('const SyncLogComponent = ', start);
assert.ok(start >= 0 && end > start);
let banner, handler;
const React = {
  useState(initial) { banner = initial; return [initial, fn => { banner = typeof fn === 'function' ? fn(banner) : fn; }]; },
  useEffect(effect) { effect(); },
};
const { SyncProgressBanner } = load(view.slice(start, end) + '\nexports.SyncProgressBanner = SyncProgressBanner;',
  undefined, { React });
SyncProgressBanner({ plugin: { app: { workspace: { on(_name, fn) { handler = fn; } } } } });
const tracker = new SyncProgressTracker();
const events = [];
tracker.onProgressChange = (pct, detail, phase) => { events.push({ pct, phase }); handler({ pct, detail, phase }); };
tracker.reset(['file']);
tracker.recordHashProgress(100);
tracker.setDownloadTotal('file', 2);
tracker.recordUploadComplete('file');
tracker.recordPageProgress('file', 0, 2, true, true);
let resets = 0, flushes = 0, idle = true;
const statuses = [];
const stats = () => ({ completed: 0, failed: 0, needUpload: 0, needModify: 0, needSyncMtime: 0, deleted: 0 });
const p = {
  syncState: { activeSyncContext: 'one', progressCheckIntervalId: null, currentSyncType: 'incremental',
    newConflictedPathsThisRound: new Set() },
  settings: { syncEnabled: true, configSyncEnabled: false }, isSyncing: true,
  noteSyncTasks: stats(), fileSyncTasks: { ...stats(), needUpload: 2 }, folderSyncTasks: stats(), configSyncTasks: stats(),
  uploadedChunksCount: 0, downloadedChunksCount: 0,
  pendingUploadHashes: new Map(), pendingNoteModifies: new Map(), pendingConfigModifies: new Map(),
  concurrencyLimiter: { activeKeys: new Set(['active-upload']), queue: [], isIdle: () => idle },
  resetSyncTasks() { resets++; }, syncPageStateMap: new Map(),
  fileDownloadSessions: new Map(), progressTracker: tracker,
  websocket: { ws: { readyState: 1, bufferedAmount: 0 } },
  updateStatusBar(...args) { statuses.push(args); }, statusBarManager: { updateConflictBadge: noop },
  expectedSyncCount: 3, localStorageManager: { getMetadata: () => true, setMetadata: noop },
  fileHashManager: { flush() { flushes++; } },
};
const began = now;
for (const elapsed of [300001, 6 * 60 * 60 * 1000]) {
  advance(elapsed);
  checkSyncCompletion(p, undefined, began, 'one');
  assert.equal(p.syncState.activeSyncContext, 'one', 'elapsed duration must not retire unfinished work');
  assert.equal(resets, 0);
  assert.equal(events.some(e => e.pct === 100), false);
  assert.equal(banner.visible, true);
}
tracker.recordCompleted('file', 0);
tracker.recordCompleted('file', 0);
idle = false;
checkSyncCompletion(p, undefined, began, 'one');
assert.equal(resets, 0, 'queued/in-flight work must drain before completion');
idle = true;
p.pendingUploadHashes.set('late.bin', 'hash');
checkSyncCompletion(p, undefined, began, 'one');
assert.equal(resets, 0, 'pending upload ACK prevents completion');
p.pendingUploadHashes.clear();
checkSyncCompletion(p, undefined, began, 'one');
assert.equal(resets, 1);
assert.equal(flushes, 1);
assert.equal(p.isSyncing, false);
assert.equal(banner.pct, 100);
assert.equal(logs.filter(log => log.action === 'SyncSummary').length, 1);
advance(2500);
assert.equal(banner.visible, false);
const count = events.length;
tracker.recordCompleted('file', 0);
tracker.recordDownloadComplete('file');
tracker.recordHashProgress(100);
advance(100);
assert.equal(events.length, count, 'late callbacks must not re-open a completed banner');
assert.equal(banner.visible, false);

// Stopping an interrupted round must never emit a successful 100% event.
tracker.reset(['file']);
tracker.recordHashProgress(100);
tracker.setDownloadTotal('file', 2);
tracker.recordUploadComplete('file');
tracker.recordPageProgress('file', 0, 2, true, true);
const beforeStop = events.length;
tracker.stop();
assert.equal(events.at(-1).phase, 'idle');
assert.ok(events.at(-1).pct < 100);
assert.equal(banner.visible, false);
tracker.recordCompleted('file', 0);
tracker.forceComplete();
advance(2500);
assert.equal(events.length, beforeStop + 1);
assert.equal(banner.visible, false);

// A previous round's delayed status hide must not hide a new active round.
p.syncState.activeSyncContext = 'two';
tracker.reset(['file']);
const statusCount = statuses.length;
advance(10000);
assert.equal(statuses.length, statusCount);

// A blocked legacy-state conflict cannot start scanning or a network sync.
await handleSync({ fileHashManager: { isReady: () => false } });
console.log('PASS: long transfers, ACK/queue completion gates, one terminal event, late callback suppression, interrupted UI and recovery gate');
