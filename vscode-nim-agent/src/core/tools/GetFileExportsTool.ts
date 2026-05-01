import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

const EXPORT_REGEXES: RegExp[] = [
  /^\s*export\s+(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/,
  /^\s*export\s*\{\s*([^}]+)\s*\}/,
  /^\s*export\s+default\s+(?:class|function)?\s*([A-Za-z0-9_$]+)?/,
];

export class GetFileExportsTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "get_file_exports",
      description: "List exported symbols from a file (TS/JS aware with safe fallback parsing).",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to inspect." },
        },
        required: ["path"],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(input.path || "").trim();
    if (!filePath) return { ok: false, output: "Missing required input: path" };
    const uri = this.resolveUri(filePath);
    let data: Uint8Array;
    try {
      data = await vscode.workspace.fs.readFile(uri);
    } catch {
      return { ok: false, output: `File not found: ${filePath}` };
    }
    const text = Buffer.from(data).toString("utf8");
    const exports = this.extractExports(text);
    if (exports.length === 0) return { ok: true, output: "No exports found." };
    return { ok: true, output: exports.join("\n") };
  }

  private extractExports(text: string): string[] {
    const found = new Set<string>();
    const lines = text.split(/\r?\n/);
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Named exports: export const foo = ...
      for (const regex of EXPORT_REGEXES) {
        const m = line.match(regex);
        if (!m) continue;

        if (regex === EXPORT_REGEXES[1]) {
          // Handling export { a, b as c }
          let block = m[1] || "";
          // If the block is not closed on this line, try to peek ahead (simple multi-line support)
          if (!line.includes("}") && i + 1 < lines.length) {
            let j = i + 1;
            while (j < lines.length && !lines[j].includes("}")) {
              block += " " + lines[j].trim();
              j++;
            }
            if (j < lines.length) block += " " + lines[j].split("}")[0];
          }
          
          const names = block
            .split(",")
            .map((part) => {
              const trimmed = part.trim();
              if (trimmed.includes(" as ")) {
                return trimmed.split(/\s+as\s+/i)[1].trim();
              }
              return trimmed;
            })
            .filter(Boolean);
          names.forEach((n) => found.add(n));
        } else if (regex === EXPORT_REGEXES[2]) {
          found.add(m[1] || "default");
        } else if (m[1]) {
          found.add(m[1]);
        }
      }
    }
    return [...found].sort();
  }

  private resolveUri(filePath: string): vscode.Uri {
    if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return vscode.Uri.file(filePath);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, filePath) : vscode.Uri.file(filePath);
  }
}
