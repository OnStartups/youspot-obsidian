import type { PluginData, SyncState, YouSpotSettings } from "../types";

export const EXPORT_TYPES = ["contact", "company", "project", "note", "web_link"] as const;

export const DEFAULT_SETTINGS: YouSpotSettings = {
  token: "",
  apiBase: "https://be.youspot.com",
  appBase: "https://youspot.com",
  syncFolder: "",
  exportFolder: "YouSpot",
  syncIntervalMinutes: 5,
  syncOnSave: true,
  pullEnabled: true,
  exportTypes: Object.fromEntries(EXPORT_TYPES.map((t) => [t, true])),
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
      ...DEFAULT_SETTINGS.exportTypes,
      ...(isRecord(settings.exportTypes) ? settings.exportTypes : {}),
    },
  } as YouSpotSettings;
  const base = emptyState(
    typeof state.vaultId === "string" && state.vaultId ? state.vaultId : vaultId(),
  );
  return {
    version: 1,
    settings: merged,
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
