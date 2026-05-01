import * as vscode from "vscode";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class DebuggerTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "debugger",
      description: "Control the VS Code debugger to hunt for bugs at runtime. You can start debug sessions, set breakpoints, and evaluate variables.",
      input: {
        type: "object",
        properties: {
          action: { 
            type: "string", 
            description: "The action to perform: start (start debugging), stop (stop debugging), set_breakpoint (add a breakpoint), evaluate (inspect a variable/expression), get_stack (get current call stack)." 
          } as any,
          path: { type: "string", description: "File path for breakpoints." } as any,
          line: { type: "number", description: "Line number for breakpoints." } as any,
          expression: { type: "string", description: "Expression to evaluate." } as any,
          configName: { type: "string", description: "Name of the launch configuration to use." } as any
        },
        required: ["action"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = String(input.action);

    try {
      if (action === "start") {
        const configName = input.configName ? String(input.configName) : undefined;
        const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], configName || {
          type: "node",
          request: "launch",
          name: "NIM Auto Debug",
          program: "${file}"
        });
        return { ok: started, output: started ? "Debug session started." : "Failed to start debug session." };
      }

      if (action === "stop") {
        await vscode.commands.executeCommand("workbench.action.debug.stop");
        return { ok: true, output: "Debug session stopped." };
      }

      if (action === "set_breakpoint") {
        const filePath = String(input.path || "");
        const line = Number(input.line || 1);
        if (!filePath) return { ok: false, output: "Missing 'path' for breakpoint." };

        const uri = vscode.Uri.file(filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath) ? filePath : vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, filePath).fsPath);
        const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)));
        vscode.debug.addBreakpoints([breakpoint]);
        return { ok: true, output: `Breakpoint set at ${filePath}:${line}` };
      }

      if (action === "evaluate") {
        const session = vscode.debug.activeDebugSession;
        if (!session) return { ok: false, output: "No active debug session. Use 'start' first." };

        const expression = String(input.expression || "");
        const response = await session.customRequest("stackTrace", { threadId: 1 });
        const frameId = response.stackFrames[0]?.id;

        const result = await session.customRequest("evaluate", {
          expression,
          frameId,
          context: "hover"
        });

        return { ok: true, output: `Result: ${JSON.stringify(result.result)}` };
      }

      if (action === "get_stack") {
        const session = vscode.debug.activeDebugSession;
        if (!session) return { ok: false, output: "No active debug session." };

        const response = await session.customRequest("stackTrace", { threadId: 1 });
        const frames = response.stackFrames.map((f: any) => `${f.name} (${f.source?.name || "unknown"}:${f.line})`);
        return { ok: true, output: `Stack Trace:\n${frames.join("\n")}` };
      }

      return { ok: false, output: `Unknown action: ${action}` };
    } catch (err) {
      return { ok: false, output: `Debugger tool failed: ${(err as Error).message}` };
    }
  }
}
