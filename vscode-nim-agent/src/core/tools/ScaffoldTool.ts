import * as vscode from "vscode";
import * as path from "path";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class ScaffoldTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "scaffold_project",
      description:
        "Generate a directory structure and create multiple files at once. Use this to quickly bootstrap components, modules, or entire projects.",
      input: {
        type: "object",
        properties: {
          files: {
            type: "array",
            description: "List of files to create with their contents.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Relative path to the file (e.g., 'src/components/Button.tsx')" },
                content: { type: "string", description: "The complete content of the file." }
              },
              required: ["path", "content"]
            }
          }
        },
        required: ["files"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const files = input.files as Array<{ path: string; content: string }>;
    if (!Array.isArray(files) || files.length === 0) {
      return { ok: false, output: "Missing or invalid 'files' argument." };
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return { ok: false, output: "No workspace folder is open." };
    }

    const rootUri = folders[0].uri;
    const createdFiles: string[] = [];
    const errors: string[] = [];

    for (const file of files) {
      if (!file.path || typeof file.content !== "string") {
        errors.push(`Invalid file format: ${JSON.stringify(file)}`);
        continue;
      }

      try {
        const fileUri = vscode.Uri.joinPath(rootUri, file.path);
        
        // Ensure directory exists by attempting to write the file, vscode fs.writeFile creates missing directories
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(file.content, "utf8"));
        createdFiles.push(file.path);
      } catch (err) {
        errors.push(`Failed to write ${file.path}: ${(err as Error).message}`);
      }
    }

    if (errors.length > 0) {
      return { 
        ok: false, 
        output: `Scaffold partially failed.\nCreated:\n${createdFiles.join("\n")}\nErrors:\n${errors.join("\n")}` 
      };
    }

    return {
      ok: true,
      output: `Successfully scaffolded ${createdFiles.length} files:\n${createdFiles.join("\n")}`
    };
  }
}
