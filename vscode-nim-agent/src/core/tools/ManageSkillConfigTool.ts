import { BaseTool, ToolDefinition, ToolResult } from "./BaseTool";
import { ExtensionContextStore } from "../../utils/context";

export class ManageSkillConfigTool extends BaseTool {
  constructor(private readonly store: ExtensionContextStore) {
    super();
  }

  definition(): ToolDefinition {
    return {
      name: "manage_skill_config",
      description: "Read or update the configuration for Agent Skills (e.g., user preferences for issue trackers, labels, etc.).",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "update"], description: "The action to perform." },
          config: { type: "object", description: "The configuration object to save (only for 'update' action)." }
        },
        required: ["action"]
      }
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = input.action as "read" | "update";
    
    if (action === "read") {
      const config = await this.store.skillManager.loadConfig();
      return { ok: true, output: JSON.stringify(config, null, 2) };
    } else if (action === "update") {
      const config = input.config as Record<string, any>;
      if (!config) return { ok: false, output: "Missing 'config' object for update." };
      
      await this.store.skillManager.saveConfig(config);
      return { ok: true, output: "Configuration updated successfully." };
    }
    
    return { ok: false, output: "Invalid action." };
  }
}
