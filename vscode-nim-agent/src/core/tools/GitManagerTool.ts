import * as vscode from "vscode";
import * as cp from "child_process";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class GitManagerTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "git_manager",
      description: "Manage git repository. Can view status, view diffs, and create conventional commits.",
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "diff", "commit"],
            description: "Git action to perform."
          },
          commitType: {
            type: "string",
            enum: ["feat", "fix", "chore", "docs", "style", "refactor", "perf", "test"],
            description: "REQUIRED for commit. The type of change according to Conventional Commits."
          },
          commitScope: {
            type: "string",
            description: "OPTIONAL for commit. The scope of the change (e.g., 'ui', 'api')."
          },
          commitMessage: {
            type: "string",
            description: "REQUIRED for commit. A brief, imperative description of the change."
          }
        },
        required: ["action"]
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = String(input.action);

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return { ok: false, output: "No workspace folder open." };
    }
    const cwd = folders[0].uri.fsPath;

    try {
      if (action === "status") {
        const out = await this.execCommand("git status -s", cwd);
        return { ok: true, output: out || "No changes (working tree clean)." };
      }

      if (action === "diff") {
        let out = await this.execCommand("git diff HEAD", cwd);
        if (!out.trim()) {
          out = await this.execCommand("git diff", cwd); // Check unstaged if HEAD diff is empty
        }
        
        if (out.length > 50000) {
          out = out.substring(0, 50000) + "\n...[Diff Truncated]";
        }
        return { ok: true, output: out || "No diff available." };
      }

      if (action === "commit") {
        const type = input.commitType as string;
        const scope = input.commitScope ? `(${input.commitScope})` : "";
        const message = input.commitMessage as string;

        if (!type || !message) {
          return { ok: false, output: "commitType and commitMessage are strictly required for the 'commit' action." };
        }

        const formattedMessage = `${type}${scope}: ${message}`;
        
        // Add all and commit
        await this.execCommand("git add .", cwd);
        
        // Escape double quotes in message
        const escapedMsg = formattedMessage.replace(/"/g, '\\"');
        const out = await this.execCommand(`git commit -m "${escapedMsg}"`, cwd);
        
        return { ok: true, output: `Successfully committed:\n${out}` };
      }

      return { ok: false, output: `Unknown action: ${action}` };
    } catch (err) {
      return { ok: false, output: `Git error: ${(err as Error).message}` };
    }
  }

  private execCommand(cmd: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.exec(cmd, { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${error.message}\n${stderr}`));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }
}
