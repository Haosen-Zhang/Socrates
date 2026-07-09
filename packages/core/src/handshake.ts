/**
 * Sidecar 启动握手：sidecar 把监听端口和访问 token 以单行 JSON 打到 stdout，
 * Tauri 侧解析后转发给前端。协议字段变更必须升版本号。
 */
export const HANDSHAKE_PROTOCOL = "socrates-sidecar/1";

export type SidecarHandshake = {
  protocol: typeof HANDSHAKE_PROTOCOL;
  port: number;
  token: string;
};

export function serializeHandshake(h: SidecarHandshake): string {
  return JSON.stringify(h);
}

export function parseHandshake(line: string): SidecarHandshake | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.protocol !== HANDSHAKE_PROTOCOL) return null;
  if (typeof v.port !== "number" || !Number.isInteger(v.port) || v.port <= 0 || v.port > 65535) return null;
  if (typeof v.token !== "string" || v.token.length === 0) return null;
  return { protocol: HANDSHAKE_PROTOCOL, port: v.port, token: v.token };
}
