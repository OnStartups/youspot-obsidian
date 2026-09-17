import {
  type App,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
} from "obsidian";
import { ApiError } from "./api";
import { FolderSuggest } from "./folder-suggest";
import type YouSpotPlugin from "./main";
import { DEFAULT_SETTINGS, applyCapabilities } from "./sync/state";
import type { YouSpotSettings } from "./types";

export { DEFAULT_SETTINGS };

const PLUGIN_PAGE = "https://community.obsidian.md/plugins/youspot";

function gitignoreLine(app: App): string {
  return `${app.vault.configDir}/plugins/youspot/data.json`;
}

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
  constructor(
    app: App,
    private readonly plugin: YouSpotPlugin,
  ) {
    super(app, plugin);
  }

  private get prefs(): YouSpotSettings {
    return this.plugin.prefs;
  }

  override getControlValue(key: string): unknown {
    if (key.startsWith("export:")) {
      return this.prefs.exportTypes[key.slice("export:".length)] === true;
    }
    return this.prefs[key as keyof YouSpotSettings];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key.startsWith("export:")) {
      this.prefs.exportTypes[key.slice("export:".length)] = Boolean(value);
    } else {
      Object.assign(this.prefs, { [key]: value });
    }
    await this.plugin.saveSettings();
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "Account",
        items: [
          {
            name: "Token",
            desc: 'Mint a token named "Obsidian" on the YouSpot integrations MCP tab and paste it here.',
            aliases: ["api key", "connect", "sign in"],
            render: (setting) => this.renderToken(setting),
          },
          {
            name: "Keep the token out of Git",
            desc: "It is stored in plain text inside this vault.",
            aliases: ["gitignore", "secret", "security"],
            render: (setting) => this.renderGitignore(setting),
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
                    const me = await this.plugin.api.me();
                    applyCapabilities(this.prefs, await this.plugin.api.capabilities());
                    this.prefs.capabilitiesAccount = me.email;
                    await this.plugin.saveSettings();
                    this.update();
                  } catch (error) {
                    new Notice(String(error));
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
                  this.prefs.exportSpaceId = value;
                  await this.plugin.saveSettings();
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
                    this.prefs.attachments = value === "available" ? "available" : "none";
                    await this.plugin.saveSettings();
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
                  .onClick(async () => {
                    await this.plugin.engine.refresh();
                    this.update();
                  }),
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
                `Documents written: ${report.written}. Originals kept: ${report.originals}. Attachments: ${report.assets}. Conflicts: ${report.conflicts.length}.`,
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
        heading: "Danger zone",
        items: [
          {
            name: "Vault ID",
            desc: "Identifies this vault to YouSpot. Kept across resets.",
            render: (setting) => {
              setting.addText((t) => t.setValue(this.plugin.state.vaultId).setDisabled(true));
            },
          },
          {
            name: "Reset sync state",
            desc: "Re-scan original notes. Managed export hashes and pending refresh progress are kept to protect local files.",
            render: (setting) => {
              setting.addButton((b) =>
                b
                  .setButtonText("Reset")
                  .setDestructive()
                  .onClick(() =>
                    new ConfirmModal(
                      this.app,
                      "Reset YouSpot sync state?",
                      "Notes in YouSpot are kept. Original notes will be re-scanned; existing managed exports remain protected.",
                      () => void this.plugin.resetSyncState(),
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
        : "Not connected yet.",
    });
    setting.addText((t) => {
      t.inputEl.type = "password";
      t.inputEl.addClass("youspot-wide-input");
      t.setPlaceholder("mcp_…")
        .setValue(this.prefs.token)
        .onChange(async (value) => {
          this.prefs.token = value.trim();
          await this.plugin.saveSettings();
        });
    });
    setting.addButton((b) =>
      b.setButtonText("Check").onClick(async () => {
        try {
          const me = await this.plugin.api.me();
          this.plugin.accountEmail = me.email;
          applyCapabilities(this.prefs, await this.plugin.api.capabilities());
          this.prefs.capabilitiesAccount = me.email;
          await this.plugin.saveSettings();
          this.plugin.engine.resume();
          new Notice(
            `YouSpot: connected as ${me.email} (${me.brain_count} objects in your Brain).`,
          );
        } catch (err) {
          const message =
            err instanceof ApiError && err.unauthorized ? "token rejected" : String(err);
          new Notice(`YouSpot: ${message}`);
        }
        this.update();
      }),
    );
    setting.addButton((b) =>
      b.setButtonText("Disconnect").onClick(async () => {
        this.prefs.token = "";
        this.plugin.accountEmail = null;
        await this.plugin.saveSettings();
        this.update();
      }),
    );
  }

  private renderGitignore(setting: Setting): void {
    setting.descEl.createEl("p", {
      text: "If the vault is in Git or synced elsewhere, keep the plugin data file out of it:",
    });
    setting.descEl.createEl("p").createEl("code", { text: gitignoreLine(this.app) });
    setting.addButton((b) =>
      b.setButtonText("Copy line").onClick(async () => {
        await navigator.clipboard.writeText(`${gitignoreLine(this.app)}\n`);
        new Notice("Copied.");
      }),
    );
  }

  private renderSyncFolder(setting: Setting): void {
    setting.addText((t) => {
      t.setPlaceholder("knowledge").setValue(this.prefs.syncFolder);
      new FolderSuggest(this.app, t.inputEl, (folder) => {
        this.prefs.syncFolder = folder;
        void this.plugin.saveSettings();
      });
      t.onChange(async (value) => {
        this.prefs.syncFolder = value.trim().replace(/^\/+|\/+$/g, "");
        await this.plugin.saveSettings();
      });
    });
  }

  private renderHelp(setting: Setting): void {
    const list = setting.descEl.createEl("ol", { cls: "youspot-settings-steps" });
    list.createEl("li", { text: "Create a token on the Obsidian tab of YouSpot integrations." });
    list.createEl("li", { text: "Paste it above and press Check." });
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
