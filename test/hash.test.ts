import { describe, expect, test } from "bun:test";
import { hashableFrontmatter, localHash, sha256Hex } from "../src/sync/hash";

describe("hash", () => {
  test("sha256 known vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  test("youspot_id and position never count", async () => {
    const a = await localHash("body", { title: "T" });
    const b = await localHash("body", { title: "T", youspot_id: "note_1", position: { x: 1 } });
    expect(a).toBe(b);
    expect(hashableFrontmatter({ youspot_id: "x", a: 1 })).toEqual({ a: 1 });
  });
  test("body or frontmatter edits change it, key order does not", async () => {
    const base = await localHash("body", { a: 1, b: 2 });
    expect(await localHash("body!", { a: 1, b: 2 })).not.toBe(base);
    expect(await localHash("body", { a: 1, b: 3 })).not.toBe(base);
    expect(await localHash("body", { b: 2, a: 1 })).toBe(base);
  });
});
