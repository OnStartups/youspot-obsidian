import type {
  ChangesResponse,
  DeleteRef,
  DeleteResponse,
  InventoryResponse,
  MeResponse,
  PushRequest,
  PushResponse,
  ServerNote,
} from "./types";

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export interface HttpPort {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface ApiConfig {
  apiBase: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get unauthorized(): boolean {
    return this.status === 401;
  }

  get disabled(): boolean {
    return this.status === 403 && this.code === "not_enabled";
  }

  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class ApiClient {
  constructor(
    private readonly http: HttpPort,
    private readonly config: () => ApiConfig,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const { apiBase, token } = this.config();
    if (!token) throw new ApiError("No token configured", 401, "no_token");
    const base = apiBase.replace(/\/+$/, "");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: HttpResponse;
    try {
      res = await this.http.request({
        url: `${base}${path}`,
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(err instanceof Error ? err.message : "Network error", 0, "network");
    }
    const json = parseJson(res.text);
    if (res.status < 200 || res.status >= 300) {
      const code = typeof json?.error === "string" ? json.error : undefined;
      throw new ApiError(code ?? `${path} failed with ${res.status}`, res.status, code);
    }
    if (!json) throw new ApiError(`${path} returned no JSON`, res.status, "bad_json");
    return json as T;
  }

  me(): Promise<MeResponse> {
    return this.call("GET", "/api/obsidian/me");
  }

  push(req: PushRequest): Promise<PushResponse> {
    return this.call("POST", "/api/obsidian/notes/push", req);
  }

  deleteNotes(vaultId: string, notes: DeleteRef[]): Promise<DeleteResponse> {
    return this.call("POST", "/api/obsidian/notes/delete", { vault_id: vaultId, notes });
  }

  inventory(vaultId: string, page = 1, perPage = 100): Promise<InventoryResponse> {
    const q = new URLSearchParams({
      vault_id: vaultId,
      page: String(page),
      per_page: String(perPage),
    });
    return this.call("GET", `/api/obsidian/notes?${q}`);
  }

  note(objectId: string): Promise<ServerNote> {
    return this.call("GET", `/api/obsidian/notes/${encodeURIComponent(objectId)}`);
  }

  changes(
    since: string | null,
    types: string[],
    page = 1,
    perPage = 100,
  ): Promise<ChangesResponse> {
    const q = new URLSearchParams({
      types: types.join(","),
      page: String(page),
      per_page: String(perPage),
    });
    if (since) q.set("since", since);
    return this.call("GET", `/api/obsidian/changes?${q}`);
  }
}
