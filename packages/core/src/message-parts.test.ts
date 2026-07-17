import { describe, expect, it } from "bun:test";
import { validateMessageParts } from "./message-parts";

describe("structured message parts", () => {
  it("accepts text and opaque attachment/workspace references", () => {
    expect(validateMessageParts([
      { type: "text", text: "hello" },
      { type: "image", attachmentId: "a", mediaType: "image/png" },
      { type: "workspace_ref", refId: "r", relativePath: "src/a.ts" },
    ])).toEqual([]);
  });

  it("rejects local absolute path payloads and empty messages", () => {
    expect(validateMessageParts([])).toContain("message_parts_required");
    expect(validateMessageParts([{ type: "workspace_ref", refId: "r", relativePath: "/tmp/a" }])).toContain("workspace_ref_invalid_path");
  });
});
