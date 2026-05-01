import * as vscode from "vscode";
import * as path from "path";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export interface FileEdit {
  path: string;
  edits: {
    range?: {
      startLine: number;
      startCharacter: number;
      endLine: number;
      endCharacter: number;
    };
    oldText?: string; // For search-and-replace style
    newText: string;
  }[];
}

export class ApplyWorkspaceEditTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "apply_workspace_edit",
      description: "Apply multiple edits across one or more files in the workspace. Use this for refactoring or multi-file changes. Supports both coordinate-based and search-replace-based edits.",
      input: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace-relative path to the file." },
                type: { type: "string", enum: ["replace", "create", "delete", "rename"] },
                newPath: { type: "string", description: "Used only for 'rename'." },
                content: { type: "string", description: "Used for 'create' or as the replacement text for 'replace'." },
                oldText: { type: "string", description: "The exact text to find and replace (for search-replace style)." },
                range: {
                  type: "object",
                  properties: {
                    startLine: { type: "number" },
                    startCharacter: { type: "number" },
                    endLine: { type: "number" },
                    endCharacter: { type: "number" }
                  },
                  description: "Coordinate-based range (1-indexed). If provided, it overrides 'oldText'."
                }
              },
              required: ["path", "type"]
            }
          },
          label: { type: "string", description: "A human-readable label for this edit (e.g., 'Refactor User service')." }
        },
        required: ["edits"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const editsInput = input.edits as any[];
    const label = String(input.label || "AI Applied Edits");
    
    const workspaceEdit = new vscode.WorkspaceEdit();
    const results: string[] = [];

    for (const edit of editsInput) {
      const fullPath = this.resolveFullPath(edit.path);
      const uri = vscode.Uri.file(fullPath);

      switch (edit.type) {
        case "create":
          workspaceEdit.createFile(uri, { overwrite: true, ignoreIfExists: false });
          workspaceEdit.insert(uri, new vscode.Position(0, 0), edit.content || "");
          results.push(`Created ${edit.path}`);
          break;

        case "delete":
          workspaceEdit.deleteFile(uri, { recursive: true, ignoreIfNotExists: true });
          results.push(`Deleted ${edit.path}`);
          break;

        case "rename":
          if (edit.newPath) {
            const newUri = vscode.Uri.file(this.resolveFullPath(edit.newPath));
            workspaceEdit.renameFile(uri, newUri);
            results.push(`Renamed ${edit.path} to ${edit.newPath}`);
          }
          break;

        case "replace":
          if (edit.range) {
            const range = new vscode.Range(
              edit.range.startLine - 1,
              edit.range.startCharacter - 1,
              edit.range.endLine - 1,
              edit.range.endCharacter - 1
            );
            workspaceEdit.replace(uri, range, edit.content || "");
            results.push(`Replaced range in ${edit.path}`);
          } else if (edit.oldText) {
            // Search and replace logic
            const doc = await vscode.workspace.openTextDocument(uri);
            const text = doc.getText();
            const index = text.indexOf(edit.oldText);
            if (index !== -1) {
              const startPos = doc.positionAt(index);
              const endPos = doc.positionAt(index + edit.oldText.length);
              workspaceEdit.replace(uri, new vscode.Range(startPos, endPos), edit.content || "");
              results.push(`Replaced text in ${edit.path}`);
            } else {
              return { ok: false, output: `Could not find exact text to replace in ${edit.path}. Check for whitespace or indentation mismatches.` };
            }
          }
          break;
      }
    }

    const success = await vscode.workspace.applyEdit(workspaceEdit);
    if (success) {
      // Save all modified documents
      const docs = editsInput.map(e => this.resolveFullPath(e.path));
      for (const p of docs) {
        try {
          const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === p);
          if (doc) await doc.save();
        } catch { /* ignore */ }
      }
      return { ok: true, output: `Successfully applied edits:\n${results.join("\n")}` };
    } else {
      return { ok: false, output: "Failed to apply workspace edits. There might be a conflict or invalid file paths." };
    }
  }

  private resolveFullPath(p: string): string {
    if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return p;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return p;
    return path.join(folders[0].uri.fsPath, p);
  }
}
