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
      const action = this.parseAction(assistantText);

      if (action.thought) {
        steps.push({ type: "thought", payload: action.thought });
      }

      if (action.tool) {
        const toolDef = this.store.toolRegistry.get(action.tool.name)?.definition();
        if (this.allowedTools() && !this.allowedTools()!.includes(action.tool.name)) {
          const denied = `Tool "${action.tool.name}" is not allowed for the ${this.role} agent.`;
          steps.push({ type: "tool_result", name: action.tool.name, payload: denied });
          messages.push({ role: "user", content: this.toolResultPrompt(action.tool.name, { ok: false, output: denied }) });
          continue;
        }

        // Permission check
        if (toolDef?.requiresPermission && input.onPermissionRequest) {
          const allowed = await input.onPermissionRequest(action.tool.name, action.tool.input);
          if (!allowed) {
            const denied = `User denied permission to execute ${action.tool.name}.`;
            steps.push({ type: "tool_result", name: action.tool.name, payload: denied });
            messages.push({ role: "user", content: this.toolResultPrompt(action.tool.name, { ok: false, output: denied }) });
            continue;
          }
        }

        steps.push({ type: "tool_call", name: action.tool.name, payload: JSON.stringify(action.tool.input) });
        const result = await this.store.toolRegistry.execute(action.tool.name, action.tool.input);
        
        if (result.ok && (action.tool.name === "write_file" || action.tool.name === "replace_in_file")) {
          const fp = action.tool.input.path as string | undefined;
          if (fp && fp.includes(".nim-agent")) {
            try {
              const folders = vscode.workspace.workspaceFolders;
              if (folders && folders.length > 0) {
                const fullPath = path.isAbsolute(fp) ? fp : path.join(folders[0].uri.fsPath, fp);
                vscode.window.showTextDocument(vscode.Uri.file(fullPath), { preview: false, preserveFocus: true });
              }
            } catch (e) { /* ignore */ }
          }
        }

        steps.push({ type: "tool_result", name: action.tool.name, payload: result.output });
        messages.push({ role: "user", content: this.toolResultPrompt(action.tool.name, result) });
        if (result.terminal) {
          finalContent = result.output;
          break;
        }
        continue;
      }

      if (action.plan) {
        steps.push({ type: "thought", payload: `Proposed Plan: ${action.plan}` });
        if (input.onPlanApproval) {
          const approved = await input.onPlanApproval(action.plan);
          if (!approved) {
            finalContent = "Plan rejected by user. Stopping.";
            steps.push({ type: "final", payload: finalContent });
            break;
          }
        }
        messages.push({ role: "user", content: "Plan approved. Please proceed with the execution." });
        continue;
      }

      if (action.final) {
        finalContent = action.final;
        steps.push({ type: "final", payload: finalContent });
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
Use standard markdown formatting. For task.md, use `- [ ]` for incomplete and `- [x]` for complete.
</artifacts>
</planning_mode>`;
    }

    return `${this.systemPrompt()}

You are running inside the NIM Agent IDE — an agentic VS Code extension. You can call tools to read or modify the user's workspace.

Available tools:
${tools}

${allowedNote}
${planInstruction}

To call a tool, reply with EXACTLY one fenced JSON block of the form:
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
   * Parses the assistant's reply for a JSON action block.
   * Tolerant of leading natural-language thought.
   */
  private parseAction(text: string): ParsedAction {
    const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/i);
    const thought = fenceMatch ? text.slice(0, fenceMatch.index).trim() : undefined;
    const jsonText = fenceMatch ? fenceMatch[1].trim() : this.findBareJson(text);

    if (!jsonText) {
      return { thought, final: text.trim() };
    }
    try {
      const parsed = JSON.parse(jsonText) as {
        tool?: string;
        input?: Record<string, unknown>;
        final?: string;
      };
      if (parsed.tool) {
        return {
          thought,
          tool: { name: parsed.tool, input: parsed.input ?? {} }
        };
      }
      if (typeof parsed.plan === "string") {
        return { thought, plan: parsed.plan };
      }
      if (typeof parsed.final === "string") {
        return { thought, final: parsed.final };
      }
    } catch {
      // fall through
    }
    return { thought, final: text.trim() };
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
