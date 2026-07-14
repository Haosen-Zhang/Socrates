import { describe, expect, it } from "bun:test";
import { MAX_AGENT_AVATAR_BYTES } from "@socrates/core";
import { validateAvatarUpload } from "./agentAvatarUpload";

describe("validateAvatarUpload", () => {
  it("accepts common raster image formats within the size limit", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(validateAvatarUpload({ type, size: 1024 })).toBeNull();
    }
  });

  it("rejects executable or oversized avatar files", () => {
    expect(validateAvatarUpload({ type: "image/svg+xml", size: 1024 })).toBe("format");
    expect(validateAvatarUpload({ type: "image/png", size: MAX_AGENT_AVATAR_BYTES + 1 })).toBe("size");
  });
});
