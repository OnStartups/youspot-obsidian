export interface FileMeta {
  path: string;
  basename: string;
  mtime: number;
}

export interface FileCache {
  frontmatter: Record<string, unknown> | null;
  tags: string[];
}

export interface VaultPort {
  vaultName(): string;
  listMarkdown(): FileMeta[];
  stat(path: string): FileMeta | null;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
  cache(path: string): FileCache | null;
  resolvedLinks(path: string): string[];
  stampFrontmatter(path: string, key: string, value: string): Promise<void>;
}
