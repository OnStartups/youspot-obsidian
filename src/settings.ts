import {
  type App,
  apiVersion,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
} from "obsidian";
import { diagnosticSummary } from "./diagnostics";
import { relativeTime, setupOf } from "./status";
import { FolderSuggest } from "./folder-suggest";
import type YouSpotPlugin from "./main";
import { DEFAULT_SETTINGS, applyCapabilities } from "./sync/state";
import type { YouSpotSettings } from "./types";

export { DEFAULT_SETTINGS };

const PLUGIN_PAGE = "https://community.obsidian.md/plugins/youspot";

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly body: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Confirm")
          .setDestructive()
          .onClick(() => {
            this.onConfirm();
            this.close();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export class YouSpotSettingTab extends PluginSettingTab {
  private healthSetting?: Setting;
  private failuresSetting?: Setting;
  private missingSetting?: Setting;
  private statusSignature = "";
  constructor(
    app: App,
    private readonly plugin: YouSpotPlugin,
  ) {
    super(app, plugin);
  }

  private get prefs(): YouSpotSettings {
    return this.plugin.prefs;
  }

  updateStatus(): void {
    const state = this.plugin.state;
    const signature = JSON.stringify([
      Math.floor(Date.now() / 60_000),
      state.lastPushAt,
      state.lastPullAt,
      state.lastUploadAttemptAt,
      state.lastUploadCheckAt,
      state.pending?.length,
      Object.keys(state.notes).length,
      Object.keys(state.exports).length,
      state.failures,
      state.missing,
      state.uploadError,
      state.downloadError,
      state.refreshError,
    ]);
    if (signature === this.statusSignature) return;
    this.statusSignature = signature;
    for (const [setting, render] of [
      [this.healthSetting, (item: Setting) => this.renderHealth(item)],
      [this.failuresSetting, (item: Setting) => this.renderFailures(item)],
      [this.missingSetting, (item: Setting) => this.renderMissing(item)],
    ] as const) {
      if (!setting?.settingEl.isConnected) continue;
      setting.descEl.empty();
      setting.controlEl.empty();
      render(setting);
    }
  }

  override getControlValue(key: string): unknown {
    if (key.startsWith("export:")) {
      return this.prefs.exportTypes[key.slice("export:".length)] === true;
    }
    return this.prefs[key as keyof YouSpotSettings];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const patch = key.startsWith("export:")
      ? {
          exportTypes: { ...this.prefs.exportTypes, [key.slice("export:".length)]: Boolean(value) },
        }
      : { [key]: value };
    await this.plugin.run(() => this.plugin.updateSettings(patch));
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "Account",
        items: [
          {
            name: "Token",
            desc: "Create a token on the YouSpot Obsidian integration page, paste it here, and save the connection on this installation.",
            aliases: ["api key", "connect", "sign in"],
            render: (setting) => this.renderToken(setting),
          },
          {
            name: "Local connection",
            desc: "The token is kept in Obsidian secret storage on this installation. It is not written to the shared plugin data file.",
            aliases: ["secret", "security"],
          },
          {
            name: "API base",
            desc: `Where the plugin talks to. Default ${DEFAULT_SETTINGS.apiBase}.`,
            control: { type: "text", key: "apiBase", defaultValue: DEFAULT_SETTINGS.apiBase },
          },
          {
            name: "App base",
            desc: `Used when opening an object in the browser. Default ${DEFAULT_SETTINGS.appBase}.`,
            control: { type: "text", key: "appBase", defaultValue: DEFAULT_SETTINGS.appBase },
          },
        ],
      },
      {
        type: "group",
        heading: "Folders",
        items: [
          {
            name: "Sync folder",
            desc: "Only notes inside this folder go to YouSpot. Sync is off until one is chosen.",
            aliases: ["vault folder", "which notes"],
            render: (setting) => this.renderSyncFolder(setting),
          },
          {
            name: "Export folder",
            desc: "Inside the sync folder. Brain objects are written here and never pushed back.",
            control: {
              type: "text",
              key: "exportFolder",
              defaultValue: DEFAULT_SETTINGS.exportFolder,
              validate: (value) =>
                String(value).includes("..") ? "Must be a folder name, not a path." : undefined,
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Sync",
        items: [
          {
            name: "Sync on save",
            desc: "Push a note a few seconds after it changes.",
            control: { type: "toggle", key: "syncOnSave" },
          },
          {
            name: "Sync interval (minutes)",
            desc: "Background push and pull. 0 disables the interval.",
            control: {
              type: "number",
              key: "syncIntervalMinutes",
              defaultValue: DEFAULT_SETTINGS.syncIntervalMinutes,
              validate: (value) => (Number(value) < 0 ? "Cannot be negative." : undefined),
            },
          },
          {
            name: "Pull Brain objects",
            desc: "Write YouSpot objects into the export folder as Markdown.",
            aliases: ["contacts", "companies", "export"],
            control: { type: "toggle", key: "pullEnabled" },
          },
        ],
      },
      {
        type: "group",
        heading: "Full Brain export",
        items: [
          {
            name: "Discover export options",
            desc: "Load supported types, fields and limits from your account. Newly supported types stay off until selected.",
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText("Reload options").onClick(async () => {
                  try {
                    await this.plugin.api.me();
                    const next = { ...this.prefs, exportTypes: { ...this.prefs.exportTypes } };
                    applyCapabilities(next, await this.plugin.api.capabilities());
                    await this.plugin.updateSettings({
                      exportTypes: next.exportTypes,
                      exportSpaceId: next.exportSpaceId,
                      selectionInitialized: next.selectionInitialized,
                    });
                    this.update();
                  } catch (error) {
                    await this.plugin.run(async () => {
                      throw error;
                    });
                  }
                }),
              );
            },
          },
          {
            name: "Brain",
            desc: "Full refresh exports one Brain you own. Background note sync still uses your active Brain.",
            render: (setting) => {
              setting.addDropdown((dropdown) => {
                for (const space of this.prefs.capabilities?.spaces ?? [])
                  dropdown.addOption(space.id, space.name);
                dropdown.setValue(this.prefs.exportSpaceId).onChange(async (value) => {
                  await this.plugin.run(() => this.plugin.updateSettings({ exportSpaceId: value }));
                });
              });
            },
          },
          {
            name: "Attachments",
            render: (setting) => {
              setting.addDropdown((dropdown) =>
                dropdown
                  .addOption("none", "Text only")
                  .addOption("available", "Include available attachments")
                  .setValue(this.prefs.attachments)
                  .onChange(async (value) => {
                    await this.plugin.run(() =>
                      this.plugin.updateSettings({
                        attachments: value === "available" ? "available" : "none",
                      }),
                    );
                  }),
              );
            },
          },
          {
            name: "Full refresh",
            desc: "Capture all selected content using the shared Brain exporter. Existing originals and local edits are preserved. Rich exports update on full refresh; background sync does not replace them. Full refresh uses the same selection limits as downloadable Brain archives.",
            render: (setting) => {
              setting.addButton((button) =>
                button
                  .setButtonText(this.plugin.state.refresh ? "Continue refresh" : "Full refresh")
                  .onClick(
                    () =>
                      void this.plugin.run(async () => {
                        await this.plugin.engine.refresh();
                        await this.plugin.engine.push();
                      }),
                  ),
              );
              if (this.plugin.state.refresh)
                setting.addButton((button) =>
                  button.setButtonText("Cancel refresh").onClick(async () => {
                    try {
                      await this.plugin.engine.cancelRefresh();
                      this.update();
                    } catch (error) {
                      new Notice(String(error));
                    }
                  }),
                );
            },
          },
          {
            name: "Last refresh report",
            render: (setting) => {
              const report = this.plugin.state.refreshReport;
              if (!report) {
                setting.setDesc("No full refresh completed yet.");
                return;
              }
              setting.setDesc(
                `Documents written: ${report.written}. Already current: ${report.current ?? 0}. Originals recognized in this selection: ${report.originals}. Attachments: ${report.assets}. Conflicts: ${report.conflicts.length}.`,
              );
              for (const conflict of report.conflicts)
                setting.descEl.createEl("p", { text: `${conflict.path}: ${conflict.reason}` });
              setting.descEl.createEl("p", {
                text: `${Number(report.coverage.assets_missing ?? 0)} unavailable attachments; ${Number(report.coverage.assets_excluded ?? 0)} attachments excluded by your selection; ${Number(report.coverage.omitted_relationships ?? 0)} relationships outside the selection.`,
              });
              const warnings = report.coverage.warnings as Record<string, number> | undefined;
              for (const [code, count] of Object.entries(warnings ?? {}))
                setting.descEl.createEl("p", { text: `${code.replaceAll("_", " ")}: ${count}.` });
              const exclusions = report.coverage.excluded_types as
                | Record<string, { count: number; reason: string }>
                | undefined;
              for (const [type, item] of Object.entries(exclusions ?? {}))
                setting.descEl.createEl("p", {
                  text: `${type.replaceAll("_", " ")}: ${item.count} excluded. ${item.reason}`,
                });
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Exported types",
        items: (this.prefs.capabilities?.types ?? [])
          .filter((item) => ["document", "context"].includes(item.classification))
          .map((item) => ({
            name: item.label,
            desc: [
              item.reason,
              Object.keys(item.fields).length
                ? `Fields: ${Object.keys(item.fields).join(", ")}.`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
            control: { type: "toggle" as const, key: `export:${item.type}` },
          })),
      },
      {
        type: "group",
        heading: "Sync health and recovery",
        items: [
          {
            name: "Uploads and downloads",
            render: (setting) => {
              this.healthSetting = setting;
              this.renderHealth(setting);
            },
          },
          {
            name: "Failed originals",
            render: (setting) => {
              this.failuresSetting = setting;
              this.renderFailures(setting);
            },
          },
          {
            name: "Missing originals",
            render: (setting) => {
              this.missingSetting = setting;
              this.renderMissing(setting);
            },
          },
          {
            name: "Copy diagnostic summary",
            desc: "Includes selected folder names, versions, counts and error codes. No tokens or note contents are included.",
            render: (setting) =>
              setting.addButton((button) =>
                button.setButtonText("Copy diagnostics").onClick(
                  () =>
                    void this.plugin.run(async () => {
                      await navigator.clipboard.writeText(
                        diagnosticSummary(
                          this.plugin.data,
                          apiVersion,
                          this.plugin.manifest.version,
                        ),
                      );
                      new Notice("YouSpot: diagnostic summary copied.");
                    }),
                ),
              ),
          },
        ],
      },
      {
        type: "group",
        heading: "Repair",
        items: [
          {
            name: "Vault ID",
            desc: "Identifies this vault to YouSpot. Kept across resets.",
            render: (setting) => {
              setting.addText((t) => t.setValue(this.plugin.state.vaultId).setDisabled(true));
            },
          },
          {
            name: "Rescan and retry originals",
            desc: "Re-scan original notes. Managed export hashes and pending refresh progress are kept to protect local files.",
            render: (setting) => {
              setting.addButton((b) =>
                b
                  .setButtonText("Rescan")
                  .onClick(() =>
                    new ConfirmModal(
                      this.app,
                      "Rescan original notes?",
                      "Notes in YouSpot are kept. Original notes will be re-scanned; existing managed exports remain protected.",
                      () => void this.plugin.run(() => this.plugin.resetSyncState()),
                    ).open(),
                  ),
              );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Getting started",
        items: [
          {
            name: "How to connect",
            searchable: false,
            render: (setting) => this.renderHelp(setting),
          },
        ],
      },
    ];
  }

  private renderToken(setting: Setting): void {
    setting.setClass("youspot-token-row");
    setting.descEl.createEl("p", {
      cls: "youspot-settings-account",
      text: this.plugin.accountEmail
        ? `Connected as ${this.plugin.accountEmail}`
        : setupOf(this.prefs) === "needs-folder"
          ? "Token saved. Choose a sync folder below to finish connecting."
          : "Not connected on this installation.",
    });
    let draft = this.prefs.token;
    setting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.addClass("youspot-wide-input");
      text
        .setPlaceholder("mcp_…")
        .setValue(draft)
        .onChange((value) => {
          draft = value.trim();
        });
    });
    setting.addButton((button) =>
      button
        .setButtonText("Save and connect")
        .onClick(() => void this.plugin.run(() => this.plugin.updateSettings({ token: draft }))),
    );
    setting.addButton((button) =>
      button
        .setButtonText("Disconnect")
        .onClick(() => void this.plugin.run(() => this.plugin.updateSettings({ token: "" }))),
    );
  }

  private renderHealth(setting: Setting): void {
    const state = this.plugin.state;
    const ago = (value: number | null | undefined) =>
      value ? relativeTime(value, Date.now()) : "never";
    for (const text of [
      `Last acknowledged upload: ${ago(state.lastPushAt)}. Last upload attempt: ${ago(state.lastUploadAttemptAt)}.`,
      `Last successful upload check: ${ago(state.lastUploadCheckAt)}. Pending originals: ${state.pending?.length ?? 0}.`,
      `Last successful download: ${ago(state.lastPullAt)}.`,
      `Tracked originals: ${Object.keys(state.notes).length}. Managed export baselines: ${Object.keys(state.exports).length}.`,
      state.uploadError ? `Upload needs attention: ${state.uploadError}` : "",
      state.downloadError ? `Download needs attention: ${state.downloadError}` : "",
      state.refreshError ? `Full refresh needs attention: ${state.refreshError}` : "",
    ].filter(Boolean))
      setting.descEl.createEl("p", { text });
    setting.addButton((button) =>
      button
        .setButtonText("Sync now")
        .onClick(() => void this.plugin.run(() => this.plugin.syncNow())),
    );
  }

  private renderFailures(setting: Setting): void {
    const failures = Object.values(this.plugin.state.failures ?? {});
    setting.setDesc(
      failures.length
        ? `${failures.length} original${failures.length === 1 ? " needs" : "s need"} attention. Retry after resolving the reported problem.`
        : "No failed originals.",
    );
    for (const failure of failures.slice(0, 25)) {
      setting.descEl.createEl("p", { text: `${failure.entry.path}: ${failure.error}` });
    }
    if (failures.length)
      setting.addButton((button) =>
        button
          .setButtonText("Retry failed")
          .onClick(() => void this.plugin.run(() => this.plugin.engine.retryFailed())),
      );
  }

  private renderMissing(setting: Setting): void {
    const missing = Object.values(this.plugin.state.missing ?? {});
    setting.setDesc(
      missing.length
        ? `${missing.length} Brain originals were not found here. Let cloud delivery finish first. Removing a note requires confirmation.`
        : "No missing originals found in the last folder scan.",
    );
    setting.addButton((button) =>
      button
        .setButtonText("Rescan folder")
        .onClick(() => void this.plugin.run(() => this.plugin.engine.reconcile())),
    );
    for (const note of missing.slice(0, 25)) {
      const row = new Setting(setting.descEl)
        .setName(note.path)
        .setDesc(
          note.serverEdited
            ? "Edited in YouSpot. Review it there before removing it."
            : "Missing here; it may still exist on another installation.",
        );
      row.addButton((button) =>
        button
          .setButtonText("Open in YouSpot")
          .onClick(() =>
            window.open(
              `${this.prefs.appBase.replace(/\/+$/, "")}/graph/object/${encodeURIComponent(note.objectId)}`,
              "_blank",
              "noopener,noreferrer",
            ),
          ),
      );
      row.addButton((button) =>
        button
          .setButtonText("Remove from Brain")
          .setDisabled(note.serverEdited)
          .onClick(() =>
            new ConfirmModal(
              this.app,
              "Remove this original from Brain?",
              `${note.path} may still exist on another installation. This removes its Brain record, not the local file.`,
              () => void this.plugin.run(() => this.plugin.engine.removeMissing(note.path)),
            ).open(),
          ),
      );
    }
  }

  private renderSyncFolder(setting: Setting): void {
    setting.addText((t) => {
      t.setPlaceholder("Knowledge").setValue(this.prefs.syncFolder);
      new FolderSuggest(this.app, t.inputEl, (folder) => {
        void this.plugin.run(() => this.plugin.updateSettings({ syncFolder: folder }));
      });
      t.onChange(async (value) => {
        await this.plugin.run(() =>
          this.plugin.updateSettings({ syncFolder: value.trim().replace(/^\/+|\/+$/g, "") }),
        );
      });
    });
  }

  private renderHelp(setting: Setting): void {
    const list = setting.descEl.createEl("ol", { cls: "youspot-settings-steps" });
    list.createEl("li", { text: "Create a token on the Obsidian tab of YouSpot integrations." });
    list.createEl("li", {
      text: "Paste your token, then connect this installation.",
    });
    list.createEl("li", {
      text: "Choose a sync folder. Nothing moves until you do, so the rest of the vault stays put.",
    });
    list.createEl("li", { text: "Run “YouSpot: sync now” from the command palette." });
    setting.descEl
      .createEl("p")
      .createEl("a", { text: "Plugin page", href: PLUGIN_PAGE })
      .setAttrs({ target: "_blank", rel: "noopener noreferrer" });
  }
}
