import type { ChangeObject, PathRules, SyncState, Tombstone, YouSpotSettings } from "../types";
import { sha256Hex } from "./hash";
import { exportPath } from "./paths";
import { renderObject } from "./render";

export type PullAction =
  | {
      kind: "write";
      objectId: string;
      path: string;
      previousPath: string | null;
      content: string;
      hash: string;
      type: string;
      updatedAt: string;
    }
  | { kind: "trash"; objectId: string; path: string };

export interface PullPlan {
  actions: PullAction[];
  serverEdited: string[];
  forgetNotes: string[];
}

function typeEnabled(settings: YouSpotSettings, type: string): boolean {
  return settings.exportTypes[type] !== false;
}

export async function planPull(
  objects: ChangeObject[],
  tombstones: Tombstone[],
  state: SyncState,
  settings: YouSpotSettings,
  rules: PathRules,
): Promise<PullPlan> {
  const plan: PullPlan = { actions: [], serverEdited: [], forgetNotes: [] };
  const vaultNotes = new Map<string, string>();
  for (const [path, note] of Object.entries(state.notes)) vaultNotes.set(note.youspot_id, path);

  const included: ChangeObject[] = [];
  for (const obj of objects) {
    if (obj.origin === "vault" || vaultNotes.has(obj.object_id)) {
      if (obj.server_edited) plan.serverEdited.push(obj.object_id);
      continue;
    }
    if (typeEnabled(settings, obj.type)) included.push(obj);
  }

  const assigned = new Map<string, string>();
  const taken = new Set<string>();
  for (const [id, entry] of Object.entries(state.exports)) {
    if (!included.some((o) => o.object_id === id)) taken.add(entry.path);
  }
  for (const obj of included) {
    const path = exportPath(rules, obj.type, obj.name, obj.object_id, taken);
    assigned.set(obj.object_id, path);
    taken.add(path);
  }

  const resolvePath = (objectId: string): string | null =>
    assigned.get(objectId) ?? state.exports[objectId]?.path ?? null;

  const rendered = await Promise.all(
    included.map(async (obj) => {
      const content = renderObject(obj, { appBase: settings.appBase, resolvePath });
      return { obj, content, hash: await sha256Hex(content) };
    }),
  );

  for (const { obj, content, hash } of rendered) {
    const path = assigned.get(obj.object_id);
    if (!path) continue;
    const existing = state.exports[obj.object_id];
    if (existing && existing.path === path && existing.rendered_hash === hash) continue;
    plan.actions.push({
      kind: "write",
      objectId: obj.object_id,
      path,
      previousPath: existing && existing.path !== path ? existing.path : null,
      content,
      hash,
      type: obj.type,
      updatedAt: obj.updated_at,
    });
  }

  for (const tomb of tombstones) {
    const exported = state.exports[tomb.object_id];
    if (exported) {
      plan.actions.push({ kind: "trash", objectId: tomb.object_id, path: exported.path });
      continue;
    }
    const notePath = vaultNotes.get(tomb.object_id);
    if (notePath) plan.forgetNotes.push(notePath);
  }

  return plan;
}
