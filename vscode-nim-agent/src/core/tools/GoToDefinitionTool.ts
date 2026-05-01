import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class GoToDefinitionTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "go_to_definition",
      description: "Find symbol definition locations using VS Code language servers.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path containing symbol usage." },
          line: { type: "number", description: "1-indexed line of symbol usage." },
          character: { type: "number", description: "1-indexed character of symbol usage." },
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
    const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeDefinitionProvider",
      uri,
      pos
    );
    if (!locations || locations.length === 0) return { ok: true, output: "No definitions found." };
    const out = locations.map((loc) => {
      const item = "uri" in loc ? loc : { uri: loc.targetUri, range: loc.targetRange };
      return `${vscode.workspace.asRelativePath(item.uri)}:${item.range.start.line + 1}:${item.range.start.character + 1}`;
    });
    return { ok: true, output: out.join("\n") };
  }

  private resolveUri(filePath: string): vscode.Uri {
    if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return vscode.Uri.file(filePath);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, filePath) : vscode.Uri.file(filePath);
  }
}
