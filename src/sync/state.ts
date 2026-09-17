import type { ExportCapabilities, PluginData, SyncState, YouSpotSettings } from "../types";

const LEGACY_DEFAULT_TYPES = ["contact", "company", "project", "note", "web_link"];

export const DEFAULT_SETTINGS: YouSpotSettings = {
  token: "",
  apiBase: "https://be.youspot.com",
  appBase: "https://youspot.com",
  syncFolder: "",
  exportFolder: "YouSpot",
  syncIntervalMinutes: 5,
  syncOnSave: true,
  pullEnabled: true,
  exportTypes: {},
  exportSpaceId: "",
  attachments: "none",
  selectionInitialized: false,
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newVaultId(random: () => number = Math.random): string {
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  }
  return id;
}

export function emptyState(vaultId: string): SyncState {
  return {
    vaultId,
    notes: {},
    exports: {},
    watermark: null,
    lastPushAt: null,
    lastPullAt: null,
    lastError: null,
    serverEdited: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadPluginData(raw: unknown, vaultId: () => string = newVaultId): PluginData {
  const data = isRecord(raw) ? raw : {};
  const settings = isRecord(data.settings) ? data.settings : {};
  const state = isRecord(data.state) ? data.state : {};
  const merged: YouSpotSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    exportTypes: {
      ...(data.version === 1 || (data.settings && !data.version)
        ? Object.fromEntries(LEGACY_DEFAULT_TYPES.map((type) => [type, true]))
        : {}),
      ...(isRecord(settings.exportTypes) ? settings.exportTypes : {}),
    },
  } as YouSpotSettings;
  const base = emptyState(
    typeof state.vaultId === "string" && state.vaultId ? state.vaultId : vaultId(),
  );
  return {
    version: 2,
    settings: {
      ...merged,
      selectionInitialized: Boolean(
        settings.selectionInitialized || (data.version !== 2 && data.settings),
      ),
    },
    state: {
      ...base,
      ...state,
      vaultId: base.vaultId,
      notes: isRecord(state.notes) ? (state.notes as SyncState["notes"]) : {},
      exports: isRecord(state.exports) ? (state.exports as SyncState["exports"]) : {},
      serverEdited: Array.isArray(state.serverEdited) ? (state.serverEdited as string[]) : [],
    },
  };
}

export function resetState(state: SyncState): SyncState {
  return emptyState(state.vaultId);
}

export function applyCapabilities(
  settings: YouSpotSettings,
  capabilities: ExportCapabilities,
): void {
  if (
    capabilities.obsidian_version !== 1 ||
    capabilities.archive_version !== 1 ||
    capabilities.renderer_version !== 1
  ) {
    throw new Error("Update the plugin to use this export format.");
  }
  for (const item of capabilities.types) {
    if (!(item.type in settings.exportTypes)) {
      settings.exportTypes[item.type] =
        !settings.selectionInitialized &&
        item.default &&
        ["document", "context"].includes(item.classification);
    }
  }
  settings.selectionInitialized = true;
  settings.capabilities = capabilities;
  if (!settings.exportSpaceId) {
    settings.exportSpaceId =
      capabilities.spaces.find((space) => space.id === capabilities.active_space_id)?.id ??
      capabilities.spaces[0]?.id ??
      "";
  }
}
