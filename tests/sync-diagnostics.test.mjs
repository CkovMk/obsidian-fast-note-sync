import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
const nfc = path => path.normalize('NFC');
const hashContent = text => String([...text].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0));
const module = { exports: {} };
const source = fs.readFileSync('src/lib/sync/sync_diagnostics.ts', 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
} }).outputText, {
  module, exports: module.exports,
  window: { setTimeout, clearTimeout },
  require: id => id === 'obsidian' ? { Platform: { isMobile: true } } : { dump: noop, nfc, hashContent },
});
const { SyncDiagnostics, SYNC_DIAGNOSTIC_BUILD } = module.exports;
let reads = 0;
const pending = new Map();
let baseHash = '123';
const plugin = {
  manifest: { version: '2.4.0' },
  settings: { logEnabled: 'internal', apiToken: 'SECRET', api: 'https://private.example' },
  syncState: { activeSyncContext: 'first' },
  localStorageManager: { getMetadata: () => 2000 },
  fileHashManager: {
    getPathHash: () => baseHash, getValidHash: () => '123',
    getRestoreDiagnostics: () => ({ cacheSource: 'mirror', baselineSource: 'mirror', cacheEntries: 50, baselineEntries: 40 }),
  },
  pendingUploadHashes: pending,
  api: { getFileInfo: async path => {
    reads++;
    return { path, pathHash: hashContent(path), contentHash: '123', size: 12, mtime: 5000,
      ctime: 1, lastTime: 1000, token: 'SECRET', savePath: '/private/server/path' };
  } },
};
const diag = new SyncDiagnostics(plugin);
diag.start(true);
const candidate = { path: 'caf\u00e9.bin', pathHash: hashContent('caf\u00e9.bin'), contentHash: '123',
  baseHash: '123', size: 12, mtime: 5000, ctime: 1 };
diag.scan([candidate], 2000);
for (let i = 0; i < 80; i++) {
  const data = { path: 'cafe\u0301.bin', pathHash: hashContent('cafe\u0301.bin'), sessionId: String(i) };
  diag.wireUpload(data);
  diag.uploadRequest(data, { path: data.path, stat: { mtime: 5000, size: 12 } });
  await diag.beforeUpload(data.sessionId, '123');
}
diag.uploadAck({ path: 'caf\u00e9.bin', lastTime: 1000 });
diag.finish({ hasChanges: false });
let snapshot = JSON.parse(diag.exportJSON());
assert.equal(snapshot.diagnosticBuild, SYNC_DIAGNOSTIC_BUILD);
assert.match(snapshot.canonicalPathPolicy, /NFC/);
assert.equal(snapshot.platform, 'mobile');
assert.equal(snapshot.rounds[0].endReason, 'completed');
assert.deepEqual(snapshot.hashRestore, {
  cacheSource: 'mirror', baselineSource: 'mirror', cacheEntries: 50, baselineEntries: 40,
});
const round = snapshot.rounds[0];
assert.equal(round.uploadRequests, 80);
assert.equal(round.uploads.length, 32, 'bound retained samples without losing request total');
assert.equal(reads, 4, 'metadata lookups are bounded per round');
assert.equal(round.candidateReasons['mtime-not-before-cursor'], 1);
const trace = round.uploads[0];
assert.equal(trace.normalizationChanged, true);
assert.notEqual(trace.wirePathHash, trace.canonicalPathHash);
assert.equal(trace.candidate.contentHash, '123');
assert.equal(trace.uploadedHash, '123');
assert.equal(trace.server.hashMatchesUpload, true);
assert.equal(trace.server.olderThanRequestCursor, true);
assert.equal(trace.eligibility, 'mtime-not-before-cursor');
assert.equal(trace.ack.cursorBeforeAck, 2000);
assert.equal(trace.serverLookup, 'before-first-binary-chunk');
assert.doesNotMatch(diag.exportJSON(), /SECRET|private\.example|private\/server/);

for (const [context, pendingValue, baseValue, reason] of [
  ['second', '123', '123', 'pending-upload'],
  ['third', undefined, null, 'missing-acknowledged-hash'],
]) {
  plugin.syncState.activeSyncContext = context;
  pending.clear();
  if (pendingValue) pending.set(candidate.path, pendingValue);
  baseHash = baseValue;
  diag.start(true);
  diag.scan([candidate], 2000);
  snapshot = JSON.parse(diag.exportJSON());
  assert.equal(snapshot.rounds.at(-1).candidateReasons[reason], 1);
}
snapshot = JSON.parse(diag.exportJSON());
assert.equal(snapshot.rounds.length, 2, 'retain the last two rounds for repeat-upload comparison');
assert.equal(snapshot.rounds[0].context, 'second');

const stopped = new SyncDiagnostics(plugin);
plugin.settings.logEnabled = 'off';
stopped.start(true);
stopped.scan([candidate], 2000);
stopped.wireUpload({ path: candidate.path, sessionId: 'disabled' });
await stopped.beforeUpload('disabled', '123');
assert.equal(JSON.parse(stopped.exportJSON()).rounds.length, 0);
assert.equal(reads, 4, 'logging off adds no HTTP requests');

plugin.settings.logEnabled = 'internal';
plugin.syncState.activeSyncContext = 'failure';
plugin.api.getFileInfo = async () => { throw new Error('SECRET private response'); };
stopped.start(true);
stopped.wireUpload({ path: candidate.path, sessionId: 'failure' });
await stopped.beforeUpload('failure', '123');
snapshot = JSON.parse(stopped.exportJSON());
assert.equal(snapshot.rounds[0].uploads[0].serverLookup, 'unavailable');
assert.doesNotMatch(stopped.exportJSON(), /SECRET|private response/);
plugin.syncState.activeSyncContext = 'replacement';
stopped.finish({ shouldNotAppear: true });
assert.doesNotMatch(stopped.exportJSON(), /shouldNotAppear/, 'stale contexts cannot finish a newer round');
delete plugin.fileHashManager.getRestoreDiagnostics;
assert.equal(JSON.parse(stopped.exportJSON()).hashRestore, null, 'startup diagnostics tolerate an unavailable manager');
plugin.syncState.activeSyncContext = 'disconnect';
stopped.start(true);
stopped.end('disconnected');
assert.equal(JSON.parse(stopped.exportJSON()).rounds.at(-1).endReason, 'disconnected');
plugin.syncState.activeSyncContext = 'stalled';
stopped.start(true);
stopped.end('stalled');
assert.equal(JSON.parse(stopped.exportJSON()).rounds.at(-1).endReason, 'stalled');
plugin.syncState.activeSyncContext = 'superseded';
stopped.start(true);
plugin.syncState.activeSyncContext = 'new-round';
stopped.start(true);
assert.equal(JSON.parse(stopped.exportJSON()).rounds[0].endReason, 'superseded');
console.log('PASS: bounded mobile sync diagnostics, eligibility, server evidence, ACKs, privacy and logging-off behavior');
