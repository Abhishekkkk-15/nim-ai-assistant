import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";
import { VALID_HANDOFF_ROLES } from "./HandOffTool";

export const PARALLEL_HANDOFF_MARKER = "__PARALLEL_HANDOFF__";

export interface ParallelHandoffItem {
  to: string;
  reason: string;
  followUp: string;
}

/**
 * Lets the supervisor trigger multiple agents in parallel.
 * Example: Triggering a Coder and a Tester simultaneously.
 */
export class ParallelHandOffTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "parallel_hand_off",
      description: "Trigger multiple specialized agents to work on different parts of a task simultaneously. Returns control to you only after ALL agents have finished. Use this for speed when tasks are independent.",
      input: {
        type: "object",
        properties: {
          handoffs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                to: { type: "string", description: "Role to hand off to." },
                reason: { type: "string", description: "Why this agent is being triggered." },
                followUp: { type: "string", description: "The specific prompt for this agent." }
              },
              required: ["to", "reason", "followUp"]
            },
            minItems: 2
          }
        },
        required: ["handoffs"]
      }
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const handoffs = input.handoffs as ParallelHandoffItem[];
    if (!Array.isArray(handoffs) || handoffs.length < 2) {
      return { ok: false, output: "Must provide at least 2 handoffs for parallel execution." };
    }

    for (const item of handoffs) {
      if (!VALID_HANDOFF_ROLES.includes(item.to as any)) {
        return { ok: false, output: `Invalid role: ${item.to}` };
      }
    }

    const payload = JSON.stringify(handoffs);
    return {
      ok: true,
      terminal: true,
      output: `Triggering ${handoffs.length} agents in parallel...\n${PARALLEL_HANDOFF_MARKER}${payload}`
    };
  }
}
