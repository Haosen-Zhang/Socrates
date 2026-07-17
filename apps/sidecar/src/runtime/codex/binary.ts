import { existsSync } from "node:fs";

const MACOS_CHATGPT_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

/** Deliberately does not search arbitrary PATH binaries; protocol and binary must stay pinned. */
export function configuredCodexBinary(): string {
  const configured = process.env.SOCRATES_CODEX_BINARY;
  if (configured) {
    if (!configured.startsWith("/") || !existsSync(configured)) throw new Error("codex_binary_invalid");
    return configured;
  }
  if (process.platform === "darwin" && existsSync(MACOS_CHATGPT_CODEX)) return MACOS_CHATGPT_CODEX;
  throw new Error("codex_binary_unavailable");
}
