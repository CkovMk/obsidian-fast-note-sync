# Fast Note Sync — Module Separation & Layering Guide

A map of how this Obsidian plugin is organized: what each directory owns, which layer
depends on which, and where the boundaries are (and where they leak).

> Verified against the source at `src/` (v2.4.x). File paths below are relative to the repo root.

## Table of contents

1. [What this codebase is](#1-what-this-codebase-is)
2. [Directory map](#2-directory-map)
3. [Layer diagram](#3-layer-diagram)
4. [The core wiring pattern: `FastSync` as the hub](#4-the-core-wiring-pattern-fastsync-as-the-hub)
5. [Layer-by-layer breakdown](#5-layer-by-layer-breakdown)
   - [L1 — Plugin shell (`src/main.ts`, `src/setting.tsx`)](#l1--plugin-shell)
   - [L2 — Event ingestion (`lib/utils/events_manager.ts`)](#l2--event-ingestion)
   - [L3 — Sync engine (`lib/sync/`)](#l3--sync-engine)
   - [L4 — Transport (WebSocket + `lib/api/` + `pb/`)](#l4--transport)
   - [L5 — Local state (`lib/storage/`)](#l5--local-state)
   - [L6 — UI (`views/`, `lib/ui/`)](#l6--ui)
   - [Cross-cutting: i18n, utils, logging](#cross-cutting-concerns)
6. [Key data flows](#6-key-data-flows)
7. [Dependency rules & where they leak](#7-dependency-rules--where-they-leak)
8. [Build, test & codegen notes](#8-build-test--codegen-notes)

---

## 1. What this codebase is

An Obsidian plugin (~24k lines of TS/TSX in `src/`) that syncs a vault with a
self-hosted server (`fast-note-sync-service`) in real time:

- **Primary channel**: one persistent WebSocket per client. All note/file/folder/config
  changes, ACKs, paginated bulk sync, and binary file chunks travel over it.
- **Secondary channel**: REST API (history, restore, recycle bin, sharing, admin) via
  `HttpApiService`.
- **Wire format**: JSON by default; protobuf is negotiated at handshake (`useProtobuf`)
  and used for text payloads, while binary file content always travels as raw chunks.

The architecture is a **hub-and-spoke design**: one large plugin class (`FastSync` in
`src/main.ts`) owns every manager, and all modules communicate *through* that hub rather
than importing each other. Understanding that single pattern explains 90% of the codebase.

## 2. Directory map

```
src/
├── main.ts                        # L1 — Plugin entry: `FastSync` class, the app's hub
├── setting.tsx                    # L1/L6 — Settings tab; also defines `PluginSettings` + DEFAULT_SETTINGS
├── styles.scss                    # All plugin CSS (compiled to styles.css)
│
├── i18n/                          # Cross-cutting — translation layer
│   ├── lang.ts                    #   `$()` lookup, locale map, interpolation
│   └── locales/{en,zh-CN,zh-TW,ja,ko}.ts
│
├── pb/                            # L4 — wire-format code (generated + mapper)
│   ├── v1/sync.js / sync.d.ts     #   generated from the server's .proto (`npm run proto`)
│   └── protobuf_mapper.ts         #   DTO ⇄ protobuf encode/decode per WS action
│
├── lib/
│   ├── helpers_obsidian_bypass.js # Cross-cutting — plain-JS shim: dump/dumpError logging,
│   │                              #   nativeFetch / vaultDelete (Obsidian API bypasses)
│   ├── api/http_api_service.ts    # L4 — REST client for non-WebSocket operations
│   ├── settings/vault_name.ts     # Vault-name helpers used by the settings tab
│   │
│   ├── storage/                   # L5 — local state & persistence
│   │   ├── file_hash_manager.ts       # content/path hash cache for notes+attachments
│   │   ├── config_hash_manager.ts     # same, for .obsidian/ config files
│   │   ├── folder_snapshot_manager.ts # folder mtime snapshot (folder rename/delete detection)
│   │   ├── local_storage_manager.ts   # Obsidian localStorage metadata + pending-queue persistence
│   │   └── file_cloud_preview.ts      # remote "cloud preview" source mapping config
│   │
│   ├── sync/                      # L3 — the sync engine (heart of the plugin)
│   │   ├── operator.ts                # orchestration: handleSync, receive dispatch table, completion checks
│   │   ├── operator_note.ts           # note (.md) send/receive handlers
│   │   ├── operator_file.ts           # attachment/binary file handlers + chunked upload/download
│   │   ├── operator_folder.ts         # folder handlers
│   │   ├── operator_config.ts         # .obsidian/ config-file handlers
│   │   ├── websocket_manager.ts       # WS façade: context injection, logging, BatchAck event bus
│   │   ├── websocket_client.ts        # raw socket: connect/auth/reconnect/health probe
│   │   ├── websocket_action.ts        # string action constants (send/receive)
│   │   ├── sync_state.ts              # aggregated per-session runtime state (~30 fields)
│   │   ├── runtime_config.ts          # effective API/WS URLs after redirect probing
│   │   ├── lock_manager.ts            # per-key mutex with retry
│   │   ├── concurrency_limiter.ts     # ACK-driven upload slot limiter (priority + FIFO)
│   │   ├── sync_progress_tracker.ts   # page-based progress, drives status bar + ACK watermarks
│   │   ├── sync_log_manager.ts        # singleton: user-facing sync log (in-memory, capped)
│   │   └── config_manager.ts          # config-sync enablement/path rules glue
│   │
│   ├── ui/                        # L6 — DOM-bound UI managers
│   │   ├── menu_manager.ts            # ribbon icon, commands, context menus, upgrade badge
│   │   ├── status_bar_manager.ts      # status bar text / progress / failed-count dot
│   │   └── share_indicator_manager.ts # share icons stamped into the file explorer DOM
│   │
│   └── utils/                     # Cross-cutting — shared plumbing
│       ├── helpers.ts                 # kitchen sink: paths, rules, hashing, persistence, notices
│       ├── types.ts                   # domain model (SnapFile, sync payloads) + internal API typings
│       ├── events_manager.ts          # L2 — vault/workspace/window event ingestion
│       ├── debug_log_manager.ts       # singleton: 1000-line in-memory debug ring buffer
│       ├── version_manager.ts         # plugin+server version badges, in-place upgrades
│       └── helpers_image.ts           # image processing helpers
│
└── views/                         # L6 — Obsidian Modals & ItemViews
    ├── settings-view.tsx            # React: remote-source / connection settings panel
    ├── sync-log-view.tsx            # React: right-sidebar sync log (ItemView)
    ├── conflict-resolve-modal.ts    # manual conflict merge (diff editor)
    ├── conflict-list-modal.tsx      # list of conflicted notes
    ├── recycle-bin-modal.ts         # server-side recycle bin (REST)
    ├── share-modal.ts / share-manage-modal.ts   # create/manage shares (REST)
    ├── sso-import-modal.ts          # import connection settings from obsidian:// link
    ├── ws-clients-modal.tsx         # list connected clients (admin, REST)
    ├── note-history/                # React: version history detail/modal/view + icons
    ├── rule-editor(.ts/-modal.ts)   # exclude-rule editor used by settings
    ├── about-modal.tsx / confirm-modal.ts / debug-log-modal.ts / path-suggest.ts
```

---

## 3. Layer diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Obsidian host: App, Vault, Workspace, Modal, Notice, localStorage        │
└──────────────────────────────▲───────────────────────────────────────────┘
                               │ (rendering, events, file IO)
┌──────────────────────────────┴───────────────────────────────────────────┐
│ L1  PLUGIN SHELL   src/main.ts (FastSync), src/setting.tsx               │
│     lifecycle · settings persistence · service wiring · commands         │
└─────┬──────────────────────────────┬──────────────────────────┬──────────┘
      │                              │                          │
┌─────▼────────────────┐   ┌─────────▼───────────────┐   ┌──────▼─────────────────────┐
│ L2 EVENT INGESTION   │   │ L3 SYNC ENGINE          │   │ L6 UI                      │
│ utils/events_manager │──▶│ lib/sync/*              │◀──│ views/*, setting.tsx,      │
│ (+localStorage watch)│   │ operator*, websocket_*, │   │ lib/ui/*                   │
└──────────────────────┘   │ sync_state, locks ...   │   └────────────────────────────┘
                           └───────┬──────────┬──────┘
            ┌──────────────────────▼──┐  ┌────▼────────────────────────┐
            │ L4 TRANSPORT            │  │ L5 LOCAL STATE              │
            │ WebSocket (+protobuf)   │  │ lib/storage/*               │
            │ lib/api/http_api_service│  │ hash caches · snapshots ·   │
            │ pb/ (generated + mapper)│  │ localStorage metadata       │
            └─────────────────────────┘  └─────────────────────────────┘

Cross-cutting: i18n ($) · lib/utils/helpers (+ bypass shim) · lib/utils/types.ts
               singletons: SyncLogManager, DebugLogManager
```

Dependency direction (verified from the actual import graph):

| From \ To | L1 main | L2 events | L3 sync | L4 api/pb | L5 storage | L6 views/ui | i18n | utils |
|---|---|---|---|---|---|---|---|---|
| **L1 `main.ts`** | — | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| **L2 events** | type-only | — | ✔ (operators) | | | ✔ (modals) | ✔ | ✔ |
| **L3 sync** | type-only | | — | ✔ (api, pb) | ✔ (preview consts) | ✔ (confirm-modal) | ✔ | ✔ |
| **L4 api/pb** | type-only | | ✔ (pb→action) | — | | | ✔ | ✔ |
| **L5 storage** | type-only | | ✔ (operator_config only) | | — | | | ✔ |
| **L6 views/ui** | type-only + value | | ✔ (operators, log mgr) | ✔ (api) | | — | ✔ | ✔ |

The important cells:

- **Everything may import `main.ts`, but almost always as `import type FastSync`** — a
  compile-time-only reference to the hub's shape. There is no runtime cycle because the
  bundler elides type-only imports.
- **No layer imports "up" for real work.** The one notable cross-layer import is
  `lib/storage → lib/sync/operator_config` (two functions, see L5), and
  `pb/protobuf_mapper → sync/websocket_action` (action constants).
- **L6 UI may reach into L3 directly** — it does, in a few documented places (see §7).

## 4. The core wiring pattern: `FastSync` as the hub

Before reading any module, understand how modules are connected. There is no DI
container and no interface-per-service; instead:

1. **One god-object.** `export default class FastSync extends Plugin` (`src/main.ts`)
   declares a field for every manager:

   ```ts
   api: HttpApiService            // new HttpApiService(this)
   websocket: WebSocketManager    // new WebSocketManager(this)
   fileHashManager: FileHashManager   // new FileHashManager(this)
   lockManager: LockManager       // new LockManager()  ← the only zero-arg manager
   ...
   ```

2. **Every constructor takes the plugin instance.** Managers receive `plugin: FastSync`
   and reach their peers *through* it: `plugin.websocket.Send(...)`,
   `plugin.fileHashManager.getValidHash(...)`, `plugin.lockManager.withLock(...)`.
   Modules therefore rarely import each other at all — they share one object.

3. **Lib modules import the hub as a type.** The ubiquitous line
   `import type FastSync from "../../main"` gives full type safety on `plugin.*` with no
   runtime dependency. (Three files use a value import — `menu_manager.ts`,
   `sync_log_manager.ts`, `utils/helpers.ts` — but only in type positions, so it is
   elided at build time as well.)

4. **Two singleton escape hatches.** `SyncLogManager.getInstance()` and
   `DebugLogManager.getInstance()` are reachable without the hub, which is why nearly
   every sync operator can log without extra plumbing.

5. **State was recently aggregated.** A refactor moved ~30 scattered runtime fields into
   two plain classes — `SyncState` (per-session sync state) and `RuntimeConfig`
   (effective API/WS URLs) — and left ~45 compatibility getters/setters on `FastSync`
   (`get isSyncing() { return this.syncState.isSyncing }`, …) so all sub-modules keep
   working via `plugin.xxx` unchanged. If you see `plugin.noteSyncTasks` in old code,
   it's really `plugin.syncState.noteSyncTasks`.

**Practical consequences:**

- To add a new manager: declare the field on `FastSync`, construct it in `onload()`
  (order matters — see L1), and pass `this`. Nothing else to wire.
- "Who calls this?" questions are answered by searching for `plugin.<field>`, not by
  following imports.
- The flip side: *any* module can touch *any* other's state via the hub. The layering in
  §3 is a convention enforced by code review, not by the compiler. See §7 for the leaks.

---

## 5. Layer-by-layer breakdown

### L1 — Plugin shell

**Files:** `src/main.ts` (1056 lines), `src/setting.tsx` (2099 lines)

`FastSync` is the composition root. Its `onload()` builds the whole object graph in a
deliberate order:

| # | Step | Why this position |
|---|------|-------------------|
| 1 | Debug globals, custom icons (`fns-dot-*`), `setupProgressTracker()` | no dependencies |
| 2 | `localStorageManager`, `api`, `websocket` | core services needed by everything below |
| 3 | `await loadSettings()` | settings gate all later behavior |
| 4 | `versionManager` | needs `settings.vault` to be loaded |
| 5 | `settingTab` + `addSettingTab` | UI entry point |
| 6 | `localStorageManager.startWatch()` | must run after dependent managers exist |
| 7 | `lockManager`, then `concurrencyLimiter` | locks must precede event manager & operators |
| 8 | SSO protocol handler (`obsidian://fast-note-sync/sso`) | connection import flow |
| 9 | `statusBarManager`, `menuManager.initRibbon()` | **before** `onLayoutReady` so Obsidian restores saved ribbon order onto an existing button |
| 10 | `workspace.onLayoutReady(…)` → the rest: sync-log view + commands, `menuManager.init()`, WS status/activity listeners, `shareIndicatorManager`, feature managers (`fileCloudPreview`, `fileHashManager`, `configHashManager`, `folderSnapshotManager`, `configManager`), parallel `initialize()` of hash/snapshot caches, **crash recovery** (restore persisted pending queues, prune expired upload checkpoints), `eventManager.registerEvents()` (only if hash cache ready), `reloadServices()` | deferred so Obsidian startup isn't blocked |

`onunload()` runs the mirror image: `cancelSync` → abort file ops → stop watchers →
unload UI managers → flush debounced hash/snapshot writes → unregister websocket.

**Settings persistence is its own mini-architecture** (see flow D in §6): connection
settings (`api`, `apiToken`, `vault`) are dual-written to Obsidian localStorage *and*
`data.json` (token obfuscated) because iOS can evict webview storage; `loadSettings()`
carries a long migration path for legacy field names and rule formats.

`setting.tsx` is unusual: it defines the `PluginSettings` interface and
`DEFAULT_SETTINGS` (the settings *schema* lives in the UI file), renders the tab, and —
because of the hub pattern — writes directly to `plugin.settings` then calls
`plugin.saveAndReloadServices()`. It also hosts the React-based `settings-view.tsx` for
connection management.

### L2 — Event ingestion

**File:** `src/lib/utils/events_manager.ts` (lives in `utils/`, but functionally this is
the L2→L3 bridge) plus `LocalStorageManager.startWatch()`.

`EventManager.registerEvents()` refuses to run until `fileHashManager.isReady()`, then
wires:

| Source | Event | Handler → action |
|---|---|---|
| `vault.on` | `create` / `modify` | `watchModify`: guards (authed? not manual/readonly?) → skip if part of a pending rename → per-path debounce (`syncUpdateDelay`) under `lockManager.withLock(path)` → dispatch by type: `.md` → `noteModify`, other files → `fileModify`, folders → `folderModify` (all in L3) |
| `vault.on` | `delete` | same guards → `noteDelete` / `fileDelete` / `folderDelete` |
| `vault.on` | `rename` | cancels old-path timer, records new path in `pendingRenamePaths` (suppresses the follow-up modify); extension change ⇒ delete+create; otherwise `noteRename`/`fileRename`/`folderRename`. Runs *without* the shared lock (rename handlers hold their own — avoids nested-lock deadlock) |
| `vault.on` | `raw` (internal API) | config-dir changes not surfaced as vault events → `configManager.handleRawEvent` → whitelist/dir rules → `configModify`/`configDelete` |
| `workspace.on` | `file-menu` | adds "History" + "Share" items for `.md` files (opens L6 modals) |
| `window` | `online` / `offline` | `websocket.triggerReconnect()` / `unRegister()` |
| `window` | `focus` / `blur` / `visibilitychange` | mobile pause/resume: 1 s debounced reconnect on refocus; optional 30 s blur-pause and minimize-pause via settings |

The scheduling primitive is `runWithDelay(path, task)`: coalesces rapid events per path
(one timer per path), then executes the task inside a lock with retries (immediate:
3×50 ms; delayed: 5×100 ms) so local and remote writes to the same file serialize.

A second, smaller ingestion path is `LocalStorageManager.startWatch()`: it watches
Obsidian's own localStorage (active-leaf changes + cross-tab `storage` events), re-hashes
watched values, and pushes changes through the **config-sync** pipeline as virtual
`_localStorage/…` items — which is why L5 imports `operator_config` (the one storage→sync
module import).

### L3 — Sync engine (`lib/sync/`)

The heart of the plugin. **Naming gotcha:** there is no `Operator` class. "Operator"
means *a function that performs one sync operation*. `operator.ts` and the
`operator_*.ts` files are plain modules exporting handler functions, glued together by a
dispatch table.

**`operator.ts` — orchestration + inbound dispatch (1702 lines)**

- `receiveOperators: Map<WSReceiveAction, OperatorHandler>` — the single place where
  incoming server messages are mapped to handlers (`NoteSyncModify → receiveNoteSyncModify`,
  `FileUpload → receiveFileUpload`, `*Ack` handlers, `*SyncPage → handleSyncPage`, …).
  `WebSocketManager.handleStructuredMessage()` looks actions up here.
- `startupSync(plugin)` / `startupFullSync(plugin)` — entry points after WS auth (or when
  a user-triggered sync had to wait for a reconnect; queued in `syncState.pendingSyncType`).
- `handleSync(plugin, isLoadLastTime, syncMode)` — one full round: guard on `isSyncing`,
  scan local state against the hash caches, build per-type payloads (modify / delete /
  missing lists), send them in **batches** (`sendSyncInBatches` + `BatchSendSession`,
  gated by server `*BatchAck` events through the WS manager's tiny event bus), then run
  the completion loop.
- `checkSyncCompletion(plugin, …)` — interval-driven completion detector with two safety
  mechanisms: a **context ownership guard** (a late timer from an old session after
  reconnect only cleans itself up) and a **stall timeout** based on *time since last real
  progress* (5 min), not wall-clock — so slow-but-steady large transfers aren't killed.
  Completion = all enabled types done **and** no open download sessions **and** WS send
  buffer drained.
- `cancelSync`, `rebuildAllHashes`, `clearAllHashes`, `resetSettingSyncTime` — the
  operations exposed to the UI (menu commands, settings buttons).

**Per-entity modules** — each owns both directions for one entity kind:

| Module | Send-side (local → server) | Receive-side (server → local) |
|---|---|---|
| `operator_note.ts` | `noteModify`, `noteDelete`, `noteRename` (+ by-path variants) | `receiveNoteSyncModify/Mtime/Delete/Rename`, conflict detection (local unsynced change ⇒ skip overwrite, register in `conflictedPaths`) |
| `operator_file.ts` (1665 lines) | `fileModify` … + **chunked upload** with resume checkpoints (`fns-<vault>-uploadSession-*` in localStorage), temp-chunk dirs | `receiveFileUpload`, chunked **download sessions** (`fileDownloadSessions`, reaper for stalled downloads), `FileSyncUpdate` |
| `operator_folder.ts` | `folderModify/Delete/Rename` | folder receive handlers (snapshot-mtime based) |
| `operator_config.ts` | `configModify/Delete` (+ module-level reload timer, cleaned in `onunload`) | config receive handlers; owns `configAllPaths` path-walker used by L5's cold build |

**WebSocket layering (three files, three jobs):**

```
operators / main
      │  plugin.websocket.Send(action, data)
      ▼
WebSocketManager (façade)          websocket_manager.ts
  • injects sync `context` into outgoing payloads (session correlation)
  • records every send/receive in SyncLogManager
  • owns the on/off/emit event bus used to await server BatchAcks
  • status & activity listeners (ribbon icon, sync spinner)
      │
      ▼
WebSocketClient (raw socket)       websocket_client.ts
  • connect (health-probe first), auth handshake, pv2 capability negotiation
    (chunk counts, pipeline windows → written into plugin.syncState)
  • reconnect with backoff; `triggerReconnect()` for network-change events
      │
      ▼
WebSocket  (browser API)           text: JSON or protobuf · binary: file chunks
```

`websocket_action.ts` is just a catalog of string action constants (`WSReceiveAction` /
`WSSendAction`) shared by the dispatch table, the mapper, and log categorization.

**Control & state machinery:**

- `sync_state.ts` — `SyncState`: one class holding ~30 session fields (control flags,
  per-type task stats wrapped in **Proxies** that fire `onCompletedChange`, pending ACK
  queues, scanned-hash caches, watch sets, `activeSyncContext`). `resetSession()` starts
  a clean round. The hub proxies every field via getters (§4).
- `runtime_config.ts` — `RuntimeConfig`: the *effective* `runApi`/`runWsApi` after any
  301/302 redirect probing, plus the `wsSettingChange` flag that forces re-registration.
- `lock_manager.ts` — `LockManager.withLock(key, task)`: a per-key mutex (in-memory Set,
  "fallback mode") with retry+sleep; keys are usually file paths. Serializes concurrent
  local/remote operations on the same path.
- `concurrency_limiter.ts` — `ConcurrencyLimiter`: ACK-driven upload slots capped by
  `settings.maxConcurrentUploads`. Tasks call `waitForSlot(key, isFifo, priority)`,
  release when the server ACKs (`releaseSlot` / `releaseFifoSlot` for path-less batch
  ACKs). Priority ordering lets e.g. uploads outrank downloads; `clear()` on
  disconnect/timeout settles waiters without granting slots.
- `sync_progress_tracker.ts` — page-based progress accounting (server paginates bulk
  sync with `*SyncPage` messages); drives the status bar, broadcasts
  `fns:sync-progress` workspace events (decoupling views from the plugin), and emits
  `onPageComplete` → `plugin.sendSyncPageAck(...)` to advance the server-side watermark.
- `sync_log_manager.ts` — **singleton** user-facing log: in-memory `Map<id, SyncLog>`,
  capped at 5000 entries with a separate 1000-entry cap for failures (failures are never
  evicted by volume), throttled change notifications, unread-failed counter feeding the
  status-bar red dot. Rendered by `views/sync-log-view.tsx`.

### L4 — Transport

**WebSocket** is covered above; it carries *all* sync traffic.

**`lib/api/http_api_service.ts` (971 lines)** — REST client for everything that isn't
real-time sync. Auth = API token from settings (sent per request; `noAuth` flag for
health). Notable behavior: transparent **redirect probing** (`probeApiRedirect`,
`updateRuntimeApi`) that rewrites the effective base URL when the server 301/302s —
this is why `RuntimeConfig` exists. Endpoints wrapped:

| Area | Endpoints | Used by |
|---|---|---|
| Health / probing | `GET /api/health` (noAuth) | startup probe, reconnect health check |
| Admin | `/api/admin/check`, `/api/admin/upgrade`, `/api/admin/ws_clients` | version manager, ws-clients modal |
| Notes | `/api/notes`, `/api/note/histories`, `/api/note/history`, `/api/note/history/restore`, `/api/note/restore` | note-history views, restore |
| Files | `/api/files`, `/api/file/info`, `/api/file`, `/api/file/restore` | file info/preview, restore |
| Recycle bin | `/api/note/recycle-clear`, `/api/file/recycle-clear` (+ list via notes/files) | recycle-bin modal |
| Sharing | `/api/share` (GET/POST), `/api/share/password`, `/api/share/short_link`, `/api/shares`, `/api/notes/share-paths` | share modals, share indicator |
| Misc | `/api/user/info`, `/api/support` | user info, support page |

**`pb/`** — `v1/sync.js` is generated from the server's `sync.proto`
(`npm run proto`, requires the service repo checked out alongside);
`protobuf_mapper.ts` provides `enSendDTOToProtobuf(action, payload)` and
`deReceivePacket(bytes)` per action. Used only when the handshake negotiated
`useProtobuf`; JSON remains the default path. Binary file chunks never use protobuf —
they go through `SendBinary` with a message-type prefix (`VaultFileMsgType = "00"`).

### L5 — Local state (`lib/storage/`)

The storage layer is a set of **state caches + persistence units**. It knows nothing
about sockets; it exposes plain getters/setters that the sync operators consume.

| Manager | What it stores | Where | Purpose |
|---|---|---|---|
| `FileHashManager` | per-path content hash (`contentHash`) + path hash (`pathHash`) for notes & attachments | Obsidian localStorage key `fns-fileHashMap`, mirrored to `<pluginDir>/fileHashMap.json` (+ `syncHashMap.json`) | change detection: local scan compares against these; server payloads carry the same hashes so both sides can diff cheaply |
| `ConfigHashManager` | same, for `.obsidian/` config files | `fns-configHashMap` → `configHashMap.json` | config sync (only active when `configSyncEnabled`) |
| `FolderSnapshotManager` | folder mtime snapshot | `fns-folderSnapshot` → `folderSnapshot.json` | folder rename/delete detection (folders have no content) |
| `LocalStorageManager` | plugin metadata (client name, version flags, sync timestamps), **pending-queue persistence** (`pendingNoteModifies`, `pendingUploadHashes`, `pendingConfigModifies`), internal exclude rules, conflicted paths | Obsidian localStorage (+ file mirrors) | crash recovery: pending queues survive a restart and are restored in `onload` (see L1); also the localStorage *watch* from L2 |
| `FileCloudPreview` | remote "cloud preview" source mapping (URL templates with `{notePath}` / `{attachmentFolderPath}` variables), restricted-type lists | settings + localStorage | lets a note render attachments that live only on another source; its static extension lists are the only thing L3 imports from here |

**Hash strategy** (in `utils/helpers.ts`): a fast, **non-cryptographic** djb2 rolling
hash (`hash = (hash<<5) - hash + char`) — collisions are acceptable because it's only for
change detection, and full content is exchanged on mismatch. Async variants yield the
main thread every 256 KB; files >10 MB are hashed from head + middle + tail 5 MB slices
to bound memory. `pathHash` (hash of the path string) is what makes renames detectable
instead of delete+create.

**Resilience pattern — `LocalStateFileMirror`:** every localStorage-backed cache is
mirrored into a JSON file in the plugin directory (2 s debounced, latest-wins, queued
writes). This exists because **iOS can evict webview localStorage under storage
pressure**; on load, managers restore from the mirror instead of rebuilding (and
re-notifying) from scratch. Legacy key names (`fns-<vault>-fileHashMap`, …) are migrated
on read.

**Dependency note:** storage→sync is exactly two imports, both from `operator_config.ts`
(`configModify` for the localStorage watch path, `configAllPaths` for cold builds);
sync→storage is only `FileCloudPreview`'s static constants. Everything else flows through
the hub object. In principle the storage layer could be driven by any transport.

### L6 — UI (`views/`, `lib/ui/`, `setting.tsx`)

**Two rendering stacks coexist:** plain Obsidian `Modal`/`ItemView` classes (most views)
and **React 18** (`settings-view.tsx`, `sync-log-view.tsx`, `note-history/*`). React is
bundled by esbuild; there is no JSX toolchain beyond TS.

Each view takes `(app, plugin)` and pulls services off the hub — it is a service-locator
consumer:

| View | Talks to |
|---|---|
| `sync-log-view.tsx` (right sidebar) | `SyncLogManager.getInstance()` (singleton, not via hub) + `fns:sync-progress` workspace events |
| `recycle-bin-modal.ts` | `plugin.api` / fresh `new HttpApiService(plugin)` — REST list/restore/clear |
| `share-modal.ts` / `share-manage-modal.ts` | `plugin.api` — create/list shares, password, short links |
| `note-history/*` | `plugin.api` — histories, history detail, restore |
| `ws-clients-modal.tsx` | `plugin.api.adminWsClients()` |
| `sso-import-modal.ts` | writes settings via hub (from the obsidian:// protocol handler) |
| `conflict-list-modal.tsx` / `conflict-resolve-modal.ts` | **directly into L3** — see §7 |
| `about-modal`, `confirm-modal`, `debug-log-modal`, `rule-editor*`, `path-suggest` | hub helpers, `DebugLogManager.getInstance()`, settings rules |

**`lib/ui/` managers** (DOM-bound, constructed by the hub):

- `MenuManager` — ribbon icon + its status colors, all plugin commands, file-context
  menu items, upgrade badge; calls L3 operators for user-initiated syncs
  (`startupSync`, `cancelSync`, `rebuildAllHashes`, …).
- `StatusBarManager` — status-bar text/progress; failed-count red dot from
  `SyncLogManager`.
- `ShareIndicatorManager` — stamps share icons into Obsidian's file-explorer DOM via a
  `MutationObserver` on `document.body` (native DOM, not an API), syncs shared paths
  with the server.

### Cross-cutting concerns

- **i18n (`src/i18n/`).** One function: `$("ui.status.completed", { n: 3 })`. Locales are
  typed against the English key set (`Partial<typeof en>`), so a missing key in any
  locale is a compile error; active locales: `en, ja, ko, zh-cn, zh-tw` (more exist as
  commented-out imports). Lookup falls back to English, then to the raw key. Interpolation
  supports `${path.to.value}` from params. Locale comes from Obsidian's `moment.locale()`.
  A script (`npm run translate`) regenerates translations via an LLM.
- **Logging.** `dump`/`dumpError` (from `lib/helpers_obsidian_bypass.js`, re-exported by
  `helpers.ts`) route to `console` or into the `DebugLogManager` singleton — a 1000-line
  in-memory ring buffer surfaced by the debug-log modal. Log level is a setting
  (`off | console | internal`). The *user-facing* sync log is the separate
  `SyncLogManager` (§L3).
- **`lib/utils/helpers.ts` (1251 lines)** — the kitchen sink, categorized: path/filename
  utils · exclude-rule engine (`parseRules`/`stringifyRules`/`isPathExcluded`/whitelist) ·
  hashing (above) · large-binary memory guards (128 MB in-memory cap) · timing primitives
  (`sleep`, `yieldToMain`, `debounce`) · `LocalStateFileMirror` · URL/redirect-whitelist
  utils · token obfuscation + the save/load pairs for connection settings · notices
  (`showSyncNotice`) · misc (`formatFileSize`, `isVersionNew`, `safeStringify`,
  case-conflict detection). If a utility is used by ≥2 layers it lives here.
- **`lib/utils/types.ts`** — the shared domain model: `SnapFile { path, pathHash,
  contentHash, mtime, ctime, size }` (the fundamental sync unit), `NoteSyncData` /
  `FileSyncData` / `ConfigSyncData` / `FolderSyncData` payload envelopes, WS message
  types (`ReceiveMessage`, `FileDownloadSession`, `SyncEndData`, …), plus typings for
  Obsidian **internal** APIs (`AppWithInternal`, `WorkspaceWithInternal`) used where the
  public API is insufficient.
- **`lib/helpers_obsidian_bypass.js`** — deliberately plain JavaScript: a shim around
  Obsidian internals (logging, `nativeFetch`, `vaultDelete`) kept out of TS so it can be
  swapped without type churn.

---

## 6. Key data flows

**A. Local edit → server (incremental)**

```
vault.on("modify")                        [L2 events_manager]
  → guards: ws authed? manual/readonly off? not part of pending rename?
  → runWithDelay(path): debounce per path, then lockManager.withLock(path)
  → noteModify(file, plugin)              [L3 operator_note]
      hash = hashContentAsync(await vault.read(file))
      if hash == fileHashManager.getValidHash(path) → no-op
      concurrencyLimiter.waitForSlot(path)          (upload slot, ACK-released)
      websocket.Send("NoteModify", { path, contentHash, … })   [L4]
  → server replies "NoteModifyAck"
      → receiveOperators dispatch → mark hash committed in FileHashManager
      → concurrencyLimiter.releaseSlot(path)
```

**B. Server push → local apply**

```
ws.onmessage (JSON or protobuf)
  → WebSocketClient → WebSocketManager.handleStructuredMessage(action, data)
      SyncLogManager.logReceivedMessage(…)
  → receiveOperators.get(action)(data, plugin)        [L3 operator_*]
      e.g. receiveNoteSyncModify:
        local unsynced change? → register in syncState.conflictedPaths (manual merge later)
        else write file via vault.create/modify, update FileHashManager, record progress
  → SyncProgressTracker.recordCompleted(type) → status bar + fns:sync-progress event [L6]
```

**C. Startup / first sync**

```
onload → … → onLayoutReady → hash caches initialize() (parallel)
  → crash recovery: restore pending* queues from LocalStorageManager, drop dead paths
  → eventManager.registerEvents()   (only once hashes are ready)
  → reloadServices(): optional API redirect probe → websocket.register()
      auth handshake → ClientInfo (versions, pv2 chunk/pipeline params → syncState)
      → StartHandle() → startupDelay → isFirstSync = true
      → startupSync / startupFullSync → handleSync round:
          scan local (hashes vs caches) → build modify/delete/missing payloads per type
          → send in batches (BatchAck-gated) → server streams *SyncPage downloads
          → checkSyncCompletion loop until all types done + buffer drained
```

**D. Settings change → reconnect**

```
setting.tsx writes plugin.settings.* → plugin.saveAndReloadServices()
  → saveSettings(): dual-write connection settings (localStorage + data.json, token obfuscated)
  → reloadServices(): update RuntimeConfig URLs; if wsSettingChange → websocket.unRegister()
      then register() again; reset watch sets (ignoredFiles, lastSyncMtime, …)
      optional scheduled handleSync for the just-enabled sync type
```

**E. Crash recovery** — see C: pending upload/modify queues persist in localStorage and
are re-validated against `vault.getAllLoadedFiles()` at load; upload resume checkpoints
older than 20 min (server session timeout) are pruned.

---

## 7. Dependency rules & where they leak

**The intended contract** (convention, not compiler-enforced):

1. Dependencies point **downward**: L1 → L2/L3/L4/L5/L6; L3 → L4 (transport) and L5
   (caches); L6 → L4 (REST) and L3 (user-initiated syncs); everyone → i18n/utils.
2. Cross-module communication goes **through the hub** (`plugin.*`) or the two singletons,
   not via direct imports.
3. `main.ts` is imported from lib code **as a type only**.

**Observed leaks / smells** (worth knowing before you refactor):

- **UI executes sync protocol steps.** `views/conflict-resolve-modal.ts` is the deepest:
  it mutates `plugin.syncState.conflictedPaths`, persists via
  `localStorageManager.setConflictedPaths()`, grabs an upload slot from
  `concurrencyLimiter.waitForSlot()`, and sends a raw `NoteModify` with
  `isConflictResolved: true` — bypassing the `operator_note.ts` receive path. Also:
  `menu_manager.ts` calls `startupSync`/`cancelSync`/`rebuildAllHashes` directly, and
  `setting.tsx` reassigns `plugin.settings` and sends `SettingClear` itself.
- **`events_manager.ts` sits in `utils/`** but is functionally L2 and imports L3
  operators *and* L6 modals — the import graph shows `utils → sync` and `utils → views`,
  which looks inverted only because of this file.
- **`helpers.ts` imports `sync_log_manager`** (utils→sync) for notice/logging helpers,
  and value-imports `main` (elided at build).
- **The hub makes everything reachable from everywhere.** There is no way to express
  "views must not touch syncState" — the conflict modal proves it can. If you add state,
  prefer putting it on `SyncState`/a manager and exposing a method, rather than a new
  loose field on `FastSync`.

**Where to put new code:**

| You're adding… | Put it in |
|---|---|
| A new server→local or local→server message handler | the matching `operator_*.ts` + entry in `receiveOperators` (or send-side call site) + action constant in `websocket_action.ts` |
| New per-session sync state | `SyncState` (+ a compatibility getter on `FastSync` if legacy names matter) |
| A new local cache/persistence concern | `lib/storage/`, with localStorage key + `LocalStateFileMirror` for iOS resilience |
| A new REST endpoint call | method on `HttpApiService`; UI consumes via `plugin.api` |
| A new modal/view | `views/`, take `(app, plugin)`, talk to L4/L3 services — not to each other |
| A user-facing string | add the key to **all** locales (typed against `en`), use `$()` |
| A utility used by ≥2 layers | `lib/utils/helpers.ts` (or a focused sibling file) |

---

## 8. Build, test & codegen notes

- **Build:** `esbuild.config.mjs` bundles the single entry `src/main.ts` → `main.js`
  (CJS, es2018, minified in prod). `obsidian`, CodeMirror packages, and Node builtins are
  external. CSS: `sass src/styles.scss styles.css`. Type-check via `tsc -noEmit` in the
  build script. `npm run dev` watches both.
- **Tests:** no test framework — `tests/*.mjs` are Node smoke tests that transpile a
  *single* module with `ts.transpileModule`, load it in a `vm` context, and stub its
  imports (`requireStub`). They cover specific regressions (file-mirror restore,
  websocket auth errors, vault-name setting, sync recovery). This design only works
  because modules are function-centric and take their dependencies as parameters — keep
  new code testable the same way if you want it covered.
- **Codegen:** `src/pb/v1/*` is generated from the server's `sync.proto`
  (`npm run proto`, expects the service repo at a relative path); `helpers_obsidian_bypass.js`
  and the obfuscated icons (`npm run icons`) are also tool-generated. Don't hand-edit
  generated files.
- **i18n codegen:** `npm run translate` regenerates locale values from English via an LLM;
  keys must stay in sync with `en.ts`.

---

*Generated as a living document — if the wiring described here drifts from the code, fix
this guide in the same PR.*
