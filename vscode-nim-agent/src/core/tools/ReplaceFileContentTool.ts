import * as vscode from "vscode";
import * as path from "path";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class ReplaceFileContentTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "replace_file_content",
      description: "Surgically edit an existing file by replacing a specific block of text. Use this INSTEAD of 'write_file' when modifying existing files to save time and avoid rewriting the whole document.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the target file." },
          targetContent: { type: "string", description: "The EXACT character sequence currently in the file to be replaced, including all whitespace and indentation." },
          replacementContent: { type: "string", description: "The new content to insert in its place." },
          startLine: { type: "number", description: "Optional. 1-indexed start line to restrict the search." },
          endLine: { type: "number", description: "Optional. 1-indexed end line to restrict the search." },
          allowMultiple: { type: "boolean", description: "Optional. If true, replaces all occurrences found within the bounds. Default false." }
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
    const startLine = input.startLine ? Number(input.startLine) : undefined;
    const endLine = input.endLine ? Number(input.endLine) : undefined;
    const allowMultiple = Boolean(input.allowMultiple);

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
      const text = Buffer.from(data).toString("utf8");
      const lines = text.split(/\r?\n/);

      let searchStartIdx = 0;
      let searchEndIdx = lines.length;

      if (startLine !== undefined && startLine >= 1) {
        searchStartIdx = startLine - 1;
      }
      if (endLine !== undefined && endLine >= 1 && endLine <= lines.length) {
        searchEndIdx = endLine;
      }

      if (searchStartIdx > searchEndIdx) {
        return { ok: false, output: "startLine cannot be greater than endLine." };
      }

      const searchArea = lines.slice(searchStartIdx, searchEndIdx).join("\n");
      
      let occurrences = 0;
      let pos = searchArea.indexOf(target);
      while (pos !== -1) {
        occurrences++;
        pos = searchArea.indexOf(target, pos + target.length);
      }

      if (occurrences === 0) {
        return { ok: false, output: "targetContent not found in the specified range. Ensure exact whitespace matching." };
      }

      if (occurrences > 1 && !allowMultiple) {
        return { ok: false, output: `Found ${occurrences} occurrences. Set allowMultiple: true to replace all, or specify startLine/endLine to target just one.` };
      }

      const newSearchArea = allowMultiple 
        ? searchArea.split(target).join(replacement)
        : searchArea.replace(target, replacement);

      const finalLines = [
        ...lines.slice(0, searchStartIdx),
        ...newSearchArea.split("\n"),
        ...lines.slice(searchEndIdx)
      ];

      await vscode.workspace.fs.writeFile(uri, Buffer.from(finalLines.join("\n"), "utf8"));

      return { ok: true, output: `Successfully applied block replacement in ${filePath}.` };
    } catch (err) {
      return { ok: false, output: `Failed to replace file content: ${(err as Error).message}` };
    }
  }
}
