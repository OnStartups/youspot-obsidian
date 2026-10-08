import { describe, expect, test } from "bun:test";
import { ApiClient, type HttpPort, type HttpRequest } from "../src/api";
import { SyncEngine } from "../src/sync/engine";
import { DEFAULT_SETTINGS, emptyState } from "../src/sync/state";
import type { ChangeObject, PluginData, PushRequest } from "../src/types";
import { MemoryVault } from "./memory-vault";

type Reply = { status: number; json: unknown };
type Handler = (req: HttpRequest, body: unknown) => Reply | Promise<Reply>;

class FakeHttp implements HttpPort {
  requests: HttpRequest[] = [];
  routes = new Map<string, Handler>();
  on(method: string, path: string, handler: Handler) {
    this.routes.set(`${method} ${path}`, handler);
  }
  async request(req: HttpRequest) {
    this.requests.push(req);
    const path = new URL(req.url).pathname;
    const handler = this.routes.get(`${req.method} ${path}`);
    if (!handler) return { status: 404, text: JSON.stringify({ error: "no_route" }) };
    const body = req.body ? JSON.parse(req.body) : undefined;
    const out = await handler(req, body);
    return { status: out.status, text: JSON.stringify(out.json) };
  }
}

function setup(overrides: Partial<PluginData["settings"]> = {}) {
  const vault = new MemoryVault();
  const http = new FakeHttp();
  const data: PluginData = {
    version: 1,
    settings: {
      ...DEFAULT_SETTINGS,
      token: "mcp_t",
      syncFolder: "Brain",
      syncOnSave: false,
      exportTypes: { contact: true, company: true, project: true, note: true, web_link: true },
      ...overrides,
    },
    state: emptyState("vault1"),
  };
  const notices: string[] = [];
  let persisted = 0;
  const api = new ApiClient(http, () => ({
    apiBase: data.settings.apiBase,
    token: data.settings.token,
  }));
  const engine = new SyncEngine({
    vault,
    api,
    data,
    persist: () => {
      persisted += 1;
    },
    notify: (m) => notices.push(m),
    now: () => 5000,
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id),
  });
  return { vault, http, data, engine, notices, persisted: () => persisted };
}

function okPush(http: FakeHttp, seen: PushRequest[]) {
  http.on("POST", "/api/obsidian/notes/push", (_req, body) => {
    const req = body as PushRequest;
    seen.push(req);
    return {
      status: 200,
      json: {
        success: true,
        vault_id: req.vault_id,
        results: req.notes.map((n, i) => ({
          path: n.path,
          status: n.youspot_id ? "updated" : "created",
          object_id: n.youspot_id ?? `note_${i + 1}`,
          content_hash: `srv${i}`,
          synced_at: "2026-09-02T00:00:00Z",
        })),
        counts: {},
      },
    };
  });
}

describe("SyncEngine push", () => {
  test("a moved managed export cannot be pushed as an editable original", async () => {
    const { vault, http, engine, data } = setup();
    const seen: PushRequest[] = [];
    okPush(http, seen);
    const path = "Brain/Moved export.md";
    vault.add(path, "Managed projection with local edits", {
      frontmatter: { youspot_id: "company_1", youspot_managed: true },
      tags: [],
    });
    data.state.exports.company_1 = {
      path,
      type: "company",
      rendered_hash: "previous",
      updated_at: "",
      projection_version: 1,
    };
    await engine.pushNote(path, true);
    expect(seen).toEqual([]);
    expect(await vault.read(path)).toBe("Managed projection with local edits");
    expect(data.state.notes[path]).toBeUndefined();
  });

  test("pushes a note, stamps its id, and does not push again unchanged", async () => {
    const { vault, http, engine, data } = setup();
    const seen: PushRequest[] = [];
    okPush(http, seen);
    vault.add("Brain/a.md", "hello", { frontmatter: null, tags: ["#idea"] }, ["Brain/b.md"]);
    vault.add("Brain/b.md", "other");

    engine.handleChanged("Brain/a.md");
    engine.handleChanged("Brain/b.md");
    engine.handleChanged("Other/c.md");
    const summary = await engine.push();

    expect(summary.pushed).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.vault_id).toBe("vault1");
    expect(seen[0]?.vault_name).toBe("TestVault");
    expect(http.requests[0]?.headers.Authorization).toBe("Bearer mcp_t");
    const a = seen[0]?.notes.find((n) => n.path === "Brain/a.md");
    expect(a).toMatchObject({ title: "a", tags: ["idea"], wikilinks: [{ path: "Brain/b.md" }] });
    expect(vault.stamps).toEqual([
      ["Brain/a.md", "note_1"],
      ["Brain/b.md", "note_2"],
    ]);
    expect(data.state.notes["Brain/a.md"]?.youspot_id).toBe("note_1");
    expect(data.state.lastPushAt).toBe(5000);

    engine.handleChanged("Brain/a.md");
    const again = await engine.push();
    expect(again.pushed).toBe(0);
    expect(seen).toHaveLength(1);
  });

  test("a body edit re-pushes with the stamped id and the id survives a rename", async () => {
    const { vault, http, engine, data } = setup();
    const seen: PushRequest[] = [];
    okPush(http, seen);
    vault.add("Brain/a.md", "hello");
    engine.handleChanged("Brain/a.md");
    await engine.push();

    vault.files.set("Brain/a.md", {
      content: "---\nyouspot_id: note_1\n---\nhello again",
      mtime: 3000,
    });
    engine.handleChanged("Brain/a.md");
    await engine.push();
    expect(seen[1]?.notes[0]).toMatchObject({ youspot_id: "note_1", markdown: "hello again" });
    expect(seen[1]?.notes[0]?.frontmatter).toEqual({});

    await vault.rename("Brain/a.md", "Brain/z.md");
    engine.handleRenamed("Brain/a.md", "Brain/z.md");
    await engine.push();
    expect(seen[2]?.notes[0]).toMatchObject({ youspot_id: "note_1", path: "Brain/z.md" });
    expect(data.state.notes["Brain/z.md"]?.youspot_id).toBe("note_1");
    expect(data.state.notes["Brain/a.md"]).toBeUndefined();
  });

  test("deleting a pushed note calls the delete endpoint and forgets it", async () => {
    const { vault, http, engine, data } = setup();
    okPush(http, []);
    const deletes: unknown[] = [];
    http.on("POST", "/api/obsidian/notes/delete", (_r, body) => {
      deletes.push(body);
      return { status: 200, json: { success: true, results: [{ status: "deleted" }] } };
    });
    vault.add("Brain/a.md", "hello");
    engine.handleChanged("Brain/a.md");
    await engine.push();

    vault.files.delete("Brain/a.md");
    engine.handleDeleted("Brain/a.md");
    const summary = await engine.push();
    expect(summary.deleted).toBe(1);
    expect(deletes[0]).toEqual({
      vault_id: "vault1",
      notes: [
        {
          youspot_id: "note_1",
          expected_hash: "srv0",
          expected_path: "Brain/a.md",
          expected_synced_at: "2026-09-02T00:00:00Z",
        },
      ],
    });
    expect(data.state.notes["Brain/a.md"]).toBeUndefined();
  });

  test("conflict keeps the note pending and force overwrites", async () => {
    const { vault, http, engine, data, notices } = setup();
    const seen: PushRequest[] = [];
    http.on("POST", "/api/obsidian/notes/push", (_r, body) => {
      const req = body as PushRequest;
      seen.push(req);
      const note = req.notes[0];
      if (!note) throw new Error("no note");
      if (note.youspot_id && !note.force) {
        return {
          status: 200,
          json: {
            success: true,
            vault_id: "vault1",
            results: [
              {
                path: note.path,
                status: "conflict",
                object_id: note.youspot_id,
                server_hash: "s",
                server_updated_at: "t",
              },
            ],
            counts: {},
          },
        };
      }
      return {
        status: 200,
        json: {
          success: true,
          vault_id: "vault1",
          results: [
            {
              path: note.path,
              status: note.youspot_id ? "updated" : "created",
              object_id: note.youspot_id ?? "note_1",
              content_hash: "h",
              synced_at: "t",
            },
          ],
          counts: {},
        },
      };
    });
    vault.add("Brain/a.md", "v1");
    engine.handleChanged("Brain/a.md");
    await engine.push();

    vault.files.set("Brain/a.md", { content: "---\nyouspot_id: note_1\n---\nv2", mtime: 3000 });
    engine.handleChanged("Brain/a.md");
    const conflicted = await engine.push();
    expect(conflicted.conflicts).toBe(1);
    expect(data.state.notes["Brain/a.md"]?.conflict).toEqual({
      server_hash: "s",
      server_updated_at: "t",
    });
    expect(engine.conflicts).toBe(1);
    expect(notices.some((n) => n.includes("edited in YouSpot"))).toBe(true);

    await engine.pushNote("Brain/a.md", true);
    expect(seen[2]?.notes[0]?.force).toBe(true);
    expect(data.state.notes["Brain/a.md"]?.conflict).toBeUndefined();
  });

  test("401 halts the engine and records the error", async () => {
    const { vault, http, engine, data, notices } = setup();
    http.on("POST", "/api/obsidian/notes/push", () => ({
      status: 401,
      json: { error: "not_authenticated" },
    }));
    vault.add("Brain/a.md", "x");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    expect(data.state.lastError).toBe("not_authenticated");
    expect(engine.queue.size).toBe(1);
    expect(notices[0]).toContain("token rejected");
    await engine.push();
    expect(http.requests).toHaveLength(1);
  });

  test("a 403 reports a sync failure", async () => {
    const { vault, http, engine, notices } = setup();
    http.on("POST", "/api/obsidian/notes/push", () => ({
      status: 403,
      json: { error: "forbidden" },
    }));
    vault.add("Brain/a.md", "x");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    expect(notices[0]).toContain("sync failed");
  });

  test("5xx keeps the queue for retry with backoff", async () => {
    const { vault, http, engine } = setup();
    http.on("POST", "/api/obsidian/notes/push", () => ({ status: 503, json: { error: "down" } }));
    vault.add("Brain/a.md", "x");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    expect(engine.queue.size).toBe(1);
    await engine.push();
    expect(http.requests).toHaveLength(1);
    engine.stop();
  });
});

function changes(
  objects: ChangeObject[],
  extra: Partial<{ has_more: boolean; next_since: string; tombstones: unknown[] }> = {},
) {
  return {
    status: 200,
    json: {
      success: true,
      since: "",
      next_since: "2026-09-02T00:00:00Z",
      page: 1,
      per_page: 100,
      has_more: false,
      objects,
      tombstones: [],
      ...extra,
    },
  };
}

const jane: ChangeObject = {
  object_id: "per_1",
  type: "contact",
  name: "Jane",
  description: "desc",
  url: null,
  page_url: "https://youspot.com/brain/object/per_1",
  json_data: { email: "j@x.com" },
  fields: {},
  tags: [],
  connections: [],
  created_at: "",
  updated_at: "2026-09-01T00:00:00Z",
  origin: "brain",
};

describe("SyncEngine pull", () => {
  test("writes exports, advances the watermark, and managed writes never queue a push", async () => {
    const { vault, http, engine, data } = setup();
    http.on("GET", "/api/obsidian/changes", (req) => {
      const since = new URL(req.url).searchParams.get("since");
      return since ? changes([]) : changes([jane]);
    });
    const summary = await engine.pull();
    expect(summary.written).toBe(1);
    expect(vault.writes).toEqual(["Brain/YouSpot/Contacts/Jane.md"]);
    expect(vault.files.get("Brain/YouSpot/Contacts/Jane.md")?.content).toContain("email: j@x.com");
    expect(data.state.watermark).toBe("2026-09-02T00:00:00Z");
    expect(data.state.exports.per_1?.path).toBe("Brain/YouSpot/Contacts/Jane.md");

    engine.handleChanged("Brain/YouSpot/Contacts/Jane.md");
    expect(engine.queue.size).toBe(0);

    await engine.pull();
    expect(new URL(http.requests[1]?.url ?? "").searchParams.get("since")).toBe(
      "2026-09-02T00:00:00Z",
    );
  });

  test("a failing later page leaves the watermark untouched", async () => {
    const { http, engine, data } = setup();
    http.on("GET", "/api/obsidian/changes", (req) => {
      const page = new URL(req.url).searchParams.get("page");
      if (page === "1") return changes([jane], { has_more: true });
      return { status: 500, json: { error: "boom" } };
    });
    await engine.pull();
    expect(data.state.watermark).toBeNull();
    expect(data.state.lastError).toBe("boom");
    engine.stop();
  });

  test("tombstones trash unchanged legacy exports while title changes keep the path", async () => {
    const { vault, http, engine, data } = setup();
    let call = 0;
    http.on("GET", "/api/obsidian/changes", () => {
      call += 1;
      if (call === 1) return changes([jane]);
      if (call === 2) return changes([{ ...jane, name: "Jane Doe" }]);
      return changes([], {
        tombstones: [{ object_id: "per_1", type: "contact", deleted_at: "", obsidian: null }],
      });
    });
    await engine.pull();
    await engine.pull();
    expect(vault.renames).toEqual([]);
    expect(await vault.read("Brain/YouSpot/Contacts/Jane.md")).toContain("Jane Doe");
    await engine.pull();
    expect(vault.trashed).toEqual(["Brain/YouSpot/Contacts/Jane.md"]);
    expect(data.state.exports.per_1).toBeUndefined();
  });

  test("exported files are wikilink targets that push as object ids", async () => {
    const { vault, http, engine } = setup();
    http.on("GET", "/api/obsidian/changes", () => changes([jane]));
    const seen: PushRequest[] = [];
    okPush(http, seen);
    await engine.pull();
    vault.add("Brain/n.md", "see jane", undefined, ["Brain/YouSpot/Contacts/Jane.md"]);
    engine.handleChanged("Brain/n.md");
    await engine.push();
    expect(seen[0]?.notes[0]?.wikilinks).toEqual([{ object_id: "per_1" }]);
  });
});

describe("SyncEngine reconcile", () => {
  test("uploads discovered files and preserves server notes missing on this client", async () => {
    const { vault, http, engine, data } = setup();
    const seen: PushRequest[] = [];
    okPush(http, seen);
    const deletes: unknown[] = [];
    http.on("POST", "/api/obsidian/notes/delete", (_r, body) => {
      deletes.push(body);
      return { status: 200, json: { success: true, results: [] } };
    });
    http.on("GET", "/api/obsidian/notes", () => ({
      status: 200,
      json: {
        notes: [
          {
            object_id: "note_gone",
            path: "Brain/gone.md",
            content_hash: "",
            mtime: null,
            synced_at: null,
            updated_at: "",
            server_edited: false,
          },
        ],
        total: 1,
        page: 1,
        per_page: 100,
      },
    }));
    vault.add("Brain/new.md", "n");
    data.state.notes["Brain/missing.md"] = {
      youspot_id: "note_m",
      local_hash: "",
      content_hash: "",
      server_updated_at: "",
      last_pushed_at: 0,
    };
    await engine.reconcile();
    expect(seen[0]?.notes.map((n) => n.path)).toEqual(["Brain/new.md"]);
    expect(deletes).toEqual([]);
    expect(data.state.missing?.["Brain/gone.md"]?.objectId).toBe("note_gone");
    expect(data.state.notes["Brain/missing.md"]?.youspot_id).toBe("note_m");
  });

  test("pullServerVersion writes a conflict copy that never syncs", async () => {
    const { vault, http, engine, data } = setup();
    http.on("GET", "/api/obsidian/notes/note_1", () => ({
      status: 200,
      json: {
        object_id: "note_1",
        name: "A",
        description: "server text",
        updated_at: "t",
        obsidian: null,
        server_edited: true,
      },
    }));
    vault.add("Brain/a.md", "local");
    data.state.notes["Brain/a.md"] = {
      youspot_id: "note_1",
      local_hash: "",
      content_hash: "",
      server_updated_at: "",
      last_pushed_at: 0,
    };
    const target = await engine.pullServerVersion("Brain/a.md");
    expect(target).toBe("Brain/a.youspot-conflict.md");
    expect(vault.files.get(target ?? "")?.content).toContain("server text");
    engine.handleChanged(target ?? "");
    expect(engine.queue.size).toBe(0);
  });
});

describe("upload recovery and deletion safety", () => {
  test("a missing queued upsert never becomes a deletion", async () => {
    const { vault, http, engine, data } = setup();
    okPush(http, []);
    vault.add("Brain/a.md", "original");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    engine.handleChanged("Brain/a.md");
    vault.files.delete("Brain/a.md");
    await engine.push();
    expect(http.requests.filter((request) => request.url.endsWith("/delete"))).toEqual([]);
    expect(data.state.notes["Brain/a.md"]?.youspot_id).toBe("note_1");
  });

  test("moving an original out of scope preserves its Brain record", async () => {
    const { vault, http, engine, data } = setup();
    okPush(http, []);
    vault.add("Brain/a.md", "original");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    await vault.rename("Brain/a.md", "Outside/a.md");
    engine.handleRenamed("Brain/a.md", "Outside/a.md");
    await engine.push();
    expect(http.requests.filter((request) => request.url.endsWith("/delete"))).toEqual([]);
    expect(data.state.notes["Brain/a.md"]).toBeDefined();
  });

  test("a recreated original cancels deletion before the request", async () => {
    const { vault, http, engine } = setup();
    okPush(http, []);
    vault.add("Brain/a.md", "original");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    vault.files.delete("Brain/a.md");
    engine.handleDeleted("Brain/a.md");
    vault.add("Brain/a.md", "restored", { frontmatter: { youspot_id: "note_1" }, tags: [] });
    await engine.push();
    expect(http.requests.filter((request) => request.url.endsWith("/delete"))).toEqual([]);
  });

  test("a server deletion conflict keeps the identity and a reviewable failure", async () => {
    const { vault, http, engine, data } = setup();
    okPush(http, []);
    http.on("POST", "/api/obsidian/notes/delete", () => ({
      status: 200,
      json: { success: true, results: [{ status: "conflict", object_id: "note_1" }] },
    }));
    vault.add("Brain/a.md", "original");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    vault.files.delete("Brain/a.md");
    engine.handleDeleted("Brain/a.md");
    const result = await engine.push();
    expect(result.outcome).toBe("failed");
    expect(data.state.notes["Brain/a.md"]?.youspot_id).toBe("note_1");
    expect(data.state.failures?.["Brain/a.md"]?.entry.expectedHash).toBe("srv0");
  });

  test("permanent errors do not loop or disappear, and a restart can retry them", async () => {
    const first = setup();
    first.http.on("POST", "/api/obsidian/notes/push", (_request, body) => ({
      status: 200,
      json: {
        success: true,
        results: (body as PushRequest).notes.map((note) => ({
          path: note.path,
          status: "error",
          error: "brain_limit_reached",
        })),
      },
    }));
    first.vault.add("Brain/a.md", "original");
    first.engine.handleChanged("Brain/a.md");
    const result = await first.engine.push();
    expect(result.outcome).toBe("failed");
    expect(first.http.requests).toHaveLength(1);
    expect(first.data.state.lastPushAt).toBeNull();
    expect(first.data.state.failures?.["Brain/a.md"]?.hash).toBeDefined();
    first.engine.handleChanged("Brain/a.md");
    await first.engine.push();
    expect(first.http.requests).toHaveLength(1);
    const second = setup();
    second.data.state = structuredClone(first.data.state);
    second.vault.add("Brain/a.md", "original");
    second.engine.reloadState();
    okPush(second.http, []);
    await second.engine.retryFailed();
    expect(second.data.state.notes["Brain/a.md"]?.youspot_id).toBe("note_1");
    expect(second.engine.failedCount).toBe(0);
  });

  test("a successful download cannot clear a failed upload", async () => {
    const { vault, http, engine, data } = setup();
    http.on("POST", "/api/obsidian/notes/push", () => ({
      status: 200,
      json: {
        success: true,
        results: [{ path: "Brain/a.md", status: "error", error: "markdown_too_large" }],
      },
    }));
    http.on("GET", "/api/obsidian/changes", () => changes([]));
    vault.add("Brain/a.md", "original");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    await engine.pull();
    expect(data.state.lastPullAt).toBe(5000);
    expect(data.state.lastError).toBe("markdown_too_large");
    expect(data.state.uploadError).toBe("markdown_too_large");
  });

  test("sync now finds preexisting notes and edits with older modification times", async () => {
    const { vault, http, engine } = setup({ pullEnabled: false });
    const seen: PushRequest[] = [];
    okPush(http, seen);
    vault.add("Brain/a.md", "original");
    await engine.syncNow();
    vault.files.set("Brain/a.md", { content: "edited without a new timestamp", mtime: 1 });
    await engine.syncNow();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.notes[0]).toMatchObject({
      youspot_id: "note_1",
      markdown: "edited without a new timestamp",
    });
    await engine.syncNow();
    expect(seen).toHaveLength(2);
  });

  test("managed bytes are excluded even before metadata arrives", async () => {
    const { vault, http, engine } = setup({ pullEnabled: false });
    okPush(http, []);
    vault.add(
      "Brain/moved.md",
      '---\nyouspot_id: "company_1"\nyouspot_managed: true\n---\nmanaged',
    );
    vault.caches.delete("Brain/moved.md");
    engine.handleChanged("Brain/moved.md");
    await engine.syncNow();
    expect(http.requests).toEqual([]);
    expect(engine.failedCount).toBe(0);
  });

  test("a request failure reports failure and restores durable pending work", async () => {
    const { vault, http, engine, data } = setup();
    http.on("POST", "/api/obsidian/notes/push", () => ({
      status: 401,
      json: { error: "not_authenticated" },
    }));
    vault.add("Brain/a.md", "original");
    engine.handleChanged("Brain/a.md");
    const result = await engine.push();
    expect(result.errors).toBe(1);
    expect(result.outcome).toBe("failed");
    expect(data.state.pending?.[0]?.path).toBe("Brain/a.md");
    const blocked = await engine.pushNote("Brain/a.md");
    expect(blocked.outcome).toBe("deferred");
  });

  test("newer bytes arriving during upload remain eligible for acknowledgement", async () => {
    const { vault, http, engine, data } = setup();
    const seen: PushRequest[] = [];
    http.on("POST", "/api/obsidian/notes/push", async (_request, body) => {
      const request = body as PushRequest;
      seen.push(request);
      if (seen.length === 1) {
        vault.files.set("Brain/a.md", { content: "newer bytes", mtime: 2000 });
        engine.handleChanged("Brain/a.md");
      }
      return {
        status: 200,
        json: {
          success: true,
          results: request.notes.map((note) => ({
            path: note.path,
            status: "updated",
            object_id: "note_1",
            content_hash: note.markdown,
            synced_at: "t",
          })),
        },
      };
    });
    vault.add("Brain/a.md", "older bytes");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    expect(seen.map((request) => request.notes[0]?.markdown)).toEqual([
      "older bytes",
      "newer bytes",
    ]);
    expect(data.state.notes["Brain/a.md"]?.content_hash).toBe("newer bytes");
    expect(data.state.pending).toEqual([]);
  });

  test("queued full refresh cannot starve original uploads", async () => {
    const { vault, http, engine, data } = setup({ pullEnabled: false });
    const seen: PushRequest[] = [];
    okPush(http, seen);
    data.state.refresh = {
      account: "test@example.invalid",
      apiBase: data.settings.apiBase,
      root: "Brain/YouSpot",
      runId: "run_1",
      request: {
        obsidian_version: 1,
        space_id: "space",
        types: ["company"],
        attachments: "none",
        request_key: "key",
      },
    };
    http.on("GET", "/api/obsidian/me", () => ({
      status: 200,
      json: { email: "test@example.invalid", brain_count: 1 },
    }));
    http.on("GET", "/api/obsidian/exports/run_1", () => ({
      status: 200,
      json: { run: { id: "run_1", status: "queued" } },
    }));
    vault.add("Brain/a.md", "original");
    await engine.syncNow();
    expect(seen).toHaveLength(1);
    expect(data.state.refresh?.runId).toBe("run_1");
    expect(data.state.notes["Brain/a.md"]?.youspot_id).toBe("note_1");
  });

  test("a tombstoned original requires explicit restoration instead of a background resurrection", async () => {
    const { vault, http, engine, data } = setup();
    const seen: PushRequest[] = [];
    okPush(http, seen);
    vault.add("Brain/a.md", "original");
    await engine.syncNow();
    http.on("GET", "/api/obsidian/changes", () =>
      changes([], {
        tombstones: [
          {
            object_id: "note_1",
            type: "note",
            deleted_at: "now",
            obsidian: { vault_id: "vault1", path: "Brain/a.md" },
          },
        ],
      }),
    );
    await engine.syncNow();
    expect(data.state.failures?.["Brain/a.md"]?.error).toContain("Removed from Brain");
    vault.files.set("Brain/a.md", { content: "new local bytes", mtime: 8000 });
    engine.handleChanged("Brain/a.md");
    await engine.syncNow();
    await engine.retryFailed();
    expect(seen).toHaveLength(1);
    const refused = await engine.pushNote("Brain/a.md");
    expect(refused.outcome).toBe("failed");
    await engine.pushNote("Brain/a.md", true);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.notes[0]).toMatchObject({ force: true, youspot_id: "note_1" });
  });

  test("an empty queue cannot clear an authorization error without a successful account check", async () => {
    const { http, engine, data } = setup();
    data.state.uploadError = "not_authenticated";
    http.on("GET", "/api/obsidian/me", () => ({
      status: 401,
      json: { error: "not_authenticated" },
    }));
    const result = await engine.push();
    expect(result.outcome).toBe("failed");
    expect(data.state.uploadError).toBe("not_authenticated");
    expect(data.state.lastUploadCheckAt).toBeNull();
  });
});
