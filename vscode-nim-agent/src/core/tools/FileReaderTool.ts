import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

const MAX_BYTES = 256_000;

export class FileReaderTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "read_file",
      description:
        "Read the contents of a file in the workspace. Path can be absolute or relative to the workspace root.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to read." },
          startLine: { type: "number", description: "Optional starting line number (1-indexed)." },
          endLine: { type: "number", description: "Optional ending line number (inclusive)." }
        },
        required: ["path"]
      }
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = String(input.path ?? "").trim();
    if (!path) {
      return { ok: false, output: "Missing 'path' argument." };
    }
    const uri = await this.resolveUri(path);
    if (!uri) {
      return { ok: false, output: `File not found: ${path}` };
    }
    const data = await vscode.workspace.fs.readFile(uri);
    let content = Buffer.from(data).toString("utf8");
    const lines = content.split("\n");
    const startLine = Number(input.startLine ?? 1);
    const endLine = input.endLine ? Number(input.endLine) : lines.length;

    if (startLine > 1 || endLine < lines.length) {
      const sliced = lines.slice(startLine - 1, endLine).join("\n");
      return { ok: true, output: sliced };
    }

    if (data.byteLength > MAX_BYTES) {
      const truncated = Buffer.from(data).slice(0, MAX_BYTES).toString("utf8");
      return {
        ok: true,
        output: `${truncated}\n\n[...truncated, ${data.byteLength} bytes total. Use startLine/endLine to read specific parts.]`
      };
    }
    return { ok: true, output: content };
  }

  private async resolveUri(p: string): Promise<vscode.Uri | undefined> {
    if (p.startsWith("/")) {
      const uri = vscode.Uri.file(p);
      return (await this.exists(uri)) ? uri : undefined;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const uri = vscode.Uri.joinPath(folder.uri, p);
      if (await this.exists(uri)) {
        return uri;
      }
    }
    return undefined;
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
