import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ExtensionContextStore } from "../../utils/context";
import type { AgentRole } from "../../core/agent/BaseAgent";
import { collectEditorContext } from "../chat/contextCollector";

interface InboundMessage {
  type:
    | "ready" | "send" | "cancel" | "selectAgent" | "selectModel" | "clearMemory"
    | "openSettings" | "addKey" | "permissionResponse" | "planApproval"
    | "toggleAutoPermit" | "togglePlanMode" | "reviewFile" | "attachFile"
    | "detachFile" | "pinFile" | "unpinFile" | "applyCode" | "commitChanges" | "diffReview"
    | "newChat" | "loadSession";
  text?: string; agent?: AgentRole; model?: string; allowed?: boolean;
  approved?: boolean; path?: string; code?: string; sessionId?: string;
}

interface OutboundMessage {
  type:
    | "state" | "user" | "assistant_start" | "assistant_token" | "assistant_end"
    | "step" | "error" | "info" | "permission_request" | "plan_proposal" | "session_loaded";
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

  private defaultAgent(): AgentRole { return vscode.workspace.getConfiguration("nimAgent").get("defaultAgent", "chat") as AgentRole; }
  private safeActiveModel(): string | undefined { try { return this.store.modelManager.getActive(); } catch { return undefined; } }
  private post(msg: OutboundMessage): void { this.view?.webview.postMessage(msg); }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = generateNonce();
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};"><style>
      :root { --radius: 8px; --accent: var(--vscode-button-background); --glass-bg: rgba(30,30,30,0.4); --glass-border: rgba(255,255,255,0.06); }
      body { height: 100vh; margin: 0; display: flex; flex-direction: column; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); overflow: hidden; }
      .toolbar { display: flex; gap: 6px; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); align-items: center; }
      select, button { font-size: 11px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-dropdown-background); color: var(--vscode-foreground); }
      button { background: var(--accent); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; font-weight: 600; }
      button.ghost { background: transparent; opacity: 0.7; }
      button.secondary { background: rgba(255,255,255,0.05); }
      button.active { background: var(--accent); box-shadow: 0 0 10px var(--accent); opacity: 1; }
      #log { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 32px; scroll-behavior: smooth; }
      .msg { border-left: 2px solid transparent; padding-left: 16px; }
      .msg.user { border-left-color: var(--vscode-charts-blue); }
      .msg.assistant { border-top: 1px solid var(--glass-border); padding-top: 24px; }
      .who { font-size: 10px; font-weight: 800; text-transform: uppercase; margin-bottom: 12px; opacity: 0.5; }
      .body { font-size: 13px; line-height: 1.6; }
      .code-block { margin: 16px 0; border: 1px solid var(--glass-border); border-radius: 10px; overflow: hidden; background: #000; }
      .code-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; background: rgba(255,255,255,0.04); font-size: 10px; }
      pre { margin: 0; padding: 16px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; }
      .diff-add { background: rgba(40,167,69,0.2); color: #acf2bd; display: block; } .diff-del { background: rgba(220,53,69,0.2); color: #f85149; text-decoration: line-through; display: block; }
      .stats { display: flex; gap: 12px; margin-top: 12px; font-size: 11px; font-weight: 700; }
      .add { color: #2ecc71; } .del { color: #e74c3c; }
      .activity-block { margin: 16px 0; border: 1px solid var(--glass-border); border-radius: 12px; background: var(--glass-bg); }
      .activity-header { display: flex; align-items: center; gap: 10px; padding: 12px; cursor: pointer; }
      .activity-title { flex: 1; font-size: 12px; font-weight: 600; }
      .activity-chevron { transition: transform 0.2s; opacity: 0.5; }
      .activity-block.collapsed .activity-chevron { transform: rotate(-90deg); }
      .activity-block.collapsed .steps-container { display: none; }
      .steps-container { padding: 4px 12px 12px 12px; border-top: 1px solid var(--glass-border); }
      .step-group { margin-top: 10px; padding-left: 14px; border-left: 1px dashed var(--glass-border); }
      .step-header { display: flex; align-items: center; gap: 8px; font-size: 11px; }
      .step-status { color: #2ecc71; font-weight: 800; font-size: 10px; }
      .step-body { margin-top: 4px; font-size: 10px; opacity: 0.6; font-family: var(--vscode-editor-font-family); background: rgba(0,0,0,0.1); padding: 2px 4px; border-radius: 4px; }
      .perm-request { background: var(--vscode-editor-findMatchHighlightBackground); border: 1px solid var(--vscode-inputOption-activeBorder); border-radius: 8px; padding: 12px; margin: 12px 0; }
      .chip { display: inline-flex; align-items: center; gap: 6px; background: rgba(0,0,0,0.2); padding: 3px 10px; border-radius: 16px; font-size: 10px; margin: 3px; border: 1px solid var(--glass-border); }
      .history-overlay { position: absolute; top: 50px; left: 10px; right: 10px; bottom: 80px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 12px; z-index: 100; display: none; flex-direction: column; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
      .history-header { padding: 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 800; font-size: 12px; display: flex; justify-content: space-between; align-items: center; }
      .history-list { flex: 1; overflow-y: auto; padding: 8px; }
      .history-item { padding: 10px; border-radius: 6px; cursor: pointer; font-size: 12px; margin-bottom: 4px; border: 1px solid transparent; }
      .history-item:hover { background: rgba(255,255,255,0.05); }
      .history-item.active { border-color: var(--accent); background: rgba(255,255,255,0.03); }
      .composer { padding: 16px; border-top: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 12px; }
      textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 12px; border-radius: 8px; resize: none; min-height: 50px; font-family: inherit; }
    </style></head><body>
      <div class="toolbar">
        <button id="historyBtn" class="ghost" title="History">📜</button>
        <button id="newChatBtn" class="ghost" title="New Chat">➕</button>
        <div style="flex:1"></div>
        <button id="planBtn" class="ghost" title="Plan Mode">Plan</button>
        <button id="autoBtn" class="ghost" title="Auto-permit">Auto</button>
        <button id="reviewBtn" class="ghost" title="Review File">🛡️</button>
        <button id="clearBtn" class="ghost" title="Clear All History">🗑️</button>
        <select id="agentSel" style="width:70px"></select>
        <select id="modelSel" style="width:100px"></select>
      </div>
      <div id="log"></div>
      <div id="historyOverlay" class="history-overlay">
        <div class="history-header"><span>Past Chats</span><span id="closeHistory" style="cursor:pointer">×</span></div>
        <div id="historyList" class="history-list"></div>
      </div>
      <div id="contextBank" style="display:none"><div id="pinnedList" style="padding:0 10px;"></div></div>
      <div id="contextBar" style="padding:4px 12px;"></div>
      <div class="composer">
        <textarea id="input" placeholder="Ask NIM Agent..."></textarea>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div id="status" style="font-size:10px; opacity:0.6;"></div>
          <div style="display:flex; gap:8px;">
            <button id="cancelBtn" class="secondary" style="display:none; background:var(--vscode-errorForeground);">Stop</button>
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
        const historyBtn = document.getElementById('historyBtn');
        const newChatBtn = document.getElementById('newChatBtn');
        const planBtn = document.getElementById('planBtn');
        const autoBtn = document.getElementById('autoBtn');
        const reviewBtn = document.getElementById('reviewBtn');
        const clearBtn = document.getElementById('clearBtn');
        const historyOverlay = document.getElementById('historyOverlay');
        const historyList = document.getElementById('historyList');
        const closeHistory = document.getElementById('closeHistory');
        const status = document.getElementById('status');
        
        let hasEdits = false, activeBubble = null, activeSteps = null, lastTool = null, streamingState = { isJson: false, jsonBuffer: '', isFinal: false, finalExtracted: '' };

        const utob = (s) => btoa(unescape(encodeURIComponent(s)));
        const btou = (s) => decodeURIComponent(escape(atob(s)));

        function format(text) {
          if (!text) return '';
          let h = text.replace(/\\{[\\s\\S]*?"tool"\\s*:\\s*"[\\s\\S]*?\\}/g, '');
          h = h.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const f = String.fromCharCode(96).repeat(3);
          const re = new RegExp(f + '(\\\\w*)\\\\n([\\\\s\\\\S]*?)' + f, 'g');
          let adds = 0, dels = 0;
          h = h.replace(re, (m, l, c) => {
            const lines = c.split('\\n').map(ln => {
              if (ln.startsWith('+')) { adds++; return '<div class="diff-add">'+ln+'</div>'; }
              if (ln.startsWith('-')) { dels++; return '<div class="diff-del">'+ln+'</div>'; }
              return '<div>'+ln+'</div>';
            }).join('');
            return '<div class="code-block"><div class="code-header"><span>'+(l||'code')+'</span><button class="apply-btn" data-code="'+utob(c)+'">Apply</button></div><pre>'+lines+'</pre></div>';
          });
          const stats = (adds || dels) ? '<div class="stats"><span class="add">+'+adds+'</span> <span class="del">-'+dels+'</span></div>' : '';
          return h.replace(/Thought:/g, '<strong>Thought:</strong>').replace(/Plan:/g, '<strong>Plan:</strong>').replace(/^\\s*\\*\\s+(.*)$/gm, '• $1').replace(/\\n/g, '<br>') + stats;
        }

        function renderMessage(role, content) {
          const d = document.createElement('div'); d.className = 'msg ' + role;
          d.innerHTML = '<div class="who">'+(role==='user'?'You':role)+'</div><div class="body">'+format(content)+'</div>';
          log.appendChild(d);
        }

        document.addEventListener('click', e => {
          const t = e.target.closest('.apply-btn, .review-btn, [data-action], .activity-header, .perm-btn, .history-item');
          if (!t) return;
          if (t.classList.contains('apply-btn')) vscode.postMessage({ type: 'applyCode', code: btou(t.dataset.code) });
          else if (t.classList.contains('review-btn')) vscode.postMessage({ type: 'diffReview' });
          else if (t.classList.contains('history-item')) { vscode.postMessage({ type: 'loadSession', sessionId: t.dataset.id }); historyOverlay.style.display = 'none'; }
          else if (t.classList.contains('perm-btn')) { vscode.postMessage({ type: 'permissionResponse', allowed: t.dataset.allow === 'true' }); t.parentElement.innerHTML = '<i>' + (t.dataset.allow === 'true' ? 'Allowed' : 'Denied') + '</i>'; }
          else if (t.dataset.action === 'pin') vscode.postMessage({ type: 'pinFile', path: t.dataset.path });
          else if (t.dataset.action === 'unpin') vscode.postMessage({ type: 'unpinFile', path: t.dataset.path });
          else if (t.dataset.action === 'detach') vscode.postMessage({ type: 'detachFile', path: t.dataset.path });
          else if (t.classList.contains('activity-header')) t.parentElement.classList.toggle('collapsed');
        });

        sendBtn.onclick = () => { const t = input.value.trim(); if (t) { vscode.postMessage({ type: 'send', text: t, agent: agentSel.value, model: modelSel.value }); input.value = ''; } };
        historyBtn.onclick = () => { historyOverlay.style.display = historyOverlay.style.display === 'flex' ? 'none' : 'flex'; };
        newChatBtn.onclick = () => vscode.postMessage({ type: 'newChat' });
        planBtn.onclick = () => vscode.postMessage({ type: 'togglePlanMode' });
        autoBtn.onclick = () => vscode.postMessage({ type: 'toggleAutoPermit' });
        reviewBtn.onclick = () => vscode.postMessage({ type: 'reviewFile' });
        clearBtn.onclick = () => { if (confirm('Clear ALL history?')) vscode.postMessage({ type: 'clearMemory' }); };
        closeHistory.onclick = () => historyOverlay.style.display = 'none';
        cancelBtn.onclick = () => vscode.postMessage({ type: 'cancel' });
        input.onkeydown = e => { if (e.ctrlKey && e.key === 'Enter') sendBtn.click(); };

        window.addEventListener('message', e => {
          const m = e.data;
          if (m.type === 'state') {
            agentSel.innerHTML = m.payload.agents.map(a => '<option value="'+a.role+'"'+(a.role===m.payload.activeAgent?' selected':'')+'>'+a.label+'</option>').join('');
            modelSel.innerHTML = m.payload.models.map(m2 => '<option value="'+m2.name+'"'+(m2.name===m.payload.activeModel?' selected':'')+'>'+m2.name+'</option>').join('');
            planBtn.className = m.payload.planMode ? 'active' : 'ghost';
            autoBtn.className = m.payload.autoPermit ? 'active' : 'ghost';
            contextBar.innerHTML = m.payload.attachedFiles.map(p => '<div class="chip"><span>'+p+'</span><span data-action="pin" data-path="'+p+'">📌</span><span data-action="detach" data-path="'+p+'">×</span></div>').join('');
            pinnedList.innerHTML = m.payload.pinnedFiles.map(p => '<div class="chip"><span>'+p+'</span><span data-action="unpin" data-path="'+p+'">×</span></div>').join('');
            document.getElementById('contextBank').style.display = m.payload.pinnedFiles.length ? 'block' : 'none';
            historyList.innerHTML = m.payload.sessions.map(s => '<div class="history-item'+(s.id===m.payload.currentSessionId?' active':'')+'" data-id="'+s.id+'">'+s.title+'</div>').join('');
          } else if (m.type === 'session_loaded') {
            log.innerHTML = ''; const msgs = m.payload.messages || []; msgs.forEach(msg => renderMessage(msg.role, msg.content)); log.scrollTop = log.scrollHeight;
          } else if (m.type === 'user') {
            renderMessage('user', m.payload); log.scrollTop = log.scrollHeight;
          } else if (m.type === 'assistant_start') {
            const d = document.createElement('div'); d.className = 'msg assistant';
            d.innerHTML = '<div class="who">'+m.payload.agent+'</div><div class="body"></div><div class="activity-block collapsed" style="display:none"><div class="activity-header"><span class="activity-icon">⚙️</span><span class="activity-title">Activity Details</span><span class="activity-chevron">▼</span></div><div class="steps-container"></div></div>';
            log.appendChild(d); activeBubble = d.querySelector('.body'); activeSteps = d.querySelector('.steps-container'); streamingState = { isJson: false, jsonBuffer: '', isFinal: false, finalExtracted: '' }; hasEdits = false; cancelBtn.style.display = 'block'; status.textContent = 'Thinking...';
          } else if (m.type === 'assistant_token') {
            status.textContent = 'Typing...'; const token = m.payload; const fence = String.fromCharCode(96).repeat(3); streamingState.jsonBuffer += token;
            if (!streamingState.isJson && (streamingState.jsonBuffer.includes(fence + 'json') || streamingState.jsonBuffer.includes('{"tool"'))) {
              streamingState.isJson = true; const r = new RegExp('(' + fence + 'json|\\\\{"tool").*$'); activeBubble.textContent = activeBubble.textContent.replace(r, '').trim();
            }
            if (streamingState.isJson) {
              if (!streamingState.isFinal && streamingState.jsonBuffer.includes('"final"')) streamingState.isFinal = true;
              if (streamingState.isFinal) {
                const match = streamingState.jsonBuffer.match(/"final":\\s*"([^"]*)/);
                if (match && match[1]) { const newContent = match[1].replace(/\\\\n/g, '\\n'); const delta = newContent.slice(streamingState.finalExtracted.length); if (delta) { activeBubble.textContent += delta; streamingState.finalExtracted = newContent; } }
              }
            } else { activeBubble.textContent += token; }
            log.scrollTop = log.scrollHeight;
          } else if (m.type === 'assistant_end') {
            cancelBtn.style.display = 'none'; status.textContent = ''; if (activeBubble) activeBubble.innerHTML = format(m.payload.content);
            if (hasEdits) {
              const row = document.createElement('div'); row.style.display = 'flex'; row.style.gap = '8px'; row.style.marginTop = '16px';
              const b1 = document.createElement('button'); b1.textContent = 'Review Changes'; b1.className = 'review-btn';
              const b2 = document.createElement('button'); b2.textContent = 'Commit'; b2.className = 'secondary';
              b2.onclick = () => { const msg = prompt('Msg:','feat: update'); if (msg) vscode.postMessage({ type: 'commitChanges', text: msg }); };
              row.appendChild(b1); row.appendChild(b2); activeBubble.appendChild(row);
            }
          } else if (m.type === 'permission_request') {
            const d = document.createElement('div'); d.className = 'perm-request';
            d.innerHTML = '<div style="font-weight:700; margin-bottom:8px;">Permission Required</div><div style="font-size:11px; opacity:0.8; margin-bottom:12px;">Use <b>'+m.payload.tool+'</b> with:<br><pre style="background:rgba(0,0,0,0.1); padding:6px; margin-top:4px;">'+JSON.stringify(m.payload.input, null, 2)+'</pre></div><div style="display:flex; gap:8px;"><button class="perm-btn" data-allow="true">Allow</button><button class="perm-btn secondary" data-allow="false" style="background:var(--vscode-errorForeground);">Deny</button></div>';
            log.appendChild(d); log.scrollTop = log.scrollHeight;
          } else if (m.type === 'step') {
            const s = m.payload; if (s.type === 'tool_call') {
              status.textContent = 'Running tool...'; activeSteps.parentElement.style.display = 'block';
              const g = document.createElement('div'); g.className = 'step-group'; g.innerHTML = '<div class="step-header"><span>🔧</span><span>'+s.name+'</span><span class="step-status">...</span></div><div class="step-body"></div>';
              activeSteps.appendChild(g); lastTool = g; if (s.name === 'write_file' || s.name === 'replace_file_content' || s.name === 'multi_replace_file_content') hasEdits = true;
            } else if (s.type === 'tool_result' && lastTool) {
              status.textContent = 'Thinking...'; lastTool.querySelector('.step-status').textContent = ' ✓ done';
              let out = String(s.payload); if (s.name === 'read_file') { const lines = out.split('\\n').length; out = 'Read ' + lines + ' lines'; } else if (out.length > 100) out = out.substring(0, 100) + '...';
              lastTool.querySelector('.step-body').textContent = out;
            }
          } else if (m.type === 'info') { status.textContent = m.payload; setTimeout(() => status.textContent = '', 3000); }
          else if (m.type === 'error') { status.textContent = ''; const d = document.createElement('div'); d.style.color = 'var(--vscode-errorForeground)'; d.textContent = 'Error: ' + m.payload; log.appendChild(d); }
        });
        vscode.postMessage({ type: 'ready' });
      </script></body></html>`;
  }
}
function generateNonce() { let r = ""; const c = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; for (let i = 0; i < 32; i++) r += c.charAt(Math.floor(Math.random() * c.length)); return r; }
