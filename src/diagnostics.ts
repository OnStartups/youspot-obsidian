import type { PluginData } from "./types";
import { syncFolders } from "./sync/paths";

function code(error: string | null | undefined): string | null {
  return error ? (/^[a-z][a-z0-9_]{0,79}$/.test(error) ? error : "sync_failed") : null;
}

export function diagnosticSummary(
  data: PluginData,
  appVersion: string,
  pluginVersion: string,
): string {
  const { settings, state } = data;
  return JSON.stringify(
    {
      appVersion,
      pluginVersion,
      stateVersion: data.version,
      folders: { originals: syncFolders(settings), exports: settings.exportFolder },
      selectedTypes: Object.entries(settings.exportTypes)
        .filter(([, selected]) => selected)
        .map(([type]) => type),
      intervalMinutes: settings.syncIntervalMinutes,
      lastAcknowledgedUpload: state.lastPushAt,
      lastUploadAttempt: state.lastUploadAttemptAt ?? null,
      lastUploadCheck: state.lastUploadCheckAt ?? null,
      lastDownload: state.lastPullAt,
      pending: state.pending?.length ?? 0,
      failed: Object.keys(state.failures ?? {}).length,
      missing: Object.keys(state.missing ?? {}).length,
      exportConflicts: state.exportConflicts?.length ?? 0,
      refreshConflicts: state.refreshReport?.conflicts.length ?? 0,
      errors: {
        upload: code(state.uploadError),
        download: code(state.downloadError),
        refresh: code(state.refreshError),
      },
    },
    null,
    2,
  );
}
