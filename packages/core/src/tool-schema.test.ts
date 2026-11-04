import { describe, expect, it } from "bun:test";
import { type JsonSchema, validateJsonSchemaInput } from "./tools";

describe("recursive tool schema validation", () => {
  const schema = {
    type: "object", required: ["sheets"], additionalProperties: false,
    properties: {
      sheets: { type: "array", minItems: 1, maxItems: 2, items: {
        type: "object", required: ["name", "rows"], additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 4, pattern: "^[A-Z]" },
          rows: { type: "array", items: { type: "array", items: { anyOf: [
            { type: "string", enum: ["ok"] }, { type: "number", minimum: 0, maximum: 10 }, { type: "null" },
          ] } } },
        },
      } },
    },
  } as JsonSchema;

  it("checks nested objects, arrays, enums and nullable cells", () => {
    expect(validateJsonSchemaInput(schema, { sheets: [{ name: "Data", rows: [["ok", 2, null]] }] })).toEqual([]);
    expect(validateJsonSchemaInput(schema, { sheets: [{ name: "Data", rows: [["bad"]], extra: 1 }] })).toEqual([
      "unknown:sheets[0].extra", "anyOf:sheets[0].rows[0][0]",
    ]);
    expect(validateJsonSchemaInput(schema, { sheets: [{ name: "Data" }] })).toContain("missing:sheets[0].rows");
  });

  it("enforces string and item bounds", () => {
    expect(validateJsonSchemaInput(schema, { sheets: [] })).toContain("minItems:sheets:1");
    expect(validateJsonSchemaInput(schema, { sheets: [{ name: "badname", rows: [] }] })).toEqual([
      "maxLength:sheets[0].name:4", "pattern:sheets[0].name",
    ]);
    expect(validateJsonSchemaInput({ type: "array", maxItems: 1, items: { type: "integer" } } as JsonSchema, [1, 2.5])).toEqual([
      "maxItems:$:1", "type:[1]:integer",
    ]);
  });

  it("rejects non-finite numbers and inherited required fields", () => {
    expect(validateJsonSchemaInput({ type: "number" } as JsonSchema, Infinity)).toEqual(["type:$:number"]);
    expect(validateJsonSchemaInput({ type: "object", properties: { toString: { type: "string" as const } }, required: ["toString"] }, {})).toEqual(["missing:toString"]);
  });

  it("validates declared schemas for extra properties without closing MCP objects by default", () => {
    expect(validateJsonSchemaInput({ type: "object", additionalProperties: { type: "integer" } } as JsonSchema, { count: "bad" })).toEqual(["type:count:integer"]);
    expect(validateJsonSchemaInput({ type: "object" }, { extra: "okay" })).toEqual([]);
  });
});
