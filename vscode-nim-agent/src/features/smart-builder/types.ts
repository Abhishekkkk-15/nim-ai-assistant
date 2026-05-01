/**
 * Shared types for the Smart Feature Builder system.
 * Kept intentionally small and serializable so they can flow over the
 * webview postMessage bridge without translation.
 */

export type BuilderIntent = "small" | "medium" | "large";
export type BuilderMode = "auto" | "quick" | "build" | "plan";

export interface BuilderContext {
  /** Active editor file (path/language/content) — best-effort. */
  activeFile?: { path: string; language: string; content: string };
  /** Current selection in the editor, if any. */
  selection?: { path: string; text: string; startLine: number; endLine: number };
  /** Short summary of the workspace (top-level layout). */
  workspaceSummary?: string;
  /** Pinned / attached files — fed to all agents as context. */
  extraFiles?: { path: string; content: string }[];
}

export interface BuilderInput {
  prompt: string;
  /** User-selected mode; "auto" means we run the ScopeAnalyzer. */
  mode: BuilderMode;
  /** Optional model override (defaults to the active model). */
  modelOverride?: string;
  context?: BuilderContext;
}

export interface ScopeDecision {
  intent: BuilderIntent;
  confidence: number;
  reason: string;
  /** Whether the intent was chosen by the user (mode override) or analyzer. */
  source: "user" | "analyzer";
}

export interface PlanStep {
  id: number;
  title: string;
  description: string;
}

export interface PlanDocument {
  summary: string;
  steps: PlanStep[];
  risks?: string[];
}

export interface ArchitectureFile {
  path: string;
  purpose: string;
  /** create = new file, modify = existing file. */
  kind: "create" | "modify";
  language?: string;
}

export interface ArchitectureDocument {
  files: ArchitectureFile[];
  dependencies?: { from: string; to: string; reason: string }[];
  notes?: string;
}

export interface GeneratedFile {
  path: string;
  /** Full file content the user would see after applying. */
  content: string;
  kind: "create" | "modify";
  /** Optional original content (modify only) for diffing. */
  originalContent?: string;
  language?: string;
}

export interface ReviewIssue {
  severity: "info" | "warn" | "error";
  path?: string;
  message: string;
}

export interface ReviewDocument {
  approved: boolean;
  issues: ReviewIssue[];
  suggestions?: string[];
}

export interface BuilderRunResult {
  scope: ScopeDecision;
  plan?: PlanDocument;
  architecture?: ArchitectureDocument;
  files: GeneratedFile[];
  review?: ReviewDocument;
  /** Per-agent timeline (for the UI's collapsible activity panel). */
  steps: BuilderStep[];
  modelUsed: string;
}

export type BuilderStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface BuilderStep {
  id: string;
  agent: BuilderAgentName;
  label: string;
  status: BuilderStepStatus;
  detail?: string;
  startedAt?: number;
  endedAt?: number;
}

export type BuilderAgentName =
  | "scope"
  | "planner"
  | "architect"
  | "coder"
  | "integrator"
  | "reviewer"
  | "debugger";

export interface BuilderProgressEvent {
  type:
    | "scope"
    | "step_start"
    | "step_done"
    | "step_failed"
    | "plan"
    | "architecture"
    | "files"
    | "review"
    | "complete"
    | "info";
  step?: BuilderStep;
  payload?: any;
}

export type BuilderProgressHandler = (event: BuilderProgressEvent) => void;
