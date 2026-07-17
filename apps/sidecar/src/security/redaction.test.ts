import { describe, expect, it } from "bun:test";
import { redactDiagnostic, redactObject } from "./redaction";

describe("diagnostic redaction", () => {
  it("redacts exact values, bearer tokens and nested credential fields", () => {
    expect(redactDiagnostic("Authorization: Bearer abc.def token=my-token exact-value", ["exact-value", "my-token"]))
      .toBe("Authorization=[REDACTED] [REDACTED] token=[REDACTED] [REDACTED]");
    expect(redactObject({ nested: { password: "p", safe: "ok", message: "value exact-secret" }, Authorization: "Bearer value" }, ["exact-secret"]))
      .toEqual({ nested: { password: "[REDACTED]", safe: "ok", message: "value [REDACTED]" }, Authorization: "[REDACTED]" });
  });
});
