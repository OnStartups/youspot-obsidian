import { describe, expect, test } from "bun:test";
import { buildNotePayload, normalizeTags, resolveLinks } from "../src/sync/payload";

const rules = { syncFolder: "Brain", exportFolder: "YouSpot" };
const exportsByPath = new Map([["Brain/YouSpot/Contacts/Jane.md", "per_1"]]);

describe("buildNotePayload", () => {
  test("title falls back to basename, frontmatter loses youspot_id, tags lose #", () => {
    const note = buildNotePayload({
      path: "Brain/Alpha.md",
      body: "hello",
      frontmatter: { youspot_id: "note_1", status: "active", position: {} },
      tags: ["#idea", "idea", "#project/alpha"],
      links: [],
      mtime: 0,
      rules,
      exportsByPath,
    });
    expect(note.title).toBe("Alpha");
    expect(note.youspot_id).toBe("note_1");
    expect(note.frontmatter).toEqual({ status: "active" });
    expect(note.tags).toEqual(["idea", "project/alpha"]);
    expect(note.mtime).toBe("1970-01-01T00:00:00.000Z");
  });
  test("frontmatter title wins, state id used when frontmatter has none", () => {
    const note = buildNotePayload({
      path: "Brain/Alpha.md",
      body: "",
      frontmatter: { title: " Real title " },
      tags: [],
      links: [],
      mtime: 0,
      youspotId: "note_9",
      rules,
      exportsByPath,
    });
    expect(note.title).toBe("Real title");
    expect(note.youspot_id).toBe("note_9");
  });
  test("links inside the folder go as paths, exports as object ids, others dropped", () => {
    const links = resolveLinks(
      [
        "Brain/Beta.md",
        "Brain/Beta.md",
        "Brain/YouSpot/Contacts/Jane.md",
        "Brain/YouSpot/Contacts/Unknown.md",
        "Elsewhere/x.md",
        "Brain/image.png",
      ],
      rules,
      exportsByPath,
    );
    expect(links).toEqual([{ path: "Brain/Beta.md" }, { object_id: "per_1" }]);
  });
  test("normalizeTags", () => {
    expect(normalizeTags(["##a", " b ", "", "a"])).toEqual(["a", "b"]);
  });
});
