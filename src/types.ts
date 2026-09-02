export type WikiLinkRef = { path: string } | { object_id: string };

export interface PushNote {
  youspot_id?: string;
  path: string;
  title: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  wikilinks: WikiLinkRef[];
  mtime: string;
  force?: boolean;
}

export interface PushRequest {
  vault_id: string;
  vault_name: string;
  force?: boolean;
  notes: PushNote[];
}

export type PushStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "restored"
  | "renamed"
  | "conflict"
  | "error";

export interface PushResult {
  path: string;
  status: PushStatus;
  object_id?: string;
  content_hash?: string;
  synced_at?: string;
  server_hash?: string;
  server_updated_at?: string;
  error?: string;
}

export interface PushResponse {
  success: boolean;
  vault_id: string;
  results: PushResult[];
  counts: Record<string, number>;
  unresolved_links?: { from: string; path: string }[];
  brain_limit?: { cap: number; count: number };
}

export type DeleteRef = { youspot_id: string } | { path: string };

export interface DeleteResult {
  status: "deleted" | "not_found" | "already_deleted";
  object_id?: string;
}

export interface DeleteResponse {
  success: boolean;
  results: DeleteResult[];
}

export interface InventoryNote {
  object_id: string;
  path: string;
  content_hash: string;
  mtime: string | null;
  synced_at: string | null;
  updated_at: string;
  server_edited: boolean;
}

export interface InventoryResponse {
  notes: InventoryNote[];
  total: number;
  page: number;
  per_page: number;
}

export interface ServerNote {
  object_id: string;
  name: string;
  description: string | null;
  updated_at: string;
  obsidian: { vault_id: string; path: string } | null;
  server_edited: boolean;
}

export interface ChangeConnection {
  type: string;
  direction: "in" | "out";
  object_id: string;
  object_type: string;
  name: string;
}

export interface ChangeObject {
  object_id: string;
  type: string;
  name: string;
  description: string | null;
  url: string | null;
  page_url: string;
  json_data: Record<string, unknown>;
  fields: Record<string, unknown>;
  tags: string[];
  connections: ChangeConnection[];
  created_at: string;
  updated_at: string;
  origin: "brain" | "vault";
  obsidian?: { vault_id: string; path: string } | null;
  server_edited?: boolean;
}

export interface Tombstone {
  object_id: string;
  type: string;
  deleted_at: string;
  obsidian: { vault_id: string; path: string } | null;
}

export interface ChangesResponse {
  success: boolean;
  since: string;
  next_since: string;
  page: number;
  per_page: number;
  has_more: boolean;
  objects: ChangeObject[];
  tombstones: Tombstone[];
}

export interface MeResponse {
  email: string;
  brain_count: number;
}

export interface YouSpotSettings {
  token: string;
  apiBase: string;
  appBase: string;
  syncFolder: string;
  exportFolder: string;
  syncIntervalMinutes: number;
  syncOnSave: boolean;
  pullEnabled: boolean;
  exportTypes: Record<string, boolean>;
}

export interface NoteConflict {
  server_hash: string;
  server_updated_at: string;
}

export interface NoteState {
  youspot_id: string;
  local_hash: string;
  content_hash: string;
  server_updated_at: string;
  last_pushed_at: number;
  conflict?: NoteConflict;
}

export interface ExportState {
  path: string;
  type: string;
  rendered_hash: string;
  updated_at: string;
}

export interface SyncState {
  vaultId: string;
  notes: Record<string, NoteState>;
  exports: Record<string, ExportState>;
  watermark: string | null;
  lastPushAt: number | null;
  lastPullAt: number | null;
  lastError: string | null;
  serverEdited: string[];
}

export interface PluginData {
  version: 1;
  settings: YouSpotSettings;
  state: SyncState;
}

export interface PathRules {
  syncFolder: string;
  exportFolder: string;
}
