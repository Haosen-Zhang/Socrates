import { describe, expect, it } from "bun:test";
import { CODEX_CLI_VERSION, isCompatibleCodexVersion } from "./protocol-v0.144.5";

describe("codex version compatibility", () => {
  it("accepts the originally pinned version and the verified 0.145 alpha", () => {
    expect(isCompatibleCodexVersion(CODEX_CLI_VERSION)).toBeTrue();
    expect(isCompatibleCodexVersion("0.145.0-alpha.30")).toBeTrue();
  });

  it("rejects unknown / unverified versions and empty input", () => {
    expect(isCompatibleCodexVersion("0.146.0-alpha.1")).toBeFalse();
    expect(isCompatibleCodexVersion("0.100.0")).toBeFalse();
    expect(isCompatibleCodexVersion(null)).toBeFalse();
    expect(isCompatibleCodexVersion(undefined)).toBeFalse();
    expect(isCompatibleCodexVersion("")).toBeFalse();
  });
});
