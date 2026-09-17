import { unzipSync } from "fflate";
import type { ExportRun } from "../types";
import { hashBytes } from "./hash";
import { dirname } from "./paths";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 22_010;

export interface ArchiveRecord {
  id: string;
  type: string;
  title: string;
  path: string;
  updated_at: string;
}

export interface ArchiveAsset {
  id: string;
  status: string;
  path?: string;
  sha256?: string;
  bytes?: number;
}

export interface BrainArchive {
  records: ArchiveRecord[];
  identities: Map<string, string>;
  assets: ArchiveAsset[];
  files: Record<string, Uint8Array>;
  report: Record<string, unknown>;
}

export function safePath(path: string): boolean {
  return (
    Boolean(path) &&
    path.length <= 1000 &&
    !/[\\:*?"<>|]/.test(path) &&
    ![...path].some((char) => char.charCodeAt(0) < 32) &&
    path
      .split("/")
      .every(
        (part) =>
          Boolean(part) &&
          part !== "." &&
          part !== ".." &&
          !part.startsWith(".") &&
          !part.endsWith(".") &&
          !part.endsWith(" "),
      )
  );
}

function json<T>(files: Record<string, Uint8Array>, path: string): T {
  if (!files[path]) throw new Error(`Missing export file: ${path}`);
  return JSON.parse(new TextDecoder().decode(files[path])) as T;
}

function* records<T>(files: Record<string, Uint8Array>, path: string): Generator<T> {
  const bytes = files[path];
  if (!bytes) throw new Error(`Missing export file: ${path}`);
  const decoder = new TextDecoder();
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 10) {
      if (i > start) yield JSON.parse(decoder.decode(bytes.subarray(start, i))) as T;
      start = i + 1;
    }
  }
}

export async function readArchive(bytes: Uint8Array, run: ExportRun): Promise<BrainArchive> {
  if (
    bytes.length > MAX_BYTES ||
    bytes.length !== run.bytes ||
    (await hashBytes(bytes)) !== run.sha256
  ) {
    throw new Error("The export failed its download integrity check.");
  }
  const names = new Set<string>();
  let expanded = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      expanded += file.originalSize;
      const key = file.name.toLocaleLowerCase();
      if (
        !safePath(file.name) ||
        names.has(key) ||
        expanded > MAX_BYTES ||
        names.size >= MAX_FILES
      ) {
        throw new Error("The export contains unsafe paths or exceeds the supported size.");
      }
      names.add(key);
      return true;
    },
  });
  const manifest = json<{
    obsidian_version: number;
    archive_version: number;
    renderer_version: number;
    run_id: string;
    selection: ExportRun["options"];
    files: Record<string, { bytes: number; sha256: string }>;
  }>(files, "manifest.json");
  if (
    manifest.obsidian_version !== 1 ||
    manifest.archive_version !== 1 ||
    manifest.renderer_version !== 1 ||
    manifest.run_id !== run.id ||
    manifest.selection.space_id !== run.options.space_id ||
    manifest.selection.attachments !== run.options.attachments ||
    [...manifest.selection.types].sort().join(",") !== [...run.options.types].sort().join(",")
  ) {
    throw new Error("The export format or selection does not match this refresh.");
  }
  for (const [path, body] of Object.entries(files)) {
    if (path === "manifest.json") continue;
    const entry = manifest.files[path];
    if (!entry || body.length !== entry.bytes || (await hashBytes(body)) !== entry.sha256) {
      throw new Error(`The export file failed its integrity check: ${path}`);
    }
  }
  if (Object.keys(manifest.files).some((path) => !files[path]))
    throw new Error("The export is incomplete.");
  const identities = new Map<string, string>();
  const objectIds = new Set<string>();
  for (const item of records<{ id: string; object_id: string }>(files, "obsidian.ndjson")) {
    if (
      !/^obj_[a-f0-9]{32}$/.test(item.id) ||
      typeof item.object_id !== "string" ||
      !item.object_id ||
      identities.has(item.id) ||
      objectIds.has(item.object_id)
    )
      throw new Error("The export contains invalid identities.");
    identities.set(item.id, item.object_id);
    objectIds.add(item.object_id);
  }
  const documents = [...records<ArchiveRecord>(files, "records.ndjson")];
  const selectedTypes = new Set(run.options.types);
  const documentIds = new Set<string>();
  const documentPaths = new Set<string>();
  for (const record of documents) {
    if (
      !identities.has(record.id) ||
      documentIds.has(record.id) ||
      documentPaths.has(record.path) ||
      !safePath(record.path) ||
      !record.path.startsWith("documents/") ||
      !record.path.endsWith(".md") ||
      !files[record.path] ||
      !selectedTypes.has(record.type)
    )
      throw new Error("The export document inventory is invalid.");
    documentIds.add(record.id);
    documentPaths.add(record.path);
  }
  if (documents.length > 20_000 || documents.length !== identities.size)
    throw new Error("The export inventory is incomplete.");
  const assets = [...records<ArchiveAsset>(files, "assets.ndjson")];
  if (assets.length > 2000) throw new Error("The export has too many attachments.");
  for (const asset of assets) {
    if (
      asset.status === "captured" &&
      (!asset.path ||
        !safePath(asset.path) ||
        !asset.path.startsWith("assets/") ||
        !files[asset.path] ||
        manifest.files[asset.path]?.sha256 !== asset.sha256 ||
        manifest.files[asset.path]?.bytes !== asset.bytes)
    )
      throw new Error("The export attachment inventory is invalid.");
  }
  return { records: documents, identities, assets, files, report: json(files, "report.json") };
}

function resolve(from: string, target: string): string {
  const parts = dirname(from).split("/");
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part) parts.push(part);
  }
  return parts.join("/");
}

function relative(from: string, to: string): string {
  const source = dirname(from).split("/");
  const target = to.split("/");
  while (source.length && target.length && source[0] === target[0]) {
    source.shift();
    target.shift();
  }
  return [...source.map(() => ".."), ...target]
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

export function relocateDocument(
  content: string,
  source: string,
  destination: string,
  paths: Map<string, string | null>,
  objectId: string,
): string {
  const relocated = content.replace(/\]\(([^)\n]*)\)/g, (match: string, href: string) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      return match;
    }
    if (/^[a-z]+:|^\//i.test(decoded)) return match;
    const target = paths.get(resolve(source, decoded));
    if (target === null) return "] (attachment unavailable locally)";
    return target ? `](${relative(destination, target)})` : match;
  });
  return relocated.replace(
    /^---\n/,
    `---\nyouspot_id: ${JSON.stringify(objectId)}\nyouspot_managed: true\n`,
  );
}
