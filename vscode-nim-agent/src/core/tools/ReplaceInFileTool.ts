import * as vscode from "vscode";
import * as path from "path";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class ReplaceInFileTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "replace_in_file",
      description: "Perform a precise string replacement in a file. Use this for targeted edits like checking off a task in a markdown list without rewriting the entire file.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to modify." },
          targetContent: { type: "string", description: "The exact string to find and replace." },
          replacementContent: { type: "string", description: "The string to replace it with." },
          replaceAll: { type: "boolean", description: "If true, replaces all occurrences. Default is false (first occurrence only)." }
        },
        required: ["path", "targetContent", "replacementContent"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(input.path);
    const target = String(input.targetContent);
    const replacement = String(input.replacementContent);
    const replaceAll = Boolean(input.replaceAll);

    if (!filePath || !target) {
      return { ok: false, output: "Missing required 'path' or 'targetContent'." };
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return { ok: false, output: "No workspace folder open." };
    }

    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(folders[0].uri.fsPath, filePath);
    const uri = vscode.Uri.file(fullPath);

    try {
      const data = await vscode.workspace.fs.readFile(uri);
      let content = Buffer.from(data).toString("utf8");

      if (!content.includes(target)) {
        return { ok: false, output: `Target content not found in file.` };
      }

      if (replaceAll) {
        content = content.split(target).join(replacement);
      } else {
        content = content.replace(target, replacement);
      }

      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));

      return { ok: true, output: `Successfully replaced content in ${filePath}.` };
    } catch (err) {
      return { ok: false, output: `Failed to replace in file: ${(err as Error).message}` };
    }
  }
}
