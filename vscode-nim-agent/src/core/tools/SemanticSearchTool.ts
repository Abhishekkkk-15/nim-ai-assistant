import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";
import type { VectorIndexService } from "../context/VectorIndexService";

export class SemanticSearchTool extends BaseTool {
  constructor(private readonly vectorIndex: VectorIndexService) {
    super();
  }

  definition(): ToolDefinition {
    return {
      name: "semantic_search",
      description: "Search the workspace using semantic meaning rather than keywords. Best for finding logic, concepts, or related code when you don't know the exact names.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "The natural language query (e.g., 'how is user authentication handled?')." },
          limit: { type: "number", description: "Number of results to return (default 5)." }
        },
        required: ["query"]
      }
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = String(input.query);
    const limit = input.limit ? Number(input.limit) : 5;

    try {
      const results = await this.vectorIndex.search(query, limit);
      if (results.length === 0) {
        return { ok: true, output: "No semantically relevant code found. Try a different query or use 'search_workspace' for keywords." };
      }

      const output = results.map(r => `File: ${r.path} (Score: ${r.score.toFixed(3)})\n\`\`\`\n${r.chunk}\n\`\`\``).join("\n\n---\n\n");
      return { ok: true, output };
    } catch (err) {
      return { ok: false, output: `Semantic search failed: ${(err as Error).message}` };
    }
  }
}
