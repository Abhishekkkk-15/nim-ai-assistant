import * as vscode from "vscode";
import { Logger } from "./utils/logger";
import { ExtensionContextStore } from "./utils/context";
import { ApiKeyManager } from "./api/ApiKeyManager";
import { ProviderRegistry } from "./api/ProviderRegistry";
import { ModelManager } from "./core/models/ModelManager";
import { ToolRegistry } from "./core/tools/ToolRegistry";
import { FileReaderTool } from "./core/tools/FileReaderTool";
import { FileWriterTool } from "./core/tools/FileWriterTool";
import { TerminalExecutorTool } from "./core/tools/TerminalExecutorTool";
import { WorkspaceSearchTool } from "./core/tools/WorkspaceSearchTool";
import { ProposeEditTool } from "./core/tools/ProposeEditTool";
import { ScaffoldTool } from "./core/tools/ScaffoldTool";
import { FetchUrlTool } from "./core/tools/FetchUrlTool";
import { CodeIntelligenceTool } from "./core/tools/CodeIntelligenceTool";
import { GitManagerTool } from "./core/tools/GitManagerTool";
import { ReplaceInFileTool } from "./core/tools/ReplaceInFileTool";
import { ReplaceFileContentTool } from "./core/tools/ReplaceFileContentTool";
import { GetDiagnosticsTool } from "./core/tools/GetDiagnosticsTool";
import { ApplyWorkspaceEditTool } from "./core/tools/ApplyWorkspaceEditTool";
import { SemanticSearchTool } from "./core/tools/SemanticSearchTool";
import { WebSearchTool } from "./core/tools/WebSearchTool";
import { HandOffTool } from "./core/tools/HandOffTool";
import { ParallelHandOffTool } from "./core/tools/ParallelHandOffTool";
import { TestRunnerTool } from "./core/tools/TestRunnerTool";
import { FrameworkScaffoldTool } from "./core/tools/FrameworkScaffoldTool";
import { VectorIndexService } from "./core/context/VectorIndexService";
import { GoToDefinitionTool } from "./core/tools/GoToDefinitionTool";
import { FindReferencesTool } from "./core/tools/FindReferencesTool";
import { GetFileExportsTool } from "./core/tools/GetFileExportsTool";
import { GlobFilesTool } from "./core/tools/GlobFilesTool";
import { MultiReplaceFileContentTool } from "./core/tools/MultiReplaceFileContentTool";
import { ManageSkillConfigTool } from "./core/tools/ManageSkillConfigTool";
import { ConversationMemory } from "./core/memory/ConversationMemory";
import { LocalCache } from "./core/memory/LocalCache";
import { AgentRegistry } from "./core/agent/AgentRegistry";
import { ContextManager } from "./core/context/ContextManager";
import { RulesLoader } from "./core/context/RulesLoader";
import { HistoryManager } from "./core/memory/HistoryManager";
import { AnalyticsManager } from "./core/memory/AnalyticsManager";
import { SkillManager } from "./core/agent/SkillManager";
import { TreeSitterService } from "./core/context/parsers/TreeSitterService";
import { MerkleTree } from "./core/context/state/MerkleTree";
import * as fs from "fs";
import * as path from "path";
import { CodeGraphService } from "./core/context/graph/CodeGraphService";
import { DebuggerTool } from "./core/tools/DebuggerTool";
import { registerInlineEditCommand } from "./commands/InlineEditCommand";
import { registerErrorHealer } from "./providers/ErrorHealerProvider";
import { ChatAssistantAgent } from "./core/agent/ChatAssistantAgent";
import { CodeGeneratorAgent } from "./core/agent/CodeGeneratorAgent";
import { SupervisorAgent } from "./core/agent/SupervisorAgent";
import { ReviewerAgent } from "./core/agent/ReviewerAgent";
import { DebugAgent } from "./core/agent/DebugAgent";
import { RefactorAgent } from "./core/agent/RefactorAgent";
import { SecurityAuditorAgent } from "./core/agent/SecurityAuditorAgent";
import { TestArchitectAgent } from "./core/agent/TestArchitectAgent";
import { ChatViewProvider } from "./ui/sidebar/ChatViewProvider";
import { registerCommands } from "./commands/registerCommands";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger("NIM Agent");
  logger.info("Activating NIM Agent IDE...");

  // Shared context store for cross-module dependencies
  const store = new ExtensionContextStore();
  store.context = context;
  store.logger = logger;

  // API key rotation + provider registry
  const apiKeyManager = new ApiKeyManager(context, logger);
  await apiKeyManager.load();
  store.apiKeyManager = apiKeyManager;

  const analyticsManager = new AnalyticsManager(context);
  store.analyticsManager = analyticsManager;

  const providerRegistry = new ProviderRegistry(logger, apiKeyManager, analyticsManager);
  providerRegistry.loadFromConfig();
  store.providerRegistry = providerRegistry;

  // Models
  const modelManager = new ModelManager(logger);
  modelManager.loadFromConfig();
  store.modelManager = modelManager;

  // Memory + caching
  const memory = new ConversationMemory(50);
  store.memory = memory;
  const cache = new LocalCache(100);
  store.cache = cache;

  const contextManager = new ContextManager(context);
  store.contextManager = contextManager;

  const treeSitter = new TreeSitterService(context);
  store.treeSitter = treeSitter;

  const merklePath = path.join(context.globalStorageUri.fsPath, "merkle_tree.json");
  let merkleTree: MerkleTree;
  if (fs.existsSync(merklePath)) {
    merkleTree = MerkleTree.deserialize("root", fs.readFileSync(merklePath, "utf8"));
  } else {
    merkleTree = new MerkleTree("root");
  }
  store.merkleTree = merkleTree;

  const codeGraph = new CodeGraphService(store);
  store.codeGraph = codeGraph;
  codeGraph.buildInitialGraph().catch(err => logger.error("Graph build error", err));

  const vectorIndex = new VectorIndexService(store);
  store.vectorIndex = vectorIndex;
  // Trigger background indexing
  vectorIndex.startIndexing().catch(err => logger.error("Background indexing error", err));

  const rulesLoader = new RulesLoader();
  store.rulesLoader = rulesLoader;
  context.subscriptions.push(rulesLoader);

  const historyManager = new HistoryManager(context);
  store.historyManager = historyManager;

  const skillManager = new SkillManager(store);
  await skillManager.initialize();
  store.skillManager = skillManager;

  // Tools
  const toolRegistry = new ToolRegistry(logger);
  toolRegistry.register(new FileReaderTool());
  toolRegistry.register(new FileWriterTool());
  toolRegistry.register(new TerminalExecutorTool());
  toolRegistry.register(new WorkspaceSearchTool());
  toolRegistry.register(new ProposeEditTool());
  toolRegistry.register(new ScaffoldTool());
  toolRegistry.register(new FetchUrlTool());
  toolRegistry.register(new CodeIntelligenceTool());
  toolRegistry.register(new GitManagerTool());
  toolRegistry.register(new ReplaceInFileTool());
  toolRegistry.register(new ReplaceFileContentTool());
  toolRegistry.register(new MultiReplaceFileContentTool());
  toolRegistry.register(new ManageSkillConfigTool(store));
  toolRegistry.register(new GetDiagnosticsTool());
  toolRegistry.register(new ApplyWorkspaceEditTool());
  toolRegistry.register(new SemanticSearchTool(vectorIndex));
  toolRegistry.register(new WebSearchTool());
  toolRegistry.register(new TestRunnerTool());
  toolRegistry.register(new DebuggerTool());
  toolRegistry.register(new FrameworkScaffoldTool());
  toolRegistry.register(new GoToDefinitionTool());
  toolRegistry.register(new FindReferencesTool());
  toolRegistry.register(new GetFileExportsTool());
  toolRegistry.register(new GlobFilesTool());
  toolRegistry.register(new HandOffTool());
  toolRegistry.register(new ParallelHandOffTool());
  store.toolRegistry = toolRegistry;

  // Agents
  const agentRegistry = new AgentRegistry();
  agentRegistry.register(new ChatAssistantAgent(store));
  agentRegistry.register(new CodeGeneratorAgent(store));
  agentRegistry.register(new SupervisorAgent(store));
  agentRegistry.register(new ReviewerAgent(store));
  agentRegistry.register(new DebugAgent(store));
  agentRegistry.register(new RefactorAgent(store));
  agentRegistry.register(new SecurityAuditorAgent(store));
  agentRegistry.register(new TestArchitectAgent(store));
  store.agentRegistry = agentRegistry;

  // UI: sidebar chat webview
  const chatProvider = new ChatViewProvider(context, store);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  store.chatProvider = chatProvider;

  // Commands
  registerCommands(context, store);

  // React to config changes (models, providers, keys)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nimAgent.models") || e.affectsConfiguration("nimAgent.defaultModel")) {
        modelManager.loadFromConfig();
        chatProvider.refreshState();
      }
      if (e.affectsConfiguration("nimAgent.providers") || e.affectsConfiguration("nimAgent.apiBaseUrl")) {
        providerRegistry.loadFromConfig();
      }
      if (e.affectsConfiguration("nimAgent.apiKeys")) {
        apiKeyManager.load().catch((err) => logger.error("Failed to reload API keys", err));
      }
    })
  );

  registerInlineEditCommand(context, store);
  registerErrorHealer(context, store);

  logger.info("NIM Agent IDE activated.");
}

export function deactivate(): void {
  // Cleanup is handled by VS Code subscription disposal.
}
