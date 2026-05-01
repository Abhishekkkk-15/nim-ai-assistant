import * as vscode from "vscode";
import * as cp from "child_process";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class FrameworkScaffoldTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "framework_scaffold",
      description: "Bootstrap a new project or discover CLI flags. Use 'inspect_help' to find non-interactive flags (e.g. --yes, --no-git) for any tool, then 'scaffold' with a custom command.",
      input: {
        type: "object",
        properties: {
          action: { 
            type: "string", 
            enum: ["scaffold", "inspect_help"],
            description: "Whether to run a scaffolding command or just inspect its help/flags." 
          } as any,
          framework: { 
            type: "string", 
            description: "The name of the framework or CLI (e.g., 'nextjs', 'nest', 'laravel')." 
          } as any,
          command: { 
            type: "string", 
            description: "Optional. Full command to run (used for 'scaffold'). If omitted, templates are used." 
          } as any,
          path: { type: "string", description: "Relative path where the project should be created." } as any,
          typescript: { type: "boolean", description: "Used only for pre-defined templates (nextjs, vite)." } as any,
          tailwind: { type: "boolean", description: "Used only for pre-defined templates (nextjs)." } as any
        },
        required: ["action", "framework"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = String(input.action);
    const framework = String(input.framework).toLowerCase();
    const targetPath = input.path ? String(input.path) : ".";
    const useTs = input.typescript !== false;
    const useTailwind = input.tailwind !== false;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return { ok: false, output: "No workspace folder open." };
    }
    const rootPath = folders[0].uri.fsPath;

    if (action === "inspect_help") {
      const helpCmd = framework.includes(" ") ? `${framework} --help` : `npx ${framework} --help`;
      return new Promise((resolve) => {
        cp.exec(helpCmd, { cwd: rootPath }, (error, stdout, stderr) => {
          const output = stdout + stderr;
          resolve({ ok: true, output: `Help output for ${framework}:\n\n${output}\n\nSearch this output for flags like --yes, --non-interactive, --no-git, etc.` });
        });
      });
    }

    let command = input.command ? String(input.command) : "";
    
    // Fallback to templates if command not provided
    if (!command) {
      switch (framework) {
        case "nextjs":
          command = `npx -y create-next-app@latest "${targetPath}" --use-npm --no-git --eslint --app --src-dir --import-alias "@/*"`;
          if (useTs) command += " --typescript"; else command += " --javascript";
          if (useTailwind) command += " --tailwind"; else command += " --no-tailwind";
          break;
        case "vite-react":
          command = `npm create vite@latest "${targetPath}" -- --template ${useTs ? "react-ts" : "react"}`;
          break;
        case "vite-vue":
          command = `npm create vite@latest "${targetPath}" -- --template ${useTs ? "vue-ts" : "vue"}`;
          break;
        case "astro":
          command = `npx -y create-astro@latest "${targetPath}" --no-install --no-git --template minimal`;
          break;
        default:
          return { ok: false, output: `No template for '${framework}'. Use 'inspect_help' to find flags, then provide a full 'command'.` };
      }
    }

    const terminal = vscode.window.terminals.find(t => t.name === "NIM Agent") || vscode.window.createTerminal("NIM Agent");
    terminal.show();
    terminal.sendText(`echo "[NIM Agent] Scaffolding ${framework}..."`);
    terminal.sendText(command);

    return new Promise((resolve) => {
      cp.exec(command, { cwd: rootPath }, (error, stdout, stderr) => {
        const output = stdout + stderr;
        if (error) {
          resolve({ ok: false, output: `Scaffolding failed: ${error.message}\n${output}` });
        } else {
          resolve({ ok: true, output: `Successfully scaffolded ${framework}.\n${output}` });
        }
      });
    });
  }
}
