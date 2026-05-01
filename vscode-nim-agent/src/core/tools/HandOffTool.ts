import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

/**
 * Lets the active agent hand off to a more specialized agent for the rest
 * of the task. The tool itself does no real work; it terminates the current
 * agent's loop with a structured marker that the chat provider parses to
 * spawn the next agent automatically.
 *
 * The structured marker is:
 *   __HANDOFF__{ "to": "<role>", "reason": "..." }
 */
export const HANDOFF_MARKER = "__HANDOFF__";

export const VALID_HANDOFF_ROLES = ["chat", "coder", "debugger", "refactor", "security", "tester", "supervisor", "reviewer"] as const;

export class HandOffTool extends BaseTool {
  definition(): ToolDefinition {
    return {
      name: "hand_off",
      description:
        "Transfer control of the conversation to a more specialized agent. " +
        "Use when the current agent is the wrong fit for the next step. " +
        "Valid 'to' values: chat, coder, debugger, refactor, security, tester, supervisor, reviewer.",
      input: {
        type: "object",
        properties: {
          to: { type: "string", description: "Role to hand off to. One of: chat, coder, debugger, refactor, security, tester, supervisor, reviewer." },
          reason: { type: "string", description: "Short explanation of why the handoff is needed." },
          followUp: { type: "string", description: "Optional. The exact prompt to send to the next agent. If omitted, the original prompt is reused with the reason as preamble." }
        },
        required: ["to", "reason"]
      }
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const to = String(input.to ?? "").trim().toLowerCase();
    const reason = String(input.reason ?? "").trim();
    const followUp = typeof input.followUp === "string" ? input.followUp : "";

    if (!to || !VALID_HANDOFF_ROLES.includes(to as (typeof VALID_HANDOFF_ROLES)[number])) {
      return {
        ok: false,
        output: `Invalid 'to' value "${to}". Must be one of: ${VALID_HANDOFF_ROLES.join(", ")}.`,
      };
    }
    if (!reason) {
      return { ok: false, output: "Missing 'reason' for handoff." };
    }

    const payload = JSON.stringify({ to, reason, followUp });
    return {
      ok: true,
      terminal: true,
      output: `Handing off to **${to}** — ${reason}\n${HANDOFF_MARKER}${payload}`,
    };
  }
}
