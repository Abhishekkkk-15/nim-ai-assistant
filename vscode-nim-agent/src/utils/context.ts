import * as vscode from "vscode";
import type { Logger } from "./logger";
import type { ApiKeyManager } from "../api/ApiKeyManager";
import type { ProviderRegistry } from "../api/ProviderRegistry";
import type { ModelManager } from "../core/models/ModelManager";
import type { ToolRegistry } from "../core/tools/ToolRegistry";
import type { ConversationMemory } from "../core/memory/ConversationMemory";
import type { LocalCache } from "../core/memory/LocalCache";
import type { AgentRegistry } from "../core/agent/AgentRegistry";
import type { ChatViewProvider } from "../ui/sidebar/ChatViewProvider";
import type { ContextManager } from "../core/context/ContextManager";
import type { VectorIndexService } from "../core/context/VectorIndexService";
import type { RulesLoader } from "../core/context/RulesLoader";
import type { HistoryManager } from "../core/memory/HistoryManager";
import { AnalyticsManager } from "../core/memory/AnalyticsManager";

/**
 * Lightweight DI container shared across modules.
 * Avoids passing dozens of args through constructors.
 */
export class ExtensionContextStore {
  context!: vscode.ExtensionContext;
  logger!: Logger;
  apiKeyManager!: ApiKeyManager;
  providerRegistry!: ProviderRegistry;
  modelManager!: ModelManager;
  toolRegistry!: ToolRegistry;
  memory!: ConversationMemory;
  cache!: LocalCache;
  agentRegistry!: AgentRegistry;
  chatProvider!: ChatViewProvider;
  contextManager!: ContextManager;
  vectorIndex!: VectorIndexService;
  rulesLoader!: RulesLoader;
  historyManager!: HistoryManager;
  analyticsManager!: AnalyticsManager;
}
