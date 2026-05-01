---
name: Agent Context Tooling Upgrade
overview: "Implement Layer 2 and Layer 3 upgrades: stronger workspace-wide semantic context, richer IDE-native tools, automatic verification loop, tool-failure retry logic, and long-horizon memory summarization."
todos:
  - id: vector-store
    content: Implement local vector store-backed indexing and retrieval with 200-line chunk metadata
    status: completed
  - id: tooling-parity
    content: Add definition/reference/exports/glob tools and complete partial git/test tools
    status: completed
  - id: first-turn-context
    content: Add first-message project context bootstrap and prompt injection
    status: completed
  - id: verify-loop
    content: Add automatic typecheck-then-tests verification after write tools
    status: completed
  - id: retry-failures
    content: Implement bounded retryOnToolFailure in BaseAgent tool execution flow
    status: completed
  - id: memory-summary
    content: Add structured memory summarization after 10 turns with persistence integration
    status: completed
  - id: validation
    content: Run typecheck/tests and add focused coverage for new behaviors
    status: completed
isProject: false
---

# Implement Layer 2 + Layer 3 Agent Upgrades

## Scope and goals
Ship the requested capabilities across the existing VS Code extension architecture in `vscode-nim-agent`:
- Semantic workspace indexing and retrieval that is always available during chat.
- Tooling parity improvements (definition/reference/exports/glob/read-range/git/test).
- Automatic project-wide context bootstrap on first user message.
- Agent reliability upgrades (verify-after-edit + retry on tool failures + summarized memory after 10 turns).

## Implementation plan

### 1) Semantic indexing: harden and make query-ready
- Extend [vscode-nim-agent/src/core/context/VectorIndexService.ts](vscode-nim-agent/src/core/context/VectorIndexService.ts) to:
  - Crawl supported source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, etc.) with stable filtering.
  - Chunk by **~200 lines** with line-span metadata (`startLine`, `endLine`) and file path.
  - Embed chunks using provider embeddings (`NimClient.embeddings()` via provider abstraction).
  - Store vectors in a **local vector store backend** (per your choice), with fast top-k cosine retrieval.
  - Expose readiness/status APIs for first-turn gating (`isReady`, indexedCount, lastUpdated).
- Keep [vscode-nim-agent/src/core/tools/SemanticSearchTool.ts](vscode-nim-agent/src/core/tools/SemanticSearchTool.ts) as the retrieval entry-point, updated to consume richer chunk metadata.
- Wire robust startup behavior in [vscode-nim-agent/src/extension.ts](vscode-nim-agent/src/extension.ts): start indexing early and permit partial results while index warms.

### 2) Tooling expansion with VS Code/LSP-native lookups
- Add new tools under `src/core/tools` and register them in [vscode-nim-agent/src/extension.ts](vscode-nim-agent/src/extension.ts):
  - `go_to_definition` using `vscode.executeDefinitionProvider`.
  - `find_references` using `vscode.executeReferenceProvider`.
  - `get_file_exports` (language-aware extraction for TS/JS, fallback parsing for other files).
  - Dedicated `glob_files` tool for file-list matching.
  - Ensure `read_file` range semantics remain first-class (already present; refine schema/docs).
- Close partial implementations:
  - Expand [vscode-nim-agent/src/core/tools/GitManagerTool.ts](vscode-nim-agent/src/core/tools/GitManagerTool.ts) to fully support advertised operations (not just status/diff/commit).
  - Expand [vscode-nim-agent/src/core/tools/TestRunnerTool.ts](vscode-nim-agent/src/core/tools/TestRunnerTool.ts) to implement any declared-but-missing runners and normalize failure capture.

### 3) First-message project context bootstrap
- In [vscode-nim-agent/src/ui/sidebar/ChatViewProvider.ts](vscode-nim-agent/src/ui/sidebar/ChatViewProvider.ts), detect first message in a session and gather lightweight project context before agent run:
  - `package.json`, `tsconfig*.json`, and key config files (`vite.config.*`, `.eslintrc*`, etc.).
  - Directory tree summary (top 2 levels).
  - Top semantic chunks from the vector index for the prompt/question.
- Extend [vscode-nim-agent/src/ui/chat/contextCollector.ts](vscode-nim-agent/src/ui/chat/contextCollector.ts) to include this `projectContext` block in `AgentContext`.
- Inject this block in [vscode-nim-agent/src/core/agent/BaseAgent.ts](vscode-nim-agent/src/core/agent/BaseAgent.ts) prompt assembly so the model starts with project awareness.

### 4) Verify-after-edit loop (selected default)
- Implement verification policy in [vscode-nim-agent/src/core/agent/BaseAgent.ts](vscode-nim-agent/src/core/agent/BaseAgent.ts): after successful write/edit tools, enqueue verification step:
  - First run project typecheck (`tsc --noEmit` or configured typecheck script).
  - If typecheck passes, run tests.
  - If failures occur, feed diagnostics/output back into loop for self-fix until step budget ends.
- Reuse [vscode-nim-agent/src/core/tools/TerminalExecutorTool.ts](vscode-nim-agent/src/core/tools/TerminalExecutorTool.ts) and [vscode-nim-agent/src/core/tools/GetDiagnosticsTool.ts](vscode-nim-agent/src/core/tools/GetDiagnosticsTool.ts) for structured error capture.

### 5) Retry-on-tool-failure budget
- Add `retryOnToolFailure` behavior to [vscode-nim-agent/src/core/agent/BaseAgent.ts](vscode-nim-agent/src/core/agent/BaseAgent.ts):
  - On tool failure, automatically re-read relevant context and retry with bounded attempts.
  - Use strategy-specific retries for edit tools (`replace_file_content`, `replace_in_file`) with fallback sequencing.
  - Log retry attempts in step telemetry so failures are visible in chat debugging.

### 6) Memory summarization after 10 turns
- Extend [vscode-nim-agent/src/core/memory/ConversationMemory.ts](vscode-nim-agent/src/core/memory/ConversationMemory.ts) with a summarization threshold:
  - After 10 turns, compress oldest turns into a structured summary block:
    - user objective
    - files changed
    - decisions made
    - unresolved tasks
  - Keep recent turns verbatim; include summary in prompt context in [vscode-nim-agent/src/core/agent/BaseAgent.ts](vscode-nim-agent/src/core/agent/BaseAgent.ts).
- Persist/restore summary boundary cleanly with [vscode-nim-agent/src/core/memory/HistoryManager.ts](vscode-nim-agent/src/core/memory/HistoryManager.ts) and session load logic in [vscode-nim-agent/src/ui/sidebar/ChatViewProvider.ts](vscode-nim-agent/src/ui/sidebar/ChatViewProvider.ts).

### 7) Validation and rollout
- Add/update targeted tests around:
  - index chunking + retrieval correctness,
  - new tools (definition/reference/exports/glob),
  - verify-after-edit retry loop,
  - memory summarization transitions.
- Run extension typecheck/tests and smoke-check interactive chat behavior for first-message context + semantic retrieval.

## Notes on chosen defaults
- Verification default: **project typecheck then tests**.
- Vector persistence target: **local vector store backend** (not just memory/json cache).

## Deliverables
- New/updated tool implementations registered and prompt-exposed.
- Local vector store-backed semantic index integrated into startup + first-message context.
- BaseAgent reliability loop with verification + retries.
- Summarized long-memory behavior that preserves key intent and decisions.