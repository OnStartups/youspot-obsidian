import { describe, expect, test } from "bun:test";
import { applyPushResults, forgetDeleted } from "../src/sync/push";
import { emptyState } from "../src/sync/state";

describe("applyPushResults", () => {
  test("created writes state and asks for a stamp", () => {
    const state = emptyState("v");
    const apply = applyPushResults(
      state,
      [
        {
          path: "a.md",
          status: "created",
          object_id: "note_1",
          content_hash: "srv",
          synced_at: "t1",
        },
      ],
      new Map([["a.md", "loc"]]),
      100,
    );
    expect(state.notes["a.md"]).toEqual({
      youspot_id: "note_1",
      local_hash: "loc",
      content_hash: "srv",
      server_updated_at: "t1",
      last_pushed_at: 100,
    });
    expect(apply.stamps).toEqual([{ path: "a.md", youspotId: "note_1" }]);
    expect(apply.applied).toBe(1);
  });
  test("updated and unchanged keep the id without a new stamp, and clear a conflict", () => {
    const state = emptyState("v");
    state.notes["a.md"] = {
      youspot_id: "note_1",
      local_hash: "old",
      content_hash: "old",
      server_updated_at: "t0",
      last_pushed_at: 1,
      conflict: { server_hash: "x", server_updated_at: "t0" },
    };
    state.serverEdited = ["note_1", "note_2"];
    const apply = applyPushResults(
      state,
      [
        {
          path: "a.md",
          status: "updated",
          object_id: "note_1",
          content_hash: "new",
          synced_at: "t1",
        },
      ],
      new Map([["a.md", "loc2"]]),
      200,
    );
    expect(apply.stamps).toHaveLength(0);
    expect(state.notes["a.md"]?.conflict).toBeUndefined();
    expect(state.notes["a.md"]?.local_hash).toBe("loc2");
    expect(state.serverEdited).toEqual(["note_2"]);
  });
  test("conflict marks the note and leaves the hash unpushed", () => {
    const state = emptyState("v");
    state.notes["a.md"] = {
      youspot_id: "note_1",
      local_hash: "old",
      content_hash: "old",
      server_updated_at: "t0",
      last_pushed_at: 1,
    };
    const apply = applyPushResults(
      state,
      [
        {
          path: "a.md",
          status: "conflict",
          object_id: "note_1",
          server_hash: "s",
          server_updated_at: "t5",
        },
      ],
      new Map([["a.md", "loc2"]]),
      200,
    );
    expect(apply.conflicts).toHaveLength(1);
    expect(state.notes["a.md"]?.local_hash).toBe("old");
    expect(state.notes["a.md"]?.conflict).toEqual({ server_hash: "s", server_updated_at: "t5" });
  });
  test("errors are collected and state untouched", () => {
    const state = emptyState("v");
    const apply = applyPushResults(
      state,
      [{ path: "a.md", status: "error", error: "brain_limit_reached" }],
      new Map(),
      1,
    );
    expect(apply.errors).toHaveLength(1);
    expect(state.notes).toEqual({});
  });
  test("forgetDeleted drops entries", () => {
    const state = emptyState("v");
    state.notes["a.md"] = {
      youspot_id: "n",
      local_hash: "",
      content_hash: "",
      server_updated_at: "",
      last_pushed_at: 0,
    };
    forgetDeleted(state, ["a.md", "missing.md"]);
    expect(state.notes).toEqual({});
  });
});
