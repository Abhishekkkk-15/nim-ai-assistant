# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter nim-agent-ide run build` — build the NIM Agent VS Code extension
- `pnpm --filter nim-agent-ide run package` — produce installable `.vsix` for VS Code

## NIM Agent IDE (`vscode-nim-agent/`)

A standalone VS Code extension implementing a Cursor-style agentic coding assistant powered by NVIDIA NIM APIs.

- Multi-model selection, multi-key API rotation (up to 3 keys), streaming responses.
- Modular agent system: Chat / Coder / Debug / Refactor agents over a shared JSON-action loop.
- Pluggable tools: file read/write, terminal, workspace search.
- Sidebar webview chat with agent + model dropdowns.
- **Multi-file diff review** — `EditTracker` snapshots files touched per turn; the chat shows a per-turn panel listing changed files with +/- line counts and per-file Diff / Revert / Revert-all actions.
- **Agent-to-agent handoff** — `HandOffTool` lets any agent emit a `__HANDOFF__` marker; the chat view runs a handoff loop (max 4 hops, no revisits) across `chat / coder / debugger / refactor / security / tester`, showing an inline banner for each hop.
- **Workspace rules file** — `RulesLoader` auto-discovers `AGENTS.md`, `.nimrules`, and `.cursorrules` at the workspace root, watches for changes, and injects them into every agent's system prompt. A `RULES` button in the chat header indicates active rule files and opens / creates them.
- **Image / screenshot input** — Users can attach images via button, paste, or drag-drop; images are sent as `image_url` content parts (data URLs) to vision-capable NIM models. Limits: 6 MB per image, 6 images per message; cache is bypassed when images are attached.
- **UI Designer** (`src/features/ui-designer/`) — Standalone module that calls a NIM model one-shot to produce a structured `UiDesignDocument` (meta + design system + screens/sections/components). Surfaced via the `DESIGN UI` header button which opens an overlay with a form (app type, style, features, notes, variations) and a result panel with Visual / Component-tree / JSON tabs. Independent of the agent loop and tool registry. Selected dropdown model now also persists across sends (bug fix: `send` and `selectModel` apply `modelManager.setActive` server-side).
- **Smart Feature Builder** (`src/features/smart-builder/`) — Multi-agent feature pipeline with scope control. A `ScopeAnalyzer` classifies user requests as SMALL / MEDIUM / LARGE; the orchestrator runs the matching pipeline: SMALL → `Coder`; MEDIUM → `Planner` → `Coder` → `Integrator`; LARGE → `Planner` → `Architect` → `Coder` → `Integrator` → `Reviewer` → `Debugger`. The `BUILD` header button opens an overlay with mode toggles (Auto / Quick Fix / Build Feature / Plan First), live progress (scope card, per-step status, plan, architecture, review issues), and a result panel that shows generated files with diff preview, per-file Apply / Copy and an "Apply all" button that writes via `vscode.workspace.fs`.
- See `vscode-nim-agent/README.md` for full architecture, configuration, and install instructions.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
