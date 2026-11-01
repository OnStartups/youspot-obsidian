import type { ManagedDuplicate, PathRules, SyncState } from "../types";
import type { VaultPort } from "../vault-port";
import { splitFrontmatter } from "./frontmatter";
import { sha256Hex } from "./hash";
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
): Promise<ManagedDuplicate[]> {
  const found = new Map<string, string[]>();
  const contents = new Map<string, string>();
  for (const file of vault.listMarkdown()) {
    if (!isExport(file.path, rules)) continue;
    const content = await vault.read(file.path);
    const id = managedIdentity(content);
    if (!id) continue;
    contents.set(file.path, content);
    found.set(id, [...(found.get(id) ?? []), file.path]);
  }
  const duplicates: ManagedDuplicate[] = [];
  for (const [id, paths] of found) {
    const existing = state.exports[id];
    if (existing && !paths.includes(existing.path) && vault.exists(existing.path))
      paths.unshift(existing.path);
    if (paths.length > 1) {
      duplicates.push({
        objectId: id,
        paths: [...paths].sort(),
        holders: paths.filter((p) => contents.has(p)).sort(),
      });
      continue;
    }
    const path = paths[0]!;
    const type = vault.cache(path)?.frontmatter?.youspot_type;
    const pristine =
      existing !== undefined &&
      (existing.path === path || (await sha256Hex(contents.get(path)!)) === existing.rendered_hash);
    state.exports[id] = {
      path,
      type: existing?.type ?? (typeof type === "string" ? type : ""),
      rendered_hash: pristine ? existing.rendered_hash : "",
      updated_at: existing?.updated_at ?? "",
      projection_version:
        existing?.projection_version ??
        (/^youspot_type:/m.test(splitFrontmatter(contents.get(path)!).raw ?? "") ? undefined : 1),
    };
  }
  state.managedDuplicates = duplicates;
  return duplicates;
}
