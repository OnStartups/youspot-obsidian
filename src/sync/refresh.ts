import type { ApiClient } from "../api";
import type { PluginData, RefreshReport } from "../types";
import type { VaultPort } from "../vault-port";
import { type BrainArchive, readArchive, relocateDocument, safePath } from "./archive";
import { hashBytes, sha256Hex } from "./hash";
import { dirname, exportRoot, isInFolder, isSyncable, joinPath, safeFileName } from "./paths";
import { applyCapabilities } from "./state";

export interface RefreshDeps {
  vault: VaultPort;
  api: ApiClient;
  data: PluginData;
  persist: () => Promise<void> | void;
  notify: (message: string) => void;
}

export async function discoverExports(deps: RefreshDeps): Promise<void> {
  const [me, capabilities] = await Promise.all([deps.api.me(), deps.api.capabilities()]);
  applyCapabilities(deps.data.settings, capabilities);
  deps.data.settings.capabilitiesAccount = me.email;
  await deps.persist();
}

export async function applyArchive(
  deps: RefreshDeps,
  archive: BrainArchive,
  runId: string,
): Promise<RefreshReport> {
  const { vault, data } = deps;
  const state = data.state;
  const rules = data.settings;
  const root = exportRoot(rules);
  if (!safePath(root) || !rules.syncFolder || !rules.exportFolder)
    throw new Error("Choose safe sync and export folders before refreshing.");
  const paths = new Map<string, string | null>();
  const originals = new Map<string, string>();
  const taken = new Set(vault.listPaths().map((path) => path.toLocaleLowerCase()));
  const assigned = new Set<string>();
  const report: RefreshReport = {
    runId,
    written: 0,
    originals: 0,
    assets: 0,
    conflicts: [],
    coverage: archive.report,
  };
  for (const file of vault.listMarkdown().sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isSyncable(file.path, rules)) continue;
    const fm = vault.cache(file.path)?.frontmatter;
    if (fm?.youspot_managed) continue;
    const id = state.notes[file.path]?.youspot_id ?? fm?.youspot_id;
    if (typeof id === "string" && !originals.has(id)) originals.set(id, file.path);
  }
  const targets = new Map<string, string>();
  for (const record of archive.records) {
    const id = archive.identities.get(record.id)!;
    const original = originals.get(id);
    if (original) {
      paths.set(record.path, original);
      report.originals++;
      continue;
    }
    const existing = state.exports[id];
    let path = existing?.path ?? joinPath(root, record.path);
    if (!safePath(path) || !isInFolder(path, root))
      throw new Error(
        "A managed document has moved outside the export folder. Restore its location before refreshing.",
      );
    if (existing) {
      if (assigned.has(path.toLocaleLowerCase()))
        throw new Error(
          "Two managed documents claim the same path. Resolve the duplicate before refreshing.",
        );
    } else {
      const base = path.slice(0, -3);
      let suffix = 1;
      const pending = state.pendingWrites?.[id];
      if (pending && safePath(pending.path) && isInFolder(pending.path, root)) path = pending.path;
      while (
        (taken.has(path.toLocaleLowerCase()) && pending?.path !== path) ||
        assigned.has(path.toLocaleLowerCase())
      ) {
        path = `${base}-${suffix++}.md`;
      }
    }
    taken.add(path.toLocaleLowerCase());
    assigned.add(path.toLocaleLowerCase());
    targets.set(id, path);
    paths.set(record.path, path);
  }
  for (const asset of archive.assets) {
    if (asset.status !== "captured" || !asset.path || !asset.sha256) continue;
    const path = joinPath(
      root,
      "assets",
      `${asset.sha256}--${safeFileName(asset.path.split("/").at(-1) ?? "attachment")}`,
    );
    if (!safePath(path)) throw new Error("The attachment has an unsafe path.");
    if (vault.exists(path)) {
      if (
        !vault.stat(path) ||
        (await hashBytes(new Uint8Array(await vault.readBinary(path)))) !== asset.sha256
      ) {
        report.conflicts.push({
          path,
          reason: "A local attachment differs from the captured bytes.",
        });
        paths.set(asset.path, null);
        continue;
      }
    } else {
      await vault.ensureFolder(dirname(path));
      await vault.createBinary(path, new Uint8Array(archive.files[asset.path]!).buffer);
    }
    paths.set(asset.path, path);
    report.assets++;
  }
  for (const record of archive.records) {
    const id = archive.identities.get(record.id)!;
    const path = targets.get(id);
    if (!path) continue;
    const content = relocateDocument(
      new TextDecoder().decode(archive.files[record.path]),
      record.path,
      path,
      paths,
      id,
    );
    const hash = await sha256Hex(content);
    const existing = state.exports[id];
    const pending = state.pendingWrites?.[id];
    let previous: string | null = null;
    if (vault.exists(path)) {
      if (!vault.stat(path)) {
        report.conflicts.push({ path, reason: "A folder occupies this document path." });
        continue;
      }
      previous = await vault.read(path);
      const actual = await sha256Hex(previous);
      if (
        actual !== existing?.rendered_hash &&
        !(pending?.path === path && actual === pending.hash)
      ) {
        report.conflicts.push({
          path,
          reason:
            "Local edits were preserved. Restore the last exported bytes, or copy your edits to a separate note and delete this managed file before retrying.",
        });
        continue;
      }
    }
    state.pendingWrites ??= {};
    state.pendingWrites[id] = { path, hash };
    await deps.persist();
    await vault.ensureFolder(dirname(path));
    if (!(await vault.writeGuarded(path, content, previous))) {
      report.conflicts.push({
        path,
        reason: "The document changed during refresh. Local edits were preserved.",
      });
      delete state.pendingWrites[id];
      await deps.persist();
      continue;
    }
    state.exports[id] = {
      path,
      type: record.type,
      rendered_hash: hash,
      updated_at: record.updated_at,
      projection_version: 1,
    };
    delete state.pendingWrites[id];
    report.written++;
    await deps.persist();
  }
  state.refreshReport = report;
  await deps.persist();
  return report;
}

export async function refreshBrain(deps: RefreshDeps): Promise<RefreshReport | null> {
  const { data, api } = deps;
  const me = await api.me();
  if (!data.state.refresh) {
    await discoverExports(deps);
    const settings = data.settings;
    const supported = new Set(
      settings
        .capabilities!.types.filter((item) => ["document", "context"].includes(item.classification))
        .map((item) => item.type),
    );
    const types = Object.entries(settings.exportTypes)
      .filter(([type, enabled]) => enabled && supported.has(type))
      .map(([type]) => type);
    if (!types.length) throw new Error("Select at least one content type in settings.");
    const root = exportRoot(settings);
    if (!settings.syncFolder || !settings.exportFolder || !safePath(root))
      throw new Error("Choose safe sync and export folders before refreshing.");
    data.state.refresh = {
      request: {
        obsidian_version: 1,
        space_id: settings.exportSpaceId,
        types,
        attachments: settings.attachments,
        request_key: crypto.randomUUID(),
      },
      account: me.email,
      apiBase: settings.apiBase,
      root,
    };
    await deps.persist();
  }
  const pending = data.state.refresh;
  if (
    pending.account !== me.email ||
    pending.apiBase !== data.settings.apiBase ||
    pending.root !== exportRoot(data.settings)
  )
    throw new Error(
      "Return to the account, server and folders used when this refresh started, or cancel it first.",
    );
  if (pending.releasePending && pending.runId) {
    await api.releaseExport(pending.runId);
    delete data.state.refresh;
    await deps.persist();
    return data.state.refreshReport ?? null;
  }
  if (!pending.runId) {
    const { run } = await api.createExport(pending.request);
    pending.runId = run.id;
    await deps.persist();
  }
  const { run } = await api.exportStatus(pending.runId);
  if (["failed", "expired", "cancelled"].includes(run.status)) {
    delete data.state.refresh;
    await deps.persist();
    throw new Error(run.error ?? "The export expired or was cancelled. Start another refresh.");
  }
  if (!["ready", "partial"].includes(run.status)) {
    deps.notify(
      `YouSpot: full refresh ${run.status}. It will continue on the next sync, or run full refresh again.`,
    );
    return null;
  }
  const archive = await readArchive(await api.downloadExport(run.id), run);
  const report = await applyArchive(deps, archive, run.id);
  pending.releasePending = true;
  await deps.persist();
  await api.releaseExport(run.id);
  delete data.state.refresh;
  data.state.lastPullAt = Date.now();
  await deps.persist();
  deps.notify(
    `YouSpot: ${report.written} documents refreshed, ${report.originals} originals kept, ${report.assets} attachments, ${report.conflicts.length} local conflicts. See the refresh report in settings.`,
  );
  return report;
}
