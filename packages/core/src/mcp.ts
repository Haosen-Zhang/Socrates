export type McpScope = "global" | "workspace";
export type McpTransport = "stdio" | "streamable_http";
export type McpConnectionState =
  | "disabled"
  | "disconnected"
  | "connecting"
  | "connected"
  | "needs_auth"
  | "degraded"
  | "failed"
  | "stopping";

export type McpStdioConfig = { transport: "stdio"; command: string; args: string[]; cwd?: string; envKeys: string[] };
export type McpHttpConfig = { transport: "streamable_http"; url: string; headerKeys: string[] };
export type McpTransportConfig = McpStdioConfig | McpHttpConfig;

export interface McpServerRecord {
  id: string;
  name: string;
  scope: McpScope;
  workspaceId: string | null;
  config: McpTransportConfig;
  enabled: boolean;
  state: McpConnectionState;
  generation: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerInput {
  name: string;
  scope: McpScope;
  workspaceId?: string | null;
  config: McpTransportConfig;
}

const SAFE_NAME = /^[a-z][a-z0-9_-]{0,47}$/u;
const SAFE_SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;

export function validateMcpServerInput(input: McpServerInput): string[] {
  const errors: string[] = [];
  if (!SAFE_NAME.test(input.name)) errors.push("mcp_name_invalid");
  if (input.scope === "workspace" && !input.workspaceId) errors.push("mcp_workspace_required");
  if (input.scope === "global" && input.workspaceId) errors.push("mcp_global_workspace_forbidden");
  if (input.config.transport === "stdio") {
    if (!input.config.command.trim()) errors.push("mcp_command_required");
    else if (!input.config.command.startsWith("/")) errors.push("mcp_command_absolute_required");
    if (input.config.command.includes("\0")) errors.push("mcp_command_invalid");
    if (input.config.args.length > 64 || input.config.args.some((arg) => arg.length > 4_096 || arg.includes("\0"))) errors.push("mcp_args_invalid");
    if (input.config.cwd?.includes("\0")) errors.push("mcp_cwd_invalid");
    if (input.config.envKeys.length > 64 || input.config.envKeys.some((key) => !SAFE_SECRET_KEY.test(key))) errors.push("mcp_env_keys_invalid");
  } else {
    try {
      const url = new URL(input.config.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") errors.push("mcp_url_invalid");
      if (url.username || url.password) errors.push("mcp_url_credentials_forbidden");
    } catch {
      errors.push("mcp_url_invalid");
    }
    if (input.config.headerKeys.length > 64 || input.config.headerKeys.some((key) => !SAFE_SECRET_KEY.test(key))) errors.push("mcp_header_keys_invalid");
  }
  return [...new Set(errors)];
}

export function mcpToolName(serverName: string, toolName: string): string {
  const normalizedTool = toolName.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64);
  if (!SAFE_NAME.test(serverName) || !normalizedTool) throw new Error("mcp_tool_name_invalid");
  return `mcp__${serverName}__${normalizedTool}`;
}

export function validateMcpToolSchema(schema: unknown, limits = { maxBytes: 64 * 1024, maxDepth: 12, maxNodes: 1_000 }): string[] {
  let encoded: string;
  try { encoded = JSON.stringify(schema); } catch { return ["mcp_schema_not_json"]; }
  if (new TextEncoder().encode(encoded).byteLength > limits.maxBytes) return ["mcp_schema_too_large"];
  let nodes = 0;
  let tooDeep = false;
  const visit = (value: unknown, depth: number) => {
    nodes += 1;
    if (depth > limits.maxDepth) tooDeep = true;
    if (nodes > limits.maxNodes || tooDeep || !value || typeof value !== "object") return;
    for (const child of Object.values(value as Record<string, unknown>)) visit(child, depth + 1);
  };
  visit(schema, 0);
  const errors: string[] = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || (schema as { type?: unknown }).type !== "object") errors.push("mcp_schema_object_required");
  if (tooDeep) errors.push("mcp_schema_too_deep");
  if (nodes > limits.maxNodes) errors.push("mcp_schema_too_complex");
  return errors;
}
