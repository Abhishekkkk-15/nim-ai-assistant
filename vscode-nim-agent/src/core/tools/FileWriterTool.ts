import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class FileWriterTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "write_file",
      description:
        "Create or overwrite a file in the workspace. The user is asked to confirm before any write occurs.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file (relative to workspace root)." },
          content: { type: "string", description: "Full new file contents." }
        },
        required: ["path", "content"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = String(input.path ?? "").trim();
    const content = String(input.content ?? "");
    if (!path) {
      return { ok: false, output: "Missing 'path' argument." };
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return { ok: false, output: "No workspace folder is open." };
    }
    const target = path.startsWith("/")
      ? vscode.Uri.file(path)
      : vscode.Uri.joinPath(folders[0].uri, path);

    const exists = await this.exists(target);
    const action = exists ? "Overwrite" : "Create";

    await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
    return {
      ok: true,
      output: `${action}d file: ${vscode.workspace.asRelativePath(target)} (${content.length} chars).`
    };
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }
}
