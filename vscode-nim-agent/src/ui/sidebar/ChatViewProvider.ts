import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ExtensionContextStore } from "../../utils/context";
import type { AgentRole } from "../../core/agent/BaseAgent";
import { collectEditorContext } from "../chat/contextCollector";
import { renderChatHtml } from "./webview/template";

interface InboundMessage {
  type:
    | "ready" | "send" | "cancel" | "selectAgent" | "selectModel" | "clearMemory"
    | "openSettings" | "addKey" | "permissionResponse" | "planApproval"
    | "toggleAutoPermit" | "togglePlanMode" | "reviewFile" | "attachFile"
    | "detachFile" | "pinFile" | "unpinFile" | "applyCode" | "commitChanges" | "diffReview"
    | "newChat" | "loadSession" | "getAnalytics" | "clearAnalytics";
  text?: string; agent?: AgentRole; model?: string; allowed?: boolean;
  approved?: boolean; path?: string; code?: string; sessionId?: string;
}

interface OutboundMessage {
  type:
    | "state" | "user" | "assistant_start" | "assistant_token" | "assistant_end"
    | "step" | "error" | "info" | "permission_request" | "plan_proposal" | "session_loaded" | "analytics";
  payload?: unknown;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "nimAgent.chatView";
  private view?: vscode.WebviewView;
  private currentAbort?: AbortController;
  private autoPermit = false;
  private planMode = false;
  private attachedFiles = new Set<string>();
  private lastProposedCode?: string;
  private permissionResolver?: (allowed: boolean) => void;

  constructor(private readonly context: vscode.ExtensionContext, private readonly store: ExtensionContextStore) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: InboundMessage) => {
      this.handleMessage(msg).catch(err => this.post({ type: "error", payload: String(err) }));
    });
  }

  async openWithPrompt(prompt: string, agent?: AgentRole): Promise<void> {
    await vscode.commands.executeCommand("nimAgent.chatView.focus");
    if (!this.view) return;
    this.view.show?.(true);
    await this.runPrompt(prompt, agent);
  }

  refreshState(): void {
    this.post({
      type: "state",
      payload: {
        models: this.store.modelManager.list(),
        activeModel: this.safeActiveModel(),
        agents: this.store.agentRegistry.list().map(a => ({ role: a.role, label: a.label })),
        activeAgent: this.defaultAgent(),
        keyCount: this.store.apiKeyManager.count(),
        autoPermit: this.autoPermit,
        planMode: this.planMode,
        attachedFiles: Array.from(this.attachedFiles),
        pinnedFiles: this.store.contextManager.getAll().map(f => f.path),
        sessions: this.store.historyManager.getSessions().map(s => ({ id: s.id, title: s.title })),
        currentSessionId: this.store.historyManager.getCurrentSessionId()
      }
    });
  }

  isPlanMode(): boolean { return this.planMode; }
  isAutoPermit(): boolean { return this.autoPermit; }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready": this.refreshState(); return;
      case "send": await this.runPrompt(msg.text || "", msg.agent); return;
      case "cancel": this.currentAbort?.abort(); return;
      case "clearMemory": 
        await this.store.historyManager.clearAll();
        this.store.memory.clear(); 
        this.post({ type: "info", payload: "All history cleared" }); 
        this.refreshState();
        return;
      case "getAnalytics":
        this.post({ type: "analytics", payload: { summary: this.store.analyticsManager.getSummary(), events: this.store.analyticsManager.getEvents() } });
        return;
      case "clearAnalytics":
        await this.store.analyticsManager.clear();
        this.handleMessage({ type: "getAnalytics" });
        return;
      case "newChat":
        await this.store.historyManager.createSession();
        this.store.memory.clear();
        this.post({ type: "session_loaded", payload: { messages: [] } });
        this.refreshState();
        return;
      case "loadSession":
        if (msg.sessionId) {
          const session = await this.store.historyManager.loadSession(msg.sessionId);
          if (session) {
            const msgs = session.messages || [];
            this.store.memory.seed(msgs);
            this.post({ type: "session_loaded", payload: { messages: msgs } });
            this.refreshState();
          }
        }
        return;
      case "toggleAutoPermit": this.autoPermit = !this.autoPermit; this.refreshState(); return;
      case "togglePlanMode": this.planMode = !this.planMode; this.refreshState(); return;
      case "permissionResponse": this.permissionResolver?.(!!msg.allowed); this.permissionResolver = undefined; return;
      case "pinFile": if (msg.path) await this.store.contextManager.pinFile(msg.path); this.refreshState(); return;
      case "unpinFile": if (msg.path) await this.store.contextManager.unpin(msg.path); this.refreshState(); return;
      case "detachFile": if (msg.path) this.attachedFiles.delete(msg.path); this.refreshState(); return;
      case "attachFile": await this.attachFiles(msg.path); return;
      case "reviewFile": await this.runPrompt("Review active file for improvements.", "coder"); return;
      case "diffReview": {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.lastProposedCode) return;
        const originalUri = editor.document.uri;
        const tempPath = path.join(os.tmpdir(), "nim_agent_proposed_" + path.basename(originalUri.fsPath));
        fs.writeFileSync(tempPath, this.lastProposedCode);
        const tempUri = vscode.Uri.file(tempPath);
        await vscode.commands.executeCommand("vscode.diff", originalUri, tempUri, "Review Changes (NIM Agent)");
        return;
      }
      case "applyCode": {
        const editor = vscode.window.activeTextEditor;
        if (editor) editor.edit(e => editor.selection.isEmpty ? e.insert(editor.selection.active, msg.code || "") : e.replace(editor.selection, msg.code || ""));
        return;
      }
      case "commitChanges": {
        const git = this.store.toolRegistry.get("git_manager");
        if (git) {
          const [type, ...rest] = (msg.text || "chore: update").split(':');
          const result = await git.execute({ action: "commit", commitType: type.trim(), commitMessage: rest.join(':').trim() || "update" });
          if (result.ok) {
            this.post({ type: "info", payload: "Committed!" });
          } else {
            this.post({ type: "error", payload: "Commit failed: " + result.output });
          }
        }
        return;
      }
    }
  }

  private async runPrompt(prompt: string, agentRole?: AgentRole): Promise<void> {
    const role = agentRole || "chat";
    const agent = this.store.agentRegistry.get(role);
    await this.store.historyManager.appendMessage({ role: "user", content: prompt });
    this.post({ type: "user", payload: prompt });
    this.post({ type: "assistant_start", payload: { agent: role } });
    this.currentAbort = new AbortController();
    try {
      const result = await agent.run({
        prompt, context: await collectEditorContext(Array.from(this.attachedFiles)),
        planMode: this.planMode, signal: this.currentAbort.signal,
        onToken: t => this.post({ type: "assistant_token", payload: t }),
        onStep: s => {
          if (s.name === 'write_file' || s.name === 'replace_file_content' || s.name === 'multi_replace_file_content') {
            try { const input = JSON.parse(s.payload); if (input.content || input.replacementContent) this.lastProposedCode = input.content || input.replacementContent; } catch {}
          }
          this.post({ type: "step", payload: s });
        },
        onPermissionRequest: async (tool, input) => {
          if (this.autoPermit) return true;
          this.post({ type: "permission_request", payload: { tool, input } });
          return new Promise(res => this.permissionResolver = res);
        }
      });
      await this.store.historyManager.appendMessage({ role: "assistant", content: result.content });
      this.post({ type: "assistant_end", payload: { content: result.content } });
      this.refreshState();
    } catch (err) { this.post({ type: "error", payload: String(err) }); }
  }

  /**
   * Attach one or more files to the next prompt's context.
   * If a path is provided we attach it directly (workspace-relative).
   * Otherwise we open VS Code's native file picker, scoped to the first
   * workspace folder when available.
   */
  private async attachFiles(givenPath?: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    const root = folders && folders.length > 0 ? folders[0] : undefined;

    let picked: vscode.Uri[] = [];
    if (givenPath) {
      try {
        const uri = root ? vscode.Uri.joinPath(root.uri, givenPath) : vscode.Uri.file(givenPath);
        picked = [uri];
      } catch { picked = []; }
    } else {
      const result = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        defaultUri: root?.uri,
        openLabel: "Attach to NIM Agent",
        title: "Attach files to chat context"
      });
      picked = result ?? [];
    }
    if (picked.length === 0) return;

    let added = 0;
    for (const uri of picked) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File) continue;
        const rel = vscode.workspace.asRelativePath(uri, false);
        if (!this.attachedFiles.has(rel)) {
          this.attachedFiles.add(rel);
          added++;
        }
      } catch { /* skip unreadable */ }
    }
    if (added > 0) this.post({ type: "info", payload: `Attached ${added} file${added === 1 ? "" : "s"}` });
    this.refreshState();
  }

  private defaultAgent(): AgentRole { return vscode.workspace.getConfiguration("nimAgent").get("defaultAgent", "chat") as AgentRole; }
  private safeActiveModel(): string | undefined { try { return this.store.modelManager.getActive(); } catch { return undefined; } }
  private post(msg: OutboundMessage): void { this.view?.webview.postMessage(msg); }

  private renderHtml(webview: vscode.Webview): string {
    return renderChatHtml(webview);
  }
}
