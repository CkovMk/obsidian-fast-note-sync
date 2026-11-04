import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 冒烟测试：移动端 localStorage 被清除后，FileHashManager 应从文件镜像恢复而非全量重建
// Smoke test: after mobile localStorage eviction, FileHashManager restores from the file mirror
// instead of rebuilding (and re-notifying) from scratch.

const root = path.resolve(import.meta.dirname, "..");

function transpile(relPath) {
  const sourcePath = path.join(root, relPath);
  const source = fs.readFileSync(sourcePath, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
}

function loadModule(relPath, requireStub, extraGlobals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(relPath), {
    require: requireStub,
    module,
    exports: module.exports,
    console,
    window: { setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    ...extraGlobals,
  });
  return module.exports;
}

// --- 载入 helpers.ts（提供 LocalStateFileMirror / debounce 等） ---
const helpersRequireStub = (id) => {
  switch (id) {
    case "obsidian":
      return {
        Notice: class { setMessage() {} hide() {} },
        normalizePath: (p) => p,
        TFolder: class {},
        Platform: { isMobile: false },
        App: class {},
      };
    case "../../i18n/lang":
      return { $: (key) => key };
    case "../../main":
      return {};
    case "../sync/sync_log_manager":
      return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: () => undefined }) } };
    case "../helpers_obsidian_bypass":
      return {
        nativeFetch: () => undefined,
        vaultDelete: () => undefined,
        dump: () => undefined,
        dumpError: () => undefined,
        setLogEnabled: () => undefined,
        logLevel: () => undefined,
      };
    default:
      throw new Error(`Unexpected require in helpers: ${id}`);
  }
};
const helpers = loadModule("src/lib/utils/helpers.ts", helpersRequireStub, {
  activeDocument: undefined,
  crypto: { getRandomValues: (a) => a },
});
const { VersionedHashStore } = loadModule("src/lib/storage/versioned_hash_store.ts", id => {
  if (id === "../utils/helpers") return helpers;
  throw new Error(`Unexpected versioned store import: ${id}`);
});

// --- 载入 file_hash_manager.ts ---
const fhmRequireStub = (id) => {
  switch (id) {
    case "../utils/helpers":
      return helpers;
    case "../../main":
      return {};
    case "./versioned_hash_store":
      return { VersionedHashStore };
    default:
      throw new Error(`Unexpected require in file_hash_manager: ${id}`);
  }
};
const { FileHashManager } = loadModule("src/lib/storage/file_hash_manager.ts", fhmRequireStub);

// --- 假 plugin：localStorage 用 Map，vault.adapter 用 Map（内存文件系统） ---
function makeFakePlugin(localStorageMap, fileMap, {
  onGetFiles, onLoadLocalStorage, onSaveLocalStorage, onReadMirror,
} = {}) {
  return {
    manifest: { id: "fast-note-sync", dir: ".obsidian/plugins/fast-note-sync" },
    settings: {},
    app: {
      loadLocalStorage: (key) => {
        onLoadLocalStorage?.(key);
        return localStorageMap.has(key) ? localStorageMap.get(key) : null;
      },
      saveLocalStorage: (key, value) => {
        if (onSaveLocalStorage?.(key, value) === false) return;
        if (value === null || value === undefined) localStorageMap.delete(key);
        else localStorageMap.set(key, String(value));
      },
      vault: {
        configDir: ".obsidian",
        getName: () => "TestVault",
        getFiles: () => {
          if (onGetFiles) onGetFiles();
          return [];
        },
        adapter: {
          mkdir: async () => {},
          exists: async (p) => fileMap.has(p),
          read: async (p) => {
            onReadMirror?.(p);
            if (!fileMap.has(p)) throw new Error("ENOENT: " + p);
            return fileMap.get(p);
          },
          write: async (p, data) => {
            fileMap.set(p, data);
          },
        },
      },
    },
  };
}

const MIRROR_PATH = ".obsidian/plugins/fast-note-sync/fileHashMap.json";
const SYNC_MIRROR_PATH = ".obsidian/plugins/fast-note-sync/syncHashMap.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataOf = raw => {
  const parsed = JSON.parse(raw);
  return parsed.format === "fast-note-sync-hash-state" ? parsed.data : parsed;
};
const snapshot = (kind, revision, data) => ({ format: "fast-note-sync-hash-state", version: 1, kind, revision, data });

// === 场景 A：写入哈希 → flush → localStorage 与镜像文件都有数据 ===
{
  const ls = new Map();
  const filesA = new Map();
  const plugin = makeFakePlugin(ls, filesA);
  const mgr = new FileHashManager(plugin);
  assert.equal(mgr.getRestoreDiagnostics(), null, "restore diagnostics are unavailable before initialization");
  await mgr.initialize(); // 双空 → 走重建（getFiles 返回空数组，静默完成）

  mgr.setFileHash("notes/a.md", "hash-a", 111, 10);
  mgr.setFileHash("img/b.png", "hash-b", 222, 20);
  mgr.flush();
  await sleep(20); // 等 adapter.write 异步落盘

  assert.equal(ls.has("fns-fileHashMap"), true, "localStorage 应有稳定 key 数据");
  assert.equal(filesA.has(MIRROR_PATH), true, "镜像文件应已写入");
  const mirrored = dataOf(filesA.get(MIRROR_PATH));
  assert.equal(mirrored["notes/a.md"].hash, "hash-a");
  assert.equal(mirrored["img/b.png"].hash, "hash-b");
  assert.deepEqual(dataOf(filesA.get(SYNC_MIRROR_PATH)), {
    "notes/a.md": "hash-a", "img/b.png": "hash-b",
  }, "ACK baselines must be persisted independently of computed cache records");

  // === 场景 B：模拟移动端 localStorage 被系统清除 → 新实例应从镜像恢复，不重建 ===
  ls.clear();
  let rebuilt = false;
  const plugin2 = makeFakePlugin(ls, filesA, { onGetFiles: () => { rebuilt = true; } });
  const mgr2 = new FileHashManager(plugin2);
  await mgr2.initialize();

  assert.equal(rebuilt, false, "镜像命中时不应触发全量重建（不应调用 vault.getFiles）");
  assert.equal(mgr2.getPathHash("notes/a.md"), "hash-a", "应从镜像恢复哈希");
  assert.equal(mgr2.getValidHash("img/b.png", 222, 20), "hash-b", "mtime/size 应一并恢复");
  assert.equal(ls.has("fns-fileHashMap"), true, "恢复后应回写 localStorage");
  mgr2.flush();
  await sleep(20);
  assert.deepEqual(dataOf(filesA.get(SYNC_MIRROR_PATH)), {
    "notes/a.md": "hash-a", "img/b.png": "hash-b",
  }, "restoring computed hashes must not empty the acknowledged mirror");
}

// === 场景 C：localStorage 与镜像均无 → 走重建路径（getFiles 被调用），不报错 ===
{
  const ls = new Map();
  const files = new Map();
  let rebuilt = false;
  const plugin = makeFakePlugin(ls, files, { onGetFiles: () => { rebuilt = true; } });
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  assert.equal(rebuilt, true, "双空时应触发重建");
  assert.equal(mgr.isReady(), true);
  mgr.flush();
}

// === 场景 D：旧版绑定库名的 key 迁移到稳定 key ===
{
  const ls = new Map();
  const files = new Map();
  ls.set("fns-TestVault-fileHashMap", JSON.stringify({ "old/n.md": { hash: "h-old", mtime: 1, size: 2 } }));
  const plugin = makeFakePlugin(ls, files);
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  assert.equal(mgr.getPathHash("old/n.md"), "h-old", "旧 key 数据应可读到");
  assert.equal(ls.has("fns-fileHashMap"), true, "旧 key 数据应迁移到稳定 key");
  mgr.flush();
}

// Computed hashes deliberately differ from acknowledged hashes: restoring a baseline
// must not silently acknowledge edited or never-uploaded local content.
const computed = {
  "notes/a.md": { hash: "local-edited-a", mtime: 111, size: 10 },
  "img/b.png": { hash: "hash-b", mtime: 222, size: 20 },
  "unsent/local.bin": { hash: "never-acknowledged", mtime: 333, size: 30 },
};
const acknowledged = { "notes/a.md": "server-a", "img/b.png": "hash-b" };
const legacyComputed = Object.fromEntries(Object.entries(computed).map(([p, value]) => [p, value.hash]));
const nfdComputed = { "cafe\u0301.bin": { hash: "edited-cafe", mtime: 444, size: 40 } };
const nfcAcknowledged = { "caf\u00e9.bin": "server-cafe" };
const scenarios = [
  {
    name: "unversioned conflicting baselines pause rather than guessing freshness",
    storedCache: computed, storedBaseline: acknowledged,
    mirroredBaseline: { "notes/a.md": "stale-server-a" },
    conflict: true,
  },
  {
    name: "localStorage eviction restores both maps independently from mirrors",
    expected: acknowledged, cacheSource: "mirror", baselineSource: "mirror",
  },
  {
    name: "computed mirror restoration cannot overwrite existing localStorage baseline",
    storedBaseline: snapshot("baseline", 2, acknowledged), mirroredBaseline: { "notes/a.md": "stale-server-a" },
    expected: acknowledged, cacheSource: "mirror", baselineSource: "localStorage",
  },
  {
    name: "legacy string-value migration cannot overwrite existing baseline",
    storedCache: legacyComputed, storedBaseline: acknowledged,
    expected: acknowledged, cacheSource: "localStorage", baselineSource: "localStorage",
  },
  {
    name: "Unicode cache-key migration preserves the independently acknowledged hash",
    storedCache: nfdComputed, storedBaseline: nfcAcknowledged,
    mirroredBaseline: nfcAcknowledged,
    expected: nfcAcknowledged, cacheSource: "localStorage", baselineSource: "localStorage", cacheEntries: 1,
  },
  {
    name: "cold computed-cache rebuild preserves localStorage baseline",
    mirroredCache: null, storedBaseline: acknowledged,
    expected: acknowledged, cacheSource: "rebuild", baselineSource: "localStorage", cacheEntries: 0,
  },
  {
    name: "cold computed-cache rebuild preserves the baseline mirror",
    mirroredCache: null,
    expected: acknowledged, cacheSource: "rebuild", baselineSource: "mirror", cacheEntries: 0,
  },
  {
    name: "corrupt computed localStorage falls back without destroying baseline",
    storedCache: "{broken", storedBaseline: acknowledged,
    expected: acknowledged, cacheSource: "mirror", baselineSource: "localStorage",
  },
  {
    name: "corrupt baseline localStorage restores the baseline mirror",
    storedCache: computed, storedBaseline: "{broken",
    expected: acknowledged, cacheSource: "localStorage", baselineSource: "mirror",
  },
  {
    name: "valid empty localStorage baseline must not inherit computed hashes or a stale mirror",
    storedBaseline: snapshot("baseline", 10, {}),
    expected: {}, cacheSource: "mirror", baselineSource: "localStorage",
  },
  {
    name: "valid empty mirror baseline must not inherit computed hashes",
    mirroredBaseline: {},
    expected: {}, cacheSource: "mirror", baselineSource: "mirror",
  },
  {
    name: "genuinely absent baseline retains the existing legacy migration policy",
    storedCache: computed, mirroredBaseline: null,
    expected: legacyComputed, cacheSource: "localStorage", baselineSource: "legacy-inheritance",
  },
  {
    name: "corrupt baselines must not acknowledge computed-only content",
    storedCache: computed, storedBaseline: "{broken", mirroredBaseline: "{broken",
    conflict: true,
  },
];

for (const scenario of scenarios) {
  const ls = new Map();
  const files = new Map();
  const serialize = value => typeof value === "string" ? value : JSON.stringify(value);
  if (scenario.storedCache !== undefined) ls.set("fns-fileHashMap", serialize(scenario.storedCache));
  if (scenario.storedBaseline !== undefined) ls.set("fns-syncHashMap", serialize(scenario.storedBaseline));
  const mirroredCache = scenario.mirroredCache === undefined ? computed : scenario.mirroredCache;
  const mirroredBaseline = scenario.mirroredBaseline === undefined ? acknowledged : scenario.mirroredBaseline;
  if (mirroredCache !== null) files.set(MIRROR_PATH, serialize(mirroredCache));
  if (mirroredBaseline !== null) files.set(SYNC_MIRROR_PATH, serialize(mirroredBaseline));
  let baselineRead = false;
  let baselineMirrorRead = false;
  const baselineWrites = [];
  const plugin = makeFakePlugin(ls, files, {
    onLoadLocalStorage: key => { if (key === "fns-syncHashMap") baselineRead = true; },
    onSaveLocalStorage: (key, value) => {
      if (key !== "fns-syncHashMap") return;
      baselineWrites.push({ baselineRead, value: dataOf(value) });
    },
    onReadMirror: p => { if (p === SYNC_MIRROR_PATH) baselineMirrorRead = true; },
  });
  const mgr = new FileHashManager(plugin);
  const originalSources = [ls.get("fns-syncHashMap"), files.get(SYNC_MIRROR_PATH)];
  await mgr.initialize();
  mgr.flush();
  await sleep(20);

  if (scenario.conflict) {
    assert.equal(mgr.isReady(), false);
    assert.equal(mgr.requiresRecovery(), true);
    assert.equal(baselineWrites.length, 0, "conflict must not overwrite either source");
    assert.deepEqual([ls.get("fns-syncHashMap"), files.get(SYNC_MIRROR_PATH)], originalSources);
    continue;
  }
  assert.ok(baselineWrites.length > 0, `${scenario.name}: baseline is persisted after restoration`);
  for (const write of baselineWrites) {
    assert.equal(write.baselineRead, true, `${scenario.name}: baseline must be read before any write`);
    assert.deepEqual(write.value, scenario.expected, `${scenario.name}: no intermediate empty baseline writes`);
  }
  assert.deepEqual(Object.fromEntries(mgr.getAllPaths().map(p => [p, mgr.getPathHash(p)])), scenario.expected, scenario.name);
  assert.deepEqual(dataOf(ls.get("fns-syncHashMap")), scenario.expected, `${scenario.name}: localStorage`);
  assert.deepEqual(dataOf(files.get(SYNC_MIRROR_PATH)), scenario.expected, `${scenario.name}: mirror`);
  assert.equal(baselineMirrorRead, mirroredBaseline !== null, `${scenario.name}: both sources inspected`);
  const diagnostics = mgr.getRestoreDiagnostics();
  assert.deepEqual({ ...diagnostics }, {
    cacheSource: scenario.cacheSource, baselineSource: scenario.baselineSource,
    cacheEntries: scenario.cacheEntries ?? Object.keys(computed).length,
    baselineEntries: Object.keys(scenario.expected).length,
  }, `${scenario.name}: startup diagnostics`);
  diagnostics.baselineEntries = -1;
  assert.notEqual(mgr.getRestoreDiagnostics().baselineEntries, -1, "diagnostic callers cannot mutate retained state");
}

// After a legitimate empty-baseline restore, ACKs must still persist and survive a warm restart.
{
  const ls = new Map([["fns-syncHashMap", "{}"]]);
  const files = new Map([[MIRROR_PATH, JSON.stringify(computed)]]);
  const plugin = makeFakePlugin(ls, files);
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  mgr.setFileHash("unsent/local.bin", "newly-acknowledged", 333, 30);
  mgr.flush();
  await sleep(20);
  const restarted = new FileHashManager(makeFakePlugin(ls, files));
  await restarted.initialize();
  assert.equal(restarted.getPathHash("unsent/local.bin"), "newly-acknowledged");
  assert.equal(restarted.getPathHash("notes/a.md"), null, "unacknowledged edits must remain unacknowledged");
  assert.equal(restarted.getRestoreDiagnostics().baselineEntries, 1);
  restarted.flush();
}

console.log(`file-mirror-restore.test.mjs: original scenarios and ${scenarios.length + 1} baseline regressions passed`);

// Reproduce fns4 with silent Obsidian API failures, not just thrown exceptions.
{
  const repairedCache = Object.fromEntries(Array.from({ length: 6546 }, (_, i) =>
    [`files/file-${i}.bin`, { hash: String(i), mtime: i + 1, size: i + 10 }]));
  const oldBaseline = Object.fromEntries(Array.from({ length: 63 }, (_, i) => [`large/old-${i}.bin`, String(i)]));
  const repairedBaseline = { ...oldBaseline,
    ...Object.fromEntries(Object.entries(repairedCache).map(([p, value]) => [p, value.hash])) };
  const ls = new Map([["fns-fileHashMap", "{}"], ["fns-syncHashMap", JSON.stringify(oldBaseline)]]);
  const files = new Map([[MIRROR_PATH, JSON.stringify(repairedCache)], [SYNC_MIRROR_PATH, JSON.stringify(repairedBaseline)]]);
  const plugin = makeFakePlugin(ls, files, { onSaveLocalStorage: () => false });
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  assert.equal(mgr.requiresRecovery(), true, "legacy 0/63 versus populated mirror cannot be guessed");
  assert.equal(dataOf(files.get(SYNC_MIRROR_PATH))["files/file-0.bin"], "0", "good mirror is preserved");
  await mgr.recoverFromMirrors();
  await sleep(20);
  assert.equal(mgr.isReady(), true);
  assert.equal(mgr.getStats().totalFiles, 6546);
  assert.equal(mgr.getAllPaths().length, 6609);
  assert.equal(Object.keys(dataOf(ls.get("fns-syncHashMap"))).length, 63, "API silently leaves old state");
  assert.equal(mgr.getPersistenceDiagnostics().baseline.lastLocalStorageWriteVerified, false);
  assert.ok(mgr.getPersistenceDiagnostics().baseline.localStorageWriteFailures > 0);
  assert.equal([...files.keys()].filter(p => p.includes('/hash-state-backups/')).length, 4, "both original sources backed up");
  const restarted = new FileHashManager(plugin);
  await restarted.initialize();
  restarted.flush();
  await sleep(20);
  assert.equal(restarted.getAllPaths().length, 6609, "newer versioned mirror beats stale valid localStorage");
  assert.equal(restarted.getRestoreDiagnostics().baselineSource, "mirror");
  restarted.removeFileHash("files/file-0.bin");
  restarted.flush();
  await sleep(20);
  const afterDelete = new FileHashManager(plugin);
  await afterDelete.initialize();
  assert.equal(afterDelete.getPathHash("files/file-0.bin"), null, "newer smaller snapshot preserves deletion");
  afterDelete.clearAll();
  afterDelete.flush();
  await sleep(20);
  const afterClear = new FileHashManager(plugin);
  await afterClear.initialize();
  assert.equal(afterClear.getAllPaths().length, 0, "newer empty snapshot is authoritative, not the larger old table");
  afterClear.flush();
}

// Equal revisions with different baseline contents are a conflict, not a merge.
{
  const ls = new Map([["fns-fileHashMap", JSON.stringify(computed)],
    ["fns-syncHashMap", JSON.stringify(snapshot("baseline", 5, acknowledged))]]);
  const files = new Map([[MIRROR_PATH, JSON.stringify(computed)],
    [SYNC_MIRROR_PATH, JSON.stringify(snapshot("baseline", 5, { "other.bin": "unrelated" }))]]);
  const mgr = new FileHashManager(makeFakePlugin(ls, files));
  await mgr.initialize();
  assert.equal(mgr.requiresRecovery(), true);
  assert.equal(dataOf(ls.get("fns-syncHashMap"))["other.bin"], undefined);
}

// Refuse recovery if backups cannot be verified; leave source maps untouched.
{
  const ls = new Map([["fns-fileHashMap", "{}"], ["fns-syncHashMap", "{}"]]);
  const files = new Map([[MIRROR_PATH, JSON.stringify(computed)], [SYNC_MIRROR_PATH, JSON.stringify(acknowledged)]]);
  const plugin = makeFakePlugin(ls, files);
  plugin.app.vault.adapter.write = async () => { throw new Error("disk unavailable"); };
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  await assert.rejects(mgr.recoverFromMirrors(), /disk unavailable/);
  assert.equal(mgr.requiresRecovery(), true);
  assert.equal(ls.get("fns-syncHashMap"), "{}");
  assert.deepEqual(JSON.parse(files.get(SYNC_MIRROR_PATH)), acknowledged);
}

// Mirror write failures remain pending and can be retried by flush.
{
  const ls = new Map(), files = new Map();
  const plugin = makeFakePlugin(ls, files);
  const write = plugin.app.vault.adapter.write;
  let fail = true;
  plugin.app.vault.adapter.write = async (...args) => {
    if (fail) throw new Error("temporary disk failure");
    return write(...args);
  };
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  mgr.setFileHash("retry.bin", "acknowledged", 1, 1);
  mgr.flush();
  await sleep(20);
  assert.equal(mgr.getPersistenceDiagnostics().baseline.mirrorWrite.lastWriteSucceeded, false);
  assert.equal(mgr.getPersistenceDiagnostics().baseline.mirrorWrite.pending, true);
  fail = false;
  mgr.flush();
  await sleep(20);
  assert.equal(dataOf(files.get(SYNC_MIRROR_PATH))["retry.bin"], "acknowledged");
  assert.equal(mgr.getPersistenceDiagnostics().baseline.mirrorWrite.lastWriteSucceeded, true);
}
console.log("PASS: exact 0/63 silent-failure recovery, revisions, deletions/empty snapshots, conflicts, backups and disk retry");

// Startup and explicit recovery must ignore vault-root copies, even if they contain
// valid-looking snapshots with higher revisions from another device or an old export.
{
  const ls = new Map([["fns-fileHashMap", "{}"], ["fns-syncHashMap", "{}"]]);
  const files = new Map([[MIRROR_PATH, "{}"], [SYNC_MIRROR_PATH, "{}"],
    ["fileHashMap.json", JSON.stringify(snapshot("cache", 1000, computed))],
    ["syncHashMap.json", JSON.stringify(snapshot("baseline", 1000, acknowledged))]]);
  const originals = [files.get("fileHashMap.json"), files.get("syncHashMap.json")];
  const reads = [];
  const plugin = makeFakePlugin(ls, files, { onSaveLocalStorage: () => false, onReadMirror: p => reads.push(p) });
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  assert.equal(mgr.getAllPaths().length, 0, "startup never auto-imports vault-root attachments");
  mgr.flush();
  await sleep(20);
  // Only the device-local mirrors are selected by the remaining recovery command.
  files.set(MIRROR_PATH, JSON.stringify(computed));
  files.set(SYNC_MIRROR_PATH, JSON.stringify(acknowledged));
  await mgr.recoverFromMirrors();
  assert.equal(mgr.isReady(), true);
  assert.equal(mgr.getPathHash("notes/a.md"), "server-a", "use confirmed baseline, not edited computed hash");
  assert.equal(mgr.getPathHash("unsent/local.bin"), null, "recovery must not acknowledge cache-only content");
  assert.equal(mgr.getRestoreDiagnostics().baselineSource, "mirror");
  assert.deepEqual([files.get("fileHashMap.json"), files.get("syncHashMap.json")], originals, "root exports are untouched");
  assert.equal(reads.some(p => p === "fileHashMap.json" || p === "syncHashMap.json"), false, "root exports are never read");
  assert.ok(mgr.getPersistenceDiagnostics().baseline.revision < 1000, "root snapshot revisions are not imported");
  assert.equal(dataOf(files.get(SYNC_MIRROR_PATH))["notes/a.md"], "server-a", "command waits for durable mirror writes");
  const restarted = new FileHashManager(plugin);
  await restarted.initialize();
  assert.equal(restarted.getPathHash("notes/a.md"), "server-a");
  assert.equal(restarted.getRestoreDiagnostics().baselineSource, "mirror");
  restarted.flush();
}
console.log("PASS: device-only mirror recovery, ignored vault-root exports and no cache-to-baseline promotion");

// Invalid recovery inputs must fail before changing either saved map.
for (const invalid of [MIRROR_PATH, SYNC_MIRROR_PATH]) {
  const ls = new Map([["fns-fileHashMap", "{}"], ["fns-syncHashMap", "{}"]]);
  const files = new Map([[MIRROR_PATH, "{}"], [SYNC_MIRROR_PATH, "{}"]]);
  const mgr = new FileHashManager(makeFakePlugin(ls, files));
  await mgr.initialize();
  mgr.flush();
  await sleep(20);
  files.set(MIRROR_PATH, JSON.stringify(computed));
  files.set(SYNC_MIRROR_PATH, JSON.stringify(acknowledged));
  files.set(invalid, "{broken");
  const before = [ls.get("fns-fileHashMap"), ls.get("fns-syncHashMap"), files.get(MIRROR_PATH), files.get(SYNC_MIRROR_PATH)];
  await assert.rejects(mgr.recoverFromMirrors(), /No valid .* mirror is available/);
  assert.equal(mgr.isReady(), false);
  assert.equal(mgr.requiresRecovery(), true);
  assert.deepEqual([ls.get("fns-fileHashMap"), ls.get("fns-syncHashMap"), files.get(MIRROR_PATH), files.get(SYNC_MIRROR_PATH)], before);
}

// A read error is not absence: do not overwrite a temporarily inaccessible source.
{
  const ls = new Map([["fns-fileHashMap", JSON.stringify(computed)], ["fns-syncHashMap", JSON.stringify(acknowledged)]]);
  const files = new Map([[MIRROR_PATH, JSON.stringify(computed)], [SYNC_MIRROR_PATH, JSON.stringify(acknowledged)]]);
  const plugin = makeFakePlugin(ls, files, { onReadMirror: p => { if (p === SYNC_MIRROR_PATH) throw new Error("read unavailable"); } });
  const mgr = new FileHashManager(plugin);
  await assert.rejects(mgr.initialize(), /read unavailable/);
  assert.equal(mgr.isReady(), false);
  assert.deepEqual(JSON.parse(files.get(SYNC_MIRROR_PATH)), acknowledged);
  assert.deepEqual(JSON.parse(ls.get("fns-syncHashMap")), acknowledged);
}

// Recovery waits for both serialized mirror writes, and failed writes keep sync paused.
{
  const ls = new Map([["fns-fileHashMap", "{}"], ["fns-syncHashMap", "{}"]]);
  const files = new Map([[MIRROR_PATH, JSON.stringify(computed)], [SYNC_MIRROR_PATH, JSON.stringify(acknowledged)]]);
  const plugin = makeFakePlugin(ls, files, { onSaveLocalStorage: () => false });
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  mgr.flush();
  await sleep(20);
  const write = plugin.app.vault.adapter.write;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  plugin.app.vault.adapter.write = async (p, data) => {
    if (p === MIRROR_PATH || p === SYNC_MIRROR_PATH) {
      markStarted();
      await blocked;
      throw new Error("disk unavailable");
    }
    await write(p, data);
  };
  const recovery = mgr.recoverFromMirrors();
  const rejection = assert.rejects(recovery, /Hash mirror write did not persist/);
  await started;
  assert.equal(mgr.isReady(), false, "must remain gated while recovery writes are in flight");
  assert.equal([...files.keys()].filter(p => p.includes('/hash-state-backups/')).length, 4);
  release();
  await rejection;
  assert.equal(mgr.isReady(), false);
  assert.equal(mgr.requiresRecovery(), true);
  assert.deepEqual(JSON.parse(files.get(SYNC_MIRROR_PATH)), acknowledged);
  assert.ok(mgr.getPersistenceDiagnostics().baseline.mirrorWrite.pending);
}

// Reloading sources for recovery cannot reuse a revision already issued in memory.
{
  const files = new Map([[SYNC_MIRROR_PATH, "{}"]]);
  const store = new VersionedHashStore(makeFakePlugin(new Map(), files, { onSaveLocalStorage: () => false }),
    "fns-syncHashMap", "syncHashMap.json", "baseline");
  await store.load();
  store.save(JSON.stringify(acknowledged));
  await store.load(); // the first save has not reached the mirror yet
  store.save("{}");
  await store.flushAsync();
  assert.equal(JSON.parse(files.get(SYNC_MIRROR_PATH)).revision, 2);
}
console.log("PASS: corrupt/unreadable states fail closed, recovery validation/durability gates and monotonic revisions");

// Exercise the real remaining command registration, including confirmation and the
// no-active-sync guard, without loading Obsidian or touching a live vault.
{
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const registrations = [];
  let hasRootCommand = false;
  function visit(node) {
    if (ts.isStringLiteral(node) && node.text === "recover-hash-state-from-vault-copies") hasRootCommand = true;
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "this.addCommand") {
      const options = node.arguments[0];
      const id = options && ts.isObjectLiteralExpression(options) && options.properties.find(property =>
        ts.isPropertyAssignment(property) && property.name.getText(ast) === "id");
      if (id && ts.isStringLiteral(id.initializer) && id.initializer.text.startsWith("recover-hash-state-")) {
        registrations.push(node.getText(ast));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(hasRootCommand, false, "vault-root recovery command is removed");
  assert.equal(registrations.length, 1, "exactly one device-local recovery command remains");
  const commands = [], modals = [], notices = [], calls = [];
  const plugin = { app: {}, isSyncing: false, addCommand: command => commands.push(command),
    fileHashManager: { recoverFromMirrors: async (...args) => { calls.push(args); } } };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(`function register() { ${registrations[0]}; } exports.register = register;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    module, exports: module.exports,
    require: id => {
      assert.equal(id, "./views/confirm-modal");
      return { ConfirmModal: class {
        constructor(_app, _title, message, confirm) { modals.push({ message, confirm }); }
        open() {}
      } };
    },
    showSyncNotice: message => notices.push(message), dump: () => {},
  });
  module.exports.register.call(plugin);
  assert.equal(commands[0].id, "recover-hash-state-from-mirrors");
  assert.equal(commands[0].name, "Recover saved hash state from mirrors");
  commands[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0, "opening the command never bypasses confirmation");
  assert.equal(modals.length, 1);
  assert.match(modals[0].message, /device's file mirrors/);
  modals[0].confirm();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 0, "only the parameterless device-local recovery API is called");
  assert.match(notices.at(-1), /Hash state recovered/);
  plugin.isSyncing = true;
  commands[0].callback();
  assert.equal(modals.length, 1, "active sync prevents even opening recovery confirmation");
  assert.match(notices.at(-1), /Finish or cancel/);
}
console.log("PASS: mirror-only command registration, explicit confirmation and active-sync guard");
