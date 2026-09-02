import type { ChangeObject } from "../types";
import { emitFrontmatter } from "./frontmatter";
import { stripExtension } from "./paths";

export const FIELD_ALLOWLIST: Record<string, [string, string][]> = {
  contact: [
    ["email", "email"],
    ["phone", "phone"],
    ["title", "job_title"],
    ["company", "company"],
    ["linkedin_url", "linkedin_url"],
    ["location", "location"],
  ],
  company: [
    ["domain", "domain"],
    ["industry", "industry"],
    ["website", "website"],
  ],
  web_link: [
    ["author", "author"],
    ["source", "source"],
  ],
  project: [["status", "status"]],
  note: [],
};

export interface RenderOptions {
  appBase: string;
  resolvePath: (objectId: string) => string | null;
}

function scalarField(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

export function objectUrl(appBase: string, objectId: string): string {
  return `${appBase.replace(/\/+$/, "")}/brain/object/${objectId}`;
}

export function renderFrontmatter(obj: ChangeObject, appBase: string): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    youspot_id: obj.object_id,
    youspot_type: obj.type,
    youspot_managed: true,
    title: obj.name,
    url: obj.page_url || objectUrl(appBase, obj.object_id),
  };
  if (obj.url) fm.source_url = obj.url;
  fm.updated_at = obj.updated_at;
  for (const [source, key] of FIELD_ALLOWLIST[obj.type] ?? []) {
    const value = scalarField(obj.json_data?.[source]) ?? scalarField(obj.fields?.[source]);
    if (value !== undefined) fm[key] = value;
  }
  const tags = [`youspot/${obj.type}`, ...(obj.tags ?? [])];
  fm.tags = Array.from(new Set(tags));
  return fm;
}

export function renderObject(obj: ChangeObject, options: RenderOptions): string {
  const parts: string[] = [emitFrontmatter(renderFrontmatter(obj, options.appBase))];
  const body = (obj.description ?? "").trim();
  if (body) parts.push(`${body}\n`);
  const connections = [...(obj.connections ?? [])].sort((a, b) =>
    `${a.name}${a.object_id}`.localeCompare(`${b.name}${b.object_id}`),
  );
  if (connections.length) {
    const lines = connections.map((c) => {
      const path = options.resolvePath(c.object_id);
      if (path) return `- [[${stripExtension(path)}|${c.name}]] — ${c.type}`;
      return `- ${c.name} (${c.object_type}) — ${objectUrl(options.appBase, c.object_id)}`;
    });
    parts.push(`## Connections\n${lines.join("\n")}\n`);
  }
  return parts.join("\n");
}
