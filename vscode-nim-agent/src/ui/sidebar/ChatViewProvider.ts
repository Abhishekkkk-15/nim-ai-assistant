import * as vscode from "vscode";
import type { ExtensionContextStore } from "../../utils/context";
import type { AgentRole } from "../../core/agent/BaseAgent";
import { collectEditorContext } from "../chat/contextCollector";

interface InboundMessage {
  type:
    | "ready"
    | "send"
    | "cancel"
    | "selectAgent"
    | "selectModel"
    | "clearMemory"
    | "openSettings"
    | "addKey"
    | "permissionResponse"
    | "planApproval"
    | "toggleAutoPermit"
    | "togglePlanMode"
    | "reviewFile"
    | "attachFile"
    | "detachFile";
  text?: string;
  agent?: AgentRole;
  model?: string;
  allowed?: boolean;
  approved?: boolean;
  path?: string;
}

interface OutboundMessage {
  type:
    | "state"
    | "user"
    | "assistant_start"
    | "assistant_token"
    | "assistant_end"
    | "step"
    | "error"
    | "info"
    | "permission_request"
    | "plan_proposal";
  payload?: unknown;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "nimAgent.chatView";

  private view?: vscode.WebviewView;
  private currentAbort?: AbortController;
  private autoPermit = false;
  private planMode = false;
  private attachedFiles = new Set<string>();
  private permissionResolver?: (allowed: boolean) => void;
  private planResolver?: (approved: boolean) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ExtensionContextStore
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void | Thenable<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    };
    view.webview.html = this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage((msg: InboundMessage) => {
      this.handleMessage(msg).catch((err) => {
        this.store.logger.error("Chat message handler failed", err);
        this.post({ type: "error", payload: err instanceof Error ? err.message : String(err) });
      });
    });
  }

  /** Public API: open the view and pre-fill a prompt. */
  async openWithPrompt(prompt: string, agent?: AgentRole): Promise<void> {
    await vscode.commands.executeCommand("nimAgent.chatView.focus");
    if (!this.view) {
      return;
    }
    this.view.show?.(true);
    if (agent) {
      this.post({ type: "info", payload: `Switched to ${agent} agent.` });
    }
    await this.runPrompt(prompt, agent);
  }

  refreshState(): void {
    this.post({
      type: "state",
      payload: {
        models: this.store.modelManager.list(),
        activeModel: this.safeActiveModel(),
        agents: this.store.agentRegistry.list().map((a) => ({ role: a.role, label: a.label })),
        activeAgent: this.defaultAgent(),
        keyCount: this.store.apiKeyManager.count(),
        autoPermit: this.autoPermit,
        planMode: this.planMode,
        attachedFiles: Array.from(this.attachedFiles)
      }
    });
  }

  isPlanMode(): boolean {
    return this.planMode;
  }

  isAutoPermit(): boolean {
    return this.autoPermit;
  }

  // --- private helpers ---

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.refreshState();
        return;
      case "send": {
        const text = (msg.text ?? "").trim();
        if (!text) {
          return;
        }
        if (msg.model) {
          this.store.modelManager.setActive(msg.model);
        }
        await this.runPrompt(text, msg.agent);
        return;
      }
      case "cancel":
        this.currentAbort?.abort();
        return;
      case "selectAgent":
        if (msg.agent) {
          await vscode.workspace
            .getConfiguration("nimAgent")
            .update("defaultAgent", msg.agent, vscode.ConfigurationTarget.Global);
          this.refreshState();
        }
        return;
      case "selectModel":
        if (msg.model) {
          this.store.modelManager.setActive(msg.model);
          await vscode.workspace
            .getConfiguration("nimAgent")
            .update("defaultModel", msg.model, vscode.ConfigurationTarget.Global);
          this.refreshState();
        }
        return;
      case "clearMemory":
        this.store.memory.clear();
        this.post({ type: "info", payload: "Conversation memory cleared." });
        return;
      case "openSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:nim-agent.nim-agent-ide"
        );
        return;
      case "addKey":
        await vscode.commands.executeCommand("nimAgent.addApiKey");
        this.refreshState();
        return;
      case "permissionResponse":
        if (this.permissionResolver) {
          this.permissionResolver(!!msg.allowed);
          this.permissionResolver = undefined;
        }
        return;
      case "planApproval":
        if (this.planResolver) {
          this.planResolver(!!msg.approved);
          this.planResolver = undefined;
        }
        return;
      case "toggleAutoPermit":
        this.autoPermit = !this.autoPermit;
        this.refreshState();
        return;
      case "togglePlanMode":
        this.planMode = !this.planMode;
        this.refreshState();
        return;
      case "reviewFile":
        if (msg.path) {
          await this.openReview(msg.path, msg.text ?? "");
        }
        return;
      case "attachFile":
        if (msg.path) this.attachedFiles.add(msg.path);
        this.refreshState();
        return;
      case "detachFile":
        if (msg.path) this.attachedFiles.delete(msg.path);
        this.refreshState();
        return;
    }
  }

  private async runPrompt(prompt: string, agentRole?: AgentRole): Promise<void> {
    const role = agentRole ?? this.defaultAgent();
    let agent;
    try {
      agent = this.store.agentRegistry.get(role);
    } catch (err) {
      this.post({ type: "error", payload: (err as Error).message });
      return;
    }

    // Parse @mentions from prompt to automatically attach files
    const mentions = prompt.match(/@([\w.\-/]+)/g);
    if (mentions) {
      for (const m of mentions) {
        const path = m.slice(1);
        this.attachedFiles.add(path);
      }
      this.refreshState();
    }

    if (!this.store.apiKeyManager.hasKeys()) {
      this.post({
        type: "error",
        payload:
          "No NVIDIA NIM API key configured. Use the \"Add API Key\" button or run \"NIM Agent: Add API Key\"."
      });
      return;
    }

    this.post({ type: "user", payload: prompt });
    this.post({ type: "assistant_start", payload: { agent: role } });

    const ctx = await collectEditorContext(Array.from(this.attachedFiles));
    this.currentAbort = new AbortController();

    try {
      const result = await agent.run({
        prompt,
        context: ctx,
        planMode: this.planMode,
        signal: this.currentAbort.signal,
        onToken: (t) => this.post({ type: "assistant_token", payload: t }),
        onStep: (step) => {
          if (step.type === "tool_call" || step.type === "tool_result" || step.type === "thought") {
            this.post({ type: "step", payload: step });
          }
        },
        onPermissionRequest: async (tool, input) => {
          if (this.autoPermit) return true;
          this.post({ type: "permission_request", payload: { tool, input } });
          return new Promise<boolean>((resolve) => {
            this.permissionResolver = resolve;
          });
        },
        onPlanApproval: async (plan) => {
          this.post({ type: "plan_proposal", payload: { plan } });
          return new Promise<boolean>((resolve) => {
            this.planResolver = resolve;
          });
        }
      });
      this.post({ type: "assistant_end", payload: { content: result.content } });
    } catch (err) {
      this.post({ type: "error", payload: err instanceof Error ? err.message : String(err) });
    } finally {
      this.currentAbort = undefined;
    }
  }

  private defaultAgent(): AgentRole {
    const v = vscode.workspace.getConfiguration("nimAgent").get<string>("defaultAgent", "chat");
    return (["chat", "coder", "debugger", "refactor"].includes(v) ? v : "chat") as AgentRole;
  }

  private safeActiveModel(): string | undefined {
    try {
      return this.store.modelManager.getActive();
    } catch {
      return undefined;
    }
  }

  private async openReview(path: string, content: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;
    const uri = vscode.Uri.joinPath(folders[0].uri, path);

    try {
      // Create a temporary read-only document for review
      const doc = await vscode.workspace.openTextDocument({ content, language: "typescript" });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (err) {
      this.store.logger.error("Failed to open review document", err);
    }
  }

  private post(msg: OutboundMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = generateNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>NIM Agent</title>
<style>
  :root {
    --gap: 8px;
    --radius: 6px;
    --bg-darker: rgba(0,0,0,0.15);
    --accent: var(--vscode-button-background);
    --accent-hover: var(--vscode-button-hoverBackground);
  }
  html, body { height: 100%; margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); overflow: hidden; }
  body { display: flex; flex-direction: column; position: relative; }
  
  .toolbar { 
    display: flex; 
    gap: 8px; 
    padding: 8px 12px; 
    border-bottom: 1px solid var(--vscode-panel-border); 
    align-items: center; 
    background: var(--vscode-sideBar-background); 
    z-index: 10;
    backdrop-filter: blur(8px);
  }
  .toolbar label { font-size: 11px; opacity: 0.8; font-weight: 600; }
  
  select, button, input { font: inherit; color: var(--vscode-foreground); }
  select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 2px 4px;
    border-radius: var(--radius);
    font-size: 11px;
  }
  
  button {
    background: var(--accent);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 12px;
    cursor: pointer;
    border-radius: var(--radius);
    font-size: 11px;
    font-weight: 500;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  button:hover { background: var(--accent-hover); transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  button.ghost {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
    opacity: 0.7;
  }
  button.ghost:hover { opacity: 1; background: var(--bg-darker); border-color: var(--vscode-focusBorder); }
  button.active { background: var(--accent); color: var(--vscode-button-foreground); border-color: transparent; opacity: 1; box-shadow: 0 0 10px var(--accent); }

  /* Timeline Layout */
  #log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 32px; padding: 24px 20px; scroll-behavior: smooth; }
  .msg { position: relative; display: flex; flex-direction: column; gap: 8px; }
  
  /* User Section */
  .msg.user { border-left: 2px solid var(--vscode-charts-blue, #3794ff); padding-left: 12px; }
  .msg.user .who { color: var(--vscode-charts-blue, #3794ff); opacity: 0.7; }
  
  /* Assistant Section */
  .msg.assistant { border-top: 1px solid rgba(255,255,255,0.05); padding-top: 24px; }
  .msg.assistant:first-child { border-top: none; padding-top: 0; }
  .msg.assistant .who { color: var(--vscode-charts-purple, #b267e6); opacity: 0.7; }
  
  .who { 
    font-size: 10px; font-weight: 800; text-transform: uppercase; 
    letter-spacing: 0.08em; display: flex; align-items: center; gap: 8px;
  }

  .body { font-size: 13.5px; line-height: 1.6; color: var(--vscode-foreground); opacity: 0.95; }
  .body pre { background: var(--bg-darker); padding: 14px; border-radius: 6px; margin: 16px 0; border: 1px solid rgba(255,255,255,0.06); }

  /* Hierarchical Activity System */
  .activity-block {
    margin: 16px 0; border: 1px solid var(--vscode-panel-border);
    border-radius: 8px; overflow: hidden; background: rgba(0,0,0,0.15);
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .activity-block.collapsed .steps-container { display: none; }
  .activity-header {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; cursor: pointer; background: rgba(255,255,255,0.03);
    user-select: none; border-bottom: 1px solid transparent;
  }
  .activity-block:not(.collapsed) .activity-header { border-bottom-color: rgba(255,255,255,0.05); }
  .activity-header:hover { background: rgba(255,255,255,0.05); }
  
  .activity-icon { font-size: 14px; opacity: 0.8; }
  .activity-title { flex: 1; font-size: 12px; font-weight: 600; opacity: 0.9; }
  .activity-duration { font-size: 11px; opacity: 0.5; font-family: var(--vscode-editor-font-family); }
  .activity-chevron { font-size: 10px; opacity: 0.3; transition: transform 0.2s; }
  .activity-block:not(.collapsed) .activity-chevron { transform: rotate(90deg); }

  .steps-container { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
  
  .step-group {
    border-radius: 6px; border: 1px solid transparent;
    transition: all 0.15s;
  }
  .step-header {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 8px; cursor: pointer; font-size: 12px;
  }
  .step-header:hover { background: rgba(255,255,255,0.03); border-radius: 4px; }
  .step-icon { font-size: 12px; width: 16px; text-align: center; opacity: 0.7; }
  .step-title { flex: 1; opacity: 0.8; }
  .step-status { font-size: 10px; opacity: 0.4; margin-right: 4px; }
  .step-chevron { font-size: 9px; opacity: 0.2; transition: transform 0.2s; }
  .step-group.expanded .step-chevron { transform: rotate(90deg); }
  
  .step-body { display: none; padding: 4px 8px 8px 32px; font-size: 11.5px; opacity: 0.7; border-left: 1px solid rgba(255,255,255,0.05); margin-left: 15px; }
  .step-group.expanded .step-body { display: block; }
  
  .step-spinner { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--vscode-charts-blue, #3794ff); border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .usage { margin-top: 12px; font-size: 10px; opacity: 0.3; text-align: right; font-style: italic; }

  .composer {
    display: flex;
    flex-direction: column;
    padding: 12px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    gap: 8px;
    position: relative;
    box-shadow: 0 -4px 20px rgba(0,0,0,0.2);
  }
  
  .composer-bottom {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .composer-btns {
    display: flex;
    gap: 8px;
  }

  #promptBar {
    background: var(--vscode-notifications-background, #333);
    color: var(--vscode-notifications-foreground, #fff);
    padding: 10px;
    border-radius: 8px;
    font-size: 12px;
    display: none;
    flex-direction: column;
    gap: 10px;
    border: 1px solid var(--vscode-panel-border);
    margin-bottom: 8px;
  }
  .prompt-actions { display: flex; gap: 6px; }
  .prompt-actions button { flex: 1; padding: 6px; font-size: 11px; }

  textarea {
    min-height: 40px;
    max-height: 200px;
    resize: none;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 10px;
    border-radius: 8px;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    transition: border-color 0.2s;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); outline: none; }
  
  #status { font-size: 10px; opacity: 0.6; font-weight: 500; font-family: var(--vscode-editor-font-family); }
  
  #contextBar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 12px;
    margin-bottom: 4px;
  }
  .chip {
    background: var(--bg-darker);
    color: var(--vscode-foreground);
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 10px;
    display: flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--vscode-panel-border);
  }
  .chip .remove {
    cursor: pointer;
    opacity: 0.5;
    font-weight: bold;
  }
  .chip .remove:hover { opacity: 1; color: var(--vscode-errorForeground); }

  .working-indicator {
    display: none;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    font-size: 11px;
    color: var(--vscode-charts-green);
    animation: fadeIn 0.3s;
  }
  .dot { width: 4px; height: 4px; background: currentColor; border-radius: 50%; animation: pulse 1.5s infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(1); } 50% { opacity: 1; transform: scale(1.2); } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .scroll-btn {
    position: absolute;
    bottom: 160px;
    right: 20px;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--accent);
    color: white;
    display: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 100;
  }

  pre, code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  pre { 
    background: var(--bg-darker); 
    padding: 12px; 
    overflow-x: auto; 
    border-radius: var(--radius); 
    margin: 12px 0; 
    border: 1px solid var(--vscode-panel-border);
    position: relative;
  }
  pre::before {
    content: 'CODE';
    position: absolute;
    top: 0;
    right: 0;
    font-size: 9px;
    padding: 2px 6px;
    opacity: 0.4;
    background: var(--bg-darker);
    border-bottom-left-radius: var(--radius);
  }
  code { background: var(--bg-darker); padding: 2px 4px; border-radius: 3px; }
  pre code { background: transparent; padding: 0; }
  
  .usage { font-size: 9px; opacity: 0.5; margin-top: 4px; text-align: right; }
</style>
</head>
<body>
  <div class="toolbar">
    <select id="agentSel" title="Select Agent Role"></select>
    <select id="modelSel" title="Select Model"></select>
    <div style="flex:1"></div>
    <button class="ghost" id="planBtn" title="Toggle Plan Mode">Plan</button>
    <button class="ghost" id="autoBtn" title="Toggle Auto-permit Mode">Auto</button>
    <button class="ghost" id="clearBtn" title="Clear Chat">🗑️</button>
  </div>
  
  <div id="keyWarn" class="key-warning" style="display:none; padding: 4px 12px; font-size: 11px; background: var(--vscode-errorForeground); color: white;">
    API Key missing. <a href="#" id="addKeyLink" style="color:white; font-weight:bold">Add Key</a>
  </div>

  <div id="log"></div>

  <div id="working" class="working-indicator">
    <div class="dot"></div><div class="dot"></div><div class="dot"></div>
    <span>Agent is working...</span>
  </div>

  <div id="scrollToBottom" class="scroll-btn" title="Scroll to bottom">↓</div>

  <div id="contextBar"></div>

  <div class="composer">
    <div id="promptBar">
      <div id="promptText"></div>
      <div class="prompt-actions">
        <button id="reviewBtn" class="secondary">Review</button>
        <button id="allowBtn">Allow</button>
        <button id="denyBtn" class="secondary">Deny</button>
      </div>
    </div>
    
    <textarea id="input" placeholder="Ask NIM Agent... (Ctrl+Enter to send)"></textarea>
    
    <div class="composer-bottom">
      <div id="status" style="font-size: 10px; opacity: 0.6;"></div>
      <div class="composer-btns">
        <button id="cancelBtn" class="secondary" style="display:none">Stop</button>
        <button id="sendBtn">Send</button>
      </div>
    </div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const agentSel = document.getElementById('agentSel');
  const modelSel = document.getElementById('modelSel');
  const sendBtn = document.getElementById('sendBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const clearBtn = document.getElementById('clearBtn');
  const planBtn = document.getElementById('planBtn');
  const autoBtn = document.getElementById('autoBtn');
  const promptBar = document.getElementById('promptBar');
  const reviewBtn = document.getElementById('reviewBtn');
  const status = document.getElementById('status');
  const working = document.getElementById('working');
  const scrollToBottom = document.getElementById('scrollToBottom');
  const contextBar = document.getElementById('contextBar');

  let activeAssistantBubble = null;
  let activeStepsContainer = null;
  let activeActivityBlock = null;
  let turnStartTime = 0;
  let turnTimer = null;
  let lastStepGroup = null;
  let currentPermissionRequest = null;
  let streamingState = { isJson: false, jsonBuffer: '', isFinal: false, finalExtracted: '' };

  function resetStreamingState() {
    streamingState = { isJson: false, jsonBuffer: '', isFinal: false, finalExtracted: '' };
  }

  function append(role, text) {
    const msg = document.createElement('div');
    msg.className = 'msg ' + role;
    
    const who = document.createElement('div');
    who.className = 'who';
    who.innerHTML = '<span>' + role + '</span>';
    msg.appendChild(who);

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text || '';
    msg.appendChild(body);
    
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  function createActivityBlock(container) {
    const block = document.createElement('div');
    block.className = 'activity-block';
    block.innerHTML = \`
      <div class="activity-header">
        <span class="activity-icon">⚙️</span>
        <span class="activity-title">Agent working...</span>
        <span class="activity-duration">0s</span>
        <span class="activity-chevron">▸</span>
      </div>
      <div class="steps-container"></div>
    \`;
    block.querySelector('.activity-header').onclick = () => block.classList.toggle('collapsed');
    container.appendChild(block);
    return { 
      block, 
      stepsContainer: block.querySelector('.steps-container'),
      durationEl: block.querySelector('.activity-duration'),
      titleEl: block.querySelector('.activity-title')
    };
  }

  function formatMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\\\`\\\`\\\`([\\s\\S]*?)\\\`\\\`\\\`/g, '<pre><code>$1</code></pre>')
      .replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
      .replace(/^\\s*-\\s+(.*)$/gm, '• $1')
      .replace(/\\n/g, '<br>');
  }

  function getToolIcon(name) {
    const icons = { read_file:'📄', write_file:'✏️', run_command:'⚡', replace_file_content:'🔧', replace_in_file:'🔧', search_workspace:'🔍', propose_edit:'✨', scaffold_project:'📦', fetch_url:'🌐', code_intelligence:'🧠', git_manager:'📋' };
    return icons[name] || '🔧';
  }
  function getToolTitle(name, payload) {
    try {
      const p = JSON.parse(payload);
      if (name === 'read_file') return 'Read: ' + (p.path || '');
      if (name === 'write_file') return 'Write: ' + (p.path || '');
      if (name === 'run_command') return 'Run: ' + (p.command || '');
      if (name === 'replace_file_content') return 'Edit: ' + (p.path || '');
      if (name === 'replace_in_file') return 'Replace in: ' + (p.path || '');
      if (name === 'search_workspace') return 'Search: ' + (p.query || '');
      if (name === 'propose_edit') return 'Propose edit: ' + (p.path || '');
      if (name === 'scaffold_project') return 'Scaffold project';
      if (name === 'fetch_url') return 'Fetch: ' + (p.url || '');
      if (name === 'code_intelligence') return 'Analyze: ' + (p.action || '');
      if (name === 'git_manager') return 'Git: ' + (p.action || '');
    } catch {}
    return name || 'tool';
  }

  function appendStep(step) {
    if (!activeStepsContainer) return;
    const container = activeStepsContainer;

    if (step.type === 'thought') {
      const g = document.createElement('div');
      g.className = 'step-group thought expanded';
      g.innerHTML = '<div class="step-header"><span class="step-icon">💭</span><span class="step-title">Thought</span><span class="step-chevron">▸</span></div>';
      const body = document.createElement('div');
      body.className = 'step-body';
      body.textContent = step.payload;
      g.appendChild(body);
      g.querySelector('.step-header').onclick = (e) => { e.stopPropagation(); g.classList.toggle('expanded'); };
      container.appendChild(g);
      lastStepGroup = null;
      log.scrollTop = log.scrollHeight;
      return;
    }

    if (step.type === 'tool_call') {
      const g = document.createElement('div');
      g.className = 'step-group tool expanded';
      const icon = getToolIcon(step.name);
      const title = getToolTitle(step.name, step.payload);
      g.innerHTML = '<div class="step-header"><span class="step-icon">' + icon + '</span><span class="step-title">' + title + '</span><div class="step-spinner"></div><span class="step-chevron">▸</span></div>';
      const body = document.createElement('div');
      body.className = 'step-body';
      g.appendChild(body);
      g.querySelector('.step-header').onclick = (e) => { e.stopPropagation(); g.classList.toggle('expanded'); };
      container.appendChild(g);
      lastStepGroup = g;
      log.scrollTop = log.scrollHeight;
      return;
    }

    if (step.type === 'tool_result' && lastStepGroup) {
      const spinner = lastStepGroup.querySelector('.step-spinner');
      if (spinner) spinner.remove();
      const ok = step.payload && !step.payload.startsWith('Command failed') && !step.payload.startsWith('Tool denied');
      lastStepGroup.classList.add(ok ? 'complete' : 'failed');
      const statusEl = document.createElement('span');
      statusEl.className = 'step-status';
      statusEl.textContent = ok ? '✓ done' : '✗ failed';
      lastStepGroup.querySelector('.step-header').insertBefore(statusEl, lastStepGroup.querySelector('.step-chevron'));
      const body = lastStepGroup.querySelector('.step-body');
      if (step.payload) {
        const isCmd = lastStepGroup.querySelector('.step-icon')?.textContent === '⚡';
        if (isCmd) {
          const pre = document.createElement('pre');
          pre.textContent = step.payload;
          body.appendChild(pre);
        } else {
          const txt = document.createElement('div');
          txt.textContent = step.payload.length > 500 ? step.payload.slice(0, 500) + '...' : step.payload;
          body.appendChild(txt);
        }
      }
      lastStepGroup = null;
      log.scrollTop = log.scrollHeight;
      return;
    }
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text, agent: agentSel.value, model: modelSel.value });
    cancelBtn.style.display = 'inline-block';
  }

  function showPrompt(text, type, data) {
    promptText.textContent = text;
    promptBar.style.display = 'flex';
    currentPermissionRequest = { type, data };
    const canReview = data && (data.tool === 'write_file' || data.tool === 'propose_edit');
    reviewBtn.style.display = canReview ? 'inline-block' : 'none';
  }

  function hidePrompt() {
    promptBar.style.display = 'none';
    currentPermissionRequest = null;
  }

  window.detach = (path) => {
    vscode.postMessage({ type: 'detachFile', path });
  };

  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  clearBtn.addEventListener('click', () => { log.innerHTML = ''; vscode.postMessage({ type: 'clearMemory' }); });
  planBtn.addEventListener('click', () => vscode.postMessage({ type: 'togglePlanMode' }));
  autoBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleAutoPermit' }));
  
  allowBtn.addEventListener('click', () => {
    const req = currentPermissionRequest;
    hidePrompt();
    if (req.type === 'permission') {
      vscode.postMessage({ type: 'permissionResponse', allowed: true });
    } else {
      vscode.postMessage({ type: 'planApproval', approved: true });
    }
  });

  denyBtn.addEventListener('click', () => {
    const req = currentPermissionRequest;
    hidePrompt();
    if (req.type === 'permission') {
      vscode.postMessage({ type: 'permissionResponse', allowed: false });
    } else {
      vscode.postMessage({ type: 'planApproval', approved: false });
    }
  });

  reviewBtn.addEventListener('click', () => {
    if (currentPermissionRequest && currentPermissionRequest.data) {
      const payload = currentPermissionRequest.data.input;
      vscode.postMessage({ type: 'reviewFile', path: payload.path, text: payload.content });
    }
  });

  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  });

  log.addEventListener('scroll', () => {
    const isBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
    scrollToBottom.style.display = isBottom ? 'none' : 'flex';
  });

  scrollToBottom.addEventListener('click', () => {
    log.scrollTop = log.scrollHeight;
  });

  agentSel.addEventListener('change', () => vscode.postMessage({ type: 'selectAgent', agent: agentSel.value }));
  modelSel.addEventListener('change', () => vscode.postMessage({ type: 'selectModel', model: modelSel.value }));

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'state': {
        const s = m.payload;
        // Agents
        agentSel.innerHTML = '';
        for (const a of s.agents) {
          const opt = document.createElement('option');
          opt.value = a.role; opt.textContent = a.label;
          if (a.role === s.activeAgent) opt.selected = true;
          agentSel.appendChild(opt);
        }
        // Models
        modelSel.innerHTML = '';
        for (const m2 of s.models) {
          if (!m2.enabled) continue;
          const opt = document.createElement('option');
          opt.value = m2.name; opt.textContent = m2.name;
          if (m2.name === s.activeModel) opt.selected = true;
          modelSel.appendChild(opt);
        }
        // Toggles
        planBtn.className = s.planMode ? 'ghost active' : 'ghost';
        autoBtn.className = s.autoPermit ? 'ghost active' : 'ghost';
        status.textContent = (s.planMode ? 'PLAN MODE' : 'NORMAL') + (s.autoPermit ? ' | AUTO' : '');
        
        // Render Context Chips
        contextBar.innerHTML = '';
        if (s.attachedFiles) {
          s.attachedFiles.forEach(path => {
            const chip = document.createElement('div');
            chip.className = 'chip';
            chip.innerHTML = \`<span>\${path}</span><span class="remove" onclick="detach('\${path}')">×</span>\`;
            contextBar.appendChild(chip);
          });
        }
        break;
      }
      case 'user': {
        const ub = append('user', '');
        ub.innerHTML = formatMarkdown(m.payload);
        activeAssistantBubble = null;
        activeStepsContainer = null;
        activeActivityBlock = null;
        lastStepGroup = null;
        resetStreamingState();
        break;
      }
      case 'assistant_start': {
        const ab = append('assistant', '');
        activeAssistantBubble = ab;
        
        // Start Activity Block
        const act = createActivityBlock(ab.parentElement);
        activeActivityBlock = act;
        activeStepsContainer = act.stepsContainer;
        
        turnStartTime = Date.now();
        turnTimer = setInterval(() => {
          const s = Math.floor((Date.now() - turnStartTime) / 1000);
          act.durationEl.textContent = s + 's';
        }, 1000);

        lastStepGroup = null;
        resetStreamingState();
        cancelBtn.style.display = 'inline-block';
        working.style.display = 'flex';
        break;
      }
      case 'assistant_token': {
        if (!activeAssistantBubble) {
          const ab = append('assistant', '');
          activeAssistantBubble = ab;
          const act = createActivityBlock(ab.parentElement);
          activeActivityBlock = act;
          activeStepsContainer = act.stepsContainer;
        }
        
        const token = m.payload;
        streamingState.jsonBuffer += token;
        
        // Detect start of JSON block (cumulative)
        if (!streamingState.isJson && streamingState.jsonBuffer.includes('\\\`\\\`\\\`json')) {
          streamingState.isJson = true;
          // Trim the bubble text to remove the opening fence that might have leaked
          activeAssistantBubble.textContent = activeAssistantBubble.textContent.replace(/\\\`*$/, '').trim();
        }
        
        if (streamingState.isJson) {
          // Detect final answer streaming
          if (!streamingState.isFinal && streamingState.jsonBuffer.includes('"final"')) {
            streamingState.isFinal = true;
          }
          if (streamingState.isFinal) {
            const match = streamingState.jsonBuffer.match(/"final":\s*"([^"]*)/);
            if (match && match[1]) {
              const newContent = match[1].replace(/\\\\n/g, '\\n');
              const delta = newContent.slice(streamingState.finalExtracted.length);
              if (delta) {
                activeAssistantBubble.textContent += delta;
                streamingState.finalExtracted = newContent;
              }
            }
          }
        } else {
          activeAssistantBubble.textContent += token;
        }
        
        // Detect end of JSON block
        if (streamingState.isJson && token.includes('\\\`\\\`\\\`')) {
          const lastFence = streamingState.jsonBuffer.lastIndexOf('\\\`\\\`\\\`json');
          if (streamingState.jsonBuffer.lastIndexOf('\\\`\\\`\\\`') > lastFence + 7) {
            streamingState.isJson = false;
          }
        }
        
        log.scrollTop = log.scrollHeight;
        break;
      }
      case 'assistant_end':
        if (turnTimer) clearInterval(turnTimer);
        if (activeActivityBlock) {
          const duration = Math.floor((Date.now() - turnStartTime) / 1000);
          activeActivityBlock.titleEl.textContent = 'Worked for ' + duration + 's';
          activeActivityBlock.block.classList.add('collapsed');
        }
        if (activeAssistantBubble && m.payload) {
          if (m.payload.content) {
            activeAssistantBubble.innerHTML = formatMarkdown(m.payload.content);
          }
          if (m.payload.usage) {
            const u = m.payload.usage;
            const usageDiv = document.createElement('div');
            usageDiv.className = 'usage';
            usageDiv.textContent = \`Tokens: \${u.totalTokens} (P: \${u.promptTokens}, C: \${u.completionTokens})\`;
            activeAssistantBubble.parentElement.appendChild(usageDiv);
          }
        }
        activeAssistantBubble = null;
        activeStepsContainer = null;
        activeActivityBlock = null;
        lastStepGroup = null;
        resetStreamingState();
        cancelBtn.style.display = 'none';
        working.style.display = 'none';
        break;
      case 'step': {
        if (m.payload.type === 'tool_call' && activeAssistantBubble) {
          // Robust surgical cleaning of any JSON fragments or fences
          activeAssistantBubble.textContent = activeAssistantBubble.textContent
            .replace(/\\\`\\\`\\\`json[\s\S]*$/, '')
            .replace(/\\\`\\\`\\\`[\s\S]*$/, '')
            .replace(/\{[\s\S]*$/, '')
            .trim();
        }
        appendStep(m.payload);
        break;
      }
      case 'permission_request':
        working.style.display = 'none';
        showPrompt(\`Agent wants to use "\${m.payload.tool}". Allow?\`, 'permission', m.payload);
        break;
      case 'plan_proposal':
        working.style.display = 'none';
        showPrompt(\`Agent proposed a plan. Review and approve?\`, 'plan', m.payload);
        break;
      case 'error':
        append('error', String(m.payload));
        cancelBtn.style.display = 'none';
        working.style.display = 'none';
        break;
      case 'info':
        append('info', String(m.payload));
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function generateNonce(): string {
  let result = "";
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
