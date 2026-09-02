import { ApiError, type ApiClient } from "../api";
import type { DeleteRef, PathRules, PluginData, PushNote } from "../types";
import type { VaultPort } from "../vault-port";
import { emitFrontmatter, splitFrontmatter } from "./frontmatter";
import { localHash } from "./hash";
import { conflictPath, dirname, isExport, isSyncable } from "./paths";
import { buildNotePayload } from "./payload";
import { type PullAction, planPull } from "./pull";
import { applyPushResults, forgetDeleted } from "./push";
import { BATCH_SIZE, ChangeQueue, type QueueEntry } from "./queue";
import { planReconcile } from "./scan";

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
}

export interface PushSummary {
  pushed: number;
  deleted: number;
  conflicts: number;
  errors: number;
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
  private dirty = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = MIN_BACKOFF;
  private backoffUntil = 0;
  private halted = false;

  constructor(private readonly deps: EngineDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
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

  get configured(): boolean {
    return Boolean(this.settings.token && this.settings.syncFolder);
  }

  get running(): boolean {
    return this.pushing !== null || this.pulling !== null;
  }

  get conflicts(): number {
    return Object.values(this.state.notes).filter((n) => n.conflict).length;
  }

  resume(): void {
    this.halted = false;
    this.backoffMs = MIN_BACKOFF;
    this.backoffUntil = 0;
    this.state.lastError = null;
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
  }

  handleChanged(path: string): void {
    if (this.managed.has(path) || !isSyncable(path, this.rules)) return;
    this.queue.upsert(path, { youspotId: this.state.notes[path]?.youspot_id });
    this.schedule();
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
    this.queue.remove(path, this.state.notes[path]?.youspot_id);
    this.schedule();
  }

  handleRenamed(from: string, to: string): void {
    if (this.managed.has(from) || this.managed.has(to)) return;
    const rules = this.rules;
    if (isExport(from, rules)) {
      for (const entry of Object.values(this.state.exports)) {
        if (entry.path === from) entry.path = to;
      }
      if (!isSyncable(to, rules)) return;
    }
    const fromSyncable = isSyncable(from, rules);
    const toSyncable = isSyncable(to, rules);
    if (fromSyncable && toSyncable) {
      const note = this.state.notes[from];
      if (note) {
        delete this.state.notes[from];
        this.state.notes[to] = { ...note, local_hash: "" };
      }
      this.queue.rename(from, to, note?.youspot_id);
      this.schedule();
      return;
    }
    if (fromSyncable) {
      this.handleDeleted(from);
      return;
    }
    if (toSyncable) this.handleChanged(to);
  }

  private schedule(): void {
    this.deps.onStatus?.();
    if (!this.configured || !this.settings.syncOnSave) return;
    const debounce = this.deps.debounceMs ?? 3_000;
    const maxWait = this.deps.maxWaitMs ?? 15_000;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), debounce);
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => void this.flush(), maxWait);
    }
  }

  private async flush(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    await this.push();
  }

  async syncNow(): Promise<void> {
    await this.push();
    if (this.settings.pullEnabled) await this.pull();
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
    if (!isSyncable(path, this.rules)) {
      this.deps.notify("This note is outside the YouSpot sync folder.");
      return { pushed: 0, deleted: 0, conflicts: 0, errors: 0 };
    }
    const note = this.state.notes[path];
    if (force && note) delete note.conflict;
    this.queue.upsert(path, { youspotId: note?.youspot_id, force });
    return this.push();
  }

  private async runPush(): Promise<PushSummary> {
    const summary: PushSummary = { pushed: 0, deleted: 0, conflicts: 0, errors: 0 };
    if (!this.configured || this.halted) return summary;
    if (this.now < this.backoffUntil) {
      this.rearm(this.backoffUntil - this.now);
      return summary;
    }
    this.deps.onStatus?.();
    while (this.queue.size > 0) {
      const entries = this.queue.drain(BATCH_SIZE);
      try {
        await this.pushBatch(entries, summary);
        this.backoffMs = MIN_BACKOFF;
      } catch (err) {
        this.queue.restore(entries);
        this.failed(err);
        break;
      }
    }
    await this.deps.persist();
    return summary;
  }

  private async pushBatch(entries: QueueEntry[], summary: PushSummary): Promise<void> {
    const notes: PushNote[] = [];
    const hashes = new Map<string, string>();
    const deletes: { path: string; ref: DeleteRef }[] = [];
    const exportsByPath = new Map<string, string>();
    for (const [id, entry] of Object.entries(this.state.exports)) exportsByPath.set(entry.path, id);

    const upserts: { entry: QueueEntry; mtime: number }[] = [];
    for (const entry of entries) {
      const meta = this.deps.vault.stat(entry.path);
      if (entry.kind === "delete" || !meta) {
        const id = entry.youspotId ?? this.state.notes[entry.path]?.youspot_id;
        if (id) deletes.push({ path: entry.path, ref: { youspot_id: id } });
        continue;
      }
      upserts.push({ entry, mtime: meta.mtime });
    }

    const read = await Promise.all(
      upserts.map(async ({ entry, mtime }) => {
        const content = await this.deps.vault.read(entry.path);
        const { body } = splitFrontmatter(content);
        const cache = this.deps.vault.cache(entry.path);
        const frontmatter = cache?.frontmatter ?? null;
        return {
          entry,
          mtime,
          body,
          frontmatter,
          tags: cache?.tags ?? [],
          hash: await localHash(body, frontmatter),
        };
      }),
    );

    for (const item of read) {
      const { entry } = item;
      const known = this.state.notes[entry.path];
      if (known && known.local_hash === item.hash && !known.conflict && !entry.force) continue;
      const note = buildNotePayload({
        path: entry.path,
        body: item.body,
        frontmatter: item.frontmatter,
        tags: item.tags,
        links: this.deps.vault.resolvedLinks(entry.path),
        mtime: item.mtime,
        youspotId: entry.youspotId ?? known?.youspot_id,
        rules: this.rules,
        exportsByPath,
      });
      if (entry.force) note.force = true;
      notes.push(note);
      hashes.set(entry.path, item.hash);
    }

    if (notes.length) {
      const res = await this.deps.api.push({
        vault_id: this.state.vaultId,
        vault_name: this.deps.vault.vaultName(),
        notes,
      });
      const apply = applyPushResults(this.state, res.results, hashes, this.now);
      summary.pushed += apply.applied;
      summary.conflicts += apply.conflicts.length;
      summary.errors += apply.errors.length;
      await Promise.all(
        apply.stamps.map((stamp) =>
          this.deps.vault.stampFrontmatter(stamp.path, "youspot_id", stamp.youspotId),
        ),
      );
      const byPath = new Map(entries.map((e) => [e.path, e]));
      for (const error of apply.errors) {
        const entry = byPath.get(error.path);
        if (entry && error.error !== "brain_limit_reached") this.queue.requeue(entry);
      }
      if (apply.conflicts.length) {
        this.deps.notify(
          `YouSpot: ${apply.conflicts.length} note${apply.conflicts.length === 1 ? "" : "s"} edited in YouSpot since the last sync. Use "Push this note (overwrite server)" or "Pull server version".`,
        );
      }
      if (res.brain_limit) {
        this.deps.notify(
          `YouSpot: Brain limit reached (${res.brain_limit.count}/${res.brain_limit.cap}).`,
        );
      }
      this.state.lastPushAt = this.now;
    }

    if (deletes.length) {
      await this.deps.api.deleteNotes(
        this.state.vaultId,
        deletes.map((d) => d.ref),
      );
      forgetDeleted(
        this.state,
        deletes.map((d) => d.path),
      );
      summary.deleted += deletes.length;
      this.state.lastPushAt = this.now;
    }
    this.state.lastError = null;
  }

  pull(): Promise<PullSummary> {
    if (this.pulling) return this.pulling;
    this.pulling = this.runPull().finally(() => {
      this.pulling = null;
      this.deps.onStatus?.();
    });
    return this.pulling;
  }

  private async runPull(): Promise<PullSummary> {
    const summary: PullSummary = { written: 0, trashed: 0 };
    if (!this.configured || this.halted || !this.settings.pullEnabled) return summary;
    this.deps.onStatus?.();
    const types: string[] = [];
    for (const [type, on] of Object.entries(this.settings.exportTypes)) {
      if (on) types.push(type);
    }
    if (types.length === 0) return summary;
    try {
      let page = 1;
      let nextSince: string | null = null;
      const serverEdited = new Set<string>();
      for (;;) {
        const res = await this.deps.api.changes(this.state.watermark, types, page);
        const plan = await planPull(
          res.objects,
          res.tombstones,
          this.state,
          this.settings,
          this.rules,
        );
        for (const id of plan.serverEdited) serverEdited.add(id);
        await this.applyPull(plan.actions, summary);
        forgetDeleted(this.state, plan.forgetNotes);
        for (const path of plan.forgetNotes) this.queue.upsert(path);
        nextSince = res.next_since;
        if (!res.has_more) break;
        page += 1;
      }
      this.state.serverEdited = Array.from(serverEdited);
      this.state.watermark = nextSince;
      this.state.lastPullAt = this.now;
      this.state.lastError = null;
      this.backoffMs = MIN_BACKOFF;
    } catch (err) {
      this.failed(err);
    }
    await this.deps.persist();
    if (this.queue.size > 0) this.schedule();
    return summary;
  }

  private async applyPull(actions: PullAction[], summary: PullSummary): Promise<void> {
    for (const action of actions) {
      if (action.kind === "trash") {
        await this.managedWrite(action.path, () => this.deps.vault.trash(action.path));
        delete this.state.exports[action.objectId];
        summary.trashed += 1;
        continue;
      }
      await this.deps.vault.ensureFolder(dirname(action.path));
      if (action.previousPath && this.deps.vault.stat(action.previousPath)) {
        this.managed.add(action.path);
        await this.managedWrite(action.previousPath, () =>
          this.deps.vault.rename(action.previousPath as string, action.path),
        );
        this.managed.delete(action.path);
      }
      await this.managedWrite(action.path, () =>
        this.deps.vault.write(action.path, action.content),
      );
      this.state.exports[action.objectId] = {
        path: action.path,
        type: action.type,
        rendered_hash: action.hash,
        updated_at: action.updatedAt,
      };
      summary.written += 1;
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

  async reconcile(): Promise<void> {
    if (!this.configured || this.halted) return;
    const plan = planReconcile(this.deps.vault.listMarkdown(), this.state, this.rules);
    for (const path of plan.upserts) {
      this.queue.upsert(path, { youspotId: this.state.notes[path]?.youspot_id });
    }
    for (const gone of plan.deletes) this.queue.remove(gone.path, gone.youspotId);
    try {
      let page = 1;
      for (;;) {
        const res = await this.deps.api.inventory(this.state.vaultId, page);
        for (const note of res.notes) {
          if (this.deps.vault.stat(note.path)) continue;
          if (this.state.notes[note.path]) continue;
          this.queue.remove(note.path, note.object_id);
        }
        if (page * res.per_page >= res.total) break;
        page += 1;
      }
    } catch (err) {
      this.failed(err);
      return;
    }
    await this.push();
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
    this.queue.clear();
    const { vaultId } = this.state;
    this.deps.data.state = {
      vaultId,
      notes: {},
      exports: {},
      watermark: null,
      lastPushAt: null,
      lastPullAt: null,
      lastError: null,
      serverEdited: [],
    };
    this.resume();
  }

  private failed(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.state.lastError = message;
    if (err instanceof ApiError && err.unauthorized) {
      this.halted = true;
      this.stop();
      this.deps.notify("YouSpot: token rejected. Check the token in settings.");
      return;
    }
    if (err instanceof ApiError && err.disabled) {
      this.halted = true;
      this.stop();
      this.deps.notify("YouSpot: sync is not enabled on this account yet.");
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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), ms);
  }
}
