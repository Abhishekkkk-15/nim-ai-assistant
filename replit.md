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
- See `vscode-nim-agent/README.md` for full architecture, configuration, and install instructions.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
