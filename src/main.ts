import { addIcon, Notice, Plugin, type TAbstractFile, TFile } from "obsidian";
import { ApiClient } from "./api";
import { ICON_ID, ICON_SVG } from "./icon";
import { obsidianHttp } from "./http-obsidian";
import { YouSpotSettingTab } from "./settings";
import { formatStatus } from "./status";
import { SyncEngine } from "./sync/engine";
import { isSyncable } from "./sync/paths";
import { discoverExports } from "./sync/refresh";
import { applyCapabilities, emptyState } from "./sync/state";
import { canonicalJSON } from "./sync/frontmatter";
import { IndexedLocalStore, PluginStorage, localClientId, sharedSettings } from "./storage";
import type { PluginData } from "./types";
import { ObsidianVault } from "./vault-obsidian";

export default class YouSpotPlugin extends Plugin {
  data!: PluginData;
  api!: ApiClient;
  engine!: SyncEngine;
  accountEmail: string | null = null;
  private settingsTab!: YouSpotSettingTab;
  private statusEl!: HTMLElement;
  private intervalId: number | null = null;
  private storage!: PluginStorage;
  private transitions: Promise<void> = Promise.resolve();
  private closed = false;

  get prefs() {
    return this.data.settings;
  }

  get state() {
    return this.data.state;
  }

  override async onload(): Promise<void> {
    const clientId = localClientId(
      () => this.app.loadLocalStorage("youspot-client-id"),
      (id) => this.app.saveLocalStorage("youspot-client-id", id),
    );
    this.storage = new PluginStorage(
      new IndexedLocalStore(clientId),
      this.app.secretStorage,
      () => this.loadData(),
      (data) => this.saveData(data),
      clientId,
    );
    this.data = await this.storage.load();

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
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
    });

    this.engine.pause();
    this.settingsTab = new YouSpotSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("youspot-status");
    this.statusEl.addEventListener("click", () => void this.run(() => this.syncNow()));
    addIcon(ICON_ID, ICON_SVG);
    this.addRibbonIcon(ICON_ID, "YouSpot: sync now", () => void this.run(() => this.syncNow()));
    this.registerCommands();
    this.registerInterval(window.setInterval(() => this.renderStatus(), 30_000));

    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      this.armInterval();
      void this.run(() => this.boot());
    });
  }

  override onunload(): void {
    this.closed = true;
    if (this.engine)
      void this.engine
        .suspend()
        .catch((error: unknown) => console.error(error))
        .finally(() => this.storage.local.close());
  }

  override onExternalSettingsChange(): void {
    if (!this.storage || !this.engine) return;
    void this.run(() =>
      this.transition(async () => {
        const incoming = await this.storage.external();
        if (
          incoming.vaultId === this.state.vaultId &&
          canonicalJSON(incoming.settings) === canonicalJSON(sharedSettings(this.prefs))
        )
          return;
        await this.engine.suspend();
        this.data.settings = { ...this.prefs, ...incoming.settings };
        this.storage.unbind();
        this.data.state = emptyState(incoming.vaultId);
        await this.connect();
        this.settingsTab.update();
      }),
    );
  }

  private transition(fn: () => Promise<void>): Promise<void> {
    this.transitions = this.transitions
      .catch(() => undefined)
      .then(async () => {
        if (!this.closed) await fn();
      });
    return this.transitions;
  }

  async run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.engine?.pause();
      const message = error instanceof Error ? error.message : "Sync could not finish.";
      this.data.state.uploadError = message;
      this.data.state.lastError = message;
      new Notice(`YouSpot: ${message}`);
      console.error(error);
      await this.persist().catch((failure: unknown) => console.error(failure));
    }
    this.renderStatus();
    this.settingsTab.update();
  }

  private async connect(): Promise<void> {
    this.accountEmail = null;
    if (!this.engine.configured || this.closed) {
      this.storage.unbind();
      await this.persist();
      return;
    }
    const me = await this.api.me();
    await this.storage.bind(this.data, me.email);
    this.accountEmail = me.email;
    this.engine.reloadState();
    await discoverExports({
      vault: new ObsidianVault(this.app),
      api: this.api,
      data: this.data,
      persist: () => this.persist(),
      notify: (message) => new Notice(message),
    });
    const incoming = await this.storage.external();
    const selection = { ...this.prefs, ...incoming.settings };
    applyCapabilities(selection, this.prefs.capabilities!);
    await this.storage.preferences({
      exportTypes: selection.exportTypes,
      exportSpaceId: selection.exportSpaceId,
      selectionInitialized: selection.selectionInitialized,
    });
    this.data.settings = {
      ...this.prefs,
      exportTypes: selection.exportTypes,
      exportSpaceId: selection.exportSpaceId,
      selectionInitialized: selection.selectionInitialized,
    };
    this.engine.resume();
    this.armInterval();
    await this.engine.reconcile();
  }

  private async boot(): Promise<void> {
    await this.transition(() => this.connect());
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
      callback: () => void this.run(() => this.syncNow()),
    });
    this.addCommand({
      id: "refresh-brain-export",
      name: "Full refresh Brain export",
      callback: () =>
        void this.run(async () => {
          await this.engine.refresh();
          await this.engine.push();
        }),
    });
    this.addCommand({
      id: "pull-brain",
      name: "Pull Brain now",
      callback: () =>
        void this.run(async () => {
          const summary = await this.engine.pull();
          new Notice(
            this.state.downloadError
              ? "YouSpot: download needs attention."
              : `YouSpot: ${summary.written} written, ${summary.trashed} removed.`,
          );
        }),
    });
    this.addCommand({
      id: "reconcile-folder",
      name: "Reconcile folder",
      callback: () =>
        void this.run(async () => {
          await this.engine.reconcile();
          new Notice("YouSpot: folder rescanned. Review missing notes in settings.");
        }),
    });
    this.addCommand({
      id: "push-note",
      name: "Push this note",
      checkCallback: (checking) =>
        this.withActiveNote(checking, (path) => void this.run(() => this.pushNote(path, false))),
    });
    this.addCommand({
      id: "push-note-force",
      name: "Push this note (overwrite server)",
      checkCallback: (checking) =>
        this.withActiveNote(checking, (path) => void this.run(() => this.pushNote(path, true))),
    });
    this.addCommand({
      id: "pull-server-version",
      name: "Pull server version of this note",
      checkCallback: (checking) =>
        this.withActiveNote(
          checking,
          (path) =>
            void this.run(async () => {
              const target = await this.engine.pullServerVersion(path);
              if (target) new Notice(`YouSpot: server version written to ${target}.`);
            }),
        ),
    });
    this.addCommand({
      id: "open-object",
      name: "Open this note's object in the browser",
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
      callback: () => void this.run(() => this.resetSyncState()),
    });
  }

  private activeFile(): TFile | null {
    return this.app.workspace.getActiveFile();
  }

  private objectIdFor(file: TFile): string | null {
    const fm: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const id = fm && typeof fm === "object" ? (fm as Record<string, unknown>).youspot_id : null;
    if (typeof id === "string" && id) return id;
    return this.state.notes[file.path]?.youspot_id ?? null;
  }

  private withActiveNote(checking: boolean, fn: (path: string) => void | Promise<void>): boolean {
    const file = this.activeFile();
    if (!file || !isSyncable(file.path, this.engine.rules)) return false;
    if (!checking) void fn(file.path);
    return true;
  }

  async pushNote(path: string, force: boolean): Promise<void> {
    if (!this.accountEmail) await this.transition(() => this.connect());
    this.engine.resume();
    const summary = await this.engine.pushNote(path, force);
    new Notice(
      summary.outcome === "completed"
        ? `YouSpot: ${summary.pushed} notes acknowledged.`
        : summary.outcome === "no_change"
          ? "YouSpot: this note is already current."
          : summary.outcome === "deferred"
            ? "YouSpot: upload is pending."
            : "YouSpot: upload needs attention. See the failed notes in settings.",
    );
  }

  async syncNow(): Promise<void> {
    if (!this.engine.configured) {
      new Notice("YouSpot: add a token and choose a sync folder in settings first.");
      return;
    }
    if (!this.accountEmail) await this.transition(() => this.connect());
    this.engine.resume();
    await this.engine.syncNow();
    this.renderStatus();
  }

  async resetSyncState(): Promise<void> {
    await this.engine.suspend();
    this.engine.resetState();
    await this.persist();
    await this.engine.reconcile();
    this.renderStatus();
    new Notice("YouSpot: originals rescanned. Managed exports and Brain notes were preserved.");
  }

  async updateSettings(patch: Partial<PluginData["settings"]>): Promise<void> {
    await this.transition(async () => {
      await this.engine.suspend();
      if ("token" in patch) this.storage.token(patch.token ?? "");
      const incoming = await this.storage.preferences(patch);
      this.data.settings = {
        ...this.prefs,
        ...incoming.settings,
        ...Object.fromEntries(
          ["token", "apiBase", "appBase"]
            .filter((key) => key in patch)
            .map((key) => [key, patch[key as keyof typeof patch]]),
        ),
      };
      this.storage.unbind();
      this.data.state = emptyState(incoming.vaultId);
      await this.persist();
      await this.connect();
      this.settingsTab.update();
      this.renderStatus();
    });
  }

  private persist(): Promise<void> {
    return this.storage.save(this.data);
  }

  private armInterval(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    const minutes = this.prefs.syncIntervalMinutes;
    if (minutes <= 0) return;
    this.intervalId = window.setInterval(
      () => void this.run(() => this.engine.syncNow()),
      minutes * 60_000,
    );
    this.registerInterval(this.intervalId);
  }

  private renderStatus(): void {
    if (!this.statusEl) return;
    this.settingsTab?.updateStatus();
    const text = formatStatus({
      setup: this.engine.setup,
      pending: this.engine.queue.size,
      running: this.engine.running,
      lastPushAt: this.state.lastPushAt,
      lastPullAt: this.state.lastPullAt,
      error: this.state.lastError,
      uploadError: this.state.uploadError,
      downloadError: this.state.downloadError,
      failed: this.engine.failedCount,
      serverEdited: this.state.serverEdited.length,
      conflicts: this.engine.conflicts,
      now: Date.now(),
    });
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-error", Boolean(this.state.lastError));
  }
}
