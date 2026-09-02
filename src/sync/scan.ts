import type { PathRules, SyncState } from "../types";
import type { FileMeta } from "../vault-port";
import { isSyncable } from "./paths";

export interface ReconcilePlan {
  upserts: string[];
  deletes: { path: string; youspotId: string }[];
}

export function planReconcile(
  files: FileMeta[],
  state: SyncState,
  rules: PathRules,
): ReconcilePlan {
  const present = new Set<string>();
  const upserts: string[] = [];
  for (const file of files) {
    if (!isSyncable(file.path, rules)) continue;
    present.add(file.path);
    const known = state.notes[file.path];
    if (!known || file.mtime > known.last_pushed_at || known.conflict) upserts.push(file.path);
  }
  const deletes: ReconcilePlan["deletes"] = [];
  for (const [path, note] of Object.entries(state.notes)) {
    if (!present.has(path) && isSyncable(path, rules)) {
      deletes.push({ path, youspotId: note.youspot_id });
    }
  }
  return { upserts, deletes };
}
