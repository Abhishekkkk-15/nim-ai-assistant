import type { AgentRole, BaseAgent } from "./BaseAgent";

export class AgentRegistry {
  private agents = new Map<AgentRole, BaseAgent>();

  register(agent: BaseAgent): void {
    this.agents.set(agent.role, agent);
  }

  get(role: AgentRole): BaseAgent {
    const agent = this.agents.get(role);
    if (!agent) {
      throw new Error(`No agent registered for role: ${role}`);
    }
    return agent;
  }

  list(): BaseAgent[] {
    return [...this.agents.values()];
  }
}
