import type { PushResult, SyncState } from "../types";

export interface PushApply {
  stamps: { path: string; youspotId: string }[];
  conflicts: PushResult[];
  errors: PushResult[];
  applied: number;
}

const SETTLED = new Set(["created", "updated", "unchanged", "restored", "renamed"]);

export function applyPushResults(
  state: SyncState,
  results: PushResult[],
  hashes: Map<string, string>,
  now: number,
): PushApply {
  const apply: PushApply = { stamps: [], conflicts: [], errors: [], applied: 0 };
  for (const result of results) {
    const existing = state.notes[result.path];
    if (SETTLED.has(result.status) && result.object_id) {
      state.notes[result.path] = {
        youspot_id: result.object_id,
        local_hash: hashes.get(result.path) ?? existing?.local_hash ?? "",
        content_hash: result.content_hash ?? existing?.content_hash ?? "",
        server_updated_at: result.synced_at ?? existing?.server_updated_at ?? "",
        last_pushed_at: now,
      };
      state.serverEdited = state.serverEdited.filter((id) => id !== result.object_id);
      if (!existing || existing.youspot_id !== result.object_id) {
        apply.stamps.push({ path: result.path, youspotId: result.object_id });
      }
      apply.applied += 1;
      continue;
    }
    if (result.status === "conflict") {
      if (existing && result.server_hash && result.server_updated_at) {
        existing.conflict = {
          server_hash: result.server_hash,
          server_updated_at: result.server_updated_at,
        };
      }
      apply.conflicts.push(result);
      continue;
    }
    apply.errors.push(result);
  }
  return apply;
}

export function forgetDeleted(state: SyncState, paths: string[]): void {
  for (const path of paths) delete state.notes[path];
}
