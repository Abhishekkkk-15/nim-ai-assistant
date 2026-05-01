import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class FindReferencesTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "find_references",
      description: "Find all references to a symbol using VS Code language servers.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path containing symbol usage or declaration." },
          line: { type: "number", description: "1-indexed line of symbol." },
          character: { type: "number", description: "1-indexed character of symbol." },
        },
        required: ["path", "line", "character"],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = String(input.path || "");
    const line = Number(input.line || 1) - 1;
    const character = Number(input.character || 1) - 1;
    if (!path) return { ok: false, output: "Missing required input: path" };
    const uri = this.resolveUri(path);
    const pos = new vscode.Position(Math.max(0, line), Math.max(0, character));
    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      uri,
      pos
    );
    if (!locations || locations.length === 0) return { ok: true, output: "No references found." };
    const out = locations.map(
      (loc) => `${vscode.workspace.asRelativePath(loc.uri)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
    );
    return { ok: true, output: out.join("\n") };
  }

  private resolveUri(filePath: string): vscode.Uri {
    if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return vscode.Uri.file(filePath);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, filePath) : vscode.Uri.file(filePath);
  }
}
