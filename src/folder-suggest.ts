import { AbstractInputSuggest, type App, TFolder } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    private readonly input: HTMLInputElement,
    private readonly onPick: (folder: string) => void,
  ) {
    super(app, input);
  }

  protected getSuggestions(query: string): TFolder[] {
    const needle = query.toLowerCase();
    const matches: TFolder[] = [];
    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFolder) || file.path === "/") continue;
      if (file.path.toLowerCase().includes(needle)) matches.push(file);
    }
    return matches.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  override selectSuggestion(folder: TFolder): void {
    this.input.value = folder.path;
    this.onPick(folder.path);
    this.close();
  }
}
