import { describe, expect, it } from "bun:test";
import { isAllowedLoopbackHost, isAllowedRendererOrigin } from "./loopback";

describe("loopback request boundary", () => {
  it("allows Tauri and local dev origins only", () => {
    for (const origin of [undefined, "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"]) {
      expect(isAllowedRendererOrigin(origin)).toBe(true);
    }
    expect(isAllowedRendererOrigin("https://evil.example")).toBe(false);
    expect(isAllowedRendererOrigin("http://localhost.evil.example:1420")).toBe(false);
  });

  it("rejects non-loopback Host headers", () => {
    expect(isAllowedLoopbackHost("127.0.0.1:54321")).toBe(true);
    expect(isAllowedLoopbackHost("localhost:54321")).toBe(true);
    expect(isAllowedLoopbackHost("evil.example:54321")).toBe(false);
  });
});
