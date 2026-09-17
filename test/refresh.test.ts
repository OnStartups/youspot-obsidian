import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import fixture from "./fixtures/brain-export.json";
import { MemoryVault } from "./memory-vault";
import { ApiClient, type HttpPort, type HttpRequest, type HttpResponse } from "../src/api";
import { readArchive } from "../src/sync/archive";
import { applyArchive, discoverExports, refreshBrain } from "../src/sync/refresh";
import { hashBytes, sha256Hex } from "../src/sync/hash";
import { applyCapabilities, loadPluginData } from "../src/sync/state";
import type { ExportCapabilities, ExportRun } from "../src/types";

const capabilities: ExportCapabilities = {
  obsidian_version: 1,
  archive_version: 1,
  renderer_version: 1,
  active_space_id: "space",
  spaces: [{ id: "space", name: "Brain", counts: {} }],
  types: [...new Set(fixture.records.map((r) => r.type))].map((type) => ({
    type,
    label: type,
    classification: "document",
    default: true,
    fields: {},
    reason: "",
  })),
  incremental_types: ["note", "company"],
  legacy_default_types: ["note", "company"],
  attachment_modes: ["none", "available"],
  limits: { archive_bytes: 50 * 1024 * 1024, records: 20000, assets: 2000 },
};

async function packaged(extra: Record<string, string> = {}) {
  const run: ExportRun = {
    id: "run1",
    status: "ready",
    error: null,
    bytes: null,
    sha256: null,
    options: {
      space_id: "space",
      types: capabilities.types.map((t) => t.type),
      attachments: "available",
    },
    report: fixture.report,
  };
  const files: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  const lines = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  const contents = {
    ...fixture.files,
    "records.ndjson": lines(fixture.records),
    "relationships.ndjson": lines(fixture.relationships),
    "assets.ndjson": lines(fixture.assets),
    "obsidian.ndjson": lines(fixture.identities),
    "report.json": JSON.stringify(fixture.report),
    ...extra,
  };
  const hashes: Record<string, { bytes: number; sha256: string }> = {};
  for (const [path, content] of Object.entries(contents)) {
    const bytes = encoder.encode(content);
    files[path] = bytes;
    hashes[path] = { bytes: bytes.length, sha256: await hashBytes(bytes) };
  }
  files["manifest.json"] = encoder.encode(
    JSON.stringify({
      obsidian_version: 1,
      archive_version: 1,
      renderer_version: 1,
      run_id: run.id,
      selection: run.options,
      files: hashes,
    }),
  );
  const bytes = zipSync(files);
  run.bytes = bytes.length;
  run.sha256 = await hashBytes(bytes);
  return { run, bytes, archive: await readArchive(bytes, run) };
}

function setup() {
  const data = loadPluginData(null, () => "current-vault");
  data.settings.syncFolder = "Brain";
  data.settings.token = "mcp_test";
  data.settings.attachments = "available";
  applyCapabilities(data.settings, capabilities);
  const vault = new MemoryVault();
  const http: HttpPort = {
    request: async () => {
      throw new Error("Unexpected HTTP");
    },
  };
  return {
    data,
    vault,
    api: new ApiClient(http, () => data.settings),
    persist: async () => {},
    notify: (_message: string) => {},
  };
}

const first = fixture.records[0]!;
const last = fixture.records.at(-1)!;

const exported = (path: string) => `Brain/YouSpot/${path}`;

describe("shared archive delivery", () => {
  test("renders the shared bodies, fields and directed links with identical content", async () => {
    const { archive } = await packaged();
    const deps = setup();
    const report = await applyArchive(deps, archive, "run1");
    expect(report.written).toBe(fixture.records.length);
    expect(report.assets).toBe(1);
    expect(report.conflicts).toEqual([]);
    for (const record of fixture.records) {
      const content = await deps.vault.read(exported(record.path));
      expect(content).toContain(`youspot_id: "${archive.identities.get(record.id)}"`);
      if (record.type !== "email_message") {
        expect(content.replace(/^---\nyouspot_id: [^\n]*\nyouspot_managed: true\n/, "---\n")).toBe(
          fixture.files[record.path as keyof typeof fixture.files],
        );
      } else {
        expect(content).toContain("Complete email **body**.");
        expect(content).toContain(fixture.assets[0]!.sha256);
      }
    }
    expect(await deps.vault.read(exported(first.path))).toContain("Outgoing related");
    expect(await deps.vault.read(exported(last.path))).toContain("Incoming related");
  });

  test("resolves later targets to current originals and exports other-vault notes", async () => {
    const { archive } = await packaged();
    const deps = setup();
    deps.vault.add("Brain/Original.md", "Local original", {
      frontmatter: { youspot_id: "fixture_6" },
      tags: [],
    });
    const report = await applyArchive(deps, archive, "run1");
    expect(report.originals).toBe(1);
    expect(report.written).toBe(fixture.records.length - 1);
    expect(await deps.vault.read("Brain/Original.md")).toBe("Local original");
    expect(deps.vault.exists(exported(last.path))).toBe(false);
    expect(await deps.vault.read(exported(first.path))).toContain("](../../../Original.md)");
    expect(deps.vault.exists(exported(first.path))).toBe(true);
  });

  test("preserves unmanaged files, title changes, local edits and deselected documents", async () => {
    const { archive } = await packaged();
    const deps = setup();
    deps.vault.add(exported(first.path), "Unmanaged file");
    await applyArchive(deps, archive, "run1");
    expect(await deps.vault.read(exported(first.path))).toBe("Unmanaged file");
    const path = deps.data.state.exports.fixture_1!.path;
    expect(path).not.toBe(exported(first.path));
    await deps.vault.write(path, "Edited locally");
    archive.records[0]!.title = "New title";
    const repeated = await applyArchive(deps, archive, "run2");
    expect(repeated.conflicts).toContainEqual({
      path,
      reason: expect.stringContaining("Local edits"),
    });
    expect(await deps.vault.read(path)).toBe("Edited locally");
    deps.data.settings.exportTypes.note = false;
    archive.records = archive.records.filter((r) => r.type !== "note");
    await applyArchive(deps, archive, "run3");
    expect(await deps.vault.read(path)).toBe("Edited locally");
    expect(deps.vault.trashed).toEqual([]);
  });

  test("upgrades a legacy path only when its saved hash matches", async () => {
    const { archive } = await packaged();
    const deps = setup();
    const path = "Brain/YouSpot/Notes/Old name.md";
    deps.vault.add(path, "Old export");
    deps.data.state.exports.fixture_1 = {
      path,
      rendered_hash: await sha256Hex("Old export"),
      type: "note",
      updated_at: "",
    };
    await applyArchive(deps, archive, "run1");
    expect(deps.data.state.exports.fixture_1.path).toBe(path);
    expect(await deps.vault.read(path)).toContain("An original **Markdown** note.");
    expect(deps.vault.exists(exported(first.path))).toBe(false);
  });

  test("resumes a crash after the file write but before the state checkpoint", async () => {
    const { archive } = await packaged();
    const deps = setup();
    const write = deps.vault.writeGuarded.bind(deps.vault);
    let interrupted = false;
    deps.vault.writeGuarded = async (path, content, previous) => {
      await write(path, content, previous);
      if (!interrupted) {
        interrupted = true;
        throw new Error("Simulated interruption");
      }
      return true;
    };
    await expect(applyArchive(deps, archive, "run1")).rejects.toThrow("Simulated interruption");
    expect(deps.data.state.pendingWrites?.fixture_1).toBeDefined();
    const report = await applyArchive(deps, archive, "run1");
    expect(report.conflicts).toEqual([]);
    expect(report.written).toBe(fixture.records.length);
    expect(deps.data.state.pendingWrites).toEqual({});
  });

  test("detects an edit between checking and writing", async () => {
    const { archive } = await packaged();
    const deps = setup();
    await applyArchive(deps, archive, "run1");
    const write = deps.vault.writeGuarded.bind(deps.vault);
    deps.vault.writeGuarded = async (path, content, previous) => {
      if (path === exported(first.path)) await deps.vault.write(path, "Concurrent edit");
      return write(path, content, previous);
    };
    const report = await applyArchive(deps, archive, "run2");
    expect(await deps.vault.read(exported(first.path))).toBe("Concurrent edit");
    expect(report.conflicts.some((c) => c.path === exported(first.path))).toBe(true);
  });

  test("reports modified local attachments without linking to them as captured bytes", async () => {
    const { archive } = await packaged();
    const deps = setup();
    await applyArchive(deps, archive, "run1");
    const asset = deps.vault.listPaths().find((path) => path.includes("/assets/"))!;
    await deps.vault.write(asset, "Modified attachment");
    const report = await applyArchive(deps, archive, "run2");
    expect(report.assets).toBe(0);
    expect(report.conflicts.some((c) => c.path === asset)).toBe(true);
    expect(await deps.vault.read(exported(fixture.records[2]!.path))).toContain(
      "attachment unavailable locally",
    );
    expect(await deps.vault.read(asset)).toBe("Modified attachment");
  });

  test("rejects corrupted archives and path traversal before any vault writes", async () => {
    const { bytes, run } = await packaged();
    await expect(readArchive(bytes, { ...run, sha256: "wrong" })).rejects.toThrow("integrity");
    await expect(packaged({ "../outside.md": "escape" })).rejects.toThrow("unsafe paths");
  });

  test("rejects documents outside the selected types even with valid checksums", async () => {
    const records = fixture.records.map((record, index) =>
      index === 0 ? { ...record, type: "unselected_type" } : record,
    );
    await expect(
      packaged({ "records.ndjson": records.map((record) => JSON.stringify(record)).join("\n") }),
    ).rejects.toThrow("document inventory is invalid");
  });
});

describe("refresh protocol", () => {
  test.each([false, true])(
    "discovers both resources together and saves only complete results (failure: %s)",
    async (fail) => {
      const deps = setup();
      const before = structuredClone(deps.data.settings);
      const discovered: ExportCapabilities = {
        ...capabilities,
        active_space_id: "new-space",
        spaces: [{ id: "new-space", name: "New brain", counts: {} }],
      };
      let finishAccount!: (response: HttpResponse) => void;
      const account = new Promise<HttpResponse>((resolve) => {
        finishAccount = resolve;
      });
      const requested: string[] = [];
      deps.api = new ApiClient(
        {
          request: async (request) => {
            const path = new URL(request.url).pathname;
            requested.push(path);
            return path.endsWith("/me")
              ? account
              : { status: 200, text: JSON.stringify(discovered) };
          },
        },
        () => deps.data.settings,
      );
      const saved: unknown[] = [];
      deps.persist = async () => {
        saved.push(structuredClone(deps.data.settings));
      };

      const pending = discoverExports(deps);
      expect(requested).toEqual(["/api/obsidian/me", "/api/obsidian/export/capabilities"]);
      expect(saved).toEqual([]);
      expect(deps.data.settings).toEqual(before);
      finishAccount({
        status: fail ? 401 : 200,
        text: JSON.stringify(
          fail ? { error: "not_authenticated" } : { email: "owner@example.invalid" },
        ),
      });
      if (fail) {
        await expect(pending).rejects.toThrow("not_authenticated");
        expect(saved).toEqual([]);
        expect(deps.data.settings).toEqual(before);
      } else {
        await pending;
        expect(saved).toHaveLength(1);
        expect(deps.data.settings.capabilitiesAccount).toBe("owner@example.invalid");
        expect(deps.data.settings.capabilities).toEqual(discovered);
      }
    },
  );

  test("negotiates, resumes a queued capture, downloads without bearer leakage, and releases it", async () => {
    const { run, bytes } = await packaged();
    const deps = setup();
    const requests: HttpRequest[] = [];
    let ready = false;
    const http: HttpPort = {
      request: async (req) => {
        requests.push(req);
        if (req.url === "https://storage.example/export")
          return { status: 200, text: "", bytes: new Uint8Array(bytes).buffer };
        const path = new URL(req.url).pathname;
        const body = path.endsWith("/me")
          ? { email: "test@example.invalid" }
          : path.endsWith("/capabilities")
            ? capabilities
            : path.endsWith("/download")
              ? { url: "https://storage.example/export" }
              : path.endsWith("/release")
                ? { success: true }
                : { run: { ...run, status: ready ? "ready" : "queued" } };
        return { status: 200, text: JSON.stringify(body) };
      },
    };
    deps.api = new ApiClient(http, () => deps.data.settings);
    expect(await refreshBrain(deps)).toBeNull();
    expect(deps.data.state.refresh?.runId).toBe(run.id);
    ready = true;
    const result = await refreshBrain(deps);
    expect(result?.written).toBe(fixture.records.length);
    expect(
      requests.filter((req) => req.method === "POST" && req.url.endsWith("/exports")),
    ).toHaveLength(1);
    expect(requests.find((req) => req.url === "https://storage.example/export")?.headers).toEqual(
      {},
    );
    expect(requests.at(-1)?.url).toEndWith("/release");
    expect(deps.data.state.refresh).toBeUndefined();
  });

  test("preserves upgraded selections and leaves newly supported types opt-in", () => {
    const data = loadPluginData({
      version: 1,
      settings: { exportTypes: { note: false } },
      state: { vaultId: "old" },
    });
    applyCapabilities(data.settings, capabilities);
    expect(data.settings.exportTypes.note).toBe(false);
    expect(data.settings.exportTypes.company).toBe(true);
    expect(data.settings.exportTypes.email_message).toBe(false);
    expect(data.state.vaultId).toBe("old");
    const newType = { ...capabilities.types[0]!, type: "new_type", default: true };
    applyCapabilities(data.settings, { ...capabilities, types: [...capabilities.types, newType] });
    expect(data.settings.exportTypes.new_type).toBe(false);
  });
});
