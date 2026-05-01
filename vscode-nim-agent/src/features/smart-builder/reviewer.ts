import type { Logger } from "../../utils/logger";
import { NimChat, formatContextBlock } from "./NimChat";
import type { BuilderContext, GeneratedFile, ReviewDocument } from "./types";

const SYSTEM = [
  "You are a senior code reviewer.",
  "Given the user request and the proposed file changes, review them critically.",
  "",
  "Output ONLY a single JSON object — no fences, no prose:",
  "{",
  '  "approved":   true|false,',
  '  "issues":     [ { "severity": "info|warn|error", "path": "src/...", "message": "<short>" } ],',
  '  "suggestions": [ "<short>" ]',
  "}",
  "",
  "Rules:",
  "- Approve if the change correctly satisfies the user request and has no clear bugs.",
  "- Use 'error' for real bugs (missing imports, type errors, broken logic).",
  "- Use 'warn' for code-smells, missing edge cases, or maintainability issues.",
  "- Be concise. Cap issues at 12. Cap suggestions at 6.",
].join("\n");

/**
 * ReviewerAgent — final QA pass that returns approval + issue list.
 * Used for large scope only.
 */
export class ReviewerAgent {
  constructor(private readonly chat: NimChat, private readonly logger: Logger) {}

  async review(args: {
    prompt: string;
    files: GeneratedFile[];
    ctx?: BuilderContext;
    modelOverride?: string;
    signal?: AbortSignal;
  }): Promise<ReviewDocument> {
    const fileSummary = args.files.map(f =>
      `--- ${f.path} (${f.kind}) ---\n${truncate(f.content, 1500)}`,
    ).join("\n\n");

    const user = [
      `Original request:\n"""${args.prompt}"""`,
      "",
      "Proposed file changes:",
      fileSummary,
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
      maxTokens: 1800,
      signal: args.signal,
    });
    const obj = NimChat.extractJsonObject<any>(text);
    return normalize(obj);
  }
}

function normalize(raw: any): ReviewDocument {
  const issuesArr = Array.isArray(raw?.issues) ? raw.issues : [];
  const issues = issuesArr.slice(0, 12).map((i: any) => ({
    severity: normSeverity(i?.severity),
    path: i?.path ? String(i.path) : undefined,
    message: String(i?.message ?? "").slice(0, 400),
  })).filter((i: any) => i.message);
  const suggestions = Array.isArray(raw?.suggestions)
    ? raw.suggestions.map((s: any) => String(s).slice(0, 240)).filter(Boolean).slice(0, 6)
    : undefined;
  return {
    approved: !!raw?.approved && !issues.some((i: any) => i.severity === "error"),
    issues,
    suggestions,
  };
}

function normSeverity(v: any): "info" | "warn" | "error" {
  const s = String(v || "").toLowerCase();
  if (s.startsWith("e")) return "error";
  if (s.startsWith("w")) return "warn";
  return "info";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n[...truncated]` : s;
}
