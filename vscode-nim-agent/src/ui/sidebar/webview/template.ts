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
        <button id="rulesBtn" class="icon-btn rules-btn" title="Workspace rules" aria-label="Workspace rules" style="width:auto; padding:0 8px; font-size: var(--sz-xs); font-weight:600; letter-spacing:.04em;">RULES</button>
        <button id="designBtn" class="icon-btn design-btn" title="Generate UI design (Figma-style)" aria-label="Design UI" style="width:auto; padding:0 8px; font-size: var(--sz-xs); font-weight:600; letter-spacing:.04em;">DESIGN UI</button>
        <button id="builderBtn" class="icon-btn builder-btn" title="Smart feature builder (multi-agent)" aria-label="Smart builder" style="width:auto; padding:0 8px; font-size: var(--sz-xs); font-weight:600; letter-spacing:.04em;">BUILD</button>
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
      <div id="attachedImages" class="attached-images" aria-label="Attached images"></div>

      <div class="input-shell">
        <textarea id="input" class="input" rows="1" placeholder="Ask NIM Agent — paste an image, drop files, or type\u2026" aria-label="Message"></textarea>
        <input type="file" id="imageFileInput" accept="image/*" multiple style="display:none" />
      </div>

      <div class="composer-row">
        <button id="attachBtn" class="icon-btn" title="Attach files to context" aria-label="Attach files">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 7 7 11.5a2.5 2.5 0 1 1-3.5-3.5l5-5a3.5 3.5 0 1 1 5 5L8 13.5"/></svg>
        </button>
        <button id="imageBtn" class="icon-btn" title="Attach image / screenshot" aria-label="Attach image">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="M2 11l3.5-3.5 3 3 2-2L14 11"/></svg>
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

    <section id="designOverlay" class="overlay" role="dialog" aria-label="UI Designer">
      <div class="overlay-header">
        <span><span class="design-badge">UI Designer</span> Generate a Figma-style design</span>
        <button class="icon-btn overlay-close" aria-label="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div id="designContent" class="overlay-content">
        <form id="designForm" class="design-form" autocomplete="off">
          <label class="field">
            <span class="field-label">App type</span>
            <select id="designAppType" class="field-input">
              <option value="web">Web app</option>
              <option value="mobile">Mobile app</option>
              <option value="dashboard">Dashboard</option>
              <option value="saas" selected>SaaS</option>
              <option value="landing">Landing page</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Visual style</span>
            <select id="designStyle" class="field-input">
              <option value="modern" selected>Modern</option>
              <option value="minimal">Minimal</option>
              <option value="dark">Dark</option>
              <option value="playful">Playful</option>
              <option value="corporate">Corporate</option>
              <option value="brutalist">Brutalist</option>
              <option value="glassmorphism">Glassmorphism</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Required features (one per line)</span>
            <textarea id="designFeatures" class="field-input" rows="5" placeholder="Auth & onboarding\nProject dashboard with charts\nBilling & plan upgrade\nTeam settings"></textarea>
          </label>
          <label class="field">
            <span class="field-label">Notes (optional)</span>
            <input id="designNotes" type="text" class="field-input" placeholder="Audience, brand vibe, must-have screens\u2026" />
          </label>
          <label class="field field-inline">
            <span class="field-label">Variations</span>
            <select id="designVariations" class="field-input compact">
              <option value="1" selected>1 design</option>
              <option value="2">2 designs</option>
              <option value="3">3 designs</option>
            </select>
          </label>
          <div class="design-actions">
            <button type="button" class="btn secondary overlay-close">Cancel</button>
            <button type="submit" id="designSubmitBtn" class="btn">Generate</button>
          </div>
        </form>

        <div id="designProgress" class="design-progress" style="display:none">
          <span class="spinner"></span>
          <span id="designProgressMsg">Generating design\u2026</span>
        </div>

        <div id="designError" class="design-error" style="display:none"></div>

        <div id="designResult" class="design-result" style="display:none">
          <div class="design-result-tabs">
            <button class="tab-btn active" data-tab="visual">Visual</button>
            <button class="tab-btn" data-tab="tree">Component tree</button>
            <button class="tab-btn" data-tab="json">JSON</button>
            <span class="spacer"></span>
            <select id="designVariantSel" class="field-input compact" style="display:none"></select>
            <button id="designNewBtn" class="btn secondary" type="button">New design</button>
          </div>
          <div id="designTabVisual" class="design-tab"></div>
          <div id="designTabTree" class="design-tab" style="display:none"></div>
          <div id="designTabJson" class="design-tab" style="display:none"></div>
        </div>
      </div>
    </section>

    <section id="builderOverlay" class="overlay" role="dialog" aria-label="Smart Feature Builder">
      <div class="overlay-header">
        <span><span class="builder-badge">Smart Builder</span> Multi-agent feature builder</span>
        <button class="icon-btn overlay-close" aria-label="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div id="builderContent" class="overlay-content">
        <form id="builderForm" class="builder-form" autocomplete="off">
          <label class="field">
            <span class="field-label">What do you want to build?</span>
            <textarea id="builderPrompt" class="field-input" rows="4" placeholder="e.g. Add a login form with email + password validation, or build a dashboard with three stat cards"></textarea>
          </label>
          <div class="builder-mode-row">
            <span class="field-label">Mode</span>
            <div class="builder-mode-grid">
              <label class="builder-mode-card"><input type="radio" name="builderMode" value="auto" checked /><span class="bm-title">Auto</span><span class="bm-sub">Detect scope</span></label>
              <label class="builder-mode-card"><input type="radio" name="builderMode" value="quick" /><span class="bm-title">\u26A1 Quick Fix</span><span class="bm-sub">Coder only</span></label>
              <label class="builder-mode-card"><input type="radio" name="builderMode" value="build" /><span class="bm-title">\u{1F9E9} Build Feature</span><span class="bm-sub">Plan \u2192 Code \u2192 Wire</span></label>
              <label class="builder-mode-card"><input type="radio" name="builderMode" value="plan" /><span class="bm-title">\u{1F9E0} Plan First</span><span class="bm-sub">Full pipeline</span></label>
            </div>
          </div>
          <div class="builder-actions">
            <button type="button" class="btn secondary overlay-close">Cancel</button>
            <button type="submit" id="builderRunBtn" class="btn">Run</button>
          </div>
        </form>

        <div id="builderProgress" class="builder-progress" style="display:none">
          <div class="builder-status-row">
            <span class="spinner"></span>
            <span id="builderStatusText">Starting\u2026</span>
            <span class="spacer"></span>
            <button id="builderCancelBtn" class="btn danger" type="button">Stop</button>
          </div>
          <div id="builderScopeCard" class="builder-scope-card" style="display:none"></div>
          <div id="builderStepsList" class="builder-steps-list"></div>
          <div id="builderPlanBlock" class="builder-block" style="display:none"></div>
          <div id="builderArchBlock" class="builder-block" style="display:none"></div>
          <div id="builderReviewBlock" class="builder-block" style="display:none"></div>
        </div>

        <div id="builderError" class="builder-error" style="display:none"></div>

        <div id="builderResult" class="builder-result" style="display:none">
          <div class="builder-result-head">
            <div id="builderResultTitle" class="builder-result-title">Generated changes</div>
            <span class="spacer"></span>
            <button id="builderRestartBtn" class="btn secondary" type="button">New build</button>
            <button id="builderApplyBtn" class="btn primary" type="button">Apply all files</button>
          </div>
          <div id="builderFilesList" class="builder-files-list"></div>
        </div>
      </div>
    </section>

  </div>

  <script nonce="${nonce}">${buildScript()}</script>
</body>
</html>`;
}
