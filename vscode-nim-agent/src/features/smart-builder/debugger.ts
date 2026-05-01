import type { Logger } from "../../utils/logger";
import { NimChat, formatContextBlock } from "./NimChat";
import type { BuilderContext, GeneratedFile, ReviewDocument } from "./types";

const SYSTEM = [
  "You are a debugging engineer.",
  "You receive a set of files plus a list of review issues. Fix the ERROR-level issues.",
  "",
  "Output ONLY a single JSON object — no fences, no prose:",
  "{",
  '  "files": [',
  '    { "path": "src/...", "kind": "create|modify", "language": "typescript", "content": "<full file contents>" }',
  "  ],",
  '  "explanation": "<one short paragraph>"',
  "}",
  "",
  "Rules:",
  "- Only emit files that you actually changed. Provide their FULL new content.",
  "- Do not introduce unrelated refactors.",
  '- If no fixes are needed, return { "files": [], "explanation": "..." }.',
].join("\n");

/**
 * DebuggerAgent — patches errors flagged by the reviewer.
 * Used for large scope only.
 */
export class DebuggerAgent {
  constructor(private readonly chat: NimChat, private readonly logger: Logger) {}

  async fix(args: {
    prompt: string;
    files: GeneratedFile[];
    review: ReviewDocument;
    ctx?: BuilderContext;
    modelOverride?: string;
    signal?: AbortSignal;
  }): Promise<{ files: GeneratedFile[]; explanation?: string }> {
    const errors = args.review.issues.filter(i => i.severity === "error");
    if (errors.length === 0) {
      return { files: [], explanation: "No ERROR-level issues to fix." };
    }

    const fileSummary = args.files.map(f =>
      `--- ${f.path} (${f.kind}) ---\n${truncate(f.content, 1500)}`,
    ).join("\n\n");

    const user = [
      `Original request:\n"""${args.prompt}"""`,
      "",
      "Current files:",
      fileSummary,
      "",
      "Review issues to fix (ERROR severity):",
      errors.map(i => `- [${i.path || "?"}] ${i.message}`).join("\n"),
      "",
      "Editor context:",
      formatContextBlock(args.ctx),
      "",
      "Return JSON only.",
    ].join("\n");

    const { text } = await this.chat.complete({
      system: SYSTEM,
      user,
      modelOverride: args.modelOverride,
      temperature: 0.2,
      maxTokens: 5000,
      signal: args.signal,
    });
    const obj = NimChat.extractJsonObject<any>(text);
    const filesRaw = Array.isArray(obj?.files) ? obj.files : [];
    return {
      files: filesRaw.slice(0, 20).map((f: any) => ({
        path: String(f?.path ?? "").trim().replace(/^\.?\/+/, ""),
        content: String(f?.content ?? ""),
        kind: f?.kind === "modify" ? "modify" : "create",
        language: f?.language ? String(f.language) : undefined,
      })).filter((f: GeneratedFile) => f.path && f.content),
      explanation: obj?.explanation ? String(obj.explanation) : undefined,
    };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n[...truncated]` : s;
}
