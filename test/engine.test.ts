import { describe, expect, test } from "bun:test";
import { ApiClient, type HttpPort, type HttpRequest } from "../src/api";
import { SyncEngine } from "../src/sync/engine";
import { splitFrontmatter } from "../src/sync/frontmatter";
import { DEFAULT_SETTINGS, emptyState } from "../src/sync/state";
import type { ChangeObject, PluginData, PushRequest } from "../src/types";
import type { FileCache, FileMeta, VaultPort } from "../src/vault-port";

class MemoryVault implements VaultPort {
  files = new Map<string, { content: string; mtime: number }>();
  caches = new Map<string, FileCache>();
  links = new Map<string, string[]>();
  writes: string[] = [];
  trashed: string[] = [];
  renames: [string, string][] = [];
  stamps: [string, string][] = [];

  add(path: string, content: string, cache?: FileCache, links: string[] = []) {
    this.files.set(path, { content, mtime: 1000 });
    this.caches.set(path, cache ?? { frontmatter: null, tags: [] });
    this.links.set(path, links);
  }
  vaultName() {
    return "TestVault";
  }
  listMarkdown(): FileMeta[] {
    return [...this.files].map(([path, f]) => ({ path, basename: path, mtime: f.mtime }));
  }
  stat(path: string) {
    const f = this.files.get(path);
    return f ? { path, basename: path, mtime: f.mtime } : null;
  }
  async read(path: string) {
    return this.files.get(path)?.content ?? "";
  }
  async write(path: string, content: string) {
    this.writes.push(path);
    this.files.set(path, { content, mtime: 2000 });
  }
  async rename(from: string, to: string) {
    this.renames.push([from, to]);
    const f = this.files.get(from);
    if (f) {
      this.files.delete(from);
      this.files.set(to, f);
    }
  }
  async trash(path: string) {
    this.trashed.push(path);
    this.files.delete(path);
  }
  async ensureFolder() {}
  cache(path: string) {
    return this.caches.get(path) ?? null;
  }
  resolvedLinks(path: string) {
    return this.links.get(path) ?? [];
  }
  async stampFrontmatter(path: string, key: string, value: string) {
    this.stamps.push([path, value]);
    const f = this.files.get(path);
    if (!f) return;
    const { body } = splitFrontmatter(f.content);
    f.content = `---\n${key}: ${value}\n---\n${body}`;
    const cache = this.caches.get(path) ?? { frontmatter: null, tags: [] };
    cache.frontmatter = { ...cache.frontmatter, [key]: value };
  }
}

type Handler = (req: HttpRequest, body: unknown) => { status: number; json: unknown };

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
    const out = handler(req, body);
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
    // Obsidian passes window's timers; here plain globals are enough, and
    // the engine never reaches for either itself.
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
    expect(deletes[0]).toEqual({ vault_id: "vault1", notes: [{ youspot_id: "note_1" }] });
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

  test("403 not_enabled halts without blaming the token", async () => {
    const { vault, http, engine, data, notices } = setup();
    http.on("POST", "/api/obsidian/notes/push", () => ({
      status: 403,
      json: { error: "not_enabled" },
    }));
    vault.add("Brain/a.md", "x");
    engine.handleChanged("Brain/a.md");
    await engine.push();
    expect(data.state.lastError).toBe("not_enabled");
    expect(engine.queue.size).toBe(1);
    expect(notices[0]).toContain("not enabled");
    expect(notices[0]).not.toContain("token");
    await engine.push();
    expect(http.requests).toHaveLength(1);
  });

  test("a plain 403 is not treated as the feature being off", async () => {
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

  test("tombstones trash the export and renames follow the object", async () => {
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
    expect(vault.renames).toEqual([
      ["Brain/YouSpot/Contacts/Jane.md", "Brain/YouSpot/Contacts/Jane Doe.md"],
    ]);
    await engine.pull();
    expect(vault.trashed).toEqual(["Brain/YouSpot/Contacts/Jane Doe.md"]);
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
  test("queues new and missing files and deletes server notes gone from disk", async () => {
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
    expect(deletes[0]).toEqual({
      vault_id: "vault1",
      notes: [{ youspot_id: "note_m" }, { youspot_id: "note_gone" }],
    });
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
