import { splitFrontmatter } from "../src/sync/frontmatter";
import type { FileCache, FileMeta, VaultPort } from "../src/vault-port";

export class MemoryVault implements VaultPort {
  files = new Map<string, { content: string; mtime: number }>();
  caches = new Map<string, FileCache>();
  links = new Map<string, string[]>();
  writes: string[] = [];
  trashed: string[] = [];
  renames: [string, string][] = [];
  stamps: [string, string][] = [];

  add(path: string, content: string, cache?: FileCache, links: string[] = []) {
    this.files.set(path, { content, mtime: 1000 });
    this.caches.set(path, cache ?? { frontmatter: null, tags: [] });
    this.links.set(path, links);
  }
  listPaths() {
    return [...this.files.keys()];
  }
  exists(path: string) {
    return this.files.has(path);
  }
  async readBinary(path: string) {
    return new TextEncoder().encode(await this.read(path)).buffer;
  }
  async createBinary(path: string, bytes: ArrayBuffer) {
    if (this.exists(path)) throw new Error("File exists");
    await this.write(path, new TextDecoder().decode(bytes));
  }
  async writeGuarded(path: string, content: string, previous: string | null) {
    if (previous === null ? this.exists(path) : (await this.read(path)) !== previous) return false;
    await this.write(path, content);
    return true;
  }
  vaultName() {
    return "TestVault";
  }
  listMarkdown(): FileMeta[] {
    return [...this.files].map(([path, f]) => ({ path, basename: path, mtime: f.mtime }));
  }
  stat(path: string) {
    const f = this.files.get(path);
    return f ? { path, basename: path, mtime: f.mtime } : null;
  }
  async read(path: string) {
    return this.files.get(path)?.content ?? "";
  }
  async write(path: string, content: string) {
    this.writes.push(path);
    this.files.set(path, { content, mtime: 2000 });
  }
  async rename(from: string, to: string) {
    this.renames.push([from, to]);
    const f = this.files.get(from);
    if (f) {
      this.files.delete(from);
      this.files.set(to, f);
    }
  }
  async trash(path: string) {
    this.trashed.push(path);
    this.files.delete(path);
  }
  async ensureFolder() {}
  cache(path: string) {
    return this.caches.get(path) ?? null;
  }
  resolvedLinks(path: string) {
    return this.links.get(path) ?? [];
  }
  async stampFrontmatter(path: string, key: string, value: string) {
    this.stamps.push([path, value]);
    const f = this.files.get(path);
    if (!f) return;
    const { body } = splitFrontmatter(f.content);
    f.content = `---\n${key}: ${value}\n---\n${body}`;
    const cache = this.caches.get(path) ?? { frontmatter: null, tags: [] };
    cache.frontmatter = { ...cache.frontmatter, [key]: value };
  }
}
