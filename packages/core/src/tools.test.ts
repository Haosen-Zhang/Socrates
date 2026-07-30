import { describe, expect, it } from "bun:test";
import { type JsonSchema, makeToolCallKey, truncateToolOutput, validateJsonSchemaInput } from "./tools";

describe("tool contracts", () => {
  it("validates the supported object-schema subset and rejects unknown fields", () => {
    const schema: JsonSchema = { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string" } } };
    expect(validateJsonSchemaInput(schema, { path: "src" })).toEqual([]);
    expect(validateJsonSchemaInput(schema, {})).toContain("missing:path");
    expect(validateJsonSchemaInput(schema, { path: "src", surprise: true })).toContain("unknown:surprise");
  });

  it("validates array items and numeric bounds", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["argv"],
      additionalProperties: false,
      properties: {
        argv: { type: "array", items: { type: "string" } },
        timeoutMs: { type: "integer", minimum: 100, maximum: 1_000 },
      },
    };
    expect(validateJsonSchemaInput(schema, { argv: ["status"], timeoutMs: 500 })).toEqual([]);
    expect(validateJsonSchemaInput(schema, { argv: ["status", 1], timeoutMs: 50 })).toEqual([
      "type:argv[1]:string",
      "minimum:timeoutMs:100",
    ]);
  });

  it("uses exact input hash in stable call keys", () => {
    expect(makeToolCallKey({ attemptId: "a", turnId: "t", ordinal: 1, inputHash: "h1" })).not.toBe(
      makeToolCallKey({ attemptId: "a", turnId: "t", ordinal: 1, inputHash: "h2" }),
    );
  });

  it("bounds output by bytes and lines", () => {
    const result = truncateToolOutput("one\ntwo\nthree", { maxBytes: 100, maxLines: 2 });
    expect(result.preview).toBe("one\ntwo");
    expect(result.truncated).toBe(true);
  });
});
