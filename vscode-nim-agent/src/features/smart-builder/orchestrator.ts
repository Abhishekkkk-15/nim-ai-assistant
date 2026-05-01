import * as vscode from "vscode";
import * as path from "path";
import type { ProviderRegistry } from "../../api/ProviderRegistry";
import type { ModelManager } from "../../core/models/ModelManager";
import type { Logger } from "../../utils/logger";
import { NimChat } from "./NimChat";
import { ScopeAnalyzer } from "./scopeAnalyzer";
import { PlannerAgent } from "./planner";
import { ArchitectAgent } from "./architect";
import { CoderAgent } from "./coder";
import { IntegratorAgent, mergeFiles } from "./integrator";
import { ReviewerAgent } from "./reviewer";
import { DebuggerAgent } from "./debugger";
import type {
  BuilderAgentName,
  BuilderInput,
  BuilderProgressHandler,
  BuilderRunResult,
  BuilderStep,
  GeneratedFile,
  ScopeDecision,
} from "./types";

/**
 * SmartBuilderOrchestrator — drives the multi-agent pipeline based on scope.
 *
 *   SMALL  → Coder
 *   MEDIUM → Planner → Coder → Integrator
 *   LARGE  → Planner → Architect → Coder → Integrator → Reviewer → Debugger
 *
 * The pipeline is wholly server-side; the webview only sees `BuilderProgressEvent`
 * messages. Files are returned to the webview for diff preview before any
 * filesystem write happens (see `applyGeneratedFiles`).
 */
export class SmartBuilderOrchestrator {
  private readonly chat: NimChat;
  private readonly scope: ScopeAnalyzer;
  private readonly planner: PlannerAgent;
  private readonly architect: ArchitectAgent;
  private readonly coder: CoderAgent;
  private readonly integrator: IntegratorAgent;
  private readonly reviewer: ReviewerAgent;
  private readonly debug: DebuggerAgent;

  constructor(providers: ProviderRegistry, models: ModelManager, private readonly logger: Logger) {
    this.chat = new NimChat(providers, models, logger);
    this.scope = new ScopeAnalyzer(this.chat, logger);
    this.planner = new PlannerAgent(this.chat, logger);
    this.architect = new ArchitectAgent(this.chat, logger);
    this.coder = new CoderAgent(this.chat, logger);
    this.integrator = new IntegratorAgent(this.chat, logger);
    this.reviewer = new ReviewerAgent(this.chat, logger);
    this.debug = new DebuggerAgent(this.chat, logger);
  }

  async run(
    input: BuilderInput,
    onEvent: BuilderProgressHandler,
    signal?: AbortSignal,
  ): Promise<BuilderRunResult> {
    const steps: BuilderStep[] = [];

    // ---------- 1. Scope decision ----------
    let scopeDecision: ScopeDecision;
    if (input.mode === "quick") {
      scopeDecision = { intent: "small", confidence: 1, reason: "Forced by Quick Fix mode.", source: "user" };
    } else if (input.mode === "build") {
      scopeDecision = { intent: "medium", confidence: 1, reason: "Forced by Build Feature mode.", source: "user" };
    } else if (input.mode === "plan") {
      scopeDecision = { intent: "large", confidence: 1, reason: "Forced by Plan First mode.", source: "user" };
    } else {
      const scopeStep = openStep(steps, "scope", "scope", "Analyzing scope");
      onEvent({ type: "step_start", step: scopeStep });
      try {
        scopeDecision = await this.scope.analyze(input.prompt, input.modelOverride, signal);
        closeStep(scopeStep, "done", `${scopeDecision.intent} (${(scopeDecision.confidence * 100).toFixed(0)}%)`);
        onEvent({ type: "step_done", step: scopeStep });
      } catch (err: any) {
        closeStep(scopeStep, "failed", err?.message || String(err));
        onEvent({ type: "step_failed", step: scopeStep });
        throw err;
      }
    }
    onEvent({ type: "scope", payload: scopeDecision });

    const intent = scopeDecision.intent;

    // ---------- 2. Planner (medium/large) ----------
    let plan: BuilderRunResult["plan"];
    if (intent === "medium" || intent === "large") {
      plan = await this.runStep(steps, onEvent, "planner", "planner", "Planning steps", async () => {
        return this.planner.plan(input.prompt, input.context, input.modelOverride, signal);
      });
      onEvent({ type: "plan", payload: plan });
    }

    // ---------- 3. Architect (large only) ----------
    let architecture: BuilderRunResult["architecture"];
    if (intent === "large" && plan) {
      architecture = await this.runStep(steps, onEvent, "architect", "architect", "Designing file structure", async () => {
        return this.architect.design(input.prompt, plan!, input.context, input.modelOverride, signal);
      });
      onEvent({ type: "architecture", payload: architecture });
    }

    // ---------- 4. Coder (always) ----------
    let files: GeneratedFile[] = [];
    files = await this.runStep(steps, onEvent, "coder", "coder", "Generating code", async () => {
      return this.coder.generate({
        prompt: input.prompt,
        plan,
        architecture,
        ctx: input.context,
        modelOverride: input.modelOverride,
        signal,
      });
    });

    // ---------- 5. Integrator (medium/large) ----------
    if ((intent === "medium" || intent === "large") && files.length > 1) {
      const integration = await this.runStep(steps, onEvent, "integrator", "integrator", "Wiring files together", async () => {
        return this.integrator.integrate({
          prompt: input.prompt,
          files,
          ctx: input.context,
          modelOverride: input.modelOverride,
          signal,
        });
      });
      if (integration.files.length > 0) {
        files = mergeFiles(files, integration.files);
      }
    }

    onEvent({ type: "files", payload: files });

    // ---------- 6. Reviewer + Debugger (large only) ----------
    let review: BuilderRunResult["review"];
    if (intent === "large") {
      review = await this.runStep(steps, onEvent, "reviewer", "reviewer", "Reviewing code", async () => {
        return this.reviewer.review({
          prompt: input.prompt,
          files,
          ctx: input.context,
          modelOverride: input.modelOverride,
          signal,
        });
      });
      onEvent({ type: "review", payload: review });

      const errorCount = review.issues.filter(i => i.severity === "error").length;
      if (errorCount > 0) {
        const fixes = await this.runStep(steps, onEvent, "debugger", "debugger", `Fixing ${errorCount} issue(s)`, async () => {
          return this.debug.fix({
            prompt: input.prompt,
            files,
            review: review!,
            ctx: input.context,
            modelOverride: input.modelOverride,
            signal,
          });
        });
        if (fixes.files.length > 0) {
          files = mergeFiles(files, fixes.files);
          onEvent({ type: "files", payload: files });
        }
      }
    }

    const result: BuilderRunResult = {
      scope: scopeDecision,
      plan,
      architecture,
      files,
      review,
      steps,
      modelUsed: this.chat.resolveModel(input.modelOverride),
    };
    onEvent({ type: "complete", payload: result });
    return result;
  }

  // -- helpers -----------------------------------------------------------

  private async runStep<T>(
    steps: BuilderStep[],
    onEvent: BuilderProgressHandler,
    id: string,
    agent: BuilderAgentName,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const step = openStep(steps, id, agent, label);
    onEvent({ type: "step_start", step });
    try {
      const out = await fn();
      const detail = summarizeOutput(agent, out);
      closeStep(step, "done", detail);
      onEvent({ type: "step_done", step });
      return out;
    } catch (err: any) {
      closeStep(step, "failed", err?.message || String(err));
      onEvent({ type: "step_failed", step });
      throw err;
    }
  }
}

function openStep(steps: BuilderStep[], id: string, agent: BuilderAgentName, label: string): BuilderStep {
  const step: BuilderStep = { id, agent, label, status: "running", startedAt: Date.now() };
  steps.push(step);
  return step;
}

function closeStep(step: BuilderStep, status: BuilderStep["status"], detail?: string): void {
  step.status = status;
  if (detail) step.detail = detail;
  step.endedAt = Date.now();
}

function summarizeOutput(agent: BuilderAgentName, out: any): string | undefined {
  try {
    if (agent === "planner") return `${(out?.steps?.length ?? 0)} step(s)`;
    if (agent === "architect") return `${(out?.files?.length ?? 0)} file(s) planned`;
    if (agent === "coder") return `${Array.isArray(out) ? out.length : 0} file(s) generated`;
    if (agent === "integrator") return `${(out?.files?.length ?? 0)} file(s) re-wired`;
    if (agent === "reviewer") return out?.approved ? "Approved" : `${(out?.issues?.length ?? 0)} issue(s)`;
    if (agent === "debugger") return `${(out?.files?.length ?? 0)} file(s) patched`;
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Apply a list of generated files to the workspace using vscode.workspace.fs.
 * Returns the list of paths actually written.
 */
export async function applyGeneratedFiles(files: GeneratedFile[]): Promise<{ written: string[]; skipped: string[] }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { written: [], skipped: files.map(f => f.path) };
  }
  const root = folders[0].uri;
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (!f.path || f.content == null) {
      skipped.push(f.path);
      continue;
    }
    try {
      const target = vscode.Uri.joinPath(root, f.path);
      // Ensure parent directory exists.
      const parent = vscode.Uri.joinPath(target, "..");
      try { await vscode.workspace.fs.createDirectory(parent); } catch { /* exists */ }
      await vscode.workspace.fs.writeFile(target, Buffer.from(f.content, "utf8"));
      written.push(f.path);
    } catch (err) {
      skipped.push(f.path);
    }
  }
  return { written, skipped };
}

/** Re-export so callers can construct an orchestrator without importing from agents. */
export { applyGeneratedFiles as applySmartBuildFiles };
