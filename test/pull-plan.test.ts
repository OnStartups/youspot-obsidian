import { describe, expect, test } from "bun:test";
import { planPull } from "../src/sync/pull";
import { DEFAULT_SETTINGS, emptyState } from "../src/sync/state";
import type { ChangeObject, Tombstone } from "../src/types";

const rules = { syncFolder: "Brain", exportFolder: "YouSpot" };

function obj(overrides: Partial<ChangeObject>): ChangeObject {
  return {
    object_id: "per_1",
    type: "contact",
    name: "Jane",
    description: "",
    url: null,
    page_url: "",
    json_data: {},
    fields: {},
    tags: [],
    connections: [],
    created_at: "",
    updated_at: "2026-09-01T00:00:00Z",
    origin: "brain",
    ...overrides,
  };
}

describe("planPull", () => {
  test("creates a file for a new object", async () => {
    const plan = await planPull([obj({})], [], emptyState("v"), DEFAULT_SETTINGS, rules);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "write",
      path: "Brain/YouSpot/Contacts/Jane.md",
      previousPath: null,
    });
  });
  test("skips when the rendered content is unchanged", async () => {
    const state = emptyState("v");
    const first = await planPull([obj({})], [], state, DEFAULT_SETTINGS, rules);
    const write = first.actions[0];
    if (write?.kind !== "write") throw new Error("expected write");
    state.exports.per_1 = {
      path: write.path,
      type: "contact",
      rendered_hash: write.hash,
      updated_at: "",
    };
    const second = await planPull([obj({})], [], state, DEFAULT_SETTINGS, rules);
    expect(second.actions).toHaveLength(0);
  });
  test("renames when the name changed", async () => {
    const state = emptyState("v");
    state.exports.per_1 = {
      path: "Brain/YouSpot/Contacts/Jane.md",
      type: "contact",
      rendered_hash: "old",
      updated_at: "",
    };
    const plan = await planPull([obj({ name: "Jane Doe" })], [], state, DEFAULT_SETTINGS, rules);
    expect(plan.actions[0]).toMatchObject({
      kind: "write",
      path: "Brain/YouSpot/Contacts/Jane Doe.md",
      previousPath: "Brain/YouSpot/Contacts/Jane.md",
    });
  });
  test("collisions within one batch get id suffixes", async () => {
    const plan = await planPull(
      [obj({ object_id: "per_1" }), obj({ object_id: "per_2" })],
      [],
      emptyState("v"),
      DEFAULT_SETTINGS,
      rules,
    );
    expect(plan.actions.map((a) => a.path)).toEqual([
      "Brain/YouSpot/Contacts/Jane.md",
      "Brain/YouSpot/Contacts/Jane (per_2).md",
    ]);
  });
  test("intra-batch connections resolve to wikilinks", async () => {
    const plan = await planPull(
      [
        obj({
          connections: [
            {
              type: "works_at",
              direction: "out",
              object_id: "company_1",
              object_type: "company",
              name: "Acme",
            },
          ],
        }),
        obj({ object_id: "company_1", type: "company", name: "Acme" }),
      ],
      [],
      emptyState("v"),
      DEFAULT_SETTINGS,
      rules,
    );
    const jane = plan.actions.find((a) => a.objectId === "per_1");
    if (jane?.kind !== "write") throw new Error("expected write");
    expect(jane.content).toContain("[[Brain/YouSpot/Companies/Acme|Acme]]");
  });
  test("vault-origin objects are skipped and server edits recorded", async () => {
    const state = emptyState("v");
    state.notes["Brain/a.md"] = {
      youspot_id: "note_1",
      local_hash: "",
      content_hash: "",
      server_updated_at: "",
      last_pushed_at: 0,
    };
    const plan = await planPull(
      [
        obj({ object_id: "note_1", type: "note", server_edited: true }),
        obj({ object_id: "note_2", type: "note", origin: "vault", server_edited: false }),
      ],
      [],
      state,
      DEFAULT_SETTINGS,
      rules,
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.serverEdited).toEqual(["note_1"]);
  });
  test("disabled types are ignored", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      exportTypes: { ...DEFAULT_SETTINGS.exportTypes, contact: false },
    };
    const plan = await planPull([obj({})], [], emptyState("v"), settings, rules);
    expect(plan.actions).toHaveLength(0);
  });
  test("tombstones trash exports and forget vault notes", async () => {
    const state = emptyState("v");
    state.exports.per_1 = {
      path: "Brain/YouSpot/Contacts/Jane.md",
      type: "contact",
      rendered_hash: "",
      updated_at: "",
    };
    state.notes["Brain/a.md"] = {
      youspot_id: "note_1",
      local_hash: "",
      content_hash: "",
      server_updated_at: "",
      last_pushed_at: 0,
    };
    const tombs: Tombstone[] = [
      { object_id: "per_1", type: "contact", deleted_at: "", obsidian: null },
      {
        object_id: "note_1",
        type: "note",
        deleted_at: "",
        obsidian: { vault_id: "v", path: "Brain/a.md" },
      },
      { object_id: "unknown", type: "note", deleted_at: "", obsidian: null },
    ];
    const plan = await planPull([], tombs, state, DEFAULT_SETTINGS, rules);
    expect(plan.actions).toEqual([
      { kind: "trash", objectId: "per_1", path: "Brain/YouSpot/Contacts/Jane.md" },
    ]);
    expect(plan.forgetNotes).toEqual(["Brain/a.md"]);
  });
});
