import { describe, expect, it } from "bun:test";
import { containsCredentialMaterial, redactDiagnostic, redactObject } from "./redaction";

describe("diagnostic redaction", () => {
  it("redacts exact values, bearer tokens and nested credential fields", () => {
    expect(redactDiagnostic("Authorization: Bearer abc.def token=my-token exact-value", ["exact-value", "my-token"]))
      .toBe("Authorization=[REDACTED] [REDACTED] token=[REDACTED] [REDACTED]");
    expect(redactObject({ nested: { password: "p", safe: "ok", message: "value exact-secret" }, Authorization: "Bearer value" }, ["exact-secret"]))
      .toEqual({ nested: { password: "[REDACTED]", safe: "ok", message: "value [REDACTED]" }, Authorization: "[REDACTED]" });
  });

  it("detects credential material before a tool input can be persisted", () => {
    for (const value of [
      "password=hunter2",
      "--api-key=value",
      "token: value",
      "Authorization=Bearer abc.def",
      "sk-abcdefgh",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      "AKIAABCDEFGHIJKLMNOP",
      "ASIAABCDEFGHIJKLMNOP",
      "AWS_SESSION_TOKEN=value",
      "AWS_SECRET_ACCESS_KEY=value",
      "https://user:password@example.com",
      "-----BEGIN PRIVATE KEY-----",
    ]) {
      expect(containsCredentialMaterial(value)).toBe(true);
    }
    expect(containsCredentialMaterial("git status --short")).toBe(false);
  });
});
