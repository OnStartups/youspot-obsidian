import type { PathRules, SyncState } from "../types";
import type { VaultPort } from "../vault-port";
import { splitFrontmatter } from "./frontmatter";
import { isExport } from "./paths";

export function managedIdentity(content: string): string | null {
  const raw = splitFrontmatter(content).raw;
  if (!raw || !/^youspot_managed:\s*true\s*$/m.test(raw)) return null;
  const value = /^youspot_id:\s*(.+?)\s*$/m.exec(raw)?.[1];
  if (!value) return null;
  if (/^".*"$/.test(value)) {
    const id: unknown = JSON.parse(value);
    return typeof id === "string" && id ? id : null;
  }
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

export async function recoverManaged(
  vault: VaultPort,
  state: SyncState,
  rules: PathRules,
): Promise<void> {
  const found = new Map<string, string>();
  for (const file of vault.listMarkdown()) {
    if (!isExport(file.path, rules)) continue;
    const content = await vault.read(file.path);
    const id = managedIdentity(content);
    if (!id) continue;
    if (found.has(id))
      throw new Error(
        "Two managed files claim the same object. Resolve the duplicate before syncing.",
      );
    found.set(id, file.path);
    const existing = state.exports[id];
    if (existing && existing.path !== file.path && vault.exists(existing.path)) {
      throw new Error(
        "Two managed files claim the same object. Resolve the duplicate before syncing.",
      );
    }
    const type = vault.cache(file.path)?.frontmatter?.youspot_type;
    state.exports[id] = {
      path: file.path,
      type: existing?.type ?? (typeof type === "string" ? type : ""),
      rendered_hash: existing?.path === file.path ? existing.rendered_hash : "",
      updated_at: existing?.updated_at ?? "",
      projection_version:
        existing?.projection_version ??
        (/^youspot_type:/m.test(splitFrontmatter(content).raw ?? "") ? undefined : 1),
    };
  }
}
