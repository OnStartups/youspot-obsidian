import { canonicalJSON } from "./sync/frontmatter";
import { DEFAULT_SETTINGS, emptyState, loadPluginData, newVaultId } from "./sync/state";
import type { PluginData, SyncState, YouSpotSettings } from "./types";

export interface LocalStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  close(): void;
}

export class IndexedLocalStore implements LocalStore {
  private database: Promise<IDBDatabase>;

  constructor(clientId: string, factory: IDBFactory = indexedDB) {
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(`youspot-${clientId}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error(request.error?.message ?? "Local database could not open."));
      request.onblocked = () => reject(new Error("Close the other copy of this vault and retry."));
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const request = db.transaction("local").objectStore("local").get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () =>
        reject(new Error(request.error?.message ?? "Local state could not be read."));
    });
  }

  async put(key: string, value: unknown): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("local", "readwrite", { durability: "strict" });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(new Error(transaction.error?.message ?? "Local state could not be saved."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Local save was cancelled."));
      transaction.objectStore("local").put(value, key);
    });
  }

  close(): void {
    void this.database.then((db) => db.close());
  }
}

export interface SecretPort {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

export interface SharedData {
  version: 3;
  vaultId: string;
  settings: SharedSettings;
}

export type SharedSettings = Omit<
  YouSpotSettings,
  "token" | "apiBase" | "appBase" | "capabilities" | "capabilitiesAccount"
>;

interface LegacySeed {
  state: SyncState;
  account?: string;
  apiBase: string;
  syncFolder: string;
  exportFolder: string;
}

interface Connection {
  apiBase: string;
  appBase: string;
  account: string | null;
  migrated: boolean;
}

const SHARED_KEYS = [
  "syncFolder",
  "exportFolder",
  "syncIntervalMinutes",
  "syncOnSave",
  "pullEnabled",
  "exportTypes",
  "exportSpaceId",
  "attachments",
  "selectionInitialized",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function sharedSettings(settings: YouSpotSettings): SharedSettings {
  return Object.fromEntries(SHARED_KEYS.map((key) => [key, settings[key]])) as SharedSettings;
}

export function readShared(raw: unknown, vaultId: string): SharedData {
  const input = record(raw);
  const loaded = loadPluginData(raw, () => vaultId);
  const settings = sharedSettings(loaded.settings);
  for (const key of ["syncFolder", "exportFolder", "exportSpaceId"] as const) {
    if (typeof settings[key] !== "string")
      throw new Error("Invalid synced folder or export selection.");
  }
  if (!Number.isFinite(settings.syncIntervalMinutes) || settings.syncIntervalMinutes < 0) {
    throw new Error("Invalid synced interval.");
  }
  for (const key of ["syncOnSave", "pullEnabled"] as const) {
    if (typeof settings[key] !== "boolean") throw new Error("Invalid synced option.");
  }
  if (!["none", "available"].includes(settings.attachments))
    throw new Error("Invalid attachment selection.");
  if (Object.values(settings.exportTypes).some((value) => typeof value !== "boolean")) {
    throw new Error("Invalid synced content types.");
  }
  return {
    version: 3,
    vaultId:
      typeof input.vaultId === "string" && input.vaultId ? input.vaultId : loaded.state.vaultId,
    settings,
  };
}

export function stateScope(settings: YouSpotSettings, account: string, vaultId: string): string {
  return JSON.stringify([
    settings.apiBase.replace(/\/+$/, ""),
    account,
    vaultId,
    settings.syncFolder,
    settings.exportFolder,
  ]);
}

export class PluginStorage {
  private connection!: Connection;
  private shared!: SharedData;
  private scope: string | null = null;
  private tail: Promise<void> = Promise.resolve();
  readonly secretId: string;

  constructor(
    readonly local: LocalStore,
    private readonly secrets: SecretPort,
    private readonly read: () => Promise<unknown>,
    private readonly write: (data: SharedData) => Promise<void>,
    clientId: string,
  ) {
    this.secretId = `youspot-${clientId}`;
  }

  async load(): Promise<PluginData> {
    const raw = await this.read();
    const legacy = loadPluginData(raw);
    this.shared = readShared(raw, legacy.state.vaultId);
    this.connection = (await this.local.get<Connection>("connection")) ?? {
      apiBase: DEFAULT_SETTINGS.apiBase,
      appBase: DEFAULT_SETTINGS.appBase,
      account: null,
      migrated: false,
    };
    if (!this.connection.migrated) {
      if (record(raw).version !== 3) {
        this.connection.apiBase = legacy.settings.apiBase;
        this.connection.appBase = legacy.settings.appBase;
        const {
          refresh: _refresh,
          pendingWrites: _pending,
          refreshReport: _report,
          ...seed
        } = legacy.state;
        await this.local.put("legacy", {
          state: seed,
          account: legacy.settings.capabilitiesAccount,
          apiBase: legacy.settings.apiBase,
          syncFolder: legacy.settings.syncFolder,
          exportFolder: legacy.settings.exportFolder,
        } satisfies LegacySeed);
        if (legacy.settings.token && !this.secrets.getSecret(this.secretId)) {
          this.secrets.setSecret(this.secretId, legacy.settings.token);
          if (this.secrets.getSecret(this.secretId) !== legacy.settings.token) {
            throw new Error(
              "Could not save the local connection. Existing settings were preserved.",
            );
          }
        }
      }
      this.connection.migrated = true;
      await this.local.put("connection", this.connection);
      if (!(await this.local.get<Connection>("connection"))?.migrated) {
        throw new Error("Could not verify the local migration. Existing settings were preserved.");
      }
    }
    if (record(raw).version !== 3) await this.write(this.shared);
    const unbound = await this.local.get<SyncState>("unbound");
    return {
      version: 3,
      settings: {
        ...DEFAULT_SETTINGS,
        ...this.shared.settings,
        apiBase: this.connection.apiBase,
        appBase: this.connection.appBase,
        token: this.secrets.getSecret(this.secretId) ?? "",
      },
      state: {
        ...emptyState(this.shared.vaultId),
        uploadError: unbound?.uploadError ?? null,
        lastError: unbound?.lastError ?? null,
      },
    };
  }

  async bind(data: PluginData, account: string): Promise<void> {
    const scope = stateScope(data.settings, account, data.state.vaultId);
    const stored = await this.local.get<SyncState>(scope);
    const legacy = await this.local.get<LegacySeed>("legacy");
    data.state =
      stored ??
      (legacy &&
      legacy.state.vaultId === data.state.vaultId &&
      (!legacy.account || legacy.account === account) &&
      legacy.apiBase === data.settings.apiBase &&
      legacy.syncFolder === data.settings.syncFolder &&
      legacy.exportFolder === data.settings.exportFolder
        ? legacy.state
        : emptyState(data.state.vaultId));
    this.scope = scope;
    this.connection.account = account;
    await this.save(data);
    if (legacy) await this.local.put("legacy", null);
  }

  save(data: PluginData): Promise<void> {
    const scope = this.scope ?? "unbound";
    const state = structuredClone(data.state);
    const connection = {
      ...this.connection,
      apiBase: data.settings.apiBase,
      appBase: data.settings.appBase,
    };
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        await this.local.put(scope, state);
        await this.local.put("connection", connection);
        this.connection = connection;
      });
    return this.tail;
  }

  async preferences(patch: Partial<YouSpotSettings>): Promise<SharedData> {
    await this.tail;
    const incoming = readShared(await this.read(), this.shared.vaultId);
    const settings = {
      ...incoming.settings,
      ...Object.fromEntries(
        SHARED_KEYS.filter((key) => key in patch).map((key) => [key, patch[key]]),
      ),
    };
    const next = readShared({ version: 3, vaultId: incoming.vaultId, settings }, incoming.vaultId);
    if (canonicalJSON(incoming) !== canonicalJSON(next)) await this.write(next);
    this.shared = next;
    return next;
  }

  async external(): Promise<SharedData> {
    this.shared = readShared(await this.read(), this.shared.vaultId);
    return this.shared;
  }

  unbind(): void {
    this.scope = null;
    this.connection.account = null;
  }

  token(value: string): void {
    this.secrets.setSecret(this.secretId, value);
    if ((this.secrets.getSecret(this.secretId) ?? "") !== value) {
      throw new Error("Could not save the local token.");
    }
  }
}

export function localClientId(load: () => unknown, save: (id: string) => void): string {
  const value = load();
  if (typeof value === "string" && /^[a-z0-9]+$/.test(value)) return value;
  const id = newVaultId();
  save(id);
  if (load() !== id) throw new Error("Could not save this installation's identity.");
  return id;
}
