import * as vscode from "vscode";
import { STYLES } from "./styles";
import { buildScript } from "./script";

/** Generate a CSP nonce. */
function generateNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let r = "";
  for (let i = 0; i < 32; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
  return r;
}

/**
 * Render the full webview HTML for the chat sidebar.
 *
 * The shell is broken into clearly-labeled regions (header / log / composer /
 * overlays) so the client script can target each area as a small "component".
 */
export function renderChatHtml(webview: vscode.Webview): string {
  const nonce = generateNonce();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};`;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>NIM Agent</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="app">

    <!-- ============ HEADER ============ -->
    <header class="header">
      <div class="header-row">
        <div class="brand">
          <span class="brand-dot"></span>
          <span>NIM Agent</span>
        </div>
        <div class="spacer"></div>
        <button id="newChatBtn" class="icon-btn" title="New chat" aria-label="New chat">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
        </button>
        <button id="historyBtn" class="icon-btn" title="History" aria-label="History">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>
        </button>
        <button id="analyticsBtn" class="icon-btn" title="Analytics" aria-label="Analytics">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 13V7M7 13V4M11 13v-4M13 13H3"/></svg>
        </button>
        <button id="reviewBtn" class="icon-btn" title="Review active file" aria-label="Review file">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2 3 4v4c0 3 2.5 5 5 6 2.5-1 5-3 5-6V4Z"/></svg>
        </button>
        <button id="clearBtn" class="icon-btn" title="Clear all history" aria-label="Clear history">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4l1 9a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l1-9"/></svg>
        </button>
      </div>

      <div class="selector-row">
        <span class="select-wrap"><select id="agentSel" aria-label="Agent"></select></span>
        <span class="dot-sep"></span>
        <span class="select-wrap"><select id="modelSel" aria-label="Model"></select></span>
        <div class="spacer"></div>
        <button id="planBtn" class="icon-btn" title="Plan-only mode" aria-label="Plan mode" style="width:auto; padding:0 8px; font-size: var(--sz-xs); font-weight:600; letter-spacing:.04em;">PLAN</button>
        <button id="autoBtn" class="icon-btn" title="Auto-approve tool use" aria-label="Auto-permit" style="width:auto; padding:0 8px; font-size: var(--sz-xs); font-weight:600; letter-spacing:.04em;">AUTO</button>
      </div>
    </header>

    <!-- ============ LOG ============ -->
    <main id="log" class="log" aria-live="polite"></main>

    <!-- ============ COMPOSER ============ -->
    <footer class="composer">
      <div id="pinnedFiles" class="attached-files" aria-label="Pinned files"></div>
      <div id="attachedFiles" class="attached-files" aria-label="Attached files"></div>

      <div class="input-shell">
        <textarea id="input" class="input" rows="1" placeholder="Ask NIM Agent\u2026" aria-label="Message"></textarea>
      </div>

      <div class="composer-row">
        <button id="attachBtn" class="icon-btn" title="Attach files to context" aria-label="Attach files">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 7 7 11.5a2.5 2.5 0 1 1-3.5-3.5l5-5a3.5 3.5 0 1 1 5 5L8 13.5"/></svg>
        </button>
        <div id="status" class="status" data-state="idle">
          <span class="status-dot"></span>
          <span class="status-text"></span>
        </div>
        <span class="kbd-hint"><span class="kbd">Enter</span>send <span class="kbd">\u21E7\u21B5</span>newline</span>
        <div class="send-row">
          <button id="cancelBtn" class="btn danger" style="display:none">Stop</button>
          <button id="sendBtn" class="btn">Send</button>
        </div>
      </div>
    </footer>

    <!-- ============ OVERLAYS ============ -->
    <section id="historyOverlay" class="overlay" role="dialog" aria-label="Past chats">
      <div class="overlay-header">
        <span>Past chats</span>
        <button class="icon-btn overlay-close" aria-label="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div id="historyList" class="overlay-content"></div>
    </section>

    <section id="analyticsOverlay" class="overlay" role="dialog" aria-label="Analytics">
      <div class="overlay-header">
        <span>Analytics</span>
        <button class="icon-btn overlay-close" aria-label="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div id="analyticsContent" class="overlay-content"></div>
    </section>

  </div>

  <script nonce="${nonce}">${buildScript()}</script>
</body>
</html>`;
}
