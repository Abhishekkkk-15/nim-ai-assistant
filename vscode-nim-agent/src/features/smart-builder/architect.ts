import type { Logger } from "../../utils/logger";
import { NimChat, formatContextBlock } from "./NimChat";
import type { ArchitectureDocument, BuilderContext, PlanDocument } from "./types";

const SYSTEM = [
  "You are a senior software architect.",
  "Given a plan and editor context, decide WHICH FILES need to be created or modified, and how they relate.",
  "",
  "Output ONLY a single JSON object — no fences, no prose:",
  "{",
  '  "files": [',
  '    { "path": "src/...", "purpose": "<short>", "kind": "create|modify", "language": "typescript" }',
  "  ],",
  '  "dependencies": [',
  '    { "from": "src/a.ts", "to": "src/b.ts", "reason": "imports/wires" }',
  "  ],",
  '  "notes": "<optional architectural notes>"',
  "}",
  "",
  "Rules:",
  "- Use workspace-relative paths only. No absolute paths.",
  "- Prefer modifying existing files when reasonable; only create new files when necessary.",
  "- Limit total files to a sensible minimum for the plan (no scaffolding for its own sake).",
  "- Pick the right `language` (typescript/javascript/python/etc.) based on the workspace.",
].join("\n");

/**
 * ArchitectAgent — produces a file map and (optionally) cross-file dependencies.
 * Used for large scope; medium scope skips this and lets the Coder pick files.
 */
export class ArchitectAgent {
  constructor(private readonly chat: NimChat, private readonly logger: Logger) {}

  async design(
    prompt: string,
    plan: PlanDocument,
    ctx: BuilderContext | undefined,
    modelOverride?: string,
    signal?: AbortSignal,
  ): Promise<ArchitectureDocument> {
    const user = [
      `User request:\n"""${prompt}"""`,
      "",
      "Plan to implement:",
      JSON.stringify(plan, null, 2),
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
      maxTokens: 2000,
      signal,
    });
    const obj = NimChat.extractJsonObject<any>(text);
    return normalize(obj);
  }
}

function normalize(raw: any): ArchitectureDocument {
  const files = Array.isArray(raw?.files) ? raw.files : [];
  const deps = Array.isArray(raw?.dependencies) ? raw.dependencies : [];
  return {
    files: files.slice(0, 30).map((f: any) => ({
      path: cleanPath(f?.path),
      purpose: String(f?.purpose ?? ""),
      kind: f?.kind === "modify" ? "modify" : "create",
      language: f?.language ? String(f.language) : undefined,
    })).filter((f: any) => !!f.path),
    dependencies: deps.slice(0, 30).map((d: any) => ({
      from: cleanPath(d?.from),
      to: cleanPath(d?.to),
      reason: String(d?.reason ?? ""),
    })).filter((d: any) => d.from && d.to),
    notes: raw?.notes ? String(raw.notes) : undefined,
  };
}

function cleanPath(p: any): string {
  const s = String(p ?? "").trim();
  // Strip leading "./" or "/" so paths are workspace-relative.
  return s.replace(/^\.?\/+/, "");
}
