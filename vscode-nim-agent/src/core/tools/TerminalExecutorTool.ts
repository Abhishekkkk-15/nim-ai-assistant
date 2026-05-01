import * as vscode from "vscode";
import * as cp from "child_process";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

const TERMINAL_NAME = "NIM Agent";

export class TerminalExecutorTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "run_command",
      description:
        "Run a shell command and capture its stdout/stderr. Use this for building, testing, or inspecting state.",
      input: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
          cwd: { type: "string", description: "Optional working directory." }
        },
        required: ["command"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = String(input.command ?? "").trim();
    const cwd = input.cwd ? String(input.cwd) : undefined;
    if (!command) {
      return { ok: false, output: "Missing 'command' argument." };
    }

    // Show in terminal for user visibility
    const terminal = this.acquireTerminal(cwd);
    terminal.show(true);
    terminal.sendText(`echo "[NIM Agent] Running: ${command.replace(/"/g, '\\"')}"`, true);
    terminal.sendText(command, true);

    return new Promise<ToolResult>((resolve) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      cp.exec(command, { cwd: cwd || workspaceRoot }, (error, stdout, stderr) => {
        const output = stdout + stderr;
        if (error) {
          resolve({ ok: false, output: `Command failed: ${error.message}\n${output}` });
        } else {
          resolve({ ok: true, output });
        }
      });
    });
  }

  private acquireTerminal(cwd?: string): vscode.Terminal {
    const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
    if (existing && !cwd) {
      return existing;
    }
    return vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
  }
}
