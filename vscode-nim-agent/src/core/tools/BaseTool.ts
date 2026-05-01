export interface ToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input: ToolInputSchema;
  requiresPermission?: boolean;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /**
   * When true, the agent loop should stop because this tool has produced the final answer.
   */
  terminal?: boolean;
}

export abstract class BaseTool {
  abstract definition(): ToolDefinition;
  abstract execute(input: Record<string, unknown>): Promise<ToolResult>;
}
