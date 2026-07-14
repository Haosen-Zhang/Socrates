import { AGENT_AVATAR_ACCEPT, MAX_AGENT_AVATAR_BYTES } from "@socrates/core";

export type AvatarUploadError = "format" | "size" | null;

const ALLOWED_AVATAR_TYPES = new Set(AGENT_AVATAR_ACCEPT.split(","));

export function validateAvatarUpload(file: Pick<File, "size" | "type">): AvatarUploadError {
  if (!ALLOWED_AVATAR_TYPES.has(file.type.toLowerCase())) return "format";
  if (file.size <= 0 || file.size > MAX_AGENT_AVATAR_BYTES) return "size";
  return null;
}
