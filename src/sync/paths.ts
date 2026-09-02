import type { PathRules } from "../types";

export const PLURALS: Record<string, string> = {
  contact: "Contacts",
  company: "Companies",
  project: "Projects",
  note: "Notes",
  web_link: "Links",
  fact: "Facts",
  file: "Files",
  event: "Events",
  product: "Products",
  group: "Groups",
  domain_name: "Domains",
  tag: "Tags",
};

const MAX_NAME = 120;
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

export function normalizeFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "");
}

export function joinPath(...parts: string[]): string {
  const kept: string[] = [];
  for (const part of parts) {
    const clean = normalizeFolder(part);
    if (clean) kept.push(clean);
  }
  return kept.join("/");
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.endsWith(".md") ? file.slice(0, -3) : file;
}

export function exportRoot(rules: PathRules): string {
  return joinPath(rules.syncFolder, rules.exportFolder);
}

export function isInFolder(path: string, folder: string): boolean {
  const f = normalizeFolder(folder);
  if (!f) return true;
  return path === f || path.startsWith(`${f}/`);
}

export function isExport(path: string, rules: PathRules): boolean {
  return isInFolder(path, exportRoot(rules));
}

export const CONFLICT_SUFFIX = ".youspot-conflict.md";

export function conflictPath(path: string): string {
  return `${stripExtension(path)}${CONFLICT_SUFFIX}`;
}

export function isSyncable(path: string, rules: PathRules): boolean {
  if (!path.endsWith(".md") || path.endsWith(CONFLICT_SUFFIX)) return false;
  if (!isInFolder(path, rules.syncFolder)) return false;
  return !isExport(path, rules);
}

export function safeFileName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  const clipped = cleaned.length > MAX_NAME ? cleaned.slice(0, MAX_NAME).trim() : cleaned;
  return clipped || "Untitled";
}

export function pluralFolder(type: string): string {
  const known = PLURALS[type];
  if (known) return known;
  const words = type.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return `${words.join(" ")}s`;
}

export function exportPath(
  rules: PathRules,
  type: string,
  name: string,
  id: string,
  taken: Set<string>,
): string {
  const folder = joinPath(exportRoot(rules), pluralFolder(type));
  const plain = `${folder}/${safeFileName(name)}.md`;
  if (!taken.has(plain)) return plain;
  return `${folder}/${safeFileName(name)} (${id}).md`;
}

export function stripExtension(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}
