import { Platform } from "obsidian";
import type FastSync from "../../main";
import { dump, hashContent, nfc } from "../utils/helpers";

export const SYNC_DIAGNOSTIC_BUILD = "2026-11-03.durable-hash-state.2";
const MAX_ROUNDS = 2;
const MAX_SAMPLES = 32;
const MAX_SCAN_CANDIDATES = 10000;
const MAX_SERVER_LOOKUPS = 4;

interface FileCandidate {
  path: string;
  pathHash: string;
  contentHash: string;
  mtime: number;
  ctime: number;
  size: number;
  baseHash?: string | null;
}

interface UploadTrace {
  sessionId: string;
  wirePath: string;
  wirePathHash: string;
  localPath?: string;
  localPathHash?: string;
  canonicalPathHash?: string;
  normalizationChanged?: boolean;
  mtime?: number;
  size?: number;
  baseHashBeforeUpload?: string | null;
  cacheHashBeforeUpload?: string | null;
  pendingHashBeforeUpload?: string | null;
  eligibility?: string;
  candidate?: FileCandidate;
  uploadedHash?: string;
  server?: Record<string, unknown>;
  serverLookup?: string;
  ack?: Record<string, unknown>;
}

interface DiagnosticRound {
  context: string | null;
  startedAt: string;
  finishedAt?: string;
  endReason?: "completed" | "cancelled" | "disconnected" | "stalled" | "superseded" | "failed";
  incremental: boolean;
  cursorAtStart: number;
  requestCursor?: number;
  candidateCount?: number;
  candidateReasons?: Record<string, number>;
  candidateSamples?: FileCandidate[];
  uploads: UploadTrace[];
  uploadRequests: number;
  serverLookups: number;
  summary?: unknown;
}

/** Bounded, metadata-only snapshots survive the generic 1000-line debug-log eviction. */
export class SyncDiagnostics {
  private readonly rounds: DiagnosticRound[] = [];
  private readonly candidates = new WeakMap<DiagnosticRound, Map<string, FileCandidate>>();

  constructor(private readonly plugin: FastSync) {}

  private current(): DiagnosticRound | undefined {
    if (!this.plugin.settings.logEnabled || this.plugin.settings.logEnabled === "off") return;
    const round = this.rounds[this.rounds.length - 1];
    if (round && !round.finishedAt && round.context === this.plugin.syncState.activeSyncContext) return round;
  }

  public start(incremental: boolean): void {
    if (!this.plugin.settings.logEnabled || this.plugin.settings.logEnabled === "off") return;
    this.end("superseded", this.rounds[this.rounds.length - 1]?.context ?? undefined);
    const round: DiagnosticRound = {
      context: this.plugin.syncState.activeSyncContext,
      startedAt: new Date().toISOString(), incremental,
      cursorAtStart: Number(this.plugin.localStorageManager.getMetadata("lastFileSyncTime")) || 0,
      uploads: [], uploadRequests: 0, serverLookups: 0,
    };
    this.rounds.push(round);
    if (this.rounds.length > MAX_ROUNDS) this.rounds.shift();
    dump("[SyncDiag] start", { build: SYNC_DIAGNOSTIC_BUILD, ...round });
  }

  private eligibility(path: string, mtime: number, cursor: number, incremental: boolean): string {
    if (!incremental) return "full-sync";
    if (this.plugin.pendingUploadHashes.has(nfc(path))) return "pending-upload";
    if (this.plugin.fileHashManager.getPathHash(path) === null) return "missing-acknowledged-hash";
    if (mtime >= cursor) return "mtime-not-before-cursor";
    return "not-eligible-by-current-scan-state";
  }

  public scan(files: FileCandidate[], requestCursor: number): void {
    const round = this.current();
    if (!round) return;
    round.requestCursor = requestCursor;
    round.candidateCount = files.length;
    const candidates = new Map<string, FileCandidate>();
    for (const file of files.slice(0, MAX_SCAN_CANDIDATES)) {
      candidates.set(file.path, { path: file.path, pathHash: file.pathHash, contentHash: file.contentHash,
        mtime: file.mtime, ctime: file.ctime, size: file.size, baseHash: file.baseHash });
    }
    this.candidates.set(round, candidates);
    round.candidateSamples = Array.from(candidates.values()).slice(0, MAX_SAMPLES);
    round.candidateReasons = {};
    for (const file of files) {
      const reason = this.eligibility(file.path, file.mtime, requestCursor, round.incremental);
      round.candidateReasons[reason] = (round.candidateReasons[reason] || 0) + 1;
    }
    dump("[SyncDiag] scan", { context: round.context, requestCursor, files: files.length, reasons: round.candidateReasons });
  }

  /** Called before the inbound path is canonicalized, preserving the server's actual spelling/hash. */
  public wireUpload(data: { path?: string; pathHash?: string; sessionId?: string }): void {
    const round = this.current();
    if (!round || !data.sessionId) return;
    round.uploadRequests++;
    if (round.uploads.length >= MAX_SAMPLES || round.uploads.some(trace => trace.sessionId === data.sessionId)) return;
    round.uploads.push({ sessionId: data.sessionId, wirePath: data.path || "", wirePathHash: data.pathHash || "" });
  }

  public uploadRequest(data: { path: string; pathHash: string; sessionId: string },
    file: { path: string; stat: { mtime: number; size: number } }): void {
    const round = this.current();
    if (!round) return;
    const trace = round.uploads.find(item => item.sessionId === data.sessionId);
    if (!trace) return;
    Object.assign(trace, {
      localPath: file.path, localPathHash: hashContent(file.path),
      canonicalPathHash: hashContent(nfc(file.path)), normalizationChanged: file.path !== nfc(file.path),
      mtime: file.stat.mtime, size: file.stat.size,
      baseHashBeforeUpload: this.plugin.fileHashManager.getPathHash(file.path),
      cacheHashBeforeUpload: this.plugin.fileHashManager.getValidHash(file.path, file.stat.mtime, file.stat.size),
      pendingHashBeforeUpload: this.plugin.pendingUploadHashes.get(nfc(file.path)) ?? null,
      eligibility: this.eligibility(file.path, file.stat.mtime, round.requestCursor ?? round.cursorAtStart, round.incremental),
      candidate: this.candidates.get(round)?.get(nfc(file.path)),
    });
  }

  /** At most four read-only metadata requests per round, only while debug logging is enabled. */
  public async beforeUpload(sessionId: string, contentHash: string): Promise<void> {
    const round = this.current();
    const trace = round?.uploads.find(item => item.sessionId === sessionId);
    if (!round || !trace) return;
    trace.uploadedHash = contentHash;
    if (round.serverLookups >= MAX_SERVER_LOOKUPS) return;
    round.serverLookups++;
    let timer: number | undefined;
    try {
      const server = await Promise.race([
        this.plugin.api.getFileInfo(trace.wirePath),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("metadata lookup timed out (2s)")), 2000);
        }),
      ]);
      // Whitelist metadata: never export API tokens, URLs, response bodies, or file contents.
      trace.server = {
        path: server.path, pathHash: server.pathHash, contentHash: server.contentHash,
        size: server.size, mtime: server.mtime, ctime: server.ctime, lastTime: server.lastTime,
        hashMatchesUpload: server.contentHash === contentHash,
        hashMatchesScan: trace.candidate ? server.contentHash === trace.candidate.contentHash : undefined,
        olderThanRequestCursor: server.lastTime !== undefined
          ? server.lastTime <= (round.requestCursor ?? round.cursorAtStart) : undefined,
      };
      trace.serverLookup = "before-first-binary-chunk";
    } catch (error) {
      // Do not export arbitrary HTTP error text; a lookup failure does not prove a record is absent.
      trace.serverLookup = error instanceof Error && error.message === "metadata lookup timed out (2s)"
        ? "timeout" : "unavailable";
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }

  public uploadAck(data: { path?: string; lastTime?: number }): void {
    const round = this.current();
    if (!round || !data.path) return;
    const trace = round.uploads.find(item => !item.ack && nfc(item.wirePath) === nfc(data.path!));
    if (trace) trace.ack = {
      path: data.path, lastTime: data.lastTime,
      pendingHash: this.plugin.pendingUploadHashes.get(nfc(data.path)) ?? null,
      cursorBeforeAck: this.plugin.localStorageManager.getMetadata("lastFileSyncTime"),
    };
  }

  public finish(summary: unknown): void {
    const round = this.current();
    if (!round) return;
    round.finishedAt = new Date().toISOString();
    round.endReason = "completed";
    round.summary = summary;
    this.candidates.delete(round);
    dump("[SyncDiag] completed", { build: SYNC_DIAGNOSTIC_BUILD, context: round.context,
      uploadRequests: round.uploadRequests, retainedSamples: round.uploads.length });
  }

  public end(reason: Exclude<DiagnosticRound["endReason"], "completed" | undefined>, context?: string): void {
    const round = this.rounds[this.rounds.length - 1];
    if (!round || round.finishedAt || round.context !== (context ?? this.plugin.syncState.activeSyncContext)) return;
    round.finishedAt = new Date().toISOString();
    round.endReason = reason;
    this.candidates.delete(round);
  }

  public exportJSON(): string {
    return JSON.stringify({
      diagnosticBuild: SYNC_DIAGNOSTIC_BUILD, pluginVersion: this.plugin.manifest.version,
      canonicalPathPolicy: "NFC+unpaired-surrogate-sanitization", platform: Platform.isMobile ? "mobile" : "desktop",
      exportedAt: new Date().toISOString(), logging: this.plugin.settings.logEnabled,
      limits: { rounds: MAX_ROUNDS, samplesPerRound: MAX_SAMPLES,
        retainedScanCandidates: MAX_SCAN_CANDIDATES, serverLookupsPerRound: MAX_SERVER_LOOKUPS },
      settings: { readonly: this.plugin.settings.readonlySyncEnabled, cloudPreview: this.plugin.settings.cloudPreviewEnabled },
      hashRestore: this.plugin.fileHashManager?.getRestoreDiagnostics?.() ?? null,
      hashPersistence: this.plugin.fileHashManager?.getPersistenceDiagnostics?.() ?? null,
      rounds: this.rounds,
    }, null, 2);
  }
}
