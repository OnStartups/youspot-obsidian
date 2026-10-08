import { ApiError, type ApiClient } from "../api";
import { type Setup, setupOf } from "../status";
import type { DeleteRef, PathRules, PluginData, PushNote } from "../types";
import type { VaultPort } from "../vault-port";
import { emitFrontmatter, splitFrontmatter } from "./frontmatter";
import { localHash, sha256Hex } from "./hash";
import { conflictPath, dirname, isExport, isSyncable } from "./paths";
import { buildNotePayload } from "./payload";
import { type PullAction, planPull } from "./pull";
import { applyPushResults, forgetDeleted } from "./push";
import { BATCH_SIZE, ChangeQueue, type QueueEntry } from "./queue";
import { planReconcile } from "./scan";
import { managedIdentity, recoverManaged } from "./managed";
import { refreshBrain } from "./refresh";

export interface EngineDeps {
  vault: VaultPort;
  api: ApiClient;
  data: PluginData;
  persist: () => Promise<void> | void;
  notify: (message: string) => void;
  onStatus?: () => void;
  now?: () => number;
  debounceMs?: number;
  maxWaitMs?: number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

export interface PushSummary {
  pushed: number;
  deleted: number;
  conflicts: number;
  errors: number;
  outcome?: "completed" | "partial" | "failed" | "deferred" | "no_change";
}

export interface PullSummary {
  written: number;
  trashed: number;
}

const MIN_BACKOFF = 5_000;
const MAX_BACKOFF = 300_000;

export class SyncEngine {
  readonly queue = new ChangeQueue();
  private readonly managed = new Set<string>();
  private pushing: Promise<PushSummary> | null = null;
  private pulling: Promise<PullSummary> | null = null;
  private refreshing: Promise<void> | null = null;
  private dirty = false;
  private syncing: Promise<void> | null = null;
  private scanning: Promise<void> | null = null;
  private inflight: QueueEntry[] = [];
  private observed = new Set<string>();
  private saving: Promise<void> = Promise.resolve();
  private debounceTimer: number | null = null;
  private maxWaitTimer: number | null = null;
  private backoffMs = MIN_BACKOFF;
  private backoffUntil = 0;
  private halted = false;

  constructor(private readonly deps: EngineDeps) {
    this.reloadState();
  }

  reloadState(): void {
    this.queue.clear();
    this.queue.restore(this.state.pending ?? []);
    this.inflight = [];
    this.observed.clear();
    this.state.failures ??= {};
    this.state.missing ??= {};
  }

  get failedCount(): number {
    return Object.keys(this.state.failures ?? {}).length;
  }

  async suspend(): Promise<void> {
    this.pause();
    await Promise.all([this.syncing, this.scanning, this.pushing, this.pulling, this.refreshing]);
    await this.saving;
    await this.save();
  }

  pause(): void {
    this.halted = true;
    this.stop();
  }

  async retryFailed(): Promise<PushSummary> {
    this.resume();
    for (const [path, failure] of Object.entries(this.state.failures ?? {})) {
      if (failure.error.startsWith("Removed from Brain.")) continue;
      this.queue.restore([failure.entry]);
      delete this.state.failures?.[path];
    }
    await this.save();
    return this.push();
  }

  private async save(): Promise<void> {
    const pending = new Map(this.inflight.map((entry) => [entry.path, entry]));
    for (const entry of this.queue.snapshot()) pending.set(entry.path, entry);
    this.state.pending = [...pending.values()];
    this.state.lastError =
      this.state.uploadError ?? this.state.downloadError ?? this.state.refreshError ?? null;
    await this.deps.persist();
  }

  private changed(): void {
    this.saving = this.saving
      .catch(() => undefined)
      .then(() => this.save())
      .catch((error: unknown) => {
        this.halted = true;
        this.stop();
        this.state.lastError =
          "Local save failed. Pending changes were kept in memory. Retry after checking storage.";
        this.deps.notify(this.state.lastError);
        this.deps.onStatus?.();
        console.error(error);
      });
    this.schedule();
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private setTimer(fn: () => void, ms: number): number {
    return this.deps.setTimer(fn, ms);
  }

  private clearTimer(id: number): void {
    this.deps.clearTimer(id);
  }

  get settings() {
    return this.deps.data.settings;
  }

  get state() {
    return this.deps.data.state;
  }

  get rules(): PathRules {
    return { syncFolder: this.settings.syncFolder, exportFolder: this.settings.exportFolder };
  }

  get setup(): Setup {
    return setupOf(this.settings);
  }

  get configured(): boolean {
    return this.setup === "ready";
  }

  get running(): boolean {
    return this.pushing !== null || this.pulling !== null || this.refreshing !== null;
  }

  get conflicts(): number {
    return (
      Object.values(this.state.notes).filter((n) => n.conflict).length +
      (this.state.refreshReport?.conflicts.length ?? 0) +
      (this.state.exportConflicts?.length ?? 0)
    );
  }

  resume(): void {
    this.halted = false;
    this.backoffMs = MIN_BACKOFF;
    this.backoffUntil = 0;
  }

  stop(): void {
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    if (this.maxWaitTimer) this.clearTimer(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
  }

  private isManaged(path: string): boolean {
    return (
      Object.values(this.state.exports).some((entry) => entry.path === path) ||
      Boolean(this.deps.vault.cache(path)?.frontmatter?.youspot_managed)
    );
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (this.pushing) await this.pushing;
      if (this.pulling) await this.pulling;
      try {
        await refreshBrain(this.deps);
        this.state.refreshError = null;
      } catch (error) {
        this.failed(error, "refresh");
      }
      await this.save();
    })().finally(() => {
      this.refreshing = null;
      this.deps.onStatus?.();
      if (this.queue.size) this.schedule();
    });
    this.deps.onStatus?.();
    return this.refreshing;
  }

  async cancelRefresh(): Promise<void> {
    if (this.running) return;
    if (this.state.refresh?.runId) await this.deps.api.releaseExport(this.state.refresh.runId);
    delete this.state.refresh;
    await this.save();
  }

  handleChanged(path: string): void {
    if (this.managed.has(path) || this.isManaged(path) || !isSyncable(path, this.rules)) return;
    if (this.state.failures?.[path]?.error.startsWith("Removed from Brain.")) return;
    delete this.state.missing?.[path];
    this.queue.upsert(path, { youspotId: this.state.notes[path]?.youspot_id });
    this.changed();
  }

  handleDeleted(path: string): void {
    if (this.managed.has(path)) return;
    if (isExport(path, this.rules)) {
      for (const [id, entry] of Object.entries(this.state.exports)) {
        if (entry.path === path) delete this.state.exports[id];
      }
      return;
    }
    if (!isSyncable(path, this.rules)) return;
    const note = this.state.notes[path];
    if (this.observed.has(path) && note?.content_hash && !note.conflict) {
      this.queue.remove(path, note.youspot_id, note.content_hash, path, note.server_updated_at);
    } else {
      this.queue.cancel(path);
    }
    this.changed();
  }

  handleRenamed(from: string, to: string): void {
    if (this.managed.has(from) || this.managed.has(to)) return;
    const rules = this.rules;
    if (isExport(from, rules)) {
      for (const entry of Object.values(this.state.exports)) {
        if (entry.path === from) entry.path = to;
      }
      return;
    }
    const fromSyncable = isSyncable(from, rules);
    const toSyncable = isSyncable(to, rules);
    if (fromSyncable && toSyncable) {
      const note = this.state.notes[from];
      if (note) {
        delete this.state.notes[from];
        this.state.notes[to] = { ...note, local_hash: "" };
      }
      delete this.state.failures?.[from];
      delete this.state.missing?.[from];
      if (this.observed.delete(from)) this.observed.add(to);
      this.queue.rename(from, to, note?.youspot_id);
      this.changed();
      return;
    }
    if (fromSyncable) {
      this.queue.cancel(from);
      this.changed();
      return;
    }
    if (toSyncable) this.handleChanged(to);
  }

  private schedule(): void {
    this.deps.onStatus?.();
    if (!this.configured || !this.settings.syncOnSave) return;
    const debounce = this.deps.debounceMs ?? 3_000;
    const maxWait = this.deps.maxWaitMs ?? 15_000;
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    this.debounceTimer = this.setTimer(() => void this.flush(), debounce);
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = this.setTimer(() => void this.flush(), maxWait);
    }
  }

  private async flush(): Promise<void> {
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    if (this.maxWaitTimer) this.clearTimer(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    try {
      await this.push();
    } catch (error) {
      this.pause();
      this.failed(error, "upload");
    }
  }

  syncNow(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      if (this.refreshing) await this.refreshing;
      if (!this.configured || this.halted) return;
      await this.discover();
      await this.push();
      if (this.halted) return;
      if (this.state.refresh) await this.refresh();
      else if (this.settings.pullEnabled) await this.pull();
      await this.push();
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  push(): Promise<PushSummary> {
    if (this.pushing) {
      this.dirty = true;
      return this.pushing;
    }
    this.pushing = this.runPush().finally(() => {
      this.pushing = null;
      this.deps.onStatus?.();
      if (this.dirty && this.queue.size > 0) {
        this.dirty = false;
        this.schedule();
      }
    });
    return this.pushing;
  }

  async pushNote(path: string, force = false): Promise<PushSummary> {
    if (this.isManaged(path)) {
      this.deps.notify("Managed exports are local copies. Edit the original record in YouSpot.");
      return { pushed: 0, deleted: 0, conflicts: 0, errors: 1, outcome: "failed" };
    }
    if (!isSyncable(path, this.rules)) {
      this.deps.notify("This note is outside the YouSpot sync folder.");
      return { pushed: 0, deleted: 0, conflicts: 0, errors: 0, outcome: "deferred" };
    }
    const note = this.state.notes[path];
    if (this.state.failures?.[path]?.error.startsWith("Removed from Brain.") && !force) {
      return { pushed: 0, deleted: 0, conflicts: 0, errors: 1, outcome: "failed" };
    }
    delete this.state.failures?.[path];
    if (force && note) delete note.conflict;
    this.queue.upsert(path, { youspotId: note?.youspot_id, force });
    return this.push();
  }

  private async runPush(): Promise<PushSummary> {
    const summary: PushSummary = { pushed: 0, deleted: 0, conflicts: 0, errors: 0 };
    if (!this.configured || this.halted || this.refreshing || this.pulling) {
      return { ...summary, outcome: "deferred" };
    }
    if (this.now < this.backoffUntil) {
      this.rearm(this.backoffUntil - this.now);
      return { ...summary, outcome: "deferred" };
    }
    await this.saving;
    if (this.halted) return { ...summary, outcome: "deferred" };
    this.state.lastUploadAttemptAt = this.now;
    this.deps.onStatus?.();
    while (this.queue.size > 0 && !this.halted) {
      const entries = this.queue.drain(BATCH_SIZE);
      this.inflight = entries;
      try {
        await this.save();
        await this.pushBatch(entries, summary);
        this.backoffMs = MIN_BACKOFF;
      } catch (err) {
        if (err instanceof ApiError && !err.retryable && !err.unauthorized) {
          for (const entry of entries) {
            const hash = this.deps.vault.stat(entry.path)
              ? await localHash(
                  splitFrontmatter(await this.deps.vault.read(entry.path)).body,
                  this.deps.vault.cache(entry.path)?.frontmatter,
                )
              : undefined;
            this.block(entry, err.message, hash);
          }
        } else this.queue.restore(entries);
        summary.errors += Math.max(1, entries.length);
        this.failed(err, "upload");
        break;
      } finally {
        this.inflight = [];
        await this.save();
      }
    }
    if (summary.errors === 0 && summary.conflicts === 0 && this.failedCount === 0) {
      try {
        if (this.state.uploadError && !summary.pushed && !summary.deleted) await this.deps.api.me();
        this.state.uploadError = null;
        this.state.lastUploadCheckAt = this.now;
      } catch (error) {
        summary.errors++;
        this.failed(error, "upload");
      }
    }
    if (summary.pushed + summary.deleted > 0) this.state.lastPushAt = this.now;
    summary.outcome =
      summary.errors || summary.conflicts || this.failedCount
        ? summary.pushed + summary.deleted
          ? "partial"
          : "failed"
        : this.queue.size
          ? "deferred"
          : summary.pushed + summary.deleted
            ? "completed"
            : "no_change";
    await this.save();
    return summary;
  }

  private block(entry: QueueEntry, error: string, hash?: string): void {
    if (this.queue.has(entry.path)) return;
    (this.state.failures ??= {})[entry.path] = { entry, error, hash };
    this.state.uploadError = error;
  }

  private async hasIdentityElsewhere(id: string, path: string): Promise<boolean> {
    for (const file of this.deps.vault.listMarkdown()) {
      if (file.path === path) continue;
      if (isExport(file.path, this.rules) || this.isManaged(file.path)) continue;
      const cache = this.deps.vault.cache(file.path);
      if (cache?.frontmatter?.youspot_id === id) return true;
      if (!cache) {
        if (!isSyncable(file.path, this.rules) && !isExport(file.path, this.rules)) return true;
        const content = await this.deps.vault.read(file.path);
        if (managedIdentity(content)) continue;
        const raw = splitFrontmatter(content).raw ?? "";
        if (
          raw
            .split(/\r?\n/)
            .some(
              (line) =>
                line === `youspot_id: ${id}` || line === `youspot_id: ${JSON.stringify(id)}`,
            )
        )
          return true;
      }
    }
    return false;
  }

  private async pushBatch(entries: QueueEntry[], summary: PushSummary): Promise<void> {
    const notes: PushNote[] = [];
    const hashes = new Map<string, string>();
    const deletes: { entry: QueueEntry; ref: DeleteRef }[] = [];
    const exportsByPath = new Map<string, string>();
    for (const [id, entry] of Object.entries(this.state.exports)) exportsByPath.set(entry.path, id);
    for (const entry of entries) {
      if (!isSyncable(entry.path, this.rules) || this.isManaged(entry.path)) continue;
      const meta = this.deps.vault.stat(entry.path);
      if (entry.kind === "delete") {
        if (
          meta ||
          (entry.youspotId && (await this.hasIdentityElsewhere(entry.youspotId, entry.path)))
        )
          continue;
        if (!entry.youspotId || !entry.expectedHash) {
          this.block(entry, "Review this missing note before removing it from Brain.");
          summary.errors++;
          continue;
        }
        deletes.push({
          entry,
          ref: {
            youspot_id: entry.youspotId,
            expected_hash: entry.expectedHash,
            expected_path: entry.expectedPath ?? entry.path,
            ...(entry.expectedSyncedAt ? { expected_synced_at: entry.expectedSyncedAt } : {}),
          },
        });
        continue;
      }
      if (!meta) continue;
      const content = await this.deps.vault.read(entry.path);
      if (managedIdentity(content)) continue;
      const cache = this.deps.vault.cache(entry.path);
      if (!cache) {
        this.block(entry, "Waiting for note metadata. Rescan after the vault finishes loading.");
        summary.errors++;
        continue;
      }
      this.observed.add(entry.path);
      const { body } = splitFrontmatter(content);
      const hash = await localHash(body, cache.frontmatter);
      if (this.state.failures?.[entry.path]?.hash === hash && !entry.force) continue;
      delete this.state.failures?.[entry.path];
      const known = this.state.notes[entry.path];
      if (known?.local_hash === hash && !known.conflict && !entry.force) continue;
      const note = buildNotePayload({
        path: entry.path,
        body,
        frontmatter: cache.frontmatter,
        tags: cache.tags,
        links: this.deps.vault.resolvedLinks(entry.path),
        mtime: meta.mtime,
        youspotId: entry.youspotId ?? known?.youspot_id,
        rules: this.rules,
        exportsByPath,
      });
      if (entry.force) note.force = true;
      note.restore_deleted = false;
      notes.push(note);
      hashes.set(entry.path, hash);
    }
    if (notes.length) {
      const res = await this.deps.api.push({
        vault_id: this.state.vaultId,
        vault_name: this.deps.vault.vaultName(),
        notes,
      });
      const results = notes.map(
        (note) =>
          res.results.find((result) => result.path === note.path) ?? {
            path: note.path,
            status: "error" as const,
            error: "Upload acknowledgement missing.",
          },
      );
      const apply = applyPushResults(this.state, results, hashes, this.now);
      summary.pushed += apply.applied;
      summary.conflicts += apply.conflicts.length;
      summary.errors += apply.errors.length;
      for (const stamp of apply.stamps) {
        if (this.deps.vault.stat(stamp.path)) {
          await this.managedWrite(stamp.path, () =>
            this.deps.vault.stampFrontmatter(stamp.path, "youspot_id", stamp.youspotId),
          );
        }
      }
      for (const result of [...apply.errors, ...apply.conflicts]) {
        const entry = entries.find((candidate) => candidate.path === result.path);
        if (entry)
          this.block(
            entry,
            result.error === "note_removed"
              ? "Removed from Brain. Use Push this note (overwrite server) to restore it deliberately."
              : (result.error ??
                  (result.status === "conflict"
                    ? "This note was edited in YouSpot. Review the versions before retrying."
                    : "Note upload failed.")),
            hashes.get(entry.path),
          );
      }
      for (const note of notes) {
        if (
          results.some(
            (result) =>
              result.path === note.path &&
              result.status !== "error" &&
              result.status !== "conflict",
          )
        ) {
          delete this.state.failures?.[note.path];
          const meta = this.deps.vault.stat(note.path);
          if (meta) {
            const current = splitFrontmatter(await this.deps.vault.read(note.path));
            if (
              (await localHash(current.body, this.deps.vault.cache(note.path)?.frontmatter)) !==
              hashes.get(note.path)
            ) {
              this.queue.upsert(note.path, { youspotId: this.state.notes[note.path]?.youspot_id });
            }
          }
        }
      }
      if (apply.conflicts.length)
        this.deps.notify(
          `YouSpot: ${apply.conflicts.length} notes edited in YouSpot. Review the versions in settings.`,
        );
      if (res.brain_limit)
        this.deps.notify(
          `YouSpot: Brain limit reached (${res.brain_limit.count}/${res.brain_limit.cap}).`,
        );
    }
    if (deletes.length) {
      const res = await this.deps.api.deleteNotes(
        this.state.vaultId,
        deletes.map((item) => item.ref),
      );
      for (const [index, item] of deletes.entries()) {
        const result = res.results[index];
        if (result && ["deleted", "already_deleted", "not_found"].includes(result.status)) {
          forgetDeleted(this.state, [item.entry.path]);
          delete this.state.missing?.[item.entry.path];
          delete this.state.failures?.[item.entry.path];
          summary.deleted++;
        } else {
          this.block(item.entry, "The Brain note changed. Review it before removing it.");
          summary.conflicts++;
        }
      }
    }
  }

  pull(): Promise<PullSummary> {
    if (this.refreshing) return Promise.resolve({ written: 0, trashed: 0 });
    if (this.pulling) return this.pulling;
    this.pulling = (async () => {
      if (this.pushing) await this.pushing;
      return this.runPull();
    })().finally(() => {
      this.pulling = null;
      this.deps.onStatus?.();
    });
    return this.pulling;
  }

  private async runPull(): Promise<PullSummary> {
    const summary: PullSummary = { written: 0, trashed: 0 };
    this.state.lastDownloadAttemptAt = this.now;
    if (!this.configured || this.halted || !this.settings.pullEnabled) return summary;
    this.deps.onStatus?.();
    const types: string[] = [];
    const incrementalTypes = new Set(
      this.settings.capabilities?.incremental_types ?? Object.keys(this.settings.exportTypes),
    );
    for (const [type, on] of Object.entries(this.settings.exportTypes)) {
      if (on && incrementalTypes.has(type)) types.push(type);
    }
    if (types.length === 0) return summary;
    try {
      let page = 1;
      let nextSince: string | null = null;
      const objects = [];
      const tombstones = [];
      for (;;) {
        const res = await this.deps.api.changes(this.state.watermark, types, page);
        objects.push(...res.objects);
        tombstones.push(...res.tombstones);
        if (objects.length + tombstones.length > 20_000)
          throw new Error("Use full refresh for this selection.");
        nextSince = res.next_since;
        if (!res.has_more) break;
        page += 1;
      }
      await recoverManaged(this.deps.vault, this.state, this.rules);
      const plan = await planPull(objects, tombstones, this.state, this.settings, this.rules);
      this.state.exportConflicts = [];
      await this.applyPull(plan.actions, summary);
      for (const path of plan.forgetNotes) {
        this.queue.cancel(path);
        const note = this.state.notes[path];
        if (note) {
          this.block(
            { path, kind: "upsert", youspotId: note.youspot_id, attempts: 0 },
            "Removed from Brain. Use Push this note (overwrite server) to restore it deliberately.",
            note.local_hash,
          );
        }
      }
      this.state.serverEdited = plan.serverEdited;
      this.state.watermark = nextSince;
      this.state.lastPullAt = this.now;
      this.state.downloadError = null;
      this.backoffMs = MIN_BACKOFF;
    } catch (err) {
      this.failed(err, "download");
    }
    await this.save();
    if (this.queue.size > 0) this.schedule();
    return summary;
  }

  private async applyPull(actions: PullAction[], summary: PullSummary): Promise<void> {
    for (const action of actions) {
      const existing = this.state.exports[action.objectId];
      const previous = this.deps.vault.stat(action.path)
        ? await this.deps.vault.read(action.path)
        : null;
      if (
        action.kind === "write" &&
        previous !== null &&
        managedIdentity(previous) === action.objectId &&
        (await sha256Hex(previous)) === action.hash
      ) {
        this.state.exports[action.objectId] = {
          ...existing,
          path: action.path,
          type: action.type,
          rendered_hash: action.hash,
          updated_at: action.updatedAt,
        };
        await this.save();
        continue;
      }
      if (
        previous !== null &&
        (!existing || (await sha256Hex(previous)) !== existing.rendered_hash)
      ) {
        (this.state.exportConflicts ??= []).push(action.path);
        continue;
      }
      if (action.kind === "trash") {
        if (previous !== null)
          await this.managedWrite(action.path, () => this.deps.vault.trash(action.path));
        delete this.state.exports[action.objectId];
        summary.trashed += 1;
        continue;
      }
      if (previous !== null && (await sha256Hex(previous)) === action.hash) continue;
      await this.deps.vault.ensureFolder(dirname(action.path));
      let written = false;
      await this.managedWrite(action.path, async () => {
        written = await this.deps.vault.writeGuarded(action.path, action.content, previous);
      });
      if (!written) {
        (this.state.exportConflicts ??= []).push(action.path);
        continue;
      }
      this.state.exports[action.objectId] = {
        path: action.path,
        type: action.type,
        rendered_hash: action.hash,
        updated_at: action.updatedAt,
      };
      summary.written += 1;
      await this.save();
    }
  }

  private async managedWrite(path: string, fn: () => Promise<void>): Promise<void> {
    this.managed.add(path);
    try {
      await fn();
    } finally {
      this.managed.delete(path);
    }
  }

  private discover(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scan(): Promise<void> {
    if (!this.configured || this.halted) return;
    const plan = planReconcile(
      this.deps.vault.listMarkdown().filter((file) => !this.isManaged(file.path)),
      this.state,
      this.rules,
    );
    for (const [index, path] of plan.upserts.entries()) {
      if (this.halted) break;
      if (index > 0 && index % BATCH_SIZE === 0) {
        await new Promise<void>((resolve) => this.setTimer(resolve, 0));
      }
      const content = await this.deps.vault.read(path);
      if (managedIdentity(content)) continue;
      const cache = this.deps.vault.cache(path);
      if (!cache) continue;
      this.observed.add(path);
      const known = this.state.notes[path];
      const hash = await localHash(splitFrontmatter(content).body, cache.frontmatter);
      const failed = this.state.failures?.[path];
      if (failed?.hash === hash || failed?.error.startsWith("Removed from Brain.")) continue;
      if (!known || known.local_hash !== hash) {
        delete this.state.failures?.[path];
        this.queue.upsert(path, { youspotId: known?.youspot_id });
      }
      delete this.state.missing?.[path];
    }
    await this.save();
  }

  async reconcile(): Promise<void> {
    if (!this.configured || this.halted || this.refreshing) return;
    await this.discover();
    try {
      const missing: NonNullable<PluginData["state"]["missing"]> = {};
      let page = 1;
      for (;;) {
        const res = await this.deps.api.inventory(this.state.vaultId, page);
        for (const note of res.notes) {
          if (
            !isSyncable(note.path, this.rules) ||
            this.deps.vault.stat(note.path) ||
            (await this.hasIdentityElsewhere(note.object_id, note.path))
          )
            continue;
          missing[note.path] = {
            objectId: note.object_id,
            path: note.path,
            contentHash: note.content_hash,
            serverEdited: note.server_edited,
            syncedAt: note.synced_at ?? undefined,
          };
        }
        if (page * res.per_page >= res.total) break;
        page++;
      }
      this.state.missing = missing;
    } catch (err) {
      this.failed(err, "upload");
      await this.save();
      return;
    }
    await this.save();
    await this.push();
  }

  async removeMissing(path: string): Promise<PushSummary> {
    const note = this.state.missing?.[path];
    if (
      !note ||
      note.serverEdited ||
      this.deps.vault.exists(path) ||
      (await this.hasIdentityElsewhere(note.objectId, path))
    ) {
      return { pushed: 0, deleted: 0, conflicts: 0, errors: 1, outcome: "failed" };
    }
    this.queue.remove(path, note.objectId, note.contentHash, path, note.syncedAt);
    await this.save();
    return this.push();
  }

  async pullServerVersion(path: string): Promise<string | null> {
    const note = this.state.notes[path];
    if (!note) {
      this.deps.notify("This note has not been synced to YouSpot yet.");
      return null;
    }
    const server = await this.deps.api.note(note.youspot_id);
    const target = conflictPath(path);
    const content = `${emitFrontmatter({
      youspot_id: server.object_id,
      youspot_conflict_of: path,
      title: server.name,
      updated_at: server.updated_at,
    })}\n${server.description ?? ""}\n`;
    await this.managedWrite(target, () => this.deps.vault.write(target, content));
    return target;
  }

  resetState(): void {
    this.state.watermark = null;
    this.state.failures = Object.fromEntries(
      Object.entries(this.state.failures ?? {}).filter(([, failure]) =>
        failure.error.startsWith("Removed from Brain."),
      ),
    );
    this.state.uploadError = null;
    this.state.downloadError = null;
    this.resume();
    this.changed();
  }

  private failed(err: unknown, direction: "upload" | "download" | "refresh"): void {
    const message = err instanceof Error ? err.message : String(err);
    this.state[`${direction}Error`] = message;
    this.state.lastError =
      this.state.uploadError ?? this.state.downloadError ?? this.state.refreshError ?? null;
    if (err instanceof ApiError && err.unauthorized) {
      this.halted = true;
      this.stop();
      this.deps.notify("YouSpot: token rejected. Check the token in settings.");
      return;
    }
    if (err instanceof ApiError && err.retryable) {
      this.backoffUntil = this.now + this.backoffMs;
      this.rearm(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF);
      return;
    }
    this.deps.notify(`YouSpot sync failed: ${message}`);
  }

  private rearm(ms: number): void {
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    this.debounceTimer = this.setTimer(() => void this.flush(), ms);
  }
}
