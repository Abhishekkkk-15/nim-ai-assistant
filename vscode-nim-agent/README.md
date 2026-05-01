# NIM Agent IDE

A Cursor-style **agentic** coding assistant for VS Code, powered by **NVIDIA NIM** (OpenAI-compatible) APIs.

This is not a thin chat wrapper — it ships a full agent loop with tools, memory, multi-key rotation, multi-model selection, streaming responses, and a sidebar UI.

## Features

- **Multi-model support** — register any NIM model (Llama 3.x, Mistral, etc.). Switch from the sidebar.
- **API key rotation (up to 3 keys)** — automatic round-robin with cooldown on `429` / failures, retries the request on the next key.
- **Modular agent system** — Chat, Code Generator, Debug, Refactor agents. Each has its own system prompt and tool whitelist.
- **Pluggable tools** — File Reader, File Writer (with confirm), Terminal Executor (with confirm), Workspace Search.
- **Context awareness** — active file, selection, diagnostics, and a small workspace summary are sent automatically.
- **Streaming responses** — tokens appear live in the chat panel.
- **Conversation memory** — bounded short-term memory carries over between turns; clearable from the UI.
- **Local response cache** — identical (model + prompt) pairs are served from memory.
- **Provider registry** — designed to be extended with OpenAI / Anthropic / local backends without touching the agent loop.
- **Secure key storage** — API keys are stored in VS Code SecretStorage by default, never in `settings.json`.

## Commands

| Command | Default keybinding |
| --- | --- |
| NIM Agent: Open Chat | `Ctrl/Cmd+Alt+C` |
| NIM Agent: Ask | `Ctrl/Cmd+Alt+A` |
| NIM Agent: Refactor with AI | (right-click in editor) |
| NIM Agent: Fix this code | (right-click in editor) |
| NIM Agent: Explain this file | (right-click in editor) |
| NIM Agent: Add API Key | command palette |
| NIM Agent: Remove API Key | command palette |
| NIM Agent: Select Active Model | command palette |
| NIM Agent: Select Active Agent | command palette |
| NIM Agent: Clear Conversation Memory | command palette |

## Configuration (`settings.json`)

```jsonc
{
  "nimAgent.apiBaseUrl": "https://integrate.api.nvidia.com/v1",
  "nimAgent.useSecretStorage": true,
  "nimAgent.models": [
    { "name": "meta/llama-3.1-70b-instruct", "enabled": true },
    { "name": "mistralai/mistral-large", "enabled": true }
  ],
  "nimAgent.defaultModel": "meta/llama-3.1-70b-instruct",
  "nimAgent.defaultAgent": "chat",
  "nimAgent.maxAgentSteps": 8,
  "nimAgent.streaming": true,
  "nimAgent.temperature": 0.4,
  "nimAgent.maxTokens": 2048,
  "nimAgent.cacheEnabled": true
}
```

API keys are managed via **NIM Agent: Add API Key** so they live in SecretStorage.

## Architecture

```
src/
├── extension.ts                # activate() — wires everything together
├── api/
│   ├── ApiKeyManager.ts        # round-robin rotation + cooldowns + masking
│   ├── BaseProvider.ts         # provider-agnostic chat interface
│   ├── NimClient.ts            # OpenAI-compatible NIM client (sync + SSE streaming)
│   └── ProviderRegistry.ts     # plug-in point for future providers
├── core/
│   ├── agent/
│   │   ├── BaseAgent.ts        # JSON-action agent loop with tool calls + final answer
│   │   ├── AgentRegistry.ts
│   │   ├── ChatAssistantAgent.ts
│   │   ├── CodeGeneratorAgent.ts
│   │   ├── DebugAgent.ts
│   │   └── RefactorAgent.ts
│   ├── tools/
│   │   ├── BaseTool.ts
│   │   ├── ToolRegistry.ts
│   │   ├── FileReaderTool.ts
│   │   ├── FileWriterTool.ts       # confirms before any write
│   │   ├── TerminalExecutorTool.ts # confirms before running shell commands
│   │   └── WorkspaceSearchTool.ts
│   ├── memory/
│   │   ├── ConversationMemory.ts   # bounded short-term memory
│   │   └── LocalCache.ts           # tiny LRU response cache
│   └── models/
│       └── ModelManager.ts         # add/remove/select models
├── ui/
│   ├── sidebar/ChatViewProvider.ts # webview-based sidebar chat
│   └── chat/contextCollector.ts    # active editor + diagnostics + workspace snapshot
├── commands/registerCommands.ts
└── utils/
    ├── logger.ts                   # OutputChannel logger
    └── context.ts                  # shared store
```

### Agent Execution Loop

Each agent runs the same loop in `BaseAgent.run()`:

1. Build a system prompt that includes the agent's role, the available tools (filtered by allow-list), and the editor context (active file, selection, diagnostics, workspace summary).
2. Stream the model's response.
3. Parse the response for a JSON action block:
   - `{ "tool": "...", "input": {...} }` → execute the tool, append its output to the message history, repeat.
   - `{ "final": "..." }` → return the final answer to the user.
4. Stop after `nimAgent.maxAgentSteps` iterations.

The user's prompt + final answer is appended to `ConversationMemory` so the next turn has continuity.

### API Key Rotation

`ApiKeyManager` keeps an array of up to 3 keys with `failures` and `cooldownUntil` per entry. `next()` returns the next non-cooling key in round-robin order. `NimClient.withRotation()` retries up to 3 times on `429` / network errors / `5xx`, calling `reportFailure(status)` to penalize the offending key (longer cooldown for `429`).

## Build & Install

This extension lives in a pnpm workspace, but it is self-contained — you can also build it standalone.

### From inside this monorepo

```bash
# from the workspace root
pnpm --filter nim-agent-ide install   # if added to pnpm-workspace.yaml
pnpm --filter nim-agent-ide run build
pnpm --filter nim-agent-ide run package   # produces nim-agent-ide-0.1.0.vsix
```

### Standalone

```bash
cd vscode-nim-agent
pnpm install   # or: npm install
pnpm run build
pnpm run package
```

Then in VS Code:

1. Open the **Extensions** view.
2. `…` menu → **Install from VSIX…**
3. Pick `nim-agent-ide-0.1.0.vsix`.
4. Run **NIM Agent: Add API Key** to register your NVIDIA NIM key.
5. Click the **NIM Agent** icon in the activity bar and start chatting.

### Run from source (Extension Development Host)

```bash
cd vscode-nim-agent
pnpm install
pnpm run watch     # leave running
```

In VS Code, open the `vscode-nim-agent/` folder and press **F5** to launch the Extension Development Host.

## Extending

- **Add a tool** — subclass `BaseTool`, register it in `extension.ts`. It is automatically described to the agent.
- **Add an agent** — subclass `BaseAgent`, override `systemPrompt()` and (optionally) `allowedTools()`, register it.
- **Add a provider** — subclass `BaseProvider`, register it in `ProviderRegistry.loadFromConfig()`. The agent loop is provider-agnostic.

## License

MIT
