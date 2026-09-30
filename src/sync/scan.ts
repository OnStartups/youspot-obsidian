import type { PathRules, SyncState } from "../types";
import type { FileMeta } from "../vault-port";
import { isSyncable } from "./paths";

export interface ReconcilePlan {
  upserts: string[];
  missing: { path: string; youspotId: string }[];
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
    upserts.push(file.path);
  }
  const missing: ReconcilePlan["missing"] = [];
  for (const [path, note] of Object.entries(state.notes)) {
    if (!present.has(path) && isSyncable(path, rules)) {
      missing.push({ path, youspotId: note.youspot_id });
    }
  }
  return { upserts, missing };
}
