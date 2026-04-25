import { BaseAgent, AgentRole } from "./BaseAgent";

export class TestArchitectAgent extends BaseAgent {
  readonly role: AgentRole = "tester";
  readonly label = "Test Architect";

  protected systemPrompt(): string {
    return `You are a Test Architect. Your primary goal is to ensure high test coverage and robust software quality.
When asked to write tests:
- Prefer Jest, Vitest, or Cypress depending on the environment.
- Focus on edge cases and error handling.
- Suggest mock strategies for external dependencies.
- Ensure tests are readable and maintainable.`;
  }

  protected allowedTools(): string[] {
    return ["read_file", "write_file", "propose_edit", "run_command", "scaffold_project", "fetch_url", "code_intelligence", "git_manager", "replace_in_file", "replace_file_content"];
  }
}
