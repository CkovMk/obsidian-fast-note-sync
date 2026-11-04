import type FastSync from "../../main";
import { dump, getPluginDir, LocalStateFileMirror, nfc } from "../utils/helpers";

type StoreKind = "cache" | "baseline";
interface Snapshot {
  revision: number;
  data: Record<string, unknown>;
}

export interface HashStoreLoad {
  data: string | null;
  source: "localStorage" | "mirror" | "conflict" | null;
}

/** LocalStorage is a verified cache, not proof that the most recent snapshot was saved. */
export class VersionedHashStore {
  private readonly mirror: LocalStateFileMirror;
  private revision = 0;
  private failedWrites = 0;
  private writeVerified: boolean | null = null;
  private loadedMirrorRevision: number | null = null;
  private loadedMirrorEntries: number | null = null;

  constructor(
    private readonly plugin: FastSync,
    private readonly key: string,
    private readonly fileName: string,
    private readonly kind: StoreKind,
  ) {
    this.mirror = new LocalStateFileMirror(plugin, fileName);
  }

  private readLocal(strict: boolean = false): string | null {
    try {
      const data: unknown = this.plugin.app.loadLocalStorage(this.key);
      return typeof data === "string" ? data : null;
    } catch (error) {
      if (strict) throw error;
      return null;
    }
  }

  private decode(raw: string | null): Snapshot | null {
    if (raw === null) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const obj = value as Record<string, unknown>;
      const versioned = obj.format === "fast-note-sync-hash-state";
      if (versioned && (obj.version !== 1 || obj.kind !== this.kind ||
        !Number.isSafeInteger(obj.revision) || (obj.revision as number) < 1)) return null;
      const data = versioned ? obj.data : obj;
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      const entries: [string, unknown][] = [];
      for (const [path, record] of Object.entries(data)) {
        if (this.kind === "baseline") {
          if (typeof record !== "string") return null;
        } else if (typeof record !== "string") {
          if (!record || typeof record !== "object" || Array.isArray(record)) return null;
          const cache = record as Record<string, unknown>;
          if (typeof cache.hash !== "string" || !Number.isFinite(cache.mtime) || !Number.isFinite(cache.size)) return null;
        }
        entries.push([path, record]);
      }
      return { revision: versioned ? obj.revision as number : 0, data: Object.fromEntries(entries) };
    } catch {
      return null;
    }
  }

  private equivalent(a: Snapshot, b: Snapshot): boolean {
    const normalize = (data: Record<string, unknown>) => Object.entries(data)
      .map(([path, value]) => [nfc(path), value] as const)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return JSON.stringify(normalize(a.data)) === JSON.stringify(normalize(b.data));
  }

  async load(preferMirror = false): Promise<HashStoreLoad> {
    let localRaw = this.readLocal(true);
    if (localRaw === null && this.kind === "cache") {
      const vaultName = this.plugin.app.vault.getName();
      for (const key of [
        `fns-${vaultName}-fileHashMap`, `fast-note-sync-${vaultName}-fileHashMap`,
        `fast-note-sync-${vaultName}-file-hash-map`, `fast-note-sync-file-hash-map-${vaultName}`,
      ]) {
        const value: unknown = this.plugin.app.loadLocalStorage(key);
        if (typeof value === "string" && this.decode(value)) { localRaw = value; break; }
      }
    }
    // Always read both before allowing either source to be overwritten.
    const mirrorRaw = await this.mirror.read(true);
    const local = this.decode(localRaw);
    const mirror = this.decode(mirrorRaw);
    this.loadedMirrorRevision = mirror?.revision ?? null;
    this.loadedMirrorEntries = mirror ? Object.keys(mirror.data).length : null;
    this.revision = Math.max(this.revision, local?.revision ?? 0, mirror?.revision ?? 0);
    if (preferMirror) {
      if (!mirror) throw new Error(`No valid ${this.kind} mirror is available`);
      return { data: JSON.stringify(mirror.data), source: "mirror" };
    }
    if (this.kind === "baseline" && !local && !mirror && (localRaw !== null || mirrorRaw !== null)) {
      // Corruption is not the genuinely absent-baseline legacy migration case.
      return { data: null, source: "conflict" };
    }
    if (local && mirror && local.revision === mirror.revision && !this.equivalent(local, mirror)) {
      // Old raw maps have no ordering information. A larger table can also be an older one
      // containing deleted paths. Never merge baseline claims or infer freshness from size.
      if (this.kind === "baseline" || local.revision > 0) return { data: null, source: "conflict" };
    }
    const useMirror = !!mirror && (!local || mirror.revision > local.revision);
    const chosen = useMirror ? mirror : local;
    return { data: chosen ? JSON.stringify(chosen.data) : null,
      source: chosen ? (useMirror ? "mirror" : "localStorage") : null };
  }

  save(data: string): void {
    const parsed: unknown = JSON.parse(data);
    const encoded = JSON.stringify({ format: "fast-note-sync-hash-state", version: 1,
      kind: this.kind, revision: ++this.revision, data: parsed });
    let verified = false;
    try {
      this.plugin.app.saveLocalStorage(this.key, encoded);
      // Obsidian catches storage exceptions internally; a void return is not success.
      verified = this.readLocal() === encoded;
    } catch { /* The same read-back diagnostic covers explicit and suppressed failures. */ }
    if (!verified) {
      this.failedWrites++;
      if (this.writeVerified !== false) dump(`Hash storage: ${this.kind} localStorage write did not persist; using mirror`);
    }
    this.writeVerified = verified;
    this.mirror.scheduleWrite(encoded);
  }

  flush(): void {
    this.mirror.flush();
  }

  async flushAsync(): Promise<void> {
    await this.mirror.flushAsync();
  }

  /** Preserve both original sources before an explicitly requested mirror recovery. */
  async backupSources(): Promise<void> {
    const dir = `${getPluginDir(this.plugin)}/hash-state-backups`;
    const adapter = this.plugin.app.vault.adapter;
    if (!await adapter.exists(dir)) await adapter.mkdir(dir);
    const sources = { localStorage: this.readLocal(true), mirror: await this.mirror.read(true) };
    for (const [source, raw] of Object.entries(sources)) {
      if (raw === null) continue;
      let suffix = 0;
      let path: string;
      do { path = `${dir}/${this.fileName}.${Date.now()}-${suffix++}.${source}.json`; }
      while (await adapter.exists(path));
      await adapter.write(path, raw);
      if (await adapter.read(path) !== raw) throw new Error(`Hash-state backup verification failed: ${source}`);
    }
  }

  getDiagnostics() {
    const local = this.decode(this.readLocal());
    return {
      revision: this.revision,
      localStorageEntries: local ? Object.keys(local.data).length : null,
      localStorageRevision: local?.revision ?? null,
      lastLocalStorageWriteVerified: this.writeVerified,
      localStorageWriteFailures: this.failedWrites,
      loadedMirrorEntries: this.loadedMirrorEntries,
      loadedMirrorRevision: this.loadedMirrorRevision,
      mirrorWrite: this.mirror.getWriteDiagnostics(),
    };
  }
}
