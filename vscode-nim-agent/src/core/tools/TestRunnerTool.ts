import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class TestRunnerTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "run_tests",
      description: "Automatically detect and run tests in the workspace. Returns the test results and any failures.",
      input: {
        type: "object",
        properties: {
          testFile: { type: "string", description: "Optional specific test file to run." },
          testPattern: { type: "string", description: "Optional pattern/grep to filter tests." },
          runner: { type: "string", enum: ["npm", "jest", "mocha", "pytest", "vitest"], description: "Force a specific test runner." }
        }
      },
      requiresPermission: true
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return { ok: false, output: "No workspace folder open." };
    }
    const rootPath = folders[0].uri.fsPath;

    let runner = input.runner ? String(input.runner) : await this.detectRunner(rootPath);
    let command = "";

    if (runner === "npm") {
      command = "npm test";
      if (input.testFile) command += ` -- ${input.testFile}`;
    } else if (runner === "jest") {
      command = `npx jest ${input.testFile || ""}`;
      if (input.testPattern) command += ` -t "${input.testPattern}"`;
    } else if (runner === "vitest") {
      command = `npx vitest run ${input.testFile || ""}`;
    } else if (runner === "pytest") {
      command = `pytest ${input.testFile || ""}`;
    } else {
      return { ok: false, output: "Could not automatically detect a test runner. Please specify 'runner' or 'command' in 'run_command' instead." };
    }

    return new Promise((resolve) => {
      cp.exec(command, { cwd: rootPath }, (error, stdout, stderr) => {
        const output = stdout + stderr;
        const ok = !error;
        
        // Basic parsing for summary
        let summary = "";
        if (output.includes("Tests:")) {
          const lines = output.split("\n");
          summary = lines.find(l => l.includes("Tests:")) || "";
        }

        resolve({ 
          ok, 
          output: `Command: ${command}\n\n${output}\n\n${summary ? "Summary: " + summary : ""}`
        });
      });
    });
  }

  private async detectRunner(root: string): Promise<string | undefined> {
    const pkgPath = path.join(root, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.scripts?.test) return "npm";
        if (pkg.devDependencies?.jest || pkg.dependencies?.jest) return "jest";
        if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) return "vitest";
      } catch { /* ignore */ }
    }
    if (fs.existsSync(path.join(root, "pytest.ini")) || fs.existsSync(path.join(root, "conftest.py"))) return "pytest";
    return undefined;
  }
}
