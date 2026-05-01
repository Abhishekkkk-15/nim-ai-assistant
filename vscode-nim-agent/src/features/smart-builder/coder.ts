import * as vscode from "vscode";
import * as path from "path";
import type { Logger } from "../../utils/logger";
import { NimChat, formatContextBlock } from "./NimChat";
import type {
  ArchitectureDocument,
  BuilderContext,
  GeneratedFile,
  PlanDocument,
} from "./types";

const SYSTEM = [
  "You are a senior software engineer.",
  "Given a plan, optional architecture, and editor context, generate the FULL contents of every file required.",
  "",
  "Output ONLY a single JSON object — no fences, no prose:",
  "{",
  '  "files": [',
  '    { "path": "src/...", "kind": "create|modify", "language": "typescript", "content": "<full file contents>" }',
  "  ]",
  "}",
  "",
  "Rules:",
  "- Provide the COMPLETE file content (not a diff). The user will diff against the existing file before applying.",
  "- Use workspace-relative paths only.",
  "- Honor existing project style and imports inferred from editor context.",
  "- If you must modify a file you have not been shown, generate ONLY the new full content based on the plan, but flag it in `kind: \"modify\"`.",
  "- Do NOT include backticks in path or language fields.",
  "- Output strictly valid JSON. Escape newlines inside `content` as \\n.",
].join("\n");

/**
 * CoderAgent — generates the actual file contents.
 *
 * For SMALL scope, called with no plan/architecture: it must infer files from
 * the prompt + active file (typically a single edit on the active file).
 *
 * For MEDIUM scope, called with a plan only.
 *
 * For LARGE scope, called with both a plan and an architecture file map.
 */
export class CoderAgent {
  constructor(private readonly chat: NimChat, private readonly logger: Logger) {}

  async generate(args: {
    prompt: string;
    plan?: PlanDocument;
    architecture?: ArchitectureDocument;
    ctx?: BuilderContext;
    modelOverride?: string;
    signal?: AbortSignal;
  }): Promise<GeneratedFile[]> {
    const userParts: string[] = [
      `User request:\n"""${args.prompt}"""`,
      "",
      "Editor context:",
      formatContextBlock(args.ctx),
    ];
    if (args.plan) {
      userParts.push("", "Plan:", JSON.stringify(args.plan, null, 2));
    }
    if (args.architecture) {
      userParts.push("", "Architecture (file map):", JSON.stringify(args.architecture, null, 2));
    } else if (!args.plan) {
      userParts.push(
        "",
        "Note: No plan or architecture supplied — this is a quick-fix request.",
        "Modify only the active file unless the prompt explicitly demands otherwise.",
      );
    }
    userParts.push("", "Return JSON only.");

    const { text } = await this.chat.complete({
      system: SYSTEM,
      user: userParts.join("\n"),
      modelOverride: args.modelOverride,
      temperature: 0.3,
      maxTokens: 6000,
      signal: args.signal,
    });
    const obj = NimChat.extractJsonObject<any>(text);
    const filesRaw = Array.isArray(obj?.files) ? obj.files : [];
    const generated: GeneratedFile[] = filesRaw.slice(0, 40)
      .map((f: any) => normalizeFile(f, args.ctx))
      .filter((f: GeneratedFile | null): f is GeneratedFile => f !== null);

    // Resolve `originalContent` for modify-files by reading from disk (best-effort).
    for (const f of generated) {
      if (f.kind === "modify" && f.originalContent === undefined) {
        f.originalContent = await readFromWorkspace(f.path);
        if (f.originalContent === undefined) {
          // The model expected to modify a file that doesn't exist — treat as create.
          f.kind = "create";
        }
      }
    }
    return generated;
  }
}

function normalizeFile(raw: any, ctx?: BuilderContext): GeneratedFile | null {
  const p = String(raw?.path ?? "").trim().replace(/^\.?\/+/, "");
  if (!p) return null;
  const content = String(raw?.content ?? "");
  const kind: GeneratedFile["kind"] = raw?.kind === "modify" ? "modify" : "create";
  const language = raw?.language ? String(raw.language) : guessLanguage(p);
  let originalContent: string | undefined;
  // Heuristic: if active file matches, supply its content as the original.
  if (ctx?.activeFile && ctx.activeFile.path === p) {
    originalContent = ctx.activeFile.content;
  }
  return { path: p, content, kind, language, originalContent };
}

function guessLanguage(p: string): string | undefined {
  const ext = path.extname(p).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    cs: "csharp", swift: "swift", md: "markdown", json: "json", yaml: "yaml", yml: "yaml",
    css: "css", scss: "scss", html: "html",
  };
  return ext ? map[ext] : undefined;
}

async function readFromWorkspace(rel: string): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  try {
    const uri = vscode.Uri.joinPath(folders[0].uri, rel);
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString("utf8");
  } catch {
    return undefined;
  }
}
