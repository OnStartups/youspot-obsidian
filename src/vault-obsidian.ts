import { type App, getAllTags, normalizePath, type TFile } from "obsidian";
import type { FileCache, FileMeta, VaultPort } from "./vault-port";

function meta(file: TFile): FileMeta {
  return { path: file.path, basename: file.basename, mtime: file.stat.mtime };
}

export class ObsidianVault implements VaultPort {
  constructor(private readonly app: App) {}

  vaultName(): string {
    return this.app.vault.getName();
  }

  listPaths(): string[] {
    return this.app.vault.getAllLoadedFiles().map((file) => file.path);
  }

  listMarkdown(): FileMeta[] {
    return this.app.vault.getMarkdownFiles().map(meta);
  }

  stat(path: string): FileMeta | null {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    return file ? meta(file) : null;
  }

  private file(path: string): TFile {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) throw new Error(`Not a file: ${path}`);
    return file;
  }

  read(path: string): Promise<string> {
    return this.app.vault.read(this.file(path));
  }

  exists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(this.file(path));
  }

  async createBinary(path: string, bytes: ArrayBuffer): Promise<void> {
    await this.app.vault.createBinary(normalizePath(path), bytes);
  }

  async writeGuarded(path: string, content: string, previous: string | null): Promise<boolean> {
    if (previous === null) {
      if (this.exists(path)) return false;
      await this.app.vault.create(normalizePath(path), content);
      return true;
    }
    if (!this.app.vault.getFileByPath(normalizePath(path))) return false;
    let written = false;
    await this.app.vault.process(this.file(path), (current) => {
      if (current !== previous) return current;
      written = true;
      return content;
    });
    return written;
  }

  async write(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getFileByPath(normalizePath(path));
    if (existing) {
      await this.app.vault.modify(existing, content);
      return;
    }
    await this.app.vault.create(normalizePath(path), content);
  }

  rename(from: string, to: string): Promise<void> {
    return this.app.fileManager.renameFile(this.file(from), normalizePath(to));
  }

  trash(path: string): Promise<void> {
    return this.app.fileManager.trashFile(this.file(path));
  }

  async ensureFolder(path: string): Promise<void> {
    const folder = normalizePath(path);
    if (!folder || folder === "/") return;
    const parts = folder.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getFolderByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  cache(path: string): FileCache | null {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) return null;
    const cached = this.app.metadataCache.getFileCache(file);
    if (!cached) return null;
    const frontmatter = cached.frontmatter ? { ...cached.frontmatter } : null;
    return { frontmatter, tags: getAllTags(cached) ?? [] };
  }

  resolvedLinks(path: string): string[] {
    return Object.keys(this.app.metadataCache.resolvedLinks[path] ?? {});
  }

  stampFrontmatter(path: string, key: string, value: string): Promise<void> {
    return this.app.fileManager.processFrontMatter(
      this.file(path),
      (fm: Record<string, unknown>) => {
        fm[key] = value;
      },
    );
  }
}
