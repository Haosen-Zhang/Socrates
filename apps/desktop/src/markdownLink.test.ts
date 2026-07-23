import { describe, expect, it } from "bun:test";
import { isExternalHref } from "./markdownLink";

describe("markdown link classification", () => {
  it("treats http/https as external (open in browser)", () => {
    expect(isExternalHref("https://example.com")).toBeTrue();
    expect(isExternalHref("http://localhost:3000/x")).toBeTrue();
    expect(isExternalHref("HTTPS://EXAMPLE.COM")).toBeTrue();
  });

  it("treats workspace-relative paths and everything else as non-navigating", () => {
    expect(isExternalHref("test.md")).toBeFalse();
    expect(isExternalHref("./src/a.ts")).toBeFalse();
    expect(isExternalHref("/abs/path")).toBeFalse();
    expect(isExternalHref("mailto:x@y.z")).toBeFalse();
    expect(isExternalHref(undefined)).toBeFalse();
    expect(isExternalHref("")).toBeFalse();
  });
});
