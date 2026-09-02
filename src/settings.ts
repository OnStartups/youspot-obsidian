import { type App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { ApiError } from "./api";
import { FolderSuggest } from "./folder-suggest";
import type YouSpotPlugin from "./main";
import { DEFAULT_SETTINGS, EXPORT_TYPES } from "./sync/state";
import { pluralFolder } from "./sync/paths";

export { DEFAULT_SETTINGS };

const GITIGNORE_LINE = ".obsidian/plugins/youspot/data.json";

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
          .setWarning()
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

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderAccount(containerEl);
    this.renderFolders(containerEl);
    this.renderSync(containerEl);
    this.renderExports(containerEl);
    this.renderDanger(containerEl);
  }

  private renderAccount(el: HTMLElement): void {
    const s = this.plugin.prefs;
    new Setting(el).setName("Account").setHeading();

    const account = el.createDiv({ cls: "youspot-settings-account" });
    account.setText(
      this.plugin.accountEmail ? `Connected as ${this.plugin.accountEmail}` : "Not connected",
    );

    new Setting(el)
      .setName("Token")
      .setDesc(
        'Mint a token named "Obsidian" on the YouSpot integrations MCP tab and paste it here.',
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.style.width = "100%";
        t.setPlaceholder("mcp_…")
          .setValue(s.token)
          .onChange(async (value) => {
            s.token = value.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton((b) =>
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
          this.display();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Disconnect").onClick(async () => {
          s.token = "";
          this.plugin.accountEmail = null;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    const warning = el.createDiv({ cls: "youspot-settings-warning" });
    warning.createEl("strong", { text: "The token is stored in plain text inside this vault." });
    warning.createEl("p", {
      text: "If the vault is in git or synced elsewhere, keep the plugin data file out of it:",
    });
    const line = warning.createEl("p");
    line.createEl("code", { text: GITIGNORE_LINE });
    new Setting(warning).addButton((b) =>
      b.setButtonText("Copy .gitignore line").onClick(async () => {
        await navigator.clipboard.writeText(`${GITIGNORE_LINE}\n`);
        new Notice("Copied.");
      }),
    );

    new Setting(el)
      .setName("API base")
      .setDesc(`Where the plugin talks to. Default ${DEFAULT_SETTINGS.apiBase}.`)
      .addText((t) =>
        t.setValue(s.apiBase).onChange(async (value) => {
          s.apiBase = value.trim() || DEFAULT_SETTINGS.apiBase;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("App base")
      .setDesc(`Used by "Open in YouSpot". Default ${DEFAULT_SETTINGS.appBase}.`)
      .addText((t) =>
        t.setValue(s.appBase).onChange(async (value) => {
          s.appBase = value.trim() || DEFAULT_SETTINGS.appBase;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderFolders(el: HTMLElement): void {
    const s = this.plugin.prefs;
    new Setting(el).setName("Folders").setHeading();

    new Setting(el)
      .setName("Sync folder")
      .setDesc("Only notes inside this folder go to YouSpot. Sync is off until one is chosen.")
      .addText((t) => {
        t.setPlaceholder("knowledge").setValue(s.syncFolder);
        new FolderSuggest(this.app, t.inputEl, async (folder) => {
          s.syncFolder = folder;
          await this.plugin.saveSettings();
        });
        t.onChange(async (value) => {
          s.syncFolder = value.trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Export folder")
      .setDesc("Inside the sync folder. Brain objects are written here and never pushed back.")
      .addText((t) =>
        t.setValue(s.exportFolder).onChange(async (value) => {
          s.exportFolder = value.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.exportFolder;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderSync(el: HTMLElement): void {
    const s = this.plugin.prefs;
    new Setting(el).setName("Sync").setHeading();

    new Setting(el)
      .setName("Sync on save")
      .setDesc("Push a note a few seconds after it changes.")
      .addToggle((t) =>
        t.setValue(s.syncOnSave).onChange(async (value) => {
          s.syncOnSave = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("Sync interval (minutes)")
      .setDesc("Background push and pull. 0 disables the interval.")
      .addText((t) =>
        t.setValue(String(s.syncIntervalMinutes)).onChange(async (value) => {
          const n = Number.parseInt(value, 10);
          s.syncIntervalMinutes =
            Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.syncIntervalMinutes;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("Pull Brain objects")
      .setDesc("Write YouSpot objects into the export folder as Markdown.")
      .addToggle((t) =>
        t.setValue(s.pullEnabled).onChange(async (value) => {
          s.pullEnabled = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderExports(el: HTMLElement): void {
    const s = this.plugin.prefs;
    new Setting(el).setName("Exported types").setHeading();
    for (const type of EXPORT_TYPES) {
      new Setting(el).setName(pluralFolder(type)).addToggle((t) =>
        t.setValue(s.exportTypes[type] !== false).onChange(async (value) => {
          s.exportTypes[type] = value;
          await this.plugin.saveSettings();
        }),
      );
    }
  }

  private renderDanger(el: HTMLElement): void {
    new Setting(el).setName("Danger zone").setHeading();
    new Setting(el)
      .setName("Vault id")
      .setDesc("Identifies this vault to YouSpot. Kept across resets.")
      .addText((t) => t.setValue(this.plugin.state.vaultId).setDisabled(true));

    new Setting(el)
      .setName("Reset sync state")
      .setDesc(
        "Forget what has been pushed and pulled. The next sync re-pushes every note in the folder.",
      )
      .addButton((b) =>
        b
          .setButtonText("Reset")
          .setWarning()
          .onClick(() => {
            new ConfirmModal(
              this.app,
              "Reset YouSpot sync state?",
              "Notes in YouSpot are kept. The plugin forgets its local bookkeeping and re-syncs everything.",
              () => void this.plugin.resetSyncState(),
            ).open();
          }),
      );
  }
}
