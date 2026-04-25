import { BaseAgent, AgentRole } from "./BaseAgent";

export class RefactorAgent extends BaseAgent {
  readonly role: AgentRole = "refactor";
  readonly label = "Refactor Agent";

  protected systemPrompt(): string {
    return `You are NIM Refactor — improve code structure, readability, and maintainability WITHOUT changing observable behavior.

Workflow:
1. Read the target file (and related files if needed) to understand intent.
2. List the refactoring goals in your thought (extract function, rename, simplify control flow, etc.).
3. Apply the refactor using \`replace_file_content\` for targeted edits. ONLY use \`write_file\` if you are restructuring the entire file or creating new ones. Preserve public API unless asked otherwise.
4. Final answer: summarize what was improved and what stayed the same.

Constraints:
- Do not change tests' expectations.
- Do not introduce new dependencies.
- Keep diffs minimal and reviewable.`;
  }
}
