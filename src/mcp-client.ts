import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MindmapGraph } from "./types";

export class MindmapMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  async connect(): Promise<void> {
    if (this.client) return;

    this.transport = new StdioClientTransport({
      command: "ts-node",
      args: [path.join(__dirname, "mcp-server.ts")],
      env: process.env as Record<string, string>,
      stderr: "inherit",
    });

    this.client = new Client(
      { name: "ts-agent-main", version: "1.0.0" },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
  }

  async getMindmap(): Promise<MindmapGraph> {
    if (!this.client) throw new Error("MindmapMcpClient not connected");

    const result = await this.client.callTool({
      name: "get_mindmap",
      arguments: {},
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content[0]?.text ?? "{}";
    return JSON.parse(text) as MindmapGraph;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }
}
