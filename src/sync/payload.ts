import type { PathRules, PushNote, WikiLinkRef } from "../types";
import { hashableFrontmatter } from "./hash";
import { basename, isExport, isSyncable } from "./paths";

export interface PayloadInput {
  path: string;
  body: string;
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  links: string[];
  mtime: number;
  youspotId?: string;
  rules: PathRules;
  exportsByPath: Map<string, string>;
}

export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, "");
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

export function resolveLinks(
  links: string[],
  rules: PathRules,
  exportsByPath: Map<string, string>,
): WikiLinkRef[] {
  const out: WikiLinkRef[] = [];
  const seen = new Set<string>();
  for (const target of links) {
    if (isExport(target, rules)) {
      const id = exportsByPath.get(target);
      if (id && !seen.has(`id:${id}`)) {
        seen.add(`id:${id}`);
        out.push({ object_id: id });
      }
      continue;
    }
    if (isSyncable(target, rules) && !seen.has(`path:${target}`)) {
      seen.add(`path:${target}`);
      out.push({ path: target });
    }
  }
  return out;
}

export function noteTitle(path: string, frontmatter: Record<string, unknown> | null): string {
  const title = frontmatter?.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  return basename(path);
}

export function frontmatterId(frontmatter: Record<string, unknown> | null): string | undefined {
  const id = frontmatter?.youspot_id;
  return typeof id === "string" && id ? id : undefined;
}

export function buildNotePayload(input: PayloadInput): PushNote {
  const youspotId = frontmatterId(input.frontmatter) ?? input.youspotId;
  const note: PushNote = {
    path: input.path,
    title: noteTitle(input.path, input.frontmatter),
    markdown: input.body,
    frontmatter: hashableFrontmatter(input.frontmatter),
    tags: normalizeTags(input.tags),
    wikilinks: resolveLinks(input.links, input.rules, input.exportsByPath),
    mtime: new Date(input.mtime).toISOString(),
  };
  if (youspotId) note.youspot_id = youspotId;
  return note;
}
