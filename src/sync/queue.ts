export type QueueKind = "upsert" | "delete";

export type QueueEntry = import("../types").PendingChange;

export const BATCH_SIZE = 100;

export class ChangeQueue {
  private readonly entries = new Map<string, QueueEntry>();

  get size(): number {
    return this.entries.size;
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  snapshot(): QueueEntry[] {
    return [...this.entries.values()];
  }

  cancel(path: string): void {
    this.entries.delete(path);
  }

  upsert(path: string, options: { youspotId?: string; force?: boolean } = {}): void {
    const existing = this.entries.get(path);
    this.entries.set(path, {
      path,
      kind: "upsert",
      youspotId: options.youspotId ?? existing?.youspotId,
      attempts: 0,
      force: options.force || existing?.force,
    });
  }

  remove(
    path: string,
    youspotId?: string,
    expectedHash?: string,
    expectedPath = path,
    expectedSyncedAt?: string,
  ): void {
    const existing = this.entries.get(path);
    const id = youspotId ?? existing?.youspotId;
    if (!id) {
      this.entries.delete(path);
      return;
    }
    this.entries.set(path, {
      path,
      kind: "delete",
      youspotId: id,
      attempts: 0,
      ...(expectedHash ? { expectedHash, expectedPath } : {}),
      ...(expectedSyncedAt ? { expectedSyncedAt } : {}),
    });
  }

  rename(from: string, to: string, youspotId?: string): void {
    const existing = this.entries.get(from);
    this.entries.delete(from);
    this.entries.set(to, {
      path: to,
      kind: "upsert",
      youspotId: youspotId ?? existing?.youspotId,
      attempts: 0,
      force: existing?.force,
    });
  }

  drain(limit = BATCH_SIZE): QueueEntry[] {
    const out: QueueEntry[] = [];
    for (const [path, entry] of this.entries) {
      if (out.length >= limit) break;
      out.push(entry);
      this.entries.delete(path);
    }
    return out;
  }

  requeue(entry: QueueEntry): boolean {
    if (this.entries.has(entry.path)) return true;
    const attempts = entry.attempts + 1;
    this.entries.set(entry.path, { ...entry, attempts });
    return true;
  }

  restore(entries: QueueEntry[]): void {
    for (const entry of entries) {
      if (!this.entries.has(entry.path)) this.entries.set(entry.path, entry);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
