import type { ProviderRegistry } from "../../api/ProviderRegistry";
import type { ModelManager } from "../../core/models/ModelManager";
import type { Logger } from "../../utils/logger";
import type { ChatMessage } from "../../api/BaseProvider";

export interface NimChatOptions {
  system: string;
  user: string;
  /** Defaults to active model. */
  modelOverride?: string;
  /** Defaults to 0.4 (deterministic structured output). */
  temperature?: number;
  /** Defaults to 4000. */
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Thin convenience wrapper around the provider's chatComplete used by every
 * agent in the smart-builder. Centralizing this keeps each agent module
 * tiny — they just supply prompts and a return type.
 */
export class NimChat {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly models: ModelManager,
    private readonly logger: Logger,
  ) {}

  resolveModel(override?: string): string {
    if (override && this.models.list().some(m => m.name === override)) {
      return override;
    }
    return this.models.getActive();
  }

  async complete(opts: NimChatOptions): Promise<{ text: string; modelUsed: string }> {
    const provider = this.providers.active();
    const model = this.resolveModel(opts.modelOverride);
    const messages: ChatMessage[] = [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ];
    const r = await provider.chatComplete(
      {
        model,
        messages,
        temperature: opts.temperature ?? 0.4,
        maxTokens: opts.maxTokens ?? 4000,
        stream: false,
      },
      opts.signal,
    );
    return { text: r.content || "", modelUsed: model };
  }

  /**
   * Robust JSON-object extractor: strips ```json fences, then walks the string
   * to find the first balanced { ... } object.
   */
  static extractJsonObject<T = any>(raw: string): T {
    const fence = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    const stripped = (fence ? fence[1] : raw).trim();
    const candidate = NimChat.balancedFirstObject(stripped) ?? stripped;
    try {
      return JSON.parse(candidate) as T;
    } catch (err: any) {
      throw new Error(
        `Could not parse model output as JSON: ${err?.message}. First 200 chars: ${stripped.slice(0, 200)}`,
      );
    }
  }

  private static balancedFirstObject(s: string): string | null {
    const start = s.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }
}

/**
 * Format a BuilderContext block for inclusion in any agent's user prompt.
 * Truncates aggressively to keep the prompt under control.
 */
export function formatContextBlock(ctx: {
  activeFile?: { path: string; language: string; content: string };
  selection?: { path: string; text: string; startLine: number; endLine: number };
  workspaceSummary?: string;
  extraFiles?: { path: string; content: string }[];
} | undefined): string {
  if (!ctx) return "(no editor context)";
  const parts: string[] = [];
  if (ctx.activeFile) {
    parts.push(
      `Active file: ${ctx.activeFile.path} (${ctx.activeFile.language})\n` +
        "```\n" + truncate(ctx.activeFile.content, 4000) + "\n```",
    );
  }
  if (ctx.selection) {
    parts.push(
      `Selection in ${ctx.selection.path} L${ctx.selection.startLine}-${ctx.selection.endLine}:\n` +
        "```\n" + truncate(ctx.selection.text, 2000) + "\n```",
    );
  }
  if (ctx.workspaceSummary) {
    parts.push(`Workspace summary:\n${truncate(ctx.workspaceSummary, 2000)}`);
  }
  if (ctx.extraFiles && ctx.extraFiles.length) {
    parts.push("Additional files:");
    for (const f of ctx.extraFiles) {
      parts.push(`File: ${f.path}\n\`\`\`\n${truncate(f.content, 2500)}\n\`\`\``);
    }
  }
  return parts.length ? parts.join("\n\n") : "(no editor context)";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n[...truncated]` : s;
}
