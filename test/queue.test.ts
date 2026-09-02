import { describe, expect, test } from "bun:test";
import { ChangeQueue, MAX_ATTEMPTS, type QueueEntry } from "../src/sync/queue";

describe("ChangeQueue", () => {
  test("coalesces repeated changes to one entry", () => {
    const q = new ChangeQueue();
    q.upsert("a.md");
    q.upsert("a.md");
    q.upsert("b.md");
    expect(q.size).toBe(2);
  });
  test("create then delete of a never-pushed note cancels out", () => {
    const q = new ChangeQueue();
    q.upsert("a.md");
    q.remove("a.md");
    expect(q.size).toBe(0);
  });
  test("delete of a pushed note stays a delete with its id", () => {
    const q = new ChangeQueue();
    q.upsert("a.md", { youspotId: "note_1" });
    q.remove("a.md");
    expect(q.drain()).toEqual([{ path: "a.md", kind: "delete", youspotId: "note_1", attempts: 0 }]);
  });
  test("rename moves the entry and keeps the id", () => {
    const q = new ChangeQueue();
    q.upsert("a.md", { youspotId: "note_1" });
    q.rename("a.md", "b.md");
    expect(q.has("a.md")).toBe(false);
    expect(q.drain()[0]).toMatchObject({ path: "b.md", kind: "upsert", youspotId: "note_1" });
  });
  test("drain chunks at the limit", () => {
    const q = new ChangeQueue();
    for (let i = 0; i < 250; i++) q.upsert(`${i}.md`);
    expect(q.drain(100).length).toBe(100);
    expect(q.drain(100).length).toBe(100);
    expect(q.drain(100).length).toBe(50);
    expect(q.size).toBe(0);
  });
  test("requeue gives up after the attempt cap", () => {
    const q = new ChangeQueue();
    let entry: QueueEntry = { path: "a.md", kind: "upsert", attempts: 0 };
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(q.requeue(entry)).toBe(true);
      entry = q.drain()[0] ?? entry;
      expect(entry.attempts).toBe(i);
    }
    expect(q.requeue(entry)).toBe(false);
  });
  test("restore does not clobber newer entries", () => {
    const q = new ChangeQueue();
    q.upsert("a.md", { force: true });
    q.restore([{ path: "a.md", kind: "delete", attempts: 0 }]);
    expect(q.drain()[0]?.kind).toBe("upsert");
  });
});
