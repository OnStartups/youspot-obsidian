import { describe, expect, test } from "bun:test";
import {
  basename,
  conflictPath,
  dirname,
  exportPath,
  exportRoot,
  isExport,
  isSyncable,
  pluralFolder,
  safeFileName,
} from "../src/sync/paths";

const rules = { syncFolder: "Brain", exportFolder: "YouSpot" };

describe("isSyncable", () => {
  test("accepts markdown inside the folder, nested too", () => {
    expect(isSyncable("Brain/a.md", rules)).toBe(true);
    expect(isSyncable("Brain/deep/er/a.md", rules)).toBe(true);
  });
  test("rejects files outside, non-markdown, and the export subtree", () => {
    expect(isSyncable("Other/a.md", rules)).toBe(false);
    expect(isSyncable("Brain/a.png", rules)).toBe(false);
    expect(isSyncable("Brain/YouSpot/Contacts/Jane.md", rules)).toBe(false);
  });
  test("folder prefix is a path segment, not a string prefix", () => {
    expect(isSyncable("Brainstorm/a.md", rules)).toBe(false);
    expect(isSyncable("Brain/YouSpotty/a.md", rules)).toBe(true);
  });
  test("empty sync folder means the whole vault", () => {
    expect(isSyncable("anywhere/a.md", { syncFolder: "", exportFolder: "YouSpot" })).toBe(true);
    expect(isSyncable("YouSpot/a.md", { syncFolder: "", exportFolder: "YouSpot" })).toBe(false);
  });
  test("conflict copies never sync", () => {
    expect(isSyncable("Brain/a.youspot-conflict.md", rules)).toBe(false);
    expect(conflictPath("Brain/a.md")).toBe("Brain/a.youspot-conflict.md");
  });
});

describe("export paths", () => {
  test("root joins sync and export folders", () => {
    expect(exportRoot(rules)).toBe("Brain/YouSpot");
    expect(exportRoot({ syncFolder: "", exportFolder: "/YouSpot/" })).toBe("YouSpot");
    expect(isExport("Brain/YouSpot/x.md", rules)).toBe(true);
  });
  test("plain path unless taken, then id suffix", () => {
    const taken = new Set<string>();
    const first = exportPath(rules, "contact", "Jane Doe", "per_1", taken);
    expect(first).toBe("Brain/YouSpot/Contacts/Jane Doe.md");
    taken.add(first);
    expect(exportPath(rules, "contact", "Jane Doe", "per_2", taken)).toBe(
      "Brain/YouSpot/Contacts/Jane Doe (per_2).md",
    );
  });
  test("plurals", () => {
    expect(pluralFolder("company")).toBe("Companies");
    expect(pluralFolder("web_link")).toBe("Links");
    expect(pluralFolder("domain_name")).toBe("Domains");
    expect(pluralFolder("agent_trace")).toBe("Agent Traces");
  });
});

describe("safeFileName", () => {
  test("strips illegal characters and collapses whitespace", () => {
    expect(safeFileName('A/B: C*D?"E<F>G|H#I^J[K]')).toBe("A B C D E F G H I J K");
    expect(safeFileName("  lots   of   space  ")).toBe("lots of space");
  });
  test("trims dots and caps length", () => {
    expect(safeFileName("...dotty...")).toBe("dotty");
    expect(safeFileName("x".repeat(200)).length).toBe(120);
    expect(safeFileName("???")).toBe("Untitled");
  });
});

describe("path helpers", () => {
  test("dirname and basename", () => {
    expect(dirname("a/b/c.md")).toBe("a/b");
    expect(dirname("c.md")).toBe("");
    expect(basename("a/b/Note.md")).toBe("Note");
  });
});
