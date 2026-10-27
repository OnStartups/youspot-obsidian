import { syncFolders } from "./sync/paths";

export type Setup = "none" | "needs-folder" | "ready";

export function setupOf(settings: {
  token: string;
  syncFolder: string;
  additionalSyncFolders?: string[];
}): Setup {
  if (!settings.token) return "none";
  return syncFolders(settings).length ? "ready" : "needs-folder";
}

export interface StatusInput {
  setup: Setup;
  pending: number;
  running: boolean;
  lastPushAt: number | null;
  lastPullAt: number | null;
  error: string | null;
  uploadError?: string | null;
  downloadError?: string | null;
  failed?: number;
  serverEdited: number;
  conflicts: number;
  now: number;
}

export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatStatus(input: StatusInput): string {
  if (input.setup === "none") return "YouSpot: not connected";
  if (input.setup === "needs-folder") return "YouSpot: choose one or more sync folders";
  if (input.uploadError || input.failed)
    return `YouSpot: uploads need attention (${input.failed ?? 0} failed), download ${input.lastPullAt ? relativeTime(input.lastPullAt, input.now) : "never"}`;
  if (input.downloadError) return "YouSpot: downloads need attention";
  if (input.error) return `YouSpot: error (${input.error})`;
  if (input.running) return "YouSpot: syncing…";
  const parts: string[] = [];
  if (input.pending > 0) parts.push(`${input.pending} pending`);
  if (input.conflicts > 0)
    parts.push(`${input.conflicts} conflict${input.conflicts === 1 ? "" : "s"}`);
  if (input.serverEdited > 0) parts.push(`${input.serverEdited} edited in YouSpot`);
  if (parts.length === 0) {
    return `YouSpot: upload ${input.lastPushAt ? relativeTime(input.lastPushAt, input.now) : "never"}, download ${input.lastPullAt ? relativeTime(input.lastPullAt, input.now) : "never"}`;
  }
  return `YouSpot: ${parts.join(", ")}`;
}
