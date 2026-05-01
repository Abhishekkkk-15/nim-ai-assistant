import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class CodeIntelligenceTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "code_intelligence",
      description:
        "Perform semantic AST (Abstract Syntax Tree) searches using VS Code's Language Servers. Use this to find where classes/functions are defined, find all references to them, or list symbols in a file.",
      input: {
        type: "object",
        properties: {
          action: { 
            type: "string", 
            description: "The action to perform: workspace_symbol (search across workspace), get_definitions (find where a symbol is defined), get_references (find where a symbol is used), list_file_symbols (list all symbols in a specific file)." 
          } as any,
          query: { type: "string", description: "Symbol name to search for (used for workspace_symbol)." } as any,
          path: { type: "string", description: "File path (used for get_definitions, get_references, list_file_symbols)." } as any,
          line: { type: "number", description: "1-indexed line number (used for get_definitions, get_references)." } as any,
          character: { type: "number", description: "1-indexed character position (used for get_definitions, get_references)." } as any
        },
        required: ["action"]
      },
      requiresPermission: false
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = String(input.action);

    try {
      if (action === "workspace_symbol") {
        const query = String(input.query || "");
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          "vscode.executeWorkspaceSymbolProvider",
          query
        );

        if (!symbols || symbols.length === 0) {
          return { ok: true, output: `No symbols found for '${query}'.` };
        }

        const results = symbols.slice(0, 30).map((sym) => {
          const kind = vscode.SymbolKind[sym.kind] || "Unknown";
          const uri = sym.location.uri.fsPath;
          const range = sym.location.range;
          return `[${kind}] ${sym.name} - ${vscode.workspace.asRelativePath(uri)} (Line ${range.start.line + 1})`;
        });

        return {
          ok: true,
          output: `Found ${symbols.length} symbols (showing top 30):\n${results.join("\n")}`
        };
      } 
      
      if (action === "get_definitions" || action === "get_references") {
        const filePath = String(input.path || "");
        const line = Number(input.line || 1) - 1;
        const character = Number(input.character || 1) - 1;

        if (!filePath) return { ok: false, output: "Missing 'path' for definition/reference search." };

        const uri = vscode.Uri.file(pathIsAbsolute(filePath) ? filePath : vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, filePath).fsPath);
        const pos = new vscode.Position(line, character);

        const command = action === "get_definitions" ? "vscode.executeDefinitionProvider" : "vscode.executeReferenceProvider";
        const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(command, uri, pos);

        if (!locations || locations.length === 0) {
          return { ok: true, output: `No ${action === "get_definitions" ? "definitions" : "references"} found at L${line + 1}:${character + 1} in ${filePath}.` };
        }

        const results = locations.map(loc => {
          const l = "uri" in loc ? loc : { uri: loc.targetUri, range: loc.targetRange };
          return `${vscode.workspace.asRelativePath(l.uri)} (Line ${l.range.start.line + 1})`;
        });

        return { ok: true, output: `Found ${locations.length} results:\n${results.join("\n")}` };
      }

      if (action === "list_file_symbols") {
        const filePath = String(input.path || "");
        if (!filePath) return { ok: false, output: "Missing 'path' for file symbol listing." };

        const uri = vscode.Uri.file(pathIsAbsolute(filePath) ? filePath : vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, filePath).fsPath);
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          "vscode.executeDocumentSymbolProvider",
          uri
        );

        if (!symbols || symbols.length === 0) {
          return { ok: true, output: `No symbols found in ${filePath}.` };
        }

        const flattenSymbols = (syms: vscode.DocumentSymbol[], indent = ""): string[] => {
          let res: string[] = [];
          for (const s of syms) {
            const kind = vscode.SymbolKind[s.kind] || "Unknown";
            res.push(`${indent}[${kind}] ${s.name} (Line ${s.range.start.line + 1})`);
            if (s.children && s.children.length > 0) {
              res.push(...flattenSymbols(s.children, indent + "  "));
            }
          }
          return res;
        };

        const list = flattenSymbols(symbols);
        return { ok: true, output: `Symbols in ${filePath}:\n${list.join("\n")}` };
      }

      return { ok: false, output: `Unknown action: ${action}` };
    } catch (err) {
      return { ok: false, output: `Code intelligence failed: ${(err as Error).message}` };
    }
  }
}

function pathIsAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:/.test(p);
}
