import type { Logger } from "../../utils/logger";
import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();

  constructor(private readonly logger: Logger) {}

  register(tool: BaseTool): void {
    const def = tool.definition();
    if (this.tools.has(def.name)) {
      this.logger.warn(`Tool "${def.name}" is being re-registered.`);
    }
    this.tools.set(def.name, tool);
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  list(): BaseTool[] {
    return [...this.tools.values()];
  }

  describeForPrompt(): string {
    const lines: string[] = [];
    for (const tool of this.tools.values()) {
      const def = tool.definition();
      lines.push(`- ${def.name}: ${def.description}`);
      lines.push(`  input: ${JSON.stringify(def.input)}`);
    }
    return lines.join("\n");
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `Unknown tool: ${name}` };
    }
    try {
      this.logger.debug(`Executing tool ${name}`, input);
      return await tool.execute(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool ${name} threw`, err);
      return { ok: false, output: `Tool error: ${message}` };
    }
  }

  definitions(): ToolDefinition[] {
    return this.list().map((t) => t.definition());
  }
}
