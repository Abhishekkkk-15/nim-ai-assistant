import { BaseAgent, AgentRole } from "./BaseAgent";

export class ChatAssistantAgent extends BaseAgent {
  readonly role: AgentRole = "chat";
  readonly label = "Chat Assistant";

  protected systemPrompt(): string {
    return `You are NIM Chat — a helpful, concise coding assistant. Answer the user's question or perform the requested task. Prefer to first inspect the workspace using the read_file or search_workspace tools when answering questions about the user's code. Use markdown in your final answer and keep code blocks language-tagged.`;
  }
}
