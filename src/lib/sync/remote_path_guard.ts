import { TFolder, type TAbstractFile, type Vault } from "obsidian";
import type FastSync from "../../main";
import { SyncLogManager } from "./sync_log_manager";

// getRealPath is a desktop adapter capability, not part of the portable API.
type PathAwareAdapter = Vault["adapter"] & { getRealPath?: (path: string) => string };

/** Check identities before a destructive operation, without Unicode/space folding. */
export function blockAliasedRemoteMutation(
  plugin: FastSync,
  file: TAbstractFile | null,
  requestedPath: string,
  action: string,
): boolean {
  if (!file) return false;
  const adapter = plugin.app.vault.adapter as PathAwareAdapter;
  const separators = (path: string) => path.replace(/\\/g, "/");
  const pending = [file];
  const visited = new Set<TAbstractFile>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const expected = current === file ? requestedPath : current.path;
    const physical = adapter.getRealPath?.(current.path) ?? current.path;
    if (separators(current.path) !== separators(expected) || separators(physical) !== separators(expected)) {
      SyncLogManager.getInstance().addLog(
        "receive", `${action}PathAliasBlocked`,
        "Remote mutation blocked: requested path resolves to a different local path. Reconcile the paths before retrying.",
        "error", requestedPath,
      );
      return true;
    }
    // A folder overwrite can recursively delete an aliased descendant.
    if (current instanceof TFolder) pending.push(...current.children);
  }
  return false;
}
