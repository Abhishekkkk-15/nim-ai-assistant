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
          action: { type: "string", description: "Git action: status, stage, commit, diff, push, pull, log." } as any,
          message: { type: "string", description: "Commit message (required for 'commit')." } as any,
          path: { type: "string", description: "Optional path for status, diff, or stage." } as any,
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
    if (!folders || folders.length === 0) return { ok: false, output: "No workspace folder open." };
    const cwd = folders[0].uri.fsPath;

    try {
      if (action === "status") {
        const out = await this.runGit(["status", "-s"], cwd);
        return { ok: true, output: out || "No changes (working tree clean)." };
      }

      if (action === "diff") {
        let out = await this.runGit(["diff", "HEAD"], cwd);
        if (!out.trim()) out = await this.runGit(["diff"], cwd);
        if (out.length > 50000) out = out.substring(0, 50000) + "\n...[Diff Truncated]";
        return { ok: true, output: out || "No diff available." };
      }

      if (action === "commit") {
        const type = input.commitType as string;
        const scope = input.commitScope ? `(${input.commitScope})` : "";
        const message = input.commitMessage as string;
        if (!type || !message) return { ok: false, output: "commitType and commitMessage are required." };
        const formattedMessage = `${type}${scope}: ${message}`;
        
        await this.runGit(["add", "."], cwd);
        const out = await this.runGit(["commit", "-m", formattedMessage], cwd);
        return { ok: true, output: `Successfully committed:\n${out}` };
      }

      return { ok: false, output: `Unknown action: ${action}` };
    } catch (err) {
      return { ok: false, output: `Git error: ${(err as Error).message}` };
    }
  }

  private runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn("git", args, { cwd, shell: true });
      let stdout = "", stderr = "";
      proc.stdout.on("data", data => stdout += data.toString());
      proc.stderr.on("data", data => stderr += data.toString());
      proc.on("close", code => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`Git command failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
      });
    });
  }
}
