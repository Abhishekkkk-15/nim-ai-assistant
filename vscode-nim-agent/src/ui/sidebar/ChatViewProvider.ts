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

  #log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 16px; scroll-behavior: smooth; }
  
  .msg { position: relative; max-width: 95%; align-self: flex-start; }
  .msg.user { align-self: flex-end; }
  
  .msg .who { font-size: 10px; opacity: 0.5; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
  .msg.user .who { text-align: right; color: var(--vscode-textLink-foreground); }
  .msg.assistant .who { color: var(--vscode-charts-green, #4ec9b0); }
  
  .msg .bubble {
    padding: 10px 14px;
    border-radius: 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    transition: transform 0.2s;
  }
  .msg.assistant .bubble { border-top-left-radius: 2px; }
  .msg.user .bubble {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    border: none;
    border-top-right-radius: 2px;
  }
  
  .body { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.6; }
  
  .step {
    font-size: 11px;
    margin: 4px 0;
    padding: 8px 12px;
    border-radius: var(--radius);
    background: var(--bg-darker);
    border-left: 4px solid var(--accent);
    display: flex;
    align-items: center;
    gap: 8px;
    animation: slideIn 0.3s ease-out;
  }
  @keyframes slideIn { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); } }
  .step.thought { border-left-color: var(--vscode-charts-purple, #b267e6); font-style: italic; opacity: 0.9; }
  .step.tool_call { border-left-color: var(--vscode-charts-blue, #3794ff); font-weight: 600; }
  .step.tool_result { border-left-color: var(--vscode-charts-orange, #d18616); }

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
  let currentPermissionRequest = null;

  function append(role, text) {
    const msg = document.createElement('div');
    msg.className = 'msg ' + role;
    
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role;
    msg.appendChild(who);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text || '';
    bubble.appendChild(body);
    msg.appendChild(bubble);
    
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return body;
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

  function appendStep(step) {
    const div = document.createElement('div');
    div.className = 'step ' + step.type;
    
    let content = step.payload;
    if (step.type === 'tool_call') {
      try {
        const payload = JSON.parse(step.payload);
        if (step.name === 'write_file') {
          content = 'Writing file: ' + payload.path;
        } else if (step.name === 'run_command') {
          content = 'Running command: ' + payload.command;
        } else if (step.name === 'propose_edit') {
          content = 'Proposing edit to: ' + payload.path;
        } else if (step.name === 'read_file') {
          content = 'Reading file: ' + payload.path;
        } else if (step.name === 'search_workspace') {
          content = 'Searching workspace: ' + payload.query;
        } else {
          content = 'Calling tool: ' + step.name;
        }
      } catch {
        content = 'Calling tool: ' + step.name;
      }
    } else if (step.type === 'tool_result') {
      content = 'Tool ' + (step.name || '') + ' finished.';
    } else if (step.type === 'thought') {
      // Thought is already plain text or slightly structured
    }
    
    div.textContent = content;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
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
      case 'user':
        const userBubble = append('user', '');
        userBubble.innerHTML = formatMarkdown(m.payload);
        activeAssistantBubble = null;
        break;
      case 'assistant_start':
        activeAssistantBubble = append('assistant', '');
        cancelBtn.style.display = 'inline-block';
        working.style.display = 'flex';
        break;
      case 'assistant_token':
        if (!activeAssistantBubble) activeAssistantBubble = append('assistant', '');
        activeAssistantBubble.textContent += m.payload;
        // Don't format yet, it breaks streaming
        log.scrollTop = log.scrollHeight;
        break;
      case 'assistant_end':
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
        cancelBtn.style.display = 'none';
        working.style.display = 'none';
        break;
      case 'step': {
        // When a tool_call step arrives, clear the raw JSON from the streaming bubble
        if (m.payload.type === 'tool_call' && activeAssistantBubble) {
          activeAssistantBubble.textContent = '';
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
