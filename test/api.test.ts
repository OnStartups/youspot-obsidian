import { expect, test } from "bun:test";
import { ApiClient } from "../src/api";

test.each([{ success: false, error: "brain_limit" }, []])(
  "rejects an unsuccessful response even with HTTP 200 (%j)",
  async (body) => {
    const api = new ApiClient(
      { request: async () => ({ status: 200, text: JSON.stringify(body) }) },
      () => ({ apiBase: "https://example.invalid", token: "test" }),
    );
    await expect(api.push({ vault_id: "vault", vault_name: "Test", notes: [] })).rejects.toThrow();
  },
);
