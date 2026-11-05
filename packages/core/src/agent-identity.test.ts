import { describe, expect, it } from "bun:test";
import {
  agentAvatarFromSeed,
  agentIdentityFromSeed,
  isAgentAvatarSource,
  isGeneratedAgentAvatar,
  randomAgentIdentity,
  randomUniqueAgentIdentity,
  renderAgentAvatarSvg,
} from "./agent-identity";

describe("generated agent identities", () => {
  it("offers 2,048 distinct base names in each supported language", () => {
    for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
      const names = new Set<string>();
      for (let i = 0; i < 2048; i++) {
        const identity = randomAgentIdentity(() => i / 2048, locale);
        names.add(identity.nickname);
        expect(isGeneratedAgentAvatar(identity.avatar)).toBe(true);
        expect(locale === "en" ? /^[A-Za-z ]+$/.test(identity.nickname) : /^[\p{Script=Han}]+$/u.test(identity.nickname)).toBe(true);
      }
      expect(names.size).toBe(2048);
    }
  });

  it("exhausts the base pool before suffixing and skips normalized collisions", () => {
    const names = Array.from({ length: 2048 }, (_, i) => randomAgentIdentity(() => i / 2048, "en").nickname);
    const base = names[0]!;
    expect(randomUniqueAgentIdentity([base.toUpperCase()], () => 0, "en").nickname).not.toBe(base);
    expect(randomUniqueAgentIdentity([...names, `${base} 2`], () => 0, "en").nickname).toBe(`${base} 3`);
  });

  it("keeps existing seed fallback identities unchanged", () => {
    expect(agentIdentityFromSeed("agent-1")).toEqual({ nickname: "珊瑚修理匠", avatar: "/avatars/axolotl-mechanic.webp" });
  });

  it("renders deterministic, distinct silhouettes even without colour", () => {
    const pictures = new Set<string>();
    const silhouettes = new Set<string>();
    for (let i = 0; i < 2048; i++) {
      const source = agentAvatarFromSeed(`member-${i}`);
      expect(isAgentAvatarSource(source)).toBe(true);
      const svg = renderAgentAvatarSvg(source)!;
      expect(renderAgentAvatarSvg(source)).toBe(svg);
      pictures.add(svg);
      silhouettes.add(svg.replace(/#[0-9a-f]{6}/g, "#000000"));
      expect(svg).not.toMatch(/<script|foreignObject|href=|onload=/);
    }
    expect(pictures.size).toBe(2048);
    expect(silhouettes.size).toBeGreaterThan(2040);
  });

  it("accepts only canonical generated tokens, never arbitrary SVG or URLs", () => {
    for (const source of ["identicon:v2:0123456789abcdef", "identicon:v1:<script>", "identicon:v1:0123456789abcdef\n", "https://example.com/avatar.png", "data:image/svg+xml,<svg/>"]) {
      expect(isGeneratedAgentAvatar(source)).toBe(false);
      expect(isAgentAvatarSource(source)).toBe(false);
      expect(renderAgentAvatarSvg(source)).toBeNull();
    }
  });
});
