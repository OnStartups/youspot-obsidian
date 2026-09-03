export interface SplitContent {
  raw: string | null;
  body: string;
}

const OPEN = /^---\r?\n/;
const CLOSE = /^(---|\.\.\.)\s*$/;

export function splitFrontmatter(content: string): SplitContent {
  if (!OPEN.test(content)) return { raw: null, body: content };
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE.test(lines[i] ?? "")) {
      return {
        raw: lines.slice(1, i).join("\n"),
        body: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return { raw: null, body: content };
}

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(record[k])}`).join(",")}}`;
}

const PLAIN = /^[A-Za-z_][^\n\r"'`\\]*$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Frontmatter values arrive as unknown from the metadata cache. Anything
  // that is not already a primitive would stringify to "[object Object]",
  // which is worse than JSON in a YAML value.
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (
    text === "" ||
    RESERVED.has(text.toLowerCase()) ||
    !PLAIN.test(text) ||
    text.includes(": ") ||
    text.includes(" #") ||
    text.endsWith(":") ||
    text.endsWith(" ")
  ) {
    return JSON.stringify(text);
  }
  return text;
}

export function emitFrontmatter(record: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${scalar(item)}`);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    lines.push(`${key}: ${scalar(value)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}
