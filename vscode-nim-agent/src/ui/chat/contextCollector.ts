import * as vscode from "vscode";
import type { AgentContext } from "../../core/agent/BaseAgent";

const MAX_FILE_BYTES = 64_000;

/**
 * Snapshot the user's active editor + selection + a tiny workspace summary.
 * Bounded so we never blow up the context window.
 */
export async function collectEditorContext(extraFiles?: string[]): Promise<AgentContext> {
  const ctx: AgentContext = { extraFiles: [] };

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    const fullText = doc.getText();
    const truncated =
      fullText.length > MAX_FILE_BYTES
        ? `${fullText.slice(0, MAX_FILE_BYTES)}\n[...truncated, ${fullText.length} chars total]`
        : fullText;
    ctx.activeFile = {
      path: vscode.workspace.asRelativePath(doc.uri),
      language: doc.languageId,
      content: truncated
    };
    if (!editor.selection.isEmpty) {
      ctx.selection = {
        path: vscode.workspace.asRelativePath(doc.uri),
        text: doc.getText(editor.selection),
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1
      };
    }
    // Diagnostics for the active file
    const diags = vscode.languages.getDiagnostics(doc.uri);
    if (diags.length > 0) {
      ctx.diagnostics = diags
        .slice(0, 20)
        .map(
          (d) =>
            `${severity(d.severity)} L${d.range.start.line + 1}:${d.range.start.character + 1} ${
              d.source ?? ""
            } ${d.message}`
        )
        .join("\n");
    }
  }

  if (extraFiles && extraFiles.length > 0) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const path of extraFiles) {
        try {
          const uri = vscode.Uri.joinPath(folders[0].uri, path);
          const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
          ctx.extraFiles?.push({
            path,
            content: content.length > MAX_FILE_BYTES 
              ? `${content.slice(0, MAX_FILE_BYTES)}\n[...truncated]` 
              : content
          });
        } catch {
          // skip missing or unreadable files
        }
      }
    }
  }

  ctx.workspaceSummary = await summarizeWorkspace();
  return ctx;
}

function severity(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return "[ERROR]";
    case vscode.DiagnosticSeverity.Warning:
      return "[WARN]";
    case vscode.DiagnosticSeverity.Information:
      return "[INFO]";
    case vscode.DiagnosticSeverity.Hint:
      return "[HINT]";
  }
}

async function summarizeWorkspace(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const limit = vscode.workspace
    .getConfiguration("nimAgent")
    .get<number>("workspaceContextLimitBytes", 200_000);
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,dist,.git,.next,.cache,build}/**",
    200
  );
  const lines: string[] = [
    `Workspace: ${folders.map((f) => f.name).join(", ")}`,
    `Top-level files (max 200, total budget ${limit} bytes):`
  ];
  for (const f of files.slice(0, 80)) {
    lines.push(`  - ${vscode.workspace.asRelativePath(f)}`);
  }
  return lines.join("\n");
}
