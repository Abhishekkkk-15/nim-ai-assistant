import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class GlobFilesTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "glob_files",
      description: "List workspace files matching a glob pattern.",
      input: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob include pattern, e.g. **/*.ts" },
          exclude: { type: "string", description: "Optional exclude glob pattern." },
          limit: { type: "number", description: "Maximum number of files (default 200)." },
        },
        required: ["pattern"],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(input.pattern || "").trim();
    const exclude = String(input.exclude || "**/{node_modules,dist,.git,.next,.cache,build,out,coverage}/**");
    const limit = Number(input.limit || 200);
    if (!pattern) return { ok: false, output: "Missing required input: pattern" };
    const files = await vscode.workspace.findFiles(pattern, exclude, Math.max(1, limit));
    if (files.length === 0) return { ok: true, output: "No files matched." };
    return { ok: true, output: files.map((f) => vscode.workspace.asRelativePath(f)).join("\n") };
  }
}
