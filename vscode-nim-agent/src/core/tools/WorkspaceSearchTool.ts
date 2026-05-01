import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

const MAX_FILES = 50;
const MAX_MATCHES_PER_FILE = 10;

export class WorkspaceSearchTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "search_workspace",
      description:
        "Search the workspace for a substring (case-insensitive). Returns matching file paths and line numbers.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to look for." },
          glob: {
            type: "string",
            description: "Optional include glob (default: **/*)"
          }
        },
        required: ["query"]
      }
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = String(input.query ?? "").trim();
    const glob = input.glob ? String(input.glob) : "**/*";
    if (!query) {
      return { ok: false, output: "Missing 'query' argument." };
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return { ok: false, output: "No workspace folder is open." };
    }
    const files = await vscode.workspace.findFiles(
      glob,
      "**/{node_modules,dist,.git,.next,.cache}/**",
      MAX_FILES
    );
    const lines: string[] = [];
    const needle = query.toLowerCase();
    for (const file of files) {
      try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
        const fileLines = content.split(/\r?\n/);
        let matches = 0;
        for (let i = 0; i < fileLines.length && matches < MAX_MATCHES_PER_FILE; i++) {
          if (fileLines[i].toLowerCase().includes(needle)) {
            lines.push(
              `${vscode.workspace.asRelativePath(file)}:${i + 1}: ${fileLines[i].slice(0, 200)}`
            );
            matches++;
          }
        }
      } catch {
        // ignore unreadable files (binaries etc.)
      }
    }
    if (lines.length === 0) {
      return { ok: true, output: `No matches found for "${query}".` };
    }
    return { ok: true, output: lines.join("\n") };
  }
}
