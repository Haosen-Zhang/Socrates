import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "socrates-test", version: "1.0.0" });
server.registerTool("echo", {
  description: "Echo bounded text",
  inputSchema: { text: z.string().max(100) },
  annotations: { readOnlyHint: true },
}, async ({ text }) => ({
  content: [{ type: "text", text: `${text}:${process.env.TEST_MCP_SECRET === "available" ? "secret-present" : "secret-missing"}` }],
}));
await server.connect(new StdioServerTransport());
