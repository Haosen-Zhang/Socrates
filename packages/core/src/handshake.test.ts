import { describe, expect, it } from "bun:test";
import { HANDSHAKE_PROTOCOL, parseHandshake, serializeHandshake } from "./handshake";

describe("sidecar handshake", () => {
  it("round-trips", () => {
    const h = { protocol: HANDSHAKE_PROTOCOL, port: 49152, token: "abc" } as const;
    expect(parseHandshake(serializeHandshake(h))).toEqual(h);
  });

  it("rejects garbage and missing fields", () => {
    expect(parseHandshake("not json")).toBeNull();
    expect(parseHandshake("{}")).toBeNull();
    expect(parseHandshake(JSON.stringify({ protocol: "other/1", port: 1, token: "t" }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ protocol: HANDSHAKE_PROTOCOL, port: 0, token: "t" }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ protocol: HANDSHAKE_PROTOCOL, port: 80.5, token: "t" }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ protocol: HANDSHAKE_PROTOCOL, port: 80, token: "" }))).toBeNull();
  });
});
