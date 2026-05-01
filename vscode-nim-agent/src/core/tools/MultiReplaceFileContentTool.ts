import * as vscode from "vscode";
import * as path from "path";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export interface ReplacementChunk {
  targetContent: string;
  replacementContent: string;
  startLine?: number;
  endLine?: number;
}

export class MultiReplaceFileContentTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "multi_replace_file_content",
      description: "Surgically edit a single file by replacing multiple non-contiguous blocks of text in one atomic operation. Use this when you need to make several changes to the same file to ensure consistency and avoid race conditions.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the target file." },
          chunks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                targetContent: { type: "string", description: "The EXACT character sequence in the file to be replaced." },
                replacementContent: { type: "string", description: "The new content to insert." },
                startLine: { type: "number", description: "Optional. 1-indexed start line to restrict search." },
                endLine: { type: "number", description: "Optional. 1-indexed end line to restrict search." }
              },
              required: ["targetContent", "replacementContent"]
            },
            minItems: 1
          }
        },
        required: ["path", "chunks"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(input.path);
    const chunks = input.chunks as ReplacementChunk[];

    if (!filePath || !chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return { ok: false, output: "Missing required 'path' or 'chunks'." };
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return { ok: false, output: "No workspace folder open." };
    }

    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(folders[0].uri.fsPath, filePath);
    const uri = vscode.Uri.file(fullPath);

    try {
      const data = await vscode.workspace.fs.readFile(uri);
      let text = Buffer.from(data).toString("utf8");

      // Sort chunks by line number if provided, to help with sequential replacement if needed
      // However, since we are doing string replacement on the whole text (or ranges), 
      // we need to be careful about overlaps.
      
      let currentText = text;
      const results: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const target = chunk.targetContent;
        const replacement = chunk.replacementContent;
        const startLine = chunk.startLine;
        const endLine = chunk.endLine;

        const lines = currentText.split(/\r?\n/);
        let searchStartIdx = 0;
        let searchEndIdx = lines.length;

        if (startLine !== undefined && startLine >= 1) {
          searchStartIdx = startLine - 1;
        }
        if (endLine !== undefined && endLine >= 1 && endLine <= lines.length) {
          searchEndIdx = endLine;
        }

        if (searchStartIdx > searchEndIdx) {
          return { ok: false, output: `Chunk ${i}: startLine cannot be greater than endLine.` };
        }

        const searchArea = lines.slice(searchStartIdx, searchEndIdx).join("\n");
        
        if (!searchArea.includes(target)) {
          return { ok: false, output: `Chunk ${i}: targetContent not found in specified range. Check whitespace/indentation.` };
        }

        // Check for multiple occurrences in the search area
        const firstIdx = searchArea.indexOf(target);
        const secondIdx = searchArea.indexOf(target, firstIdx + target.length);
        if (secondIdx !== -1) {
           return { ok: false, output: `Chunk ${i}: targetContent found multiple times in range. Use more specific content or line bounds.` };
        }

        const newSearchArea = searchArea.replace(target, replacement);
        const newLines = [
          ...lines.slice(0, searchStartIdx),
          ...newSearchArea.split("\n"),
          ...lines.slice(searchEndIdx)
        ];
        
        currentText = newLines.join("\n");
        results.push(`Chunk ${i}: Applied.`);
      }

      await vscode.workspace.fs.writeFile(uri, Buffer.from(currentText, "utf8"));

      return { ok: true, output: `Successfully applied ${chunks.length} block replacements in ${filePath}.\n${results.join("\n")}` };
    } catch (err) {
      return { ok: false, output: `Failed to apply multi-replace: ${(err as Error).message}` };
    }
  }
}
