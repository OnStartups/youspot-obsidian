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
  exportSpaceId: string;
  attachments: "none" | "available";
  capabilities?: ExportCapabilities;
  capabilitiesAccount?: string;
  selectionInitialized?: boolean;
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
  projection_version?: number;
  path: string;
  type: string;
  rendered_hash: string;
  updated_at: string;
}

export interface SyncState {
  refresh?: RefreshState;
  refreshReport?: RefreshReport;
  pendingWrites?: Record<string, { path: string; hash: string }>;
  exportConflicts?: string[];
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
  version: 1 | 2;
  settings: YouSpotSettings;
  state: SyncState;
}

export interface PathRules {
  syncFolder: string;
  exportFolder: string;
}

export interface ExportCapabilities {
  obsidian_version: number;
  archive_version: number;
  renderer_version: number;
  active_space_id: string | null;
  spaces: { id: string; name: string; counts: Record<string, number> }[];
  types: {
    type: string;
    label: string;
    classification: string;
    default: boolean;
    fields: Record<string, string>;
    reason: string;
  }[];
  incremental_types: string[];
  legacy_default_types: string[];
  attachment_modes: string[];
  limits: { archive_bytes: number; records: number; assets: number };
}

export interface ExportRun {
  id: string;
  status: string;
  error: string | null;
  bytes: number | null;
  sha256: string | null;
  options: { space_id: string; types: string[]; attachments: string };
  report: Record<string, unknown>;
}

export interface RefreshRequest {
  obsidian_version: 1;
  space_id: string;
  types: string[];
  attachments: "none" | "available";
  request_key: string;
}

export interface RefreshState {
  request: RefreshRequest;
  apiBase: string;
  account: string;
  root: string;
  runId?: string;
  releasePending?: boolean;
}

export interface RefreshReport {
  runId: string;
  written: number;
  originals: number;
  assets: number;
  conflicts: { path: string; reason: string }[];
  coverage: Record<string, unknown>;
}
