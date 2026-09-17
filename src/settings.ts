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
import { DEFAULT_SETTINGS, EXPORT_TYPES } from "./sync/state";
import { pluralFolder } from "./sync/paths";
import type { YouSpotSettings } from "./types";

export { DEFAULT_SETTINGS };

const PLUGIN_PAGE = "https://community.obsidian.md/plugins/youspot";

/** Where the token actually sits, asked of the vault rather than assumed —
 *  configDir is not always `.obsidian`. */
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

/**
 * Declarative settings (1.13.0+). Describing the settings instead of drawing
 * them is what puts them in Obsidian's settings search, so someone looking
 * for "sync folder" finds it without knowing the plugin is called YouSpot.
 *
 * Values are read and written through getControlValue/setControlValue below,
 * which is why every `key` is a field of YouSpotSettings. The handful of rows
 * that are not a plain value — the token, the folder picker, the warning —
 * use `render` and draw themselves.
 */
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
      return this.prefs.exportTypes[key.slice("export:".length)] !== false;
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
        heading: "Exported types",
        items: EXPORT_TYPES.map((type) => ({
          name: pluralFolder(type),
          control: { type: "toggle" as const, key: `export:${type}` },
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
            desc: "Forget what has been pushed and pulled. The next sync re-pushes every note in the folder.",
            render: (setting) => {
              setting.addButton((b) =>
                b
                  .setButtonText("Reset")
                  .setDestructive()
                  .onClick(() =>
                    new ConfirmModal(
                      this.app,
                      "Reset YouSpot sync state?",
                      "Notes in YouSpot are kept. The plugin forgets its local bookkeeping and re-syncs everything.",
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
