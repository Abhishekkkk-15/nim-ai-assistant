import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class ProposeEditTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "propose_edit",
      description:
        "Propose a change to a file and open a diff for the user to review. This is preferred over write_file for complex changes.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file." },
          content: { type: "string", description: "New content for the file." },
          description: { type: "string", description: "Brief description of the change." }
        },
        required: ["path", "content", "description"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const path = String(input.path ?? "");
    const content = String(input.content ?? "");
    const description = String(input.description ?? "");

    if (!path || !content) {
      return { ok: false, output: "Missing path or content." };
    }

    // This tool is essentially a wrapper around a permission request that specifically
    // highlights the "Review" action. The ChatViewProvider will handle the display.
    
    return {
      ok: true,
      output: `Proposed edit to ${path}: ${description}. Waiting for user review...`
    };
  }
}
