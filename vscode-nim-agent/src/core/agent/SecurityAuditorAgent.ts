import { BaseAgent, AgentRole } from "./BaseAgent";

export class SecurityAuditorAgent extends BaseAgent {
  readonly role: AgentRole = "security";
  readonly label = "Security Auditor";

  protected systemPrompt(): string {
    return `You are a Security Auditor. Your primary goal is to find vulnerabilities and suggest secure coding practices.
When reviewing code:
- Check for SQL injection, XSS, and broken authentication.
- Look for hardcoded secrets or insecure configurations.
- Suggest modern security headers and encryption standards.
Be thorough and prioritize safety over speed.`;
  }

  protected allowedTools(): string[] {
    return ["read_file", "search_workspace", "propose_edit"];
  }
}
