// Runs real handlers, summary generation and React rendering against an in-memory vault.
// No network, live Obsidian instance, or vault writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const noop = () => {};
class TFile { constructor(path) { this.path = path; } }
class TFolder { constructor(path) { this.path = path; this.children = []; } }
let excluded = false, empty = true;
const helpers = {
  dump: noop, dumpError: noop, showSyncNotice: noop,
  isPathExcluded: () => excluded, isFolderSyncPathExcluded: () => excluded,
  configIsPathExcluded: () => excluded, isPathInConfigSyncDirs: () => true,
  waitForFolderEmpty: async () => empty, checkAndNotifyCaseConflict: () => false,
};
const en = load('src/i18n/locales/en.ts').default;
const translate = (key, params = {}) => (en[key] || key).replace(/\$\{(\w+)\}/g, (_, k) => String(params[k]));
const { SyncLogManager } = load('src/lib/sync/sync_log_manager.ts');
const manager = SyncLogManager.getInstance();
const { SyncState } = load('src/lib/sync/sync_state.ts');
const note = load('src/lib/sync/operator_note.ts');
const file = load('src/lib/sync/operator_file.ts');
const folder = load('src/lib/sync/operator_folder.ts');
const config = load('src/lib/sync/operator_config.ts');
const { checkSyncCompletion } = load('src/lib/sync/operator.ts', {
  './operator_file': { sweepStalledDownloadSessions: async () => {} },
});
const { TestSummaryCard } = load('src/views/sync-log-view.tsx', {}, '\nexport { SyncSummaryCard as TestSummaryCard };');

function load(path, extra = {}, suffix = '') {
  const module = { exports: {} };
  const source = fs.readFileSync(path, 'utf8') + suffix;
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
  } }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, WebSocket: { OPEN: 1 },
    window: { setTimeout: () => 1, clearTimeout: noop, clearInterval: noop },
    require(id) {
      if (id in extra) return extra[id];
      if (id === 'react') return require('react');
      if (id === 'obsidian') return {
        TFile, TFolder, ItemView: class {}, normalizePath: x => x.replace(/\\/g, '/'),
        moment: () => ({ format: () => '12:00:00' }), Platform: { isMobile: false },
      };
      if (id.includes('helpers')) return helpers;
      if (id.endsWith('i18n/lang')) return { $: translate };
      if (id.endsWith('sync_log_manager')) return { SyncLogManager };
      if (id === './remote_path_guard') return {
        blockAliasedRemoteMutation: (p, target, requested, action) => {
          if (target.path === requested) return false;
          manager.addLog('receive', `${action}PathAliasBlocked`, 'Aliased path', 'error', requested);
          return true;
        },
      };
      return {};
    },
  }, { filename: path });
  return module.exports;
}

const handlers = [
  ['note', 'NoteSyncDelete', note.receiveNoteSyncDelete, 'noteSyncTasks'],
  ['file', 'FileSyncDelete', file.receiveFileSyncDelete, 'fileSyncTasks'],
  ['folder', 'FolderSyncDelete', folder.receiveFolderSyncDelete, 'folderSyncTasks'],
  ['config', 'SettingSyncDelete', config.receiveConfigSyncDelete, 'configSyncTasks'],
];

function fixture(kind, present = false, fail = false) {
  manager.clearLogs();
  const path = kind === 'config' ? '.obsidian/example.json' : `example/${kind}`;
  let target = present ? (kind === 'folder' ? new TFolder(path) : new TFile(path)) : null;
  const completed = [], statuses = [], metadata = new Map(), writes = [];
  const state = new SyncState();
  state.currentSyncType = 'full';
  const trash = async () => {
    if (fail) throw new Error('trash unavailable');
    writes.push(path);
    target = null;
  };
  const p = {
    syncState: state, settings: { syncEnabled: true, configSyncEnabled: true },
    app: { vault: {
      getFileByPath: () => target, getAbstractFileByPath: () => target, trash,
      adapter: { exists: async () => !!target, trashLocal: trash },
    } },
    lockManager: { withLock: async (_, fn) => fn() },
    addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredConfigFile: () => false,
    lastSyncPathDeleted: new Set(), lastSyncMtime: new Map(), pendingNoteModifies: new Map(),
    fileHashManager: { removeFileHash: noop },
    configHashManager: { isReady: () => true, removeFileHash: noop },
    configManager: { removeFileState: noop }, folderSnapshotManager: { removeFolder: noop },
    localStorageManager: { savePending: noop, getMetadata: k => metadata.get(k), setMetadata: (k, v) => metadata.set(k, v) },
    concurrencyLimiter: { releaseSlot: noop },
    recordSyncCompleted: (...args) => completed.push(args),
    websocket: { ws: { readyState: 1, bufferedAmount: 0 } },
    progressTracker: { isTypeFullyDone: () => true, getOverallPct: () => 100, forceComplete: noop },
    fileDownloadSessions: new Map(), syncPageStateMap: new Map(),
    resetSyncTasks: () => state.resetSession(),
    updateStatusBar: text => statuses.push(text), statusBarManager: { updateConflictBadge: noop },
    expectedSyncCount: 4,
  };
  for (const key of ['noteSyncTasks', 'fileSyncTasks', 'folderSyncTasks', 'configSyncTasks']) {
    Object.defineProperty(p, key, { get: () => state[key] });
  }
  return { p, path, completed, statuses, writes };
}

function summary(p) {
  checkSyncCompletion(p);
  const log = manager.getLogs().find(x => x.action === 'SyncSummary');
  assert.ok(log, 'completion emits a summary');
  return { stats: JSON.parse(log.message), log };
}

let cases = 0;
for (const [kind, action, handler, statsKey] of handlers) {
  for (const [present, fail] of [[false, false], [true, false], [true, true]]) {
    const f = fixture(kind, present, fail);
    f.p[statsKey].needDelete = 1; // Server task count must remain untouched until normal reset.
    manager.logReceivedMessage(action, { code: 200, data: { path: f.path } }, 'full');
    assert.equal(manager.getLogs().length, 0, 'receipt alone must not claim success');
    await handler({ path: f.path, pageIndex: 3 }, f.p);
    assert.equal(f.p[statsKey].needDelete, 1, 'presentation counters cannot alter protocol totals');
    assert.equal(f.p[statsKey].deleted ?? 0, present && !fail ? 1 : 0);
    assert.equal(f.p[statsKey].alreadyAbsent ?? 0, !present ? 1 : 0);
    assert.equal(f.p[statsKey].failed, fail ? 1 : 0);
    assert.equal(f.completed.length, 1, 'complete the page item exactly once, including no-ops/failures');
    assert.equal(f.completed[0][0], kind === 'config' ? 'setting' : kind);
    assert.equal(f.completed[0][1], 3);
    const successes = manager.getLogs().filter(x => x.action === action && x.status === 'success');
    assert.equal(successes.length, present && !fail ? 1 : 0);
    const { stats, log } = summary(f.p);
    assert.equal(stats[kind].delete, present && !fail ? 1 : 0);
    assert.equal(stats.skippedDeletes[kind], !present ? 1 : 0);
    assert.equal(stats.hasChanges, present && !fail);
    assert.equal(stats.failed, fail ? 1 : 0);
    const html = renderToStaticMarkup(React.createElement(TestSummaryCard, { log }));
    if (!present) {
      assert.match(html, /No changes/);
      assert.match(html, /Ignored 1 deletion records/);
      assert.doesNotMatch(html, /badge-delete/);
      assert.equal(f.statuses[0], en['ui.status.completed_no_changes']);
    } else if (!fail) {
      assert.match(html, /badge-delete/);
      assert.doesNotMatch(html, /Ignored 1 deletion records/);
    } else {
      assert.equal(manager.getLogs().filter(x => x.status === 'error').length, 1);
      assert.equal(f.statuses[0], 'Sync completed, 1 items failed');
    }
    assert.equal(f.p[statsKey].deleted ?? 0, 0, 'session reset clears display outcomes');
    assert.equal(f.p[statsKey].alreadyAbsent ?? 0, 0);
    cases++;
  }

  const f = fixture(kind, true);
  excluded = true;
  await handler({ path: f.path, pageIndex: 7 }, f.p);
  excluded = false;
  assert.equal(f.writes.length, 0);
  assert.equal(f.p[statsKey].deleted ?? 0, 0);
  assert.equal(f.p[statsKey].alreadyAbsent ?? 0, 0, 'exclusion is not an absent-path tombstone');
  assert.equal(manager.getLogs().length, 0, 'excluded paths have no false success row');
  assert.equal(f.completed.length, 1);
  cases++;

  manager.logReceivedMessage(action, { code: 500, data: { path: f.path } }, 'full');
  assert.equal(manager.getLogs()[0].status, 'error', 'protocol errors must remain visible');
}

{
  const f = fixture('folder', true);
  empty = false;
  await folder.receiveFolderSyncDelete({ path: f.path, pageIndex: 4 }, f.p);
  empty = true;
  assert.equal(f.writes.length, 0);
  assert.equal(f.p.folderSyncTasks.deleted ?? 0, 0);
  assert.equal(f.p.folderSyncTasks.alreadyAbsent ?? 0, 0);
  assert.equal(manager.getLogs()[0].status, 'cancelled', 'non-empty-folder safeguard stays visible');
  assert.equal(f.completed.length, 1);
  cases++;
}

{
  // Replay the observed counts twice. Each fresh round must remain a no-change round.
  for (let round = 0; round < 2; round++) {
    const f = fixture('note');
    for (const [kind, count, key] of [['note', 129, 'noteSyncTasks'], ['file', 4625, 'fileSyncTasks'], ['folder', 77, 'folderSyncTasks']]) {
      f.p[key].needDelete = count;
      const [, action, handler] = handlers.find(x => x[0] === kind);
      for (let i = 0; i < count; i++) {
        const path = `${kind}/absent-${i}`;
        manager.logReceivedMessage(action, { code: 200, data: { path } }, 'full');
        await handler({ path, pageIndex: Math.floor(i / 50) }, f.p);
      }
      assert.equal(f.p[key].alreadyAbsent, count);
    }
    assert.equal(f.completed.length, 4831, 'every tombstone is acknowledged despite suppressing success logs');
    assert.equal(manager.getLogs().length, 0, 'tombstone replay cannot evict useful logs');
    const { stats, log } = summary(f.p);
    assert.equal(stats.hasChanges, false);
    assert.equal(stats.note.delete + stats.file.delete + stats.folder.delete, 0);
    const html = renderToStaticMarkup(React.createElement(TestSummaryCard, { log }));
    assert.match(html, /Ignored 4831 deletion records/);
    assert.doesNotMatch(html, /badge-delete/);
    cases++;
  }
}

{
  const f = fixture('note');
  f.p.noteSyncTasks.needModify = 1;
  f.p.fileSyncTasks.alreadyAbsent = 4625;
  const { stats, log } = summary(f.p);
  assert.equal(stats.hasChanges, true, 'real updates remain visible alongside ignored tombstones');
  assert.equal(stats.note.modify, 1);
  const html = renderToStaticMarkup(React.createElement(TestSummaryCard, { log }));
  assert.match(html, /badge-modify/);
  assert.match(html, /Ignored 4625 deletion records/);
  cases++;
}

{
  const f = fixture('note', true);
  f.p.noteSyncTasks.needDelete = 2;
  await note.receiveNoteSyncDelete({ path: f.path, pageIndex: 0 }, f.p);
  await note.receiveNoteSyncDelete({ path: f.path, pageIndex: 1 }, f.p);
  const { stats } = summary(f.p);
  assert.equal(f.writes.length, 1, 'replayed delete cannot manufacture another applied deletion');
  assert.equal(stats.note.delete, 1);
  assert.equal(stats.skippedDeletes.note, 1);
  assert.equal(f.completed.length, 2);
  cases++;
}

{
  const f = fixture('note');
  f.p.noteSyncTasks.alreadyAbsent = 129;
  const { log } = summary(f.p);
  const lines = [];
  manager.init({ app: { vault: { adapter: { append: async (_, line) => lines.push(line) } } } });
  manager.logFilePath = 'memory-only';
  await manager.persistToFile(log);
  assert.match(lines[0], /Note\(up:0,recv:0,del:0\)/);
  assert.match(lines[0], /Already absent \(no changes\): 129/);
  manager.logFilePath = '';
  cases++;
}

{
  const legacy = { timestamp: 1, status: 'success', type: 'info', message: JSON.stringify({
    syncType: 'full', hasChanges: true, note: { upload: 0, modify: 0, delete: 5 },
  }) };
  const html = renderToStaticMarkup(React.createElement(TestSummaryCard, { log: legacy }));
  assert.match(html, /badge-delete/, 'old summary entries remain readable without new outcome fields');
  assert.doesNotMatch(html, /Ignored/);
  cases++;
}

console.log(`PASS: sync deletion reporting (${cases} handler/summary/rendering cases)`);
