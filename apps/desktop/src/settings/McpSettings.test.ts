import { describe, expect, it } from "bun:test";
import { parseSecretLines } from "./mcpForm";

describe("MCP settings secret draft", () => {
  it("separates secret key declarations from values and keeps blank edit values absent", () => {
    expect(parseSecretLines("TOKEN=new-value\nAuthorization\nTOKEN=ignored")).toEqual({
      keys: ["TOKEN", "Authorization"],
      values: { TOKEN: "new-value" },
    });
  });
});
