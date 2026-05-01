import type { Logger } from "../../utils/logger";
import { NimChat, formatContextBlock } from "./NimChat";
import type { BuilderContext, PlanDocument } from "./types";

const SYSTEM = [
  "You are a senior software planner.",
  "Given a user request and editor context, produce a concise, executable plan.",
  "",
  "Output ONLY a single JSON object — no fences, no prose:",
  "{",
  '  "summary": "<one-paragraph statement of intent>",',
  '  "steps":   [ { "id": 1, "title": "<short>", "description": "<what happens>" } ],',
  '  "risks":   [ "<short risk or assumption>" ]',
  "}",
  "",
  "Rules:",
  "- Aim for 3–7 steps. Be specific (file/module, not generic).",
  "- Each step must be independently executable by a coder.",
  "- 'risks' is optional; include only meaningful concerns.",
].join("\n");

/**
 * PlannerAgent — converts a user request into an ordered list of steps.
 * Used for medium and large scope.
 */
export class PlannerAgent {
  constructor(private readonly chat: NimChat, private readonly logger: Logger) {}

  async plan(prompt: string, ctx: BuilderContext | undefined, modelOverride?: string, signal?: AbortSignal): Promise<PlanDocument> {
    const user = [
      `User request:\n"""${prompt}"""`,
      "",
      "Editor context:",
      formatContextBlock(ctx),
      "",
      "Return JSON only.",
    ].join("\n");

    const { text } = await this.chat.complete({
      system: SYSTEM,
      user,
      modelOverride,
      temperature: 0.3,
      maxTokens: 1800,
      signal,
    });
    const obj = NimChat.extractJsonObject<any>(text);
    return normalizePlan(obj);
  }
}

function normalizePlan(raw: any): PlanDocument {
  const summary = String(raw?.summary ?? "").trim() || "(no summary provided)";
  const stepsArr = Array.isArray(raw?.steps) ? raw.steps : [];
  const steps = stepsArr.slice(0, 12).map((s: any, idx: number) => ({
    id: Number.isFinite(s?.id) ? Number(s.id) : idx + 1,
    title: String(s?.title ?? `Step ${idx + 1}`),
    description: String(s?.description ?? ""),
  }));
  const risks = Array.isArray(raw?.risks)
    ? raw.risks.map((r: any) => String(r)).filter((r: string) => r.length > 0).slice(0, 8)
    : undefined;
  return { summary, steps, risks };
}
