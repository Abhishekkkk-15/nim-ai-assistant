import type { Logger } from "../../utils/logger";
import { NimChat } from "./NimChat";
import type { BuilderIntent, ScopeDecision } from "./types";

const SYSTEM = [
  "You are a routing classifier for a coding assistant.",
  "Given a user request, classify it into ONE of three scopes:",
  "  • small  — quick fix, tweak, rename, single-function edit, add validation, fix bug",
  "  • medium — add a single feature like one UI component, one API endpoint, or a small module (≤ 3 files)",
  "  • large  — multi-file feature, full subsystem, new architecture (> 3 files, planning needed)",
  "",
  "Output ONLY a single JSON object — no fences, no prose:",
  '  { "intent": "small|medium|large", "confidence": 0.0-1.0, "reason": "<one short sentence>" }',
  "",
  "Bias toward smaller scopes when in doubt. Prefer 'small' for one-line changes,",
  "'medium' for clearly bounded features, 'large' only when multiple subsystems are involved.",
].join("\n");

/**
 * ScopeAnalyzer — classifies user intent into small/medium/large.
 * The classification drives which agent pipeline runs, so we want it cheap
 * and deterministic (low temperature).
 */
export class ScopeAnalyzer {
  constructor(private readonly chat: NimChat, private readonly logger: Logger) {}

  async analyze(prompt: string, modelOverride?: string, signal?: AbortSignal): Promise<ScopeDecision> {
    const trimmed = (prompt || "").trim();
    if (!trimmed) {
      return { intent: "small", confidence: 0.5, reason: "Empty prompt", source: "analyzer" };
    }

    // Heuristic shortcut: very short / verb-only prompts almost always small.
    if (trimmed.length < 24 && /^(fix|add|tweak|rename|format|cleanup|comment)/i.test(trimmed)) {
      return {
        intent: "small",
        confidence: 0.7,
        reason: "Short imperative prompt — treated as a quick fix.",
        source: "analyzer",
      };
    }

    try {
      const { text } = await this.chat.complete({
        system: SYSTEM,
        user: `User request:\n"""${trimmed}"""\n\nClassify and return JSON only.`,
        modelOverride,
        temperature: 0,
        maxTokens: 200,
        signal,
      });
      const obj = NimChat.extractJsonObject<{ intent: string; confidence: number; reason: string }>(text);
      const intent = normalizeIntent(obj.intent);
      const confidence = clampConfidence(obj.confidence);
      const reason = String(obj.reason || "").slice(0, 240) || "No reason provided.";
      return { intent, confidence, reason, source: "analyzer" };
    } catch (err: any) {
      this.logger.warn?.(`ScopeAnalyzer fallback (parse failed): ${err?.message}`);
      // Fail-safe heuristic on parse failure — keep things moving.
      const looksLarge = /(system|architecture|dashboard|pipeline|integrate|complete|whole|entire|multi|several files)/i.test(trimmed);
      const looksMedium = /(component|endpoint|page|form|screen|tab|modal|api)/i.test(trimmed);
      const intent: BuilderIntent = looksLarge ? "large" : looksMedium ? "medium" : "small";
      return {
        intent,
        confidence: 0.4,
        reason: `Heuristic fallback (LLM classifier unavailable: ${err?.message || "unknown"}).`,
        source: "analyzer",
      };
    }
  }
}

function normalizeIntent(v: any): BuilderIntent {
  const s = String(v || "").toLowerCase();
  if (s.startsWith("l")) return "large";
  if (s.startsWith("m")) return "medium";
  return "small";
}

function clampConfidence(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
