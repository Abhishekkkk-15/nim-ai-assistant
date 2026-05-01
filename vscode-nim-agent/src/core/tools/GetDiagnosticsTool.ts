import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class GetDiagnosticsTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "get_diagnostics",
      description: "Get compilation errors, warnings, and linting issues for specific files or the entire workspace.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional file path to filter diagnostics. If omitted, returns all workspace diagnostics." },
          minSeverity: { 
            type: "string", 
            enum: ["error", "warning", "info", "hint"],
            description: "Minimum severity level to include. Default is 'warning'."
          }
        }
      },
      requiresPermission: false
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = input.path ? String(input.path) : undefined;
    const minSeverityStr = input.minSeverity ? String(input.minSeverity) : "warning";

    const severityMap: Record<string, number> = {
      "error": vscode.DiagnosticSeverity.Error,
      "warning": vscode.DiagnosticSeverity.Warning,
      "info": vscode.DiagnosticSeverity.Information,
      "hint": vscode.DiagnosticSeverity.Hint
    };
    const minSeverity = severityMap[minSeverityStr] ?? vscode.DiagnosticSeverity.Warning;

    let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

    if (filePath) {
      const fullPath = this.resolveFullPath(filePath);
      const uri = vscode.Uri.file(fullPath);
      diagnostics = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
      diagnostics = vscode.languages.getDiagnostics();
    }

    const output: string[] = [];
    for (const [uri, diags] of diagnostics) {
      const filtered = diags.filter(d => d.severity <= minSeverity);
      if (filtered.length === 0) continue;

      const relPath = vscode.workspace.asRelativePath(uri);
      output.push(`File: ${relPath}`);
      for (const d of filtered) {
        const sev = this.formatSeverity(d.severity);
        output.push(`  ${sev} L${d.range.start.line + 1}:${d.range.start.character + 1} - ${d.message} (${d.source ?? "unknown"})`);
      }
    }

    if (output.length === 0) {
      return { ok: true, output: "No diagnostics found matching the criteria." };
    }

    return { ok: true, output: output.join("\n") };
  }

  private resolveFullPath(p: string): string {
    if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return p;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return p;
    return vscode.Uri.joinPath(folders[0].uri, p).fsPath;
  }

  private formatSeverity(s: vscode.DiagnosticSeverity): string {
    switch (s) {
      case vscode.DiagnosticSeverity.Error: return "[ERROR]";
      case vscode.DiagnosticSeverity.Warning: return "[WARN]";
      case vscode.DiagnosticSeverity.Information: return "[INFO]";
      case vscode.DiagnosticSeverity.Hint: return "[HINT]";
      default: return "[UNKNOWN]";
    }
  }
}
