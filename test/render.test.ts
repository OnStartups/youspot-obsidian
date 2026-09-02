import { describe, expect, test } from "bun:test";
import { renderObject } from "../src/sync/render";
import type { ChangeObject } from "../src/types";

function contact(overrides: Partial<ChangeObject> = {}): ChangeObject {
  return {
    object_id: "per_1",
    type: "contact",
    name: "Jane Doe",
    description: "Met at the summit.",
    url: "https://linkedin.com/in/jane",
    page_url: "https://youspot.com/brain/object/per_1",
    json_data: { email: "jane@acme.com", secret: "no", location: "" },
    fields: { title: "CTO" },
    tags: ["client"],
    connections: [
      {
        type: "works_at",
        direction: "out",
        object_id: "company_1",
        object_type: "company",
        name: "Acme",
      },
      {
        type: "knows",
        direction: "out",
        object_id: "per_2",
        object_type: "contact",
        name: "Bob Smith",
      },
    ],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T12:00:00Z",
    origin: "brain",
    ...overrides,
  };
}

const options = {
  appBase: "https://youspot.com/",
  resolvePath: (id: string) => (id === "company_1" ? "Brain/YouSpot/Companies/Acme.md" : null),
};

describe("renderObject", () => {
  test("contact snapshot", () => {
    expect(renderObject(contact(), options)).toBe(
      [
        "---",
        "youspot_id: per_1",
        "youspot_type: contact",
        "youspot_managed: true",
        "title: Jane Doe",
        "url: https://youspot.com/brain/object/per_1",
        "source_url: https://linkedin.com/in/jane",
        'updated_at: "2026-09-01T12:00:00Z"',
        "email: jane@acme.com",
        "job_title: CTO",
        "tags:",
        "  - youspot/contact",
        "  - client",
        "---",
        "",
        "Met at the summit.",
        "",
        "## Connections",
        "- [[Brain/YouSpot/Companies/Acme|Acme]] — works_at",
        "- Bob Smith (contact) — https://youspot.com/brain/object/per_2",
        "",
      ].join("\n"),
    );
  });
  test("only allowlisted fields appear", () => {
    const out = renderObject(contact(), options);
    expect(out).not.toContain("secret");
    expect(out).not.toContain("location");
  });
  test("note type carries no fields and no connections block when empty", () => {
    const out = renderObject(
      contact({
        type: "note",
        object_id: "note_1",
        json_data: { email: "x" },
        connections: [],
        url: null,
      }),
      options,
    );
    expect(out).not.toContain("email");
    expect(out).not.toContain("## Connections");
    expect(out).not.toContain("source_url");
  });
  test("connections are sorted by name for stable output", () => {
    const a = renderObject(contact(), options);
    const b = renderObject(contact({ connections: [...contact().connections].reverse() }), options);
    expect(a).toBe(b);
  });
});
