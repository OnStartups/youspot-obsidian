import { describe, expect, test } from "bun:test";
import { canonicalJSON, emitFrontmatter, splitFrontmatter } from "../src/sync/frontmatter";

describe("splitFrontmatter", () => {
  test("no block", () => {
    expect(splitFrontmatter("# Hi\n")).toEqual({ raw: null, body: "# Hi\n" });
  });
  test("with block", () => {
    const out = splitFrontmatter("---\ntitle: X\n---\nbody\n");
    expect(out.raw).toBe("title: X");
    expect(out.body).toBe("body\n");
  });
  test("CRLF", () => {
    const out = splitFrontmatter("---\r\ntitle: X\r\n---\r\nbody\r\n");
    expect(out.raw).toBe("title: X");
    expect(out.body).toBe("body\n");
  });
  test("--- in the body survives", () => {
    const out = splitFrontmatter("---\na: 1\n---\nfirst\n---\nsecond\n");
    expect(out.body).toBe("first\n---\nsecond\n");
  });
  test("unterminated block is body", () => {
    expect(splitFrontmatter("---\nno end\n").raw).toBeNull();
  });
});

describe("canonicalJSON", () => {
  test("sorts keys and drops undefined", () => {
    expect(canonicalJSON({ b: 1, a: [2, { z: 1, y: undefined }] })).toBe('{"a":[2,{"z":1}],"b":1}');
  });
});

describe("emitFrontmatter", () => {
  test("quotes what YAML would misread", () => {
    const out = emitFrontmatter({
      plain: "hello world",
      colon: "a: b",
      hash: "#tag",
      num: "42",
      bool: "true",
      empty: "",
      real: 3,
      flag: false,
      nothing: null,
    });
    expect(out).toBe(
      [
        "---",
        "plain: hello world",
        'colon: "a: b"',
        'hash: "#tag"',
        'num: "42"',
        'bool: "true"',
        'empty: ""',
        "real: 3",
        "flag: false",
        "nothing: null",
        "---",
        "",
      ].join("\n"),
    );
  });
  test("arrays and nested objects, key order preserved", () => {
    const out = emitFrontmatter({
      tags: ["a", "b c"],
      none: [],
      obj: { k: 1 },
      skipped: undefined,
    });
    expect(out).toBe('---\ntags:\n  - a\n  - b c\nnone: []\nobj: {"k":1}\n---\n');
  });
});
