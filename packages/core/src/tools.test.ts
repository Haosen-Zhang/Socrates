import { describe, expect, it } from "bun:test";
import { makeToolCallKey, truncateToolOutput, validateJsonSchemaInput } from "./tools";

describe("tool contracts", () => {
  it("validates the supported object-schema subset and rejects unknown fields", () => {
    const schema = { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string" } } } as const;
    expect(validateJsonSchemaInput(schema, { path: "src" })).toEqual([]);
    expect(validateJsonSchemaInput(schema, {})).toContain("missing:path");
    expect(validateJsonSchemaInput(schema, { path: "src", surprise: true })).toContain("unknown:surprise");
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
