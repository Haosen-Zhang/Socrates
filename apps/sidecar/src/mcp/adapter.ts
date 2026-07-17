import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerRecord } from "@socrates/core";
import type { FetchLike } from "../net";

export type McpDiscoveredTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
};

export type McpCatalogEntry = {
  kind: "resource" | "resource_template" | "prompt";
  name: string;
  uri?: string;
  description?: string;
  mimeType?: string;
};

export interface McpConnection {
  listTools(): Promise<McpDiscoveredTool[]>;
  listCatalog(): Promise<McpCatalogEntry[]>;
  callTool(name: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpClientAdapter {
  connect(server: McpServerRecord, secrets: Record<string, string>, onClose: (error?: Error) => void): Promise<McpConnection>;
}

const BLOCKED_METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata.google.internal."]);

export function createBoundMcpFetch(endpoint: URL, fetchImpl: FetchLike): FetchLike {
  if (BLOCKED_METADATA_HOSTS.has(endpoint.hostname.toLowerCase()) || endpoint.hostname.toLowerCase().startsWith("fe80:")) {
    throw new Error("mcp_metadata_endpoint_forbidden");
  }
  return async (input, init) => {
    const target = new URL(typeof input === "string" ? input : String(input));
    if (target.origin !== endpoint.origin) throw new Error("mcp_cross_origin_request_forbidden");
    const response = await fetchImpl(target.toString(), { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new Error("mcp_redirect_forbidden");
    return response;
  };
}

export class OfficialMcpClientAdapter implements McpClientAdapter {
  constructor(private readonly fetchImpl: FetchLike) {}

  async connect(server: McpServerRecord, secrets: Record<string, string>, onClose: (error?: Error) => void): Promise<McpConnection> {
    const client = new Client({ name: "socrates", version: "0.1.0" }, { capabilities: {} });
    const transport = server.config.transport === "stdio"
      ? new StdioClientTransport({
          command: server.config.command,
          args: server.config.args,
          cwd: server.config.cwd,
          env: { ...getDefaultEnvironment(), ...secrets },
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(new URL(server.config.url), {
          requestInit: { headers: secrets },
          fetch: createBoundMcpFetch(new URL(server.config.url), this.fetchImpl) as typeof fetch,
          reconnectionOptions: { initialReconnectionDelay: 1_000, maxReconnectionDelay: 30_000, reconnectionDelayGrowFactor: 2, maxRetries: 0 },
        });
    if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
    transport.onclose = () => onClose();
    transport.onerror = (error) => onClose(error);
    await client.connect(transport, { timeout: 10_000 });
    return {
      async listTools() {
        const tools: McpDiscoveredTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 10_000 });
          tools.push(...page.tools.map((item) => ({
            name: item.name,
            description: item.description ?? item.title ?? item.name,
            inputSchema: item.inputSchema,
            annotations: item.annotations,
          })));
          cursor = page.nextCursor;
          if (tools.length > 1_000) throw new Error("mcp_tool_count_exceeded");
        } while (cursor);
        return tools;
      },
      async listCatalog() {
        const capabilities = client.getServerCapabilities();
        const entries: McpCatalogEntry[] = [];
        if (capabilities?.resources) {
          let cursor: string | undefined;
          do {
            const page = await client.listResources(cursor ? { cursor } : undefined, { timeout: 10_000 });
            entries.push(...page.resources.map((item) => ({
              kind: "resource" as const, name: item.name, uri: item.uri,
              description: item.description, mimeType: item.mimeType,
            })));
            cursor = page.nextCursor;
            if (entries.length > 2_000) throw new Error("mcp_catalog_count_exceeded");
          } while (cursor);
          cursor = undefined;
          do {
            const page = await client.listResourceTemplates(cursor ? { cursor } : undefined, { timeout: 10_000 });
            entries.push(...page.resourceTemplates.map((item) => ({
              kind: "resource_template" as const, name: item.name, uri: item.uriTemplate,
              description: item.description, mimeType: item.mimeType,
            })));
            cursor = page.nextCursor;
            if (entries.length > 2_000) throw new Error("mcp_catalog_count_exceeded");
          } while (cursor);
        }
        if (capabilities?.prompts) {
          let cursor: string | undefined;
          do {
            const page = await client.listPrompts(cursor ? { cursor } : undefined, { timeout: 10_000 });
            entries.push(...page.prompts.map((item) => ({
              kind: "prompt" as const, name: item.name, description: item.description,
            })));
            cursor = page.nextCursor;
            if (entries.length > 2_000) throw new Error("mcp_catalog_count_exceeded");
          } while (cursor);
        }
        return entries;
      },
      async callTool(name, input, signal) {
        return client.callTool({ name, arguments: input as Record<string, unknown> }, undefined, { timeout: 60_000, signal });
      },
      async close() { await client.close(); },
    };
  }
}
