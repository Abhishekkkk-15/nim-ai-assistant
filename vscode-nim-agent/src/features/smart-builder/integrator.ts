import type { Logger } from "../../utils/logger";
import { NimChat, formatContextBlock } from "./NimChat";
import type { BuilderContext, GeneratedFile } from "./types";

const SYSTEM = [
  "You are a senior software integrator.",
  "You receive a set of generated files. Your job is to make sure they WIRE TOGETHER correctly:",
  "  • imports/exports are consistent",
  "  • function signatures match across files",
  "  • naming and module paths are aligned",
  "  • any missing glue file (e.g. an index.ts re-export) is added",
  "",
  "Output ONLY a single JSON object — no fences, no prose:",
  "{",
  '  "files": [',
  '    { "path": "src/...", "kind": "create|modify", "language": "typescript", "content": "<full file contents>" }',
  "  ],",
  '  "notes": "<one short paragraph on what was wired up>"',
  "}",
  "",
  "Rules:",
  "- Only emit files that actually need to change. Never re-emit unchanged files.",
  "- Provide FULL file content for each file you emit.",
  '- If everything is already wired correctly, return { "files": [], "notes": "..." }.',
].join("\n");

/**
 * IntegratorAgent — second pass that fixes cross-file inconsistencies.
 * Used for medium and large scope.
 */
export class IntegratorAgent {
  constructor(private readonly chat: NimChat, private readonly logger: Logger) {}

  async integrate(args: {
    prompt: string;
    files: GeneratedFile[];
    ctx?: BuilderContext;
    modelOverride?: string;
    signal?: AbortSignal;
  }): Promise<{ files: GeneratedFile[]; notes?: string }> {
    if (args.files.length <= 1) {
      // Nothing to wire when there is only one file.
      return { files: [], notes: "Single-file change — no wiring required." };
    }

    const fileSummary = args.files.map(f =>
      `--- File: ${f.path} (${f.kind}) ---\n${truncate(f.content, 1800)}`,
    ).join("\n\n");

    const user = [
      `Original request:\n"""${args.prompt}"""`,
      "",
      "Generated files:",
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
      temperature: 0.3,
      maxTokens: 5000,
      signal: args.signal,
    });
    const obj = NimChat.extractJsonObject<any>(text);
    const filesRaw = Array.isArray(obj?.files) ? obj.files : [];
    return {
      files: filesRaw.slice(0, 30).map((f: any) => ({
        path: String(f?.path ?? "").trim().replace(/^\.?\/+/, ""),
        content: String(f?.content ?? ""),
        kind: f?.kind === "modify" ? "modify" : "create",
        language: f?.language ? String(f.language) : undefined,
      })).filter((f: GeneratedFile) => f.path && f.content),
      notes: obj?.notes ? String(obj.notes) : undefined,
    };
  }
}

/**
 * Apply integrator output on top of coder output.
 * Files emitted by the integrator REPLACE same-path entries from coder.
 * Anything new from the integrator is appended.
 */
export function mergeFiles(base: GeneratedFile[], overlay: GeneratedFile[]): GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const f of base) byPath.set(f.path, f);
  for (const f of overlay) {
    const prev = byPath.get(f.path);
    byPath.set(f.path, {
      ...f,
      originalContent: prev?.originalContent ?? f.originalContent,
    });
  }
  return Array.from(byPath.values());
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n[...truncated]` : s;
}
