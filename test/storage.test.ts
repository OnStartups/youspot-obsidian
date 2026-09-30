import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { IndexedLocalStore, PluginStorage, localClientId, type SharedData } from "../src/storage";
import { DEFAULT_SETTINGS, emptyState } from "../src/sync/state";
import { diagnosticSummary } from "../src/diagnostics";

function fixture(
  raw: unknown = {
    version: 2,
    settings: {
      token: "mcp_private",
      syncFolder: "Brain",
      exportTypes: { company: true },
      capabilitiesAccount: "test@example.invalid",
    },
    state: {
      ...emptyState("stable-vault"),
      notes: {
        "Brain/a.md": {
          youspot_id: "note_a",
          local_hash: "local",
          content_hash: "server",
          server_updated_at: "t",
          last_pushed_at: 1,
        },
      },
      refresh: { runId: "foreign-refresh" },
    },
  },
) {
  const factory = new IDBFactory();
  let disk = structuredClone(raw);
  const secrets = new Map<string, string>();
  const local = new IndexedLocalStore("client-a", factory);
  const storage = new PluginStorage(
    local,
    {
      getSecret: (id) => secrets.get(id) ?? null,
      setSecret: (id, value) => {
        secrets.set(id, value);
      },
    },
    async () => structuredClone(disk),
    async (data) => {
      disk = structuredClone(data);
    },
    "client-a",
  );
  return {
    local,
    storage,
    factory,
    secrets,
    disk: () => disk,
    incoming: (value: unknown) => {
      disk = structuredClone(value);
    },
  };
}

describe("local plugin persistence", () => {
  test("migration retains identities but does not adopt another client's refresh", async () => {
    const env = fixture();
    const data = await env.storage.load();
    expect(data.state.vaultId).toBe("stable-vault");
    expect(data.settings.token).toBe("mcp_private");
    await env.storage.bind(data, "test@example.invalid");
    expect(data.state.notes["Brain/a.md"]?.youspot_id).toBe("note_a");
    expect(data.state.refresh).toBeUndefined();
    const disk = JSON.stringify(env.disk());
    expect(disk).not.toContain("mcp_private");
    expect(disk).not.toContain("local_hash");
    expect(disk).not.toContain("foreign-refresh");
    expect((env.disk() as SharedData).version).toBe(3);
    env.local.close();
  });

  test("incoming preferences survive an ordinary runtime save and a local preference edit", async () => {
    const env = fixture();
    const data = await env.storage.load();
    await env.storage.bind(data, "test@example.invalid");
    const incoming = structuredClone(env.disk()) as SharedData;
    incoming.settings.syncIntervalMinutes = 7;
    env.incoming(incoming);
    data.state.lastPullAt = 500;
    await env.storage.save(data);
    expect((env.disk() as SharedData).settings.syncIntervalMinutes).toBe(7);
    const external = await env.storage.external();
    expect(external.settings.syncIntervalMinutes).toBe(7);
    await env.storage.preferences({ syncOnSave: false });
    expect((env.disk() as SharedData).settings.syncIntervalMinutes).toBe(7);
    expect((env.disk() as SharedData).settings.syncOnSave).toBe(false);
    env.local.close();
  });

  test("another installation cannot obtain progress or a token through shared config", async () => {
    const first = fixture();
    const a = await first.storage.load();
    await first.storage.bind(a, "test@example.invalid");
    a.state.refreshReport = {
      runId: "local-run",
      written: 32,
      originals: 13,
      assets: 0,
      conflicts: [],
      coverage: {},
    };
    await first.storage.save(a);
    const second = fixture(first.disk());
    const b = await second.storage.load();
    expect(b.settings.token).toBe("");
    expect(b.state.vaultId).toBe(a.state.vaultId);
    await second.storage.bind(b, "test@example.invalid");
    expect(b.state.refreshReport).toBeUndefined();
    expect(b.state.notes).toEqual({});
    first.local.close();
    second.local.close();
  });

  test("restarting retains pending operations and ignores reintroduced legacy runtime state", async () => {
    const env = fixture();
    const a = await env.storage.load();
    await env.storage.bind(a, "test@example.invalid");
    a.state.pending = [
      {
        path: "Brain/a.md",
        kind: "delete",
        youspotId: "note_a",
        expectedHash: "server",
        expectedSyncedAt: "2026-09-02T00:00:00Z",
        expectedPath: "Brain/a.md",
        attempts: 0,
      },
    ];
    a.state.uploadError = "not_authenticated";
    await env.storage.save(a);
    env.incoming({
      version: 2,
      settings: { token: "mcp_foreign", syncFolder: "Brain" },
      state: { ...emptyState("stable-vault"), notes: {}, refresh: { runId: "other-run" } },
    });
    const reopened = new PluginStorage(
      env.local,
      {
        getSecret: (id) => env.secrets.get(id) ?? null,
        setSecret: (id, value) => {
          env.secrets.set(id, value);
        },
      },
      async () => env.disk(),
      async (data) => env.incoming(data),
      "client-a",
    );
    const b = await reopened.load();
    await reopened.bind(b, "test@example.invalid");
    expect(b.settings.token).toBe("mcp_private");
    expect(b.state.pending?.[0]?.expectedHash).toBe("server");
    expect(b.state.pending?.[0]?.expectedSyncedAt).toBe("2026-09-02T00:00:00Z");
    expect(b.state.uploadError).toBe("not_authenticated");
    expect(b.state.refresh).toBeUndefined();
    env.local.close();
  });

  test("switching accounts or folders cannot reuse another scope's acknowledged notes", async () => {
    const env = fixture();
    const data = await env.storage.load();
    await env.storage.bind(data, "another@example.invalid");
    expect(data.state.notes).toEqual({});
    data.state.notes["Brain/b.md"] = {
      youspot_id: "note_b",
      local_hash: "b",
      content_hash: "b",
      server_updated_at: "t",
      last_pushed_at: 1,
    };
    await env.storage.save(data);
    data.settings.syncFolder = "Other";
    await env.storage.bind(data, "another@example.invalid");
    expect(data.state.notes).toEqual({});
    data.settings.syncFolder = "Brain";
    await env.storage.bind(data, "another@example.invalid");
    expect(data.state.notes["Brain/b.md"]?.youspot_id).toBe("note_b");
    env.local.close();
  });

  test("migration storage rejection preserves the shared credential and recovery data", async () => {
    let disk: unknown = {
      version: 1,
      settings: { token: "mcp_keep", syncFolder: "Brain" },
      state: { vaultId: "vault" },
    };
    const storage = new PluginStorage(
      {
        get: async () => undefined,
        put: async () => {
          throw new Error("Storage full");
        },
        close: () => {},
      },
      { getSecret: () => null, setSecret: () => {} },
      async () => disk,
      async (data) => {
        disk = data;
      },
      "client",
    );
    await expect(storage.load()).rejects.toThrow("Storage full");
    expect(JSON.stringify(disk)).toContain("mcp_keep");
    expect((disk as { version: number }).version).toBe(1);
  });

  test("local store survives reopening at the 20,000-record export envelope", async () => {
    const factory = new IDBFactory();
    const first = new IndexedLocalStore("capacity", factory);
    const state = emptyState("vault");
    for (let n = 0; n < 20_000; n++)
      state.exports[`company_${n}`] = {
        path: `Brain/YouSpot/Companies/Company ${n}.md`,
        type: "company",
        rendered_hash: "a".repeat(64),
        updated_at: "2026-09-30T00:00:00Z",
        projection_version: 1,
      };
    await first.put("scope", state);
    first.close();
    const second = new IndexedLocalStore("capacity", factory);
    const restored = await second.get<typeof state>("scope");
    expect(Object.keys(restored?.exports ?? {})).toHaveLength(20_000);
    expect(restored?.exports.company_19999?.path).toBe("Brain/YouSpot/Companies/Company 19999.md");
    second.close();
  });

  test("diagnostics exclude tokens, account details, note contents, and raw errors", () => {
    const data = {
      version: 3 as const,
      settings: {
        ...DEFAULT_SETTINGS,
        token: "mcp_private",
        capabilitiesAccount: "private@example.invalid",
        syncFolder: "Brain",
        exportFolder: "YouSpot",
        exportTypes: { company: true },
        syncIntervalMinutes: 5,
      },
      state: {
        ...emptyState("vault"),
        uploadError: "private error with mcp_private",
      },
    };
    const text = diagnosticSummary(
      data as Parameters<typeof diagnosticSummary>[0],
      "1.13.7",
      "0.3.1",
    );
    expect(text).not.toContain("mcp_private");
    expect(text).not.toContain("private@example.invalid");
    expect(JSON.parse(text).errors.upload).toBe("sync_failed");
  });

  test("installation identity cannot silently change when local persistence fails", () => {
    expect(() =>
      localClientId(
        () => undefined,
        () => {},
      ),
    ).toThrow("Could not save");
  });
});
