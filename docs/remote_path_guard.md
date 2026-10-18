# Remote path identity checks

Obsidian can expose a normalized `TFile.path` while its desktop adapter maps that
path to a different physical spelling. For example, a non-breaking space may
become an ASCII space, and decomposed Japanese characters may become NFC.
`normalizePath()` also performs these conversions. A remote tombstone or rename
can therefore resolve to a local file with a different identity.

Before a remote note, attachment or folder delete/rename, compare the original
message path with the resolved object's path and, where available, the adapter's
`getRealPath()` result. Only slash separators are made equivalent; whitespace,
Unicode and case differences are not folded. Rename checks cover both the source
and an existing overwrite target. Folder checks include descendants because an
overwrite can recursively delete them. A folder delete rechecks after waiting
for the folder to become empty. A same-object rename does not delete its source.

A mismatch logs `*PathAliasBlocked` and skips the mutation before changing
ignored-event state, hashes or pending note modifications. Existing page/task
completion still runs. Reconcile the local and server path identities before
retrying; this guard does not automatically restore server tombstones, rename
local files, or merge content conflicts.

The optional desktop capability is feature-detected. Adapters without
`getRealPath()` still receive raw-message versus logical-path checks, but hidden
physical aliases cannot be detected through that capability. The tests model
both adapter shapes; they do not constitute an on-device iOS/iPadOS test.

Run `npm run test:path-guard`. The tests transpile and execute the six source
handlers with isolated vault/adapter dependencies. Synthetic cases cover NBSP,
narrow non-breaking spaces, NFD, normalized remote aliases, physical aliases,
rename overwrite targets, alias descendants, normal mutations, Windows
separators, adapters without `getRealPath`, nonempty folders and same-path
renames. They assert that blocked operations preserve pending edits and hashes
and still complete their page once.
