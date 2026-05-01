import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class CodeIntelligenceTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "code_intelligence",
      description:
        "Perform semantic AST (Abstract Syntax Tree) searches across the workspace using VS Code's native Language Servers. Use this to find where classes/functions are defined, or find all references to them.",
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["workspace_symbol", "find_references"],
            description: "The action to perform."
          },
          query: {
            type: "string",
            description: "For workspace_symbol, provide the name of the function or class. For find_references, provide the absolute path and exact line/character coordinates (not supported yet, use WorkspaceSearchTool for now)."
          }
        },
        required: ["action", "query"]
      },
      requiresPermission: false
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = String(input.action);
    const query = String(input.query);

    try {
      if (action === "workspace_symbol") {
        // This command returns SymbolInformation[]
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          "vscode.executeWorkspaceSymbolProvider",
          query
        );

        if (!symbols || symbols.length === 0) {
          return { ok: true, output: `No symbols found for '${query}'.` };
        }

        const results = symbols.slice(0, 20).map((sym) => {
          const kind = vscode.SymbolKind[sym.kind] || "Unknown";
          const uri = sym.location.uri.fsPath;
          const range = sym.location.range;
          return `[${kind}] ${sym.name} - ${uri} (Line ${range.start.line + 1})`;
        });

        return {
          ok: true,
          output: `Found ${symbols.length} symbols (showing top 20):\n${results.join("\n")}`
        };
      } 
      
      if (action === "find_references") {
        // Find references requires a Uri and a Position.
        // It's very complex to expect the LLM to provide exact row/col.
        // I will return an error suggesting the WorkspaceSearchTool instead.
        return {
          ok: false,
          output: "find_references requires exact AST coordinates which are hard to guess. Please use the 'search_workspace' tool instead to find usages of this symbol."
        };
      }

      return { ok: false, output: `Unknown action: ${action}` };
    } catch (err) {
      return { ok: false, output: `Code intelligence failed: ${(err as Error).message}` };
    }
  }
}
