import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ExtensionContextStore } from "../../utils/context";
import type { AgentRole, AgentImageInput } from "../../core/agent/BaseAgent";
import { collectEditorContext } from "../chat/contextCollector";
import { renderChatHtml } from "./webview/template";
import { EditTracker } from "../../core/agent/EditTracker";
import { HANDOFF_MARKER, VALID_HANDOFF_ROLES } from "../../core/tools/HandOffTool";

interface AttachedImage {
  /** Stable id for client/server reconciliation. */
  id: string;
  /** data: URL with base64 payload. */
  url: string;
  /** Human-readable name (e.g. "screenshot.png" or "pasted-image-1.png"). */
  name: string;
  /** Approximate size in bytes (decoded). */
  size: number;
}

interface InboundMessage {
  type:
    | "ready" | "send" | "cancel" | "selectAgent" | "selectModel" | "clearMemory"
    | "openSettings" | "addKey" | "permissionResponse" | "planApproval"
    | "toggleAutoPermit" | "togglePlanMode" | "reviewFile" | "attachFile"
    | "detachFile" | "pinFile" | "unpinFile" | "applyCode" | "commitChanges" | "diffReview"
    | "newChat" | "loadSession" | "getAnalytics" | "clearAnalytics"
    | "attachImage" | "detachImage" | "pickImage"
    | "openEditDiff" | "revertEdit" | "revertAllEdits"
    | "openRulesFile" | "createRulesFile";
  text?: string; agent?: AgentRole; model?: string; allowed?: boolean;
  approved?: boolean; path?: string; code?: string; sessionId?: string;
  imageId?: string; imageName?: string; imageDataUrl?: string;
}

interface OutboundMessage {
  type:
    | "state" | "user" | "assistant_start" | "assistant_token" | "assistant_end"
    | "step" | "error" | "info" | "permission_request" | "plan_proposal"
    | "session_loaded" | "analytics" | "edits_summary" | "handoff";
  payload?: unknown;
}

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB per image
const MAX_TOTAL_IMAGES = 6;
const MAX_HANDOFFS = 4;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "nimAgent.chatView";
  private view?: vscode.WebviewView;
  private currentAbort?: AbortController;
  private autoPermit = false;
  private planMode = false;
  private attachedFiles = new Set<string>();
  private attachedImages: AttachedImage[] = [];
  private lastProposedCode?: string;
  private permissionResolver?: (allowed: boolean) => void;
  private editTracker = new EditTracker();
  private workspaceRules: string[] = [];

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
    void this.refreshRules();
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
        attachedImages: this.attachedImages.map(i => ({ id: i.id, name: i.name, size: i.size })),
        pinnedFiles: this.store.contextManager.getAll().map(f => f.path),
        sessions: this.store.historyManager.getSessions().map(s => ({ id: s.id, title: s.title })),
        currentSessionId: this.store.historyManager.getCurrentSessionId(),
        workspaceRules: this.workspaceRules
      }
    });
  }

  isPlanMode(): boolean { return this.planMode; }
  isAutoPermit(): boolean { return this.autoPermit; }

  private async refreshRules(): Promise<void> {
    try { this.workspaceRules = await this.store.rulesLoader.listLoaded(); }
    catch { this.workspaceRules = []; }
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.refreshRules();
        this.refreshState();
        return;
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

      // ----- Image input -----
      case "attachImage":
        this.attachImageFromWebview(msg.imageDataUrl, msg.imageName);
        return;
      case "detachImage":
        if (msg.imageId) {
          this.attachedImages = this.attachedImages.filter(i => i.id !== msg.imageId);
          this.refreshState();
        }
        return;
      case "pickImage":
        await this.attachImageFromPicker();
        return;

      // ----- Multi-file diff review -----
      case "openEditDiff":
        if (msg.path) {
          const ok = await this.editTracker.showDiff(msg.path);
          if (!ok) this.post({ type: "info", payload: `No tracked changes for ${msg.path}` });
        }
        return;
      case "revertEdit":
        if (msg.path) {
          const ok = await this.editTracker.revert(msg.path);
          this.post({ type: "info", payload: ok ? `Reverted ${msg.path}` : `Failed to revert ${msg.path}` });
          this.postEditsSummary();
        }
        return;
      case "revertAllEdits": {
        const records = this.editTracker.list();
        let n = 0;
        for (const r of records) {
          if (await this.editTracker.revert(r.path)) n++;
        }
        this.post({ type: "info", payload: `Reverted ${n} file${n === 1 ? "" : "s"}` });
        this.postEditsSummary();
        return;
      }

      // ----- Workspace rules -----
      case "openRulesFile":
        await this.openRulesFile(msg.text);
        return;
      case "createRulesFile":
        await this.createRulesFile();
        return;

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
    // Reset edit tracker for this user-prompt cycle (covers handoffs too).
    this.editTracker.clear();

    // Snapshot + clear attached images: they apply to this single send.
    const imagesForRun: AgentImageInput[] = this.attachedImages.map(i => ({ url: i.url }));
    const userImagesPayload = this.attachedImages.map(i => ({ id: i.id, name: i.name }));
    this.attachedImages = [];

    await this.store.historyManager.appendMessage({ role: "user", content: prompt });
    this.post({ type: "user", payload: { text: prompt, images: userImagesPayload } });

    let role: AgentRole = agentRole || "chat";
    let currentPrompt = prompt;
    let currentImages: AgentImageInput[] | undefined = imagesForRun.length > 0 ? imagesForRun : undefined;
    let handoffCount = 0;
    const visited = new Set<AgentRole>();

    while (true) {
      visited.add(role);
      const agent = this.store.agentRegistry.get(role);
      this.post({ type: "assistant_start", payload: { agent: role } });
      this.currentAbort = new AbortController();

      try {
        const result = await agent.run({
          prompt: currentPrompt,
          images: currentImages,
          context: await collectEditorContext(Array.from(this.attachedFiles)),
          planMode: this.planMode,
          signal: this.currentAbort.signal,
          onToken: t => this.post({ type: "assistant_token", payload: t }),
          onStep: s => this.handleAgentStep(s),
          onPermissionRequest: async (tool, input) => {
            if (this.autoPermit) return true;
            this.post({ type: "permission_request", payload: { tool, input } });
            return new Promise(res => this.permissionResolver = res);
          }
        });

        const handoff = this.parseHandoff(result.content);
        const displayContent = this.sanitizeForDisplay(result.content);

        await this.store.historyManager.appendMessage({ role: "assistant", content: displayContent });
        this.post({ type: "assistant_end", payload: { content: displayContent, agent: role } });

        if (handoff && handoffCount < MAX_HANDOFFS && !visited.has(handoff.to)) {
          handoffCount++;
          const nextRole = handoff.to;
          this.post({ type: "handoff", payload: { from: role, to: nextRole, reason: handoff.reason } });
          this.post({ type: "info", payload: `Handing off from ${role} to ${nextRole}: ${handoff.reason}` });
          role = nextRole;
          currentPrompt = handoff.followUp && handoff.followUp.trim().length > 0
            ? handoff.followUp
            : `Continue the user's task. Reason for handoff from previous agent: ${handoff.reason}\n\nOriginal user request:\n${prompt}`;
          currentImages = undefined; // images already provided to first agent in this run
          continue;
        }
        break;
      } catch (err) {
        this.post({ type: "error", payload: String(err) });
        break;
      }
    }

    this.postEditsSummary();
    this.refreshState();
  }

  private handleAgentStep(s: { type: string; name?: string; payload: string }): void {
    if (s.type === "tool_call" && EditTracker.isWriteTool(s.name)) {
      try { this.editTracker.onToolCall(s.name!, s.payload); } catch { /* ignore */ }
    }
    if (s.type === "tool_result" && EditTracker.isWriteTool(s.name)) {
      try { this.editTracker.onToolResult(s.name!); } catch { /* ignore */ }
    }
    if (s.type === "tool_call" && (s.name === "write_file" || s.name === "replace_file_content" || s.name === "multi_replace_file_content")) {
      try {
        const input = JSON.parse(s.payload);
        if (input.content || input.replacementContent) this.lastProposedCode = input.content || input.replacementContent;
      } catch { /* ignore */ }
    }
    this.post({ type: "step", payload: s });
  }

  private postEditsSummary(): void {
    const edits = this.editTracker.list();
    this.post({
      type: "edits_summary",
      payload: {
        edits: edits.map(e => ({
          path: e.path,
          added: e.added,
          removed: e.removed,
          created: e.created
        }))
      }
    });
  }

  private parseHandoff(text: string): { to: AgentRole; reason: string; followUp?: string } | undefined {
    if (!text) return undefined;
    const idx = text.indexOf(HANDOFF_MARKER);
    if (idx < 0) return undefined;
    const tail = text.slice(idx + HANDOFF_MARKER.length).trim();
    // Find the first balanced JSON object starting at `tail`.
    const jsonEnd = tail.indexOf("}");
    if (jsonEnd < 0) return undefined;
    const jsonStr = tail.slice(0, jsonEnd + 1);
    try {
      const obj = JSON.parse(jsonStr);
      const to = String(obj.to || "").toLowerCase();
      if (!VALID_HANDOFF_ROLES.includes(to as (typeof VALID_HANDOFF_ROLES)[number])) return undefined;
      return {
        to: to as AgentRole,
        reason: String(obj.reason || ""),
        followUp: typeof obj.followUp === "string" ? obj.followUp : undefined
      };
    } catch {
      return undefined;
    }
  }

  private sanitizeForDisplay(text: string): string {
    if (!text) return text;
    const idx = text.indexOf(HANDOFF_MARKER);
    if (idx < 0) return text;
    return text.slice(0, idx).trim();
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

  // --- Image attachments -----------------------------------------------------

  private attachImageFromWebview(dataUrl: string | undefined, name: string | undefined): void {
    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
      this.post({ type: "error", payload: "Attached image must be a data: URL of an image." });
      return;
    }
    const sizeBytes = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
    if (sizeBytes > MAX_IMAGE_BYTES) {
      this.post({ type: "error", payload: `Image too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB).` });
      return;
    }
    if (this.attachedImages.length >= MAX_TOTAL_IMAGES) {
      this.post({ type: "error", payload: `Maximum ${MAX_TOTAL_IMAGES} images per message.` });
      return;
    }
    const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.attachedImages.push({
      id,
      url: dataUrl,
      name: (name && name.trim()) || `pasted-image-${this.attachedImages.length + 1}.png`,
      size: sizeBytes
    });
    this.refreshState();
  }

  private async attachImageFromPicker(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    const root = folders && folders.length > 0 ? folders[0] : undefined;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: root?.uri,
      openLabel: "Attach image to NIM Agent",
      title: "Attach image(s)",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] }
    });
    if (!picked || picked.length === 0) return;
    for (const uri of picked) {
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        const ext = path.extname(uri.fsPath).slice(1).toLowerCase() || "png";
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        const dataUrl = `data:${mime};base64,${Buffer.from(data).toString("base64")}`;
        this.attachImageFromWebview(dataUrl, path.basename(uri.fsPath));
      } catch (err) {
        this.post({ type: "error", payload: `Failed to attach ${uri.fsPath}: ${String(err)}` });
      }
    }
  }

  // --- Workspace rules helpers -----------------------------------------------

  private async openRulesFile(name?: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.post({ type: "error", payload: "Open a workspace folder first." });
      return;
    }
    const target = name || this.workspaceRules[0] || "AGENTS.md";
    const uri = vscode.Uri.joinPath(folders[0].uri, target);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      // File doesn't exist yet — let createRulesFile handle it
      await this.createRulesFile(target);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async createRulesFile(name: string = "AGENTS.md"): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.post({ type: "error", payload: "Open a workspace folder first." });
      return;
    }
    const uri = vscode.Uri.joinPath(folders[0].uri, name);
    let exists = false;
    try { await vscode.workspace.fs.stat(uri); exists = true; } catch { /* ignore */ }
    if (!exists) {
      const template = `# Workspace Rules for NIM Agent\n\n` +
        `These instructions are automatically injected into every agent prompt.\n` +
        `Edit them to teach the agent project-specific conventions.\n\n` +
        `## Coding conventions\n- (e.g. Use TypeScript strict mode; prefer named exports.)\n\n` +
        `## Architecture\n- (Describe the project layout, key folders.)\n\n` +
        `## Do / Don't\n- DO ask before destructive shell commands.\n- DON'T add new top-level dependencies without confirmation.\n`;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(template, "utf8"));
      this.post({ type: "info", payload: `Created ${name}` });
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await this.refreshRules();
    this.refreshState();
  }

  private defaultAgent(): AgentRole { return vscode.workspace.getConfiguration("nimAgent").get("defaultAgent", "chat") as AgentRole; }
  private safeActiveModel(): string | undefined { try { return this.store.modelManager.getActive(); } catch { return undefined; } }
  private post(msg: OutboundMessage): void { this.view?.webview.postMessage(msg); }

  private renderHtml(webview: vscode.Webview): string {
    return renderChatHtml(webview);
  }
}
