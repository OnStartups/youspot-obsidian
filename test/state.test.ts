import { describe, expect, test } from "bun:test";
import { formatStatus } from "../src/status";
import { planReconcile } from "../src/sync/scan";
import { DEFAULT_SETTINGS, emptyState, loadPluginData, newVaultId } from "../src/sync/state";

describe("loadPluginData", () => {
  test("fresh install gets defaults and a vault id", () => {
    const data = loadPluginData(null, () => "vault123");
    expect(data.settings).toEqual(DEFAULT_SETTINGS);
    expect(data.state.vaultId).toBe("vault123");
    expect(data.state.notes).toEqual({});
  });
  test("existing data keeps its vault id and merges new defaults", () => {
    const data = loadPluginData({
      settings: { token: "mcp_x", exportTypes: { contact: false } },
      state: { vaultId: "keep", notes: { "a.md": { youspot_id: "n" } }, watermark: "w" },
    });
    expect(data.settings.token).toBe("mcp_x");
    expect(data.settings.apiBase).toBe(DEFAULT_SETTINGS.apiBase);
    expect(data.settings.exportTypes).toMatchObject({ contact: false, company: true });
    expect(data.state.vaultId).toBe("keep");
    expect(data.state.watermark).toBe("w");
    expect(data.state.serverEdited).toEqual([]);
  });
  test("newVaultId is 12 lowercase alphanumerics", () => {
    expect(newVaultId()).toMatch(/^[a-z0-9]{12}$/);
  });
});

describe("planReconcile", () => {
  const rules = { syncFolder: "Brain", exportFolder: "YouSpot" };
  test("new, stale, and conflicted files are upserts; missing state entries are deletes", () => {
    const state = emptyState("v");
    state.notes["Brain/fresh.md"] = {
      youspot_id: "n1",
      local_hash: "",
      content_hash: "",
      server_updated_at: "",
      last_pushed_at: 100,
    };
    state.notes["Brain/stale.md"] = {
      youspot_id: "n2",
      local_hash: "",
      content_hash: "",
      server_updated_at: "",
      last_pushed_at: 100,
    };
    state.notes["Brain/gone.md"] = {
      youspot_id: "n3",
      local_hash: "",
      content_hash: "",
      server_updated_at: "",
      last_pushed_at: 100,
    };
    state.notes["Brain/conf.md"] = {
      youspot_id: "n4",
      local_hash: "",
      content_hash: "",
      server_updated_at: "",
      last_pushed_at: 100,
      conflict: { server_hash: "", server_updated_at: "" },
    };
    const plan = planReconcile(
      [
        { path: "Brain/new.md", basename: "new", mtime: 1 },
        { path: "Brain/fresh.md", basename: "fresh", mtime: 50 },
        { path: "Brain/stale.md", basename: "stale", mtime: 150 },
        { path: "Brain/conf.md", basename: "conf", mtime: 50 },
        { path: "Brain/YouSpot/Contacts/x.md", basename: "x", mtime: 999 },
        { path: "Other/y.md", basename: "y", mtime: 999 },
      ],
      state,
      rules,
    );
    expect(plan.upserts).toEqual(["Brain/new.md", "Brain/stale.md", "Brain/conf.md"]);
    expect(plan.deletes).toEqual([{ path: "Brain/gone.md", youspotId: "n3" }]);
  });
});

describe("formatStatus", () => {
  const base = {
    configured: true,
    pending: 0,
    running: false,
    lastPushAt: null,
    lastPullAt: null,
    error: null,
    serverEdited: 0,
    conflicts: 0,
    now: 10 * 60_000,
  };
  test("states", () => {
    expect(formatStatus({ ...base, configured: false })).toBe("YouSpot: not connected");
    expect(formatStatus({ ...base, error: "boom" })).toBe("YouSpot: error (boom)");
    expect(formatStatus({ ...base, running: true })).toBe("YouSpot: syncing…");
    expect(formatStatus(base)).toBe("YouSpot: never synced");
    expect(formatStatus({ ...base, lastPushAt: 8 * 60_000 })).toBe("YouSpot: synced 2m ago");
    expect(formatStatus({ ...base, pending: 3, conflicts: 1, serverEdited: 2 })).toBe(
      "YouSpot: 3 pending, 1 conflict, 2 edited in YouSpot",
    );
  });
});
