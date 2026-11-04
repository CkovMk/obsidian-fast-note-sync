import { hashContentAsync, dump, isPathExcluded, showSyncNotice, isLargeBinarySyncRisk, describeBinarySyncLimit, logMemorySnapshot, hashFileAsync, debounce, nfc } from "../utils/helpers";
import type FastSync from "../../main";
import { VersionedHashStore } from "./versioned_hash_store";


/**
 * 哈希缓存结构
 */
interface HashCache {
  hash: string;
  mtime: number;
  size: number;
}

interface HashRestoreDiagnostics {
  cacheSource: "localStorage" | "mirror" | "rebuild";
  baselineSource: "localStorage" | "mirror" | "legacy-inheritance" | "conflict";
  cacheEntries: number;
  baselineEntries: number;
}

/**
 * 文件哈希管理器
 * 负责管理文件路径与哈希值的映射关系,存储在 localStorage 中
 */
export class FileHashManager {
  private plugin: FastSync;
  private hashMap: Map<string, HashCache> = new Map();
  private syncHashMap: Map<string, string> = new Map(); // path -> baseHash
  private storageKey: string;
  private syncStorageKey: string;
  private isInitialized: boolean = false;
  // Cache restoration/migration may save before the acknowledged baseline has been loaded.
  // Never let those writes replace persisted baseline state with the constructor-empty map.
  private syncStorageReady: boolean = false;
  private restoreDiagnostics: HashRestoreDiagnostics | null = null;
  private isRecovering = false;
  // 脏标记 + 防抖落盘：高频单条写入（下载/Ack 路径）不再逐条同步整表 JSON.stringify，
  // 避免高频写 localStorage 阻塞主线程导致界面白屏
  private isDirty: boolean = false;
  private debouncedFlush: () => void;
  // 文件镜像：localStorage 被移动端系统清除后的兜底恢复
  private mirror: VersionedHashStore;
  private syncMirror: VersionedHashStore;

  constructor(plugin: FastSync) {
    this.plugin = plugin;
    // 与 vault 名无关的稳定存储键：iCloud 手机端会把库文件夹改名，绑定 vault 名的旧 key 会失效
    // (与 local_storage_manager.ts getInternalKey 的修复同理)，历史键迁移由 VersionedHashStore 处理
    this.storageKey = `fns-fileHashMap`;
    this.syncStorageKey = `fns-syncHashMap`;
    this.debouncedFlush = debounce(() => this.flush(), 500);
    this.mirror = new VersionedHashStore(plugin, this.storageKey, "fileHashMap.json", "cache");
    this.syncMirror = new VersionedHashStore(plugin, this.syncStorageKey, "syncHashMap.json", "baseline");
  }

  /**
   * 标记为脏并安排一次防抖落盘（用于高频单条写入路径）
   */
  private scheduleSave(): void {
    this.isDirty = true;
    this.debouncedFlush();
  }

  /**
   * 立即将脏数据落盘（用于同步结束、插件卸载等需要保证持久化的时机）
   */
  flush(): void {
    if (this.isDirty) {
      this.isDirty = false;
      this.saveToStorage();
    }
    // 最后冲镜像：既包含 saveToStorage 刚安排的一份，也包含与 isDirty 无关的防抖中镜像写
    this.mirror.flush();
    this.syncMirror.flush();
  }

  /**
   * 初始化哈希表
   * 比较 localStorage 与文件镜像的版本后恢复；两处都无有效缓存才重建。
   * Compare both storage revisions before restoring; conflicting baselines pause sync.
   */
  async initialize(preferMirrors: boolean = false): Promise<void> {
    dump("FileHashManager: 开始初始化");
    this.isInitialized = false;
    this.syncStorageReady = false;
    this.restoreDiagnostics = null;
    let cacheSource: HashRestoreDiagnostics["cacheSource"] = "rebuild";
    let baselineSource: HashRestoreDiagnostics["baselineSource"] = "legacy-inheritance";

    const cache = await this.mirror.load(preferMirrors);
    const baseline = await this.syncMirror.load(preferMirrors);
    // Nothing may save until both sources have been compared. Unversioned conflicts
    // require explicit recovery; neither entry count nor a union proves freshness.
    if (cache.source === "conflict" || baseline.source === "conflict") {
      this.restoreDiagnostics = { cacheSource: cache.source === "mirror" ? "mirror" : "localStorage",
        baselineSource: "conflict", cacheEntries: 0, baselineEntries: 0 };
      showSyncNotice("Saved hash states conflict. Sync paused. Run 'Recover saved hash state from mirrors'.");
      return;
    }
    const hasRestoredMap = cache.data !== null && this.parseAndLoad(cache.data);
    if (hasRestoredMap) cacheSource = cache.source as "localStorage" | "mirror";
    const hasRestoredSync = baseline.data !== null && this.parseAndLoadSync(baseline.data);
    if (hasRestoredSync) baselineSource = baseline.source as "localStorage" | "mirror";

    if (!hasRestoredMap) {
      dump("FileHashManager: localStorage 与文件镜像均无本地缓存,开始构建哈希映射");
      await this.buildFileHashMap();
    }

    // 3. 数据平滑迁移：全新用户或旧版插件升级用户 (syncHashMap 尚未创建但 hashMap 已有历史数据)
    if (!hasRestoredSync) {
      dump("FileHashManager: 同步基准表无数据，正在使用本地哈希缓存进行平滑继承迁移...");
      for (const [path, cache] of this.hashMap.entries()) {
        this.syncHashMap.set(path, cache.hash);
      }
    }

    // Both restore attempts (and the existing legacy migration, if needed) are complete.
    // Persist only now, preserving a successfully restored empty baseline as well.
    this.syncStorageReady = true;
    this.saveToStorage();
    this.restoreDiagnostics = {
      cacheSource, baselineSource,
      cacheEntries: this.hashMap.size, baselineEntries: this.syncHashMap.size,
    };
    dump("FileHashManager: startup restore", this.restoreDiagnostics);
    this.isInitialized = true;
  }

  requiresRecovery(): boolean {
    return this.restoreDiagnostics?.baselineSource === "conflict";
  }

  async recoverFromMirrors(): Promise<void> {
    if (this.plugin.isSyncing) throw new Error("Finish or cancel the current sync before recovery");
    if (this.isRecovering) throw new Error("Hash-state recovery is already running");
    this.isRecovering = true;
    try {
      // Validate both before backing up or changing any state.
      const recoveredCache = (await this.mirror.load(true)).data!;
      const recoveredBaseline = (await this.syncMirror.load(true)).data!;
      await this.mirror.backupSources();
      await this.syncMirror.backupSources();
      if (!this.parseAndLoad(recoveredCache) || !this.parseAndLoadSync(recoveredBaseline)) {
        throw new Error("Recovery snapshots could not be loaded");
      }
      this.restoreDiagnostics = { cacheSource: "mirror", baselineSource: "mirror",
        cacheEntries: this.hashMap.size, baselineEntries: this.syncHashMap.size };
      this.syncStorageReady = true;
      this.isDirty = false;
      this.saveToStorage();
      this.isInitialized = true;
      this.flush();
      await Promise.all([this.mirror.flushAsync(), this.syncMirror.flushAsync()]);
    } catch (error) {
      this.isInitialized = false;
      this.syncStorageReady = false;
      this.restoreDiagnostics = { cacheSource: "mirror", baselineSource: "conflict",
        cacheEntries: this.hashMap.size, baselineEntries: this.syncHashMap.size };
      throw error;
    } finally {
      this.isRecovering = false;
    }
  }

  private parseAndLoadSync(data: string): boolean {
    try {
      const parsed = JSON.parse(data) as Record<string, string>;
      // 键统一 NFC 规范化（迁移旧数据中可能存在的 NFD 路径，见 nfc() 注释）
      // Canonicalize keys to NFC (migrates any NFD paths persisted by older builds)
      const normalized = new Map<string, string>();
      for (const [path, hash] of Object.entries(parsed)) {
        const key = nfc(path);
        if (!normalized.has(key)) normalized.set(key, hash);
      }
      this.syncHashMap = normalized;
      return true;
    } catch (error) {
      dump("FileHashManager: 解析同步基准哈希数据失败", error);
      return false;
    }
  }

  /**
   * 检查是否已初始化
   */
  isReady(): boolean {
    return this.isInitialized && !this.isRecovering;
  }

  getRestoreDiagnostics(): HashRestoreDiagnostics | null {
    return this.restoreDiagnostics ? { ...this.restoreDiagnostics } : null;
  }

  getPersistenceDiagnostics() {
    return { ready: this.isReady(), recoveryRequired: this.requiresRecovery(),
      cacheEntries: this.hashMap.size, baselineEntries: this.syncHashMap.size,
      cache: this.mirror.getDiagnostics(), baseline: this.syncMirror.getDiagnostics() };
  }

  private async buildFileHashMap(): Promise<void> {
    const notice = showSyncNotice("正在初始化文件哈希映射...", 0);

    try {
      const files = this.plugin.app.vault.getFiles();

      const totalFiles = files.length;
      let processedFiles = 0;

      dump(`FileHashManager: 开始遍历 ${totalFiles} 个文件`);

      // --- PERF: bounded concurrency for cold-build read+hash ---
      // 冷建路径原先完全串行 read+hash，参照 operator.ts 扫描阶段的 6 路有限并发改造
      const MAX_CONCURRENT_HASH = 6;
      const hashInFlight = new Set<Promise<void>>();
      const scheduleHashTask = async (task: () => Promise<void>) => {
        let p: Promise<void>;
        p = task().finally(() => hashInFlight.delete(p));
        hashInFlight.add(p);
        if (hashInFlight.size >= MAX_CONCURRENT_HASH) {
          await Promise.race(hashInFlight);
        }
      };

      for (const file of files) {
        // 跳过已排除的文件
        if (isPathExcluded(file.path, this.plugin)) {
          processedFiles++;
          continue;
        }

        if (file.extension !== "md" && isLargeBinarySyncRisk(file.stat.size, this.plugin)) {
          dump(`FileHashManager: skip large binary hash (${describeBinarySyncLimit(this.plugin)} limit): ${file.path}`, file.stat.size);
          processedFiles++;
          continue;
        }

        await scheduleHashTask(async () => {
          try {
            let contentHash: string;

            // 根据文件类型选择不同的哈希计算方式
            if (file.extension === "md") {
              // md 文件使用文本内容计算哈希
              let content: string | null = await this.plugin.app.vault.read(file);
              contentHash = await hashContentAsync(content);
              content = null; // 显式释放引用 (Explicitly release reference)
            } else {
              contentHash = await hashFileAsync(this.plugin.app, file.path);
              logMemorySnapshot(`after hash ${file.path}`);
            }

            this.hashMap.set(file.path, {
              hash: contentHash,
              mtime: file.stat.mtime,
              size: file.stat.size
            });
          } catch (error) {
            // 单个文件哈希计算失败不应中断整个构建过程
            const msg = error instanceof Error ? error.message : String(error);
            dump(`FileHashManager: 计算哈希失败，跳过文件: ${file.path}`, error);
            console.warn(`[FastNoteSync] 跳过文件 ${file.path}: ${msg}`);
          }
        });

        processedFiles++;

        // 每处理 50 个文件更新一次进度 (Update progress every 50 files)
        if (processedFiles % 50 === 0) {
          notice.setMessage(`正在初始化文件哈希映射... (${processedFiles}/${totalFiles})`);
          // 让出主线程,避免阻塞 UI
          await new Promise(resolve => window.setTimeout(resolve, 0));
        }
      }

      // 等待所有并发哈希任务收尾，确保后续落盘基于完整结果
      if (hashInFlight.size > 0) {
        await Promise.all(Array.from(hashInFlight));
      }

      // 保存到 localStorage
      this.saveToStorage();

      notice.setMessage(`文件哈希映射初始化完成! 共处理 ${totalFiles} 个文件`);
      window.setTimeout(() => notice.hide(), 3000);

      dump(`FileHashManager: 构建完成,共 ${totalFiles} 个文件`);
    } catch (error) {
      notice.hide();
      const msg = error instanceof Error ? error.message : String(error);
      showSyncNotice(`文件哈希映射初始化失败: ${msg}`);
      dump("FileHashManager: 构建失败", error);
      throw error;
    }
  }

  /**
   * 获取有效的哈希值
   * 如果缓存存在且 mtime/size 匹配，则返回缓存的哈希，否则返回 null
   */
  getValidHash(path: string, mtime: number, size: number): string | null {
    const cache = this.hashMap.get(nfc(path));
    if (cache && cache.mtime === mtime && cache.size === size) {
      return cache.hash;
    }
    return null;
  }

  /**
   * 获取指定路径的同步基准哈希值 (提供给同步作为 baseHash 的唯一来源)
   */
  getPathHash(path: string): string | null {
    return this.syncHashMap.get(nfc(path)) || null;
  }

  /**
   * 获取已成功同步的所有文件路径 (用于检测离线删除与拉取缺失文件)
   */
  getAllPaths(): string[] {
    return Array.from(this.syncHashMap.keys());
  }

  /**
   * 添加或更新单个文件的对齐基准哈希值 (在 Ack 确认或收到推送时调用)
   */
  setFileHash(path: string, hash: string, mtime: number = 0, size: number = 0): void {
    const key = nfc(path);
    this.hashMap.set(key, { hash, mtime, size });
    this.syncHashMap.set(key, hash);
    // 清理同一视觉路径的旧 Unicode 形式键（NFD→NFC 迁移后的残留）
    if (key !== path) {
      this.hashMap.delete(path);
      this.syncHashMap.delete(path);
    }
    this.scheduleSave();
  }

  /**
   * SyncEnd 兜底补偿写入 (仅更新本地缓存, 绝不更新同步基准表)
   * SyncEnd fallback cannot prove server confirmed the write; only Ack path may update syncHashMap
   */
  setFileHashes(entries: Iterable<[string, string]>, getStat?: (path: string) => { mtime?: number; size?: number } | null | undefined): void {
    let changed = false;
    for (const [path, hash] of entries) {
      const key = nfc(path);
      const stat = getStat?.(path);
      this.hashMap.set(key, { hash, mtime: stat?.mtime || 0, size: stat?.size || 0 });
      changed = true;
    }
    if (changed) this.saveToStorage();
  }

  /**
   * 删除指定路径的哈希
   */
  removeFileHash(path: string): void {
    const key = nfc(path);
    const deleted1 = this.hashMap.delete(key) || this.hashMap.delete(path);
    const deleted2 = this.syncHashMap.delete(key) || this.syncHashMap.delete(path);
    if (deleted1 || deleted2) {
      this.scheduleSave();
    }
  }

  removeFileHashes(paths: Iterable<string>): void {
    let changed = false;
    for (const path of paths) {
      const key = nfc(path);
      changed = this.hashMap.delete(key) || this.hashMap.delete(path) || changed;
      changed = this.syncHashMap.delete(key) || this.syncHashMap.delete(path) || changed;
    }
    if (changed) this.scheduleSave();
  }

  /**
   * 解析哈希表数据并装入 this.hashMap，兼容旧版仅存哈希字符串的格式
   * Parse hash map data and load it into this.hashMap, compatible with the old hash-only string format
   */
  private parseAndLoad(data: string): boolean {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      // 数据迁移逻辑：如果值是字符串，说明是旧版数据，需要重新构建或设为默认值
      // Data migration: if value is string, it's old version data; need to migrate or default
      const migratedMap = new Map<string, HashCache>();

      for (const [path, value] of Object.entries(parsed)) {
        // 键统一 NFC 规范化（迁移旧数据中可能存在的 NFD 路径，见 nfc() 注释）
        const key = nfc(path);
        if (typeof value === "string") {
          // 旧版数据：只有哈希。由于缺失 mtime/size，我们将它们设为 0，
          // 这样下次同步时会重新触发计算并更新为新格式。
          // Old data: hash only. Set mtime/size to 0 so next sync triggers recalculation and updates to new format.
          if (!migratedMap.has(key)) {
            migratedMap.set(key, { hash: value, mtime: 0, size: 0 });
          }
        } else {
          // 同一视觉路径若以不同 Unicode 形式重复出现，保留 mtime 较新的一条
          const existing = migratedMap.get(key);
          const incoming = value as HashCache;
          if (!existing || (incoming.mtime || 0) >= (existing.mtime || 0)) {
            migratedMap.set(key, incoming);
          }
        }
      }

      this.hashMap = migratedMap;

      return true;
    } catch (error) {
      dump("FileHashManager: 解析哈希表数据失败", error);
      return false;
    }
  }

  /**
   * 保存哈希映射到 localStorage，同时镜像写入文件 (兜底移动端 localStorage 被清除)
   */
  private saveToStorage(): void {
    if (this.requiresRecovery()) return;
    let data: string;
    try {
      const obj = Object.fromEntries(this.hashMap);
      data = JSON.stringify(obj);
    } catch (error) {
      dump("FileHashManager: 序列化哈希表失败", error);
      return;
    }

    this.mirror.save(data);

    // 同步保存基准哈希表
    this.saveSyncToStorage();
  }

  private saveSyncToStorage(): void {
    if (!this.syncStorageReady) return;

    let data: string;
    try {
      const obj = Object.fromEntries(this.syncHashMap);
      data = JSON.stringify(obj);
    } catch (error) {
      dump("FileHashManager: 序列化同步基准哈希表失败", error);
      return;
    }

    this.syncMirror.save(data);
  }

  /**
   * 手动重建哈希表
   * 用于命令面板
   */
  /**
   * 手动重建哈希表
   * 用于命令面板
   */
  async rebuildHashMap(): Promise<void> {
    dump("FileHashManager: 手动重建哈希映射");
    this.clearAll();
    await this.buildFileHashMap();
    // 重新扫描完成后，将本地最新计算的哈希复制写入同步基准，作为当前最新的同步对齐基准
    for (const [path, cache] of this.hashMap.entries()) {
      this.syncHashMap.set(path, cache.hash);
    }
    this.saveSyncToStorage();
  }

  /**
   * 清理所有哈希表内容
   */
  clearAll(): void {
    this.hashMap.clear();
    this.syncHashMap.clear();
    this.saveToStorage();
  }

  /**
   * Bulk-set hashes from a scanned hash map and persist once.
   * Used to eagerly commit computed hashes during scan, breaking the
   * Catch-22 where hashes are never persisted because SyncEnd is never received.
   */
  /**
   * 批量更新扫描得出的哈希值 (仅写入本地缓存以优化性能，绝不更新同步基准表)
   */
  bulkSetFromScanned(scanned: Map<string, { hash: string; mtime: number; size: number }>): void {
    if (this.requiresRecovery()) return;
    if (scanned.size === 0) return;
    let changed = false;
    for (const [path, cache] of scanned) {
      const key = nfc(path);
      const existing = this.hashMap.get(key);
      if (!existing || existing.mtime <= cache.mtime) {
        this.hashMap.set(key, { hash: cache.hash, mtime: cache.mtime, size: cache.size });
        changed = true;
      }
    }
    if (changed) {
      // 仅触发本地缓存表的 localStorage 和文件镜像保存
      let data: string;
      try {
        const obj = Object.fromEntries(this.hashMap);
        data = JSON.stringify(obj);
      } catch {
        return;
      }
      this.mirror.save(data);
    }
  }

  /**
   * 清清理已排除文件的哈希
   * 当同步排除设置变更时调用
   */
  cleanupExcludedHashes(): void {
    let deletedCount = 0;
    for (const path of this.hashMap.keys()) {
      if (isPathExcluded(path, this.plugin)) {
        this.hashMap.delete(path);
        this.syncHashMap.delete(path);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      dump(`FileHashManager: 清理了 ${deletedCount} 个已排除文件的哈希`);
      this.scheduleSave();
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): { totalFiles: number; storageKey: string } {
    return {
      totalFiles: this.hashMap.size,
      storageKey: this.storageKey,
    };
  }
}
