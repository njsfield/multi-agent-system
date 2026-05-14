import path from "path";
import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MindmapAgent } from "./mindmap-agent";
import { createPgPool } from "./pg-memory";

config({ path: path.join(__dirname, "../.env") });

async function main() {
  const DATABASE_URL =
    process.env["DATABASE_URL"] ?? "postgresql://localhost/tsagent";
  const pool = createPgPool(DATABASE_URL);
  await pool.query("SELECT 1");

  const mindmapAgent = new MindmapAgent(pool);

  const server = new McpServer(
    { name: "mindmap-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "get_mindmap",
    {
      description:
        "Build (or fetch from cache) the current mindmap graph of topics and subtopics. Returns the graph as a JSON string.",
      inputSchema: {},
    },
    async () => {
      const graph = await mindmapAgent.getGraphCached();
      return {
        content: [{ type: "text", text: JSON.stringify(graph) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Use stderr — stdout is reserved for the MCP JSON-RPC stream.
  console.error("[mcp-server] mindmap server listening on stdio");
}

main().catch((err) => {
  console.error("[mcp-server] fatal:", err);
  process.exit(1);
});
