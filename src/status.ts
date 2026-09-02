export interface StatusInput {
  configured: boolean;
  pending: number;
  running: boolean;
  lastPushAt: number | null;
  lastPullAt: number | null;
  error: string | null;
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
  if (!input.configured) return "YouSpot: not connected";
  if (input.error) return `YouSpot: error (${input.error})`;
  if (input.running) return "YouSpot: syncing…";
  const parts: string[] = [];
  if (input.pending > 0) parts.push(`${input.pending} pending`);
  if (input.conflicts > 0)
    parts.push(`${input.conflicts} conflict${input.conflicts === 1 ? "" : "s"}`);
  if (input.serverEdited > 0) parts.push(`${input.serverEdited} edited in YouSpot`);
  const last = Math.max(input.lastPushAt ?? 0, input.lastPullAt ?? 0);
  if (parts.length === 0) {
    return last ? `YouSpot: synced ${relativeTime(last, input.now)}` : "YouSpot: never synced";
  }
  return `YouSpot: ${parts.join(", ")}`;
}
