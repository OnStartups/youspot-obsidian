import { Notice, Plugin, type TAbstractFile, TFile } from "obsidian";
import { ApiClient } from "./api";
import { obsidianHttp } from "./http-obsidian";
import { YouSpotSettingTab } from "./settings";
import { formatStatus } from "./status";
import { SyncEngine } from "./sync/engine";
import { isSyncable } from "./sync/paths";
import { loadPluginData } from "./sync/state";
import type { PluginData } from "./types";
import { ObsidianVault } from "./vault-obsidian";

export default class YouSpotPlugin extends Plugin {
  data!: PluginData;
  api!: ApiClient;
  engine!: SyncEngine;
  accountEmail: string | null = null;
  private statusEl!: HTMLElement;
  private intervalId: number | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  get prefs() {
    return this.data.settings;
  }

  get state() {
    return this.data.state;
  }

  override async onload(): Promise<void> {
    this.data = loadPluginData(await this.loadData());
    await this.saveData(this.data);

    this.api = new ApiClient(obsidianHttp, () => ({
      apiBase: this.prefs.apiBase,
      token: this.prefs.token,
    }));
    this.engine = new SyncEngine({
      vault: new ObsidianVault(this.app),
      api: this.api,
      data: this.data,
      persist: () => this.persist(),
      notify: (message) => new Notice(message),
      onStatus: () => this.renderStatus(),
    });

    this.addSettingTab(new YouSpotSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("youspot-status");
    this.statusEl.addEventListener("click", () => void this.engine.syncNow());
    this.addRibbonIcon("brain", "YouSpot: sync now", () => void this.syncNow());
    this.registerCommands();
    this.registerInterval(window.setInterval(() => this.renderStatus(), 30_000));

    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      this.armInterval();
      void this.boot();
    });
  }

  override onunload(): void {
    this.engine.stop();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      void this.saveData(this.data);
    }
  }

  private async boot(): Promise<void> {
    this.renderStatus();
    if (!this.engine.configured) return;
    try {
      const me = await this.api.me();
      this.accountEmail = me.email;
    } catch {
      this.accountEmail = null;
    }
    await this.engine.reconcile();
    if (this.prefs.pullEnabled) await this.engine.pull();
    this.renderStatus();
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => this.engine.handleChanged(file.path)),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.engine.handleChanged(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.engine.handleDeleted(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) this.engine.handleRenamed(oldPath, file.path);
      }),
    );
  }

  private registerCommands(): void {
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "pull-brain",
      name: "Pull Brain now",
      callback: async () => {
        const summary = await this.engine.pull();
        new Notice(`YouSpot: ${summary.written} written, ${summary.trashed} removed.`);
      },
    });
    this.addCommand({
      id: "reconcile-folder",
      name: "Reconcile folder",
      callback: async () => {
        await this.engine.reconcile();
        new Notice("YouSpot: folder reconciled.");
      },
    });
    this.addCommand({
      id: "push-note",
      name: "Push this note",
      checkCallback: (checking) =>
        this.withActiveNote(checking, (path) => void this.pushNote(path, false)),
    });
    this.addCommand({
      id: "push-note-force",
      name: "Push this note (overwrite server)",
      checkCallback: (checking) =>
        this.withActiveNote(checking, (path) => void this.pushNote(path, true)),
    });
    this.addCommand({
      id: "pull-server-version",
      name: "Pull server version of this note",
      checkCallback: (checking) =>
        this.withActiveNote(checking, async (path) => {
          const target = await this.engine.pullServerVersion(path);
          if (target) new Notice(`YouSpot: server version written to ${target}.`);
        }),
    });
    this.addCommand({
      id: "open-in-youspot",
      name: "Open in YouSpot",
      checkCallback: (checking) => {
        const file = this.activeFile();
        const id = file ? this.objectIdFor(file) : null;
        if (!id) return false;
        if (!checking) {
          window.open(
            `${this.prefs.appBase.replace(/\/+$/, "")}/brain/object/${id}`,
            "_blank",
            "noopener,noreferrer",
          );
        }
        return true;
      },
    });
    this.addCommand({
      id: "reset-sync-state",
      name: "Reset sync state",
      callback: () => void this.resetSyncState(),
    });
  }

  private activeFile(): TFile | null {
    return this.app.workspace.getActiveFile();
  }

  private objectIdFor(file: TFile): string | null {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const id = fm?.youspot_id;
    if (typeof id === "string" && id) return id;
    return this.state.notes[file.path]?.youspot_id ?? null;
  }

  private withActiveNote(checking: boolean, fn: (path: string) => void | Promise<void>): boolean {
    const file = this.activeFile();
    if (!file || !isSyncable(file.path, this.engine.rules)) return false;
    if (!checking) void fn(file.path);
    return true;
  }

  private async pushNote(path: string, force: boolean): Promise<void> {
    const summary = await this.engine.pushNote(path, force);
    if (summary.conflicts === 0 && summary.errors === 0) new Notice("YouSpot: note pushed.");
  }

  private async syncNow(): Promise<void> {
    if (!this.engine.configured) {
      new Notice("YouSpot: add a token and choose a sync folder in settings first.");
      return;
    }
    this.engine.resume();
    await this.engine.syncNow();
    this.renderStatus();
  }

  async resetSyncState(): Promise<void> {
    this.engine.resetState();
    await this.saveData(this.data);
    this.renderStatus();
    new Notice("YouSpot: sync state reset.");
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.data);
    this.armInterval();
    this.renderStatus();
  }

  private persist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.saveData(this.data);
    }, 500);
  }

  private armInterval(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    const minutes = this.prefs.syncIntervalMinutes;
    if (minutes <= 0) return;
    this.intervalId = window.setInterval(() => void this.engine.syncNow(), minutes * 60_000);
    this.registerInterval(this.intervalId);
  }

  private renderStatus(): void {
    if (!this.statusEl) return;
    const text = formatStatus({
      configured: this.engine.configured,
      pending: this.engine.queue.size,
      running: this.engine.running,
      lastPushAt: this.state.lastPushAt,
      lastPullAt: this.state.lastPullAt,
      error: this.state.lastError,
      serverEdited: this.state.serverEdited.length,
      conflicts: this.engine.conflicts,
      now: Date.now(),
    });
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-error", Boolean(this.state.lastError));
  }
}
