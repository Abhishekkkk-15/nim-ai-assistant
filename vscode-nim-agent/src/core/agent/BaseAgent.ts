import * as vscode from "vscode";
import * as path from "path";
import type { ChatMessage } from "../../api/BaseProvider";
import type { ExtensionContextStore } from "../../utils/context";
import type { ToolResult } from "../tools/BaseTool";

export type AgentRole = "chat" | "coder" | "debugger" | "refactor" | "security" | "tester";

export interface AgentRunInput {
  prompt: string;
  context?: AgentContext;
  modelOverride?: string;
  planMode?: boolean;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onStep?: (step: AgentStep) => void;
  onPermissionRequest?: (tool: string, input: any) => Promise<boolean>;
  onPlanApproval?: (plan: string) => Promise<boolean>;
}

export interface AgentRunResult {
  content: string;
  steps: AgentStep[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface AgentStep {
  type: "thought" | "tool_call" | "tool_result" | "final";
  name?: string;
  payload: string;
}

export interface AgentContext {
  activeFile?: { path: string; language: string; content: string };
  selection?: { path: string; text: string; startLine: number; endLine: number };
  workspaceSummary?: string;
  diagnostics?: string;
  extraFiles?: { path: string; content: string }[];
}

interface ParsedAction {
  thought?: string;
  tool?: { name: string; input: Record<string, unknown> };
  plan?: string;
  final?: string;
}

interface MultiAction {
  thought?: string;
  actions: ParsedAction[];
}

/**
 * Shared agent loop. Subclasses customize the system prompt and tool whitelist.
 *
 * The loop is implemented as a "JSON action" pattern:
 *   - The model is instructed to reply with EITHER a tool call or a final answer
 *     wrapped in a fenced ```json``` block.
 *   - If a tool call is detected we execute it, append the result to the message
 *     history, and ask the model again — up to maxSteps times.
 *   - If a final answer is detected (or no JSON action is found and we've used
 *     at least one step) we return the response to the user.
 */
export abstract class BaseAgent {
  abstract readonly role: AgentRole;
  abstract readonly label: string;

  constructor(protected readonly store: ExtensionContextStore) {}

  protected abstract systemPrompt(): string;

  /**
   * Subclasses can restrict the tools this agent is allowed to call.
   * Default: all registered tools.
   */
  protected allowedTools(): string[] | undefined {
    return undefined;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const provider = this.store.providerRegistry.active();
    const model = input.modelOverride ?? this.store.modelManager.getActive();
    const config = vscode.workspace.getConfiguration("nimAgent");
    const maxSteps = config.get<number>("maxAgentSteps", 8);
    const streaming = config.get<boolean>("streaming", true);
    const temperature = config.get<number>("temperature", 0.4);
    const maxTokens = config.get<number>("maxTokens", 2048);
    const cacheEnabled = config.get<boolean>("cacheEnabled", true);

    const steps: AgentStep[] = [];
    const messages: ChatMessage[] = [];
    messages.push({ role: "system", content: this.buildSystemPrompt(input.context) });

    // Conversational memory
    const history = this.store.memory.asMessages(8);
    if (history.length > 0) {
      messages.push(...history);
    }
    messages.push({ role: "user", content: input.prompt });

    // Cheap cache for identical (model + prompt) pairs.
    const cacheKey = `${model}::${input.prompt}`;
    if (cacheEnabled) {
      const cached = this.store.cache.get(cacheKey);
      if (cached) {
        steps.push({ type: "final", payload: cached });
        input.onToken?.(cached);
        return { content: cached, steps };
      }
    }

    let finalContent = "";

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Smart Pruning: if messages exceed 20, keep system and last 10
    if (messages.length > 20) {
      const system = messages[0];
      const recent = messages.slice(-10);
      messages.length = 0;
      messages.push(system);
      messages.push({ role: "system", content: "[Context Pruned: Early messages removed to fit context window]" });
      messages.push(...recent);
    }

    let consecutiveNoJson = 0;
    for (let step = 0; step < maxSteps; step++) {
      let assistantText = "";
      let usage: any = undefined;
      
      if (streaming && input.onToken) {
        const result = await provider.chatStream(
          { model, messages, temperature, maxTokens, stream: true },
          {
            onToken: (t) => {
              assistantText += t;
              input.onToken?.(t);
            }
          },
          input.signal
        );
        assistantText = result.content || assistantText;
        usage = { prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens };
      } else {
        const result = await provider.chatComplete(
          { model, messages, temperature, maxTokens, stream: false },
          input.signal
        );
        assistantText = result.content;
        usage = { prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens };
      }

      if (usage) {
        totalPromptTokens += usage.prompt_tokens || 0;
        totalCompletionTokens += usage.completion_tokens || 0;
      }

      messages.push({ role: "assistant", content: assistantText });
      const { thought, actions } = this.parseActions(assistantText);

      if (thought) {
        const thoughtStep: AgentStep = { type: "thought", payload: thought };
        steps.push(thoughtStep);
        input.onStep?.(thoughtStep);
      }

      if (actions.length > 0) {
        let hasTool = false;
        const toolPromises = actions.map(async (action) => {
          if (action.tool) {
            hasTool = true;
            const toolName = action.tool.name;
            const toolInput = action.tool.input;

            const toolDef = this.store.toolRegistry.get(toolName)?.definition();
            if (this.allowedTools() && !this.allowedTools()!.includes(toolName)) {
              const denied = `Tool "${toolName}" is not allowed for the ${this.role} agent.`;
              return { toolName, result: { ok: false, output: denied } };
            }

            // Permission check
            if (toolDef?.requiresPermission && input.onPermissionRequest) {
              const allowed = await input.onPermissionRequest(toolName, toolInput);
              if (!allowed) {
                const denied = `User denied permission to execute ${toolName}.`;
                return { toolName, result: { ok: false, output: denied } };
              }
            }

            const toolCallStep: AgentStep = { type: "tool_call", name: toolName, payload: JSON.stringify(toolInput) };
            steps.push(toolCallStep);
            input.onStep?.(toolCallStep);
            
            const result = await this.store.toolRegistry.execute(toolName, toolInput);
            return { toolName, result };
          }
          return null;
        });

        const results = (await Promise.all(toolPromises)).filter(r => r !== null) as { toolName: string; result: ToolResult }[];
        
        for (const res of results) {
          const toolResultStep: AgentStep = { type: "tool_result", name: res.toolName, payload: res.result.output };
          steps.push(toolResultStep);
          input.onStep?.(toolResultStep);
          messages.push({ role: "user", content: this.toolResultPrompt(res.toolName, res.result) });
          
          if (res.result.terminal) {
             finalContent = res.result.output;
             return { content: finalContent, steps, usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens } };
          }
        }

        if (hasTool) {
          consecutiveNoJson = 0;
          continue;
        }

        const planAction = actions.find(a => a.plan);
        if (planAction && planAction.plan) {
          steps.push({ type: "thought", payload: `Proposed Plan: ${planAction.plan}` });
          if (input.onPlanApproval) {
            const approved = await input.onPlanApproval(planAction.plan);
            if (!approved) {
              finalContent = "Plan rejected by user. Stopping.";
              steps.push({ type: "final", payload: finalContent });
              break;
            }
          }
          messages.push({ role: "user", content: "Plan approved. Please proceed with the execution." });
          continue;
        }

        const finalAction = actions.find(a => a.final);
        if (finalAction && finalAction.final) {
          finalContent = finalAction.final;
          steps.push({ type: "final", payload: finalContent });
          break;
        }
      }

      // If no JSON block but we've had thoughts, and it looks like a tool call was intended
      if (actions.length === 0) {
        const looksLikeTool = assistantText.toLowerCase().includes("tool") || 
                             assistantText.toLowerCase().includes("read_file") ||
                             assistantText.toLowerCase().includes("write_file") ||
                             assistantText.toLowerCase().includes("replace");
        
        if (looksLikeTool && consecutiveNoJson < 2) {
          consecutiveNoJson++;
          messages.push({ role: "user", content: "It looks like you intended to call a tool but didn't provide the JSON block. Please provide exactly one JSON block for your next action." });
          continue;
        }
      }
      
      consecutiveNoJson = 0;
      if (actions.length === 0) {
         finalContent = assistantText;
         break;
      }
    }

    if (!finalContent && steps.length > 0) {
      finalContent = messages[messages.length - 1].content;
    }

    if (cacheEnabled) {
      this.store.cache.set(cacheKey, finalContent);
    }

    this.store.memory.add({
      id: `${Date.now()}`,
      agent: this.role,
      model,
      messages: [
        { role: "user", content: input.prompt },
        { role: "assistant", content: finalContent }
      ],
      createdAt: Date.now()
    });

    return { 
      content: finalContent, 
      steps, 
      usage: { 
        promptTokens: totalPromptTokens, 
        completionTokens: totalCompletionTokens, 
        totalTokens: totalPromptTokens + totalCompletionTokens 
      } 
    };
  }

  // ----- prompt helpers -----

  private buildSystemPrompt(ctx?: AgentContext): string {
    const tools = this.store.toolRegistry.describeForPrompt();
    const allowed = this.allowedTools();
    const allowedNote = allowed
      ? `You may ONLY use these tools: ${allowed.join(", ")}.`
      : "You may use any of the listed tools.";
    const ctxBlock = ctx ? this.formatContext(ctx) : "(no editor context provided)";

    let planInstruction = "";
    if (this.store.chatProvider?.isPlanMode()) {
      planInstruction = `
<planning_mode>
IMPORTANT: Plan Mode is ENABLED. You MUST follow this workflow:

1. Research first (using read_file, code_intelligence, etc).
2. Create an implementation plan artifact at \`.nim-agent/implementation_plan.md\` using the write_file tool.
3. Pause and request user approval by outputting the following JSON block:
\`\`\`json
{ "plan": "I have created the implementation plan artifact. Please review and approve." }
\`\`\`
4. After receiving approval, create \`.nim-agent/task.md\` using write_file to track your work with a \`- [ ]\` checklist.
5. As you work, use the \`replace_in_file\` tool to check off items (\`- [x]\`) in \`task.md\`.
6. When finished, create a summary artifact at \`.nim-agent/walkthrough.md\`.

<artifacts>
Store all artifacts in the \`.nim-agent\` directory.
Use standard markdown formatting. For task.md, use \`- [ ]\` for incomplete and \`- [x]\` for complete.
</artifacts>
</planning_mode>`;
    }

    return `${this.systemPrompt()}

You are running inside the NIM Agent IDE — an agentic VS Code extension. You can call tools to read or modify the user's workspace.

Available tools:
${tools}

${allowedNote}
${planInstruction}

To call tools, reply with one or more fenced JSON blocks. You may call multiple tools in parallel if it helps you achieve the goal faster (e.g. reading multiple files at once).
\`\`\`json
{ "tool": "<tool_name>", "input": { ... } }
\`\`\`

To produce the final answer for the user, reply with EXACTLY one fenced JSON block of the form:
\`\`\`json
{ "final": "<your markdown answer here>" }
\`\`\`

You may include a short natural-language thought BEFORE the JSON block if it helps you reason. Do not include both a tool call and a final answer in the same reply.

Editor context:
${ctxBlock}`;
  }

  private formatContext(ctx: AgentContext): string {
    const parts: string[] = [];
    if (ctx.activeFile) {
      parts.push(
        `Active file: ${ctx.activeFile.path} (${ctx.activeFile.language})\n` +
          "```\n" +
          this.truncate(ctx.activeFile.content, 6000) +
          "\n```"
      );
    }
    if (ctx.selection) {
      parts.push(
        `Selection in ${ctx.selection.path} lines ${ctx.selection.startLine}-${ctx.selection.endLine}:\n` +
          "```\n" +
          this.truncate(ctx.selection.text, 4000) +
          "\n```"
      );
    }
    if (ctx.workspaceSummary) {
      parts.push(`Workspace summary:\n${ctx.workspaceSummary}`);
    }
    if (ctx.diagnostics) {
      parts.push(`Diagnostics:\n${ctx.diagnostics}`);
    }
    if (ctx.extraFiles && ctx.extraFiles.length > 0) {
      parts.push("Additional Files Context:");
      for (const f of ctx.extraFiles) {
        parts.push(`File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
      }
    }
    return parts.length ? parts.join("\n\n") : "(no editor context provided)";
  }

  private toolResultPrompt(name: string, result: ToolResult): string {
    return `Tool "${name}" result (ok=${result.ok}):\n\`\`\`\n${this.truncate(result.output, 4000)}\n\`\`\`\nProceed with the next step or produce the final answer.`;
  }

  private truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n)}\n[...truncated]` : s;
  }

  /**
   * Parses the assistant's reply for multiple JSON action blocks.
   */
  private parseActions(text: string): MultiAction {
    const actions: ParsedAction[] = [];
    const fenceRegex = /```json\s*([\s\S]*?)```/gi;
    let thought: string | undefined;
    let match;

    while ((match = fenceRegex.exec(text)) !== null) {
      if (thought === undefined) {
        thought = text.slice(0, match.index).trim();
      }
      try {
        const raw = JSON.parse(match[1].trim());
        const normalized = this.normalizeAction(raw);
        if (normalized) actions.push(normalized);
      } catch { /* skip */ }
    }

    if (actions.length === 0) {
      const bare = this.findBareJson(text);
      if (bare) {
        try {
          const raw = JSON.parse(bare);
          const normalized = this.normalizeAction(raw);
          if (normalized) {
            actions.push(normalized);
            thought = text.slice(0, text.indexOf(bare)).trim();
          }
        } catch { /* skip */ }
      }
    }

    return { thought, actions };
  }

  private normalizeAction(raw: any): ParsedAction | null {
    if (!raw || typeof raw !== "object") return null;

    if (raw.tool && typeof raw.tool === "string") {
      return { tool: { name: raw.tool, input: raw.input || {} } };
    }
    if (raw.plan) return { plan: raw.plan };
    if (raw.final) return { final: raw.final };
    if (raw.thought && !raw.tool && !raw.final) return { thought: raw.thought };
    
    return null;
  }

  private findBareJson(text: string): string | undefined {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return undefined;
    }
    return text.slice(start, end + 1);
  }
}
