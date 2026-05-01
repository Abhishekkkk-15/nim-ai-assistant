/**
 * NIM Agent — Webview Stylesheet
 *
 * Design system inspired by Claude Code: minimal, dark-first, soft contrast,
 * 8px spacing grid, generous typography, subtle motion.
 */
export const STYLES = `
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --accent: var(--vscode-button-background);
  --accent-fg: var(--vscode-button-foreground);
  --bg: var(--vscode-sideBar-background);
  --bg-raised: color-mix(in srgb, var(--vscode-foreground) 4%, var(--bg));
  --bg-sunken: color-mix(in srgb, var(--vscode-foreground) 2%, var(--bg));
  --border: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
  --border-strong: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  --text: var(--vscode-foreground);
  --text-muted: color-mix(in srgb, var(--vscode-foreground) 60%, transparent);
  --text-faint: color-mix(in srgb, var(--vscode-foreground) 40%, transparent);
  --success: #2ecc71;
  --danger: var(--vscode-errorForeground, #e74c3c);
  --warning: #f5a524;
  --mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  --sans: var(--vscode-font-family);
  --sz-xs: 10px;
  --sz-sm: 11px;
  --sz-base: 13px;
  --sz-md: 14px;
  --duration: 180ms;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
}

* { box-sizing: border-box; }

html, body {
  height: 100vh;
  margin: 0;
  padding: 0;
  overflow: hidden;
  font-family: var(--sans);
  font-size: var(--sz-base);
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}

button {
  font-family: inherit;
  font-size: var(--sz-sm);
  cursor: pointer;
  border: none;
  background: transparent;
  color: inherit;
  padding: 0;
}

button:focus-visible,
select:focus-visible,
textarea:focus-visible,
[role="button"]:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}

/* ===========================
   App shell
   =========================== */
.app {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100vh;
  position: relative;
}

/* ===========================
   Header
   =========================== */
.header {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.header-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 600;
  font-size: var(--sz-base);
  letter-spacing: -0.01em;
}

.brand-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: linear-gradient(135deg, #76b900, #2ecc71);
  box-shadow: 0 0 8px rgba(118, 185, 0, 0.4);
}

.spacer { flex: 1; }

.icon-btn {
  width: 28px; height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition: background var(--duration) var(--ease), color var(--duration) var(--ease);
}
.icon-btn:hover { background: var(--bg-raised); color: var(--text); }
.icon-btn.active {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent-fg);
}

.icon-btn svg { width: 14px; height: 14px; }

.selector-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--sz-sm);
  color: var(--text-muted);
}

.select-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.selector-row select {
  appearance: none;
  -webkit-appearance: none;
  background: var(--bg-raised);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px 22px 4px 10px;
  font-size: var(--sz-sm);
  font-family: inherit;
  cursor: pointer;
  transition: border-color var(--duration) var(--ease);
}
.selector-row select:hover { border-color: var(--border-strong); }

.select-wrap::after {
  content: "";
  position: absolute;
  right: 8px;
  pointer-events: none;
  width: 6px; height: 6px;
  border-right: 1.5px solid var(--text-muted);
  border-bottom: 1.5px solid var(--text-muted);
  transform: translateY(-2px) rotate(45deg);
}

.dot-sep {
  width: 3px; height: 3px;
  border-radius: 50%;
  background: var(--text-faint);
}

/* ===========================
   Conversation log
   =========================== */
.log {
  overflow-y: auto;
  padding: var(--space-5) var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  scroll-behavior: smooth;
}

.log::-webkit-scrollbar { width: 8px; }
.log::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  border-radius: 8px;
}
.log::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--vscode-foreground) 24%, transparent);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-3);
  padding: var(--space-6) var(--space-4);
  color: var(--text-muted);
}
.empty-title {
  font-size: 15px;
  color: var(--text);
  font-weight: 600;
}
.empty-sub { font-size: var(--sz-sm); max-width: 240px; line-height: 1.5; }

/* ===========================
   Message
   =========================== */
.msg {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  animation: fadeUp 240ms var(--ease) both;
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.msg-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--sz-xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}

.role-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
  font-size: var(--sz-xs);
  color: var(--text-muted);
}
.role-pill.user {
  background: color-mix(in srgb, var(--vscode-charts-blue, #4ea1d3) 18%, transparent);
  color: var(--text);
}
.role-pill.assistant {
  background: color-mix(in srgb, #76b900 18%, transparent);
  color: var(--text);
}
.role-pill .role-glyph {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.7;
}

.msg-time { color: var(--text-faint); font-weight: 500; text-transform: none; }

.msg-body {
  font-size: var(--sz-base);
  line-height: 1.65;
  color: var(--text);
  word-wrap: break-word;
}

.msg-body p { margin: 0 0 var(--space-2); }
.msg-body p:last-child { margin-bottom: 0; }
.msg-body code:not(pre code) {
  font-family: var(--mono);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
}
.msg-body strong { font-weight: 600; }
.msg-body ul { margin: var(--space-2) 0; padding-left: var(--space-4); }

/* ===========================
   File preview / code block
   =========================== */
.code-block {
  margin: var(--space-3) 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-sunken);
}
.code-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-raised);
  border-bottom: 1px solid var(--border);
  font-size: var(--sz-xs);
  color: var(--text-muted);
}
.code-file-icon { opacity: 0.7; }
.code-file-name {
  flex: 1;
  font-family: var(--mono);
  font-size: var(--sz-sm);
  color: var(--text);
  font-weight: 500;
}
.code-lang {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
}
.code-actions { display: flex; gap: var(--space-1); }
.code-action {
  font-size: var(--sz-xs);
  padding: 3px 8px;
  border-radius: 4px;
  color: var(--text-muted);
  transition: background var(--duration) var(--ease), color var(--duration) var(--ease);
}
.code-action:hover { background: var(--bg-sunken); color: var(--text); }
.code-action.primary {
  background: var(--accent);
  color: var(--accent-fg);
}
.code-action.primary:hover { filter: brightness(1.08); }

.code-block pre {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
}

.code-block .diff-add { color: #6ed27a; background: color-mix(in srgb, #2ecc71 8%, transparent); padding: 0 4px; }
.code-block .diff-del { color: #f08080; background: color-mix(in srgb, #e74c3c 8%, transparent); padding: 0 4px; }

.diff-stats {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-3);
  font-size: var(--sz-sm);
  font-weight: 600;
  font-family: var(--mono);
}
.diff-stats .add { color: var(--success); }
.diff-stats .del { color: var(--danger); }

/* ===========================
   Agent activity / steps
   =========================== */
.activity {
  margin-top: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
  overflow: hidden;
}
.activity-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  user-select: none;
  transition: background var(--duration) var(--ease);
}
.activity-header:hover { background: var(--bg-raised); }
.activity-icon {
  width: 16px; height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}
.activity-title {
  flex: 1;
  font-size: var(--sz-sm);
  font-weight: 600;
  color: var(--text);
}
.activity-count {
  font-size: var(--sz-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.activity-chevron {
  width: 8px; height: 8px;
  border-right: 1.5px solid var(--text-muted);
  border-bottom: 1.5px solid var(--text-muted);
  transform: rotate(45deg);
  transition: transform var(--duration) var(--ease);
  margin-right: 4px;
}
.activity.collapsed .activity-chevron { transform: rotate(-45deg); }

.activity-steps {
  padding: var(--space-2) var(--space-3) var(--space-3);
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
  transition: max-height var(--duration) var(--ease);
}
.activity.collapsed .activity-steps {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
  border-top-color: transparent;
}

.step {
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: var(--space-2);
  padding: 6px 0;
  font-size: var(--sz-sm);
  align-items: start;
}
.step-status {
  width: 14px; height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 50%;
  flex: none;
}
.step-status.running {
  color: var(--text);
  background: transparent;
  border: 1.5px solid var(--text-faint);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
.step-status.done { color: var(--success); }
.step-status.failed { color: var(--danger); }

@keyframes spin {
  to { transform: rotate(360deg); }
}

.step-content { min-width: 0; }
.step-name {
  font-weight: 500;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
}
.step-detail {
  margin-top: 2px;
  font-size: var(--sz-xs);
  color: var(--text-muted);
  font-family: var(--mono);
  white-space: pre-wrap;
  word-break: break-all;
}

/* ===========================
   Permission card
   =========================== */
.perm {
  margin: var(--space-3) 0;
  border: 1px solid color-mix(in srgb, var(--warning) 50%, var(--border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning) 8%, var(--bg-sunken));
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.perm-title {
  font-weight: 600;
  font-size: var(--sz-sm);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.perm-title::before { content: "⚠"; color: var(--warning); }
.perm-tool {
  font-family: var(--mono);
  font-size: var(--sz-sm);
  background: var(--bg-sunken);
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 140px;
  overflow-y: auto;
}
.perm-actions { display: flex; gap: var(--space-2); }
.btn {
  font-size: var(--sz-sm);
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  background: var(--accent);
  color: var(--accent-fg);
  transition: filter var(--duration) var(--ease);
}
.btn:hover { filter: brightness(1.1); }
.btn.secondary {
  background: var(--bg-raised);
  color: var(--text);
  border: 1px solid var(--border);
}
.btn.danger {
  background: color-mix(in srgb, var(--danger) 90%, black);
  color: white;
}

/* ===========================
   Inline action row
   =========================== */
.action-row {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

/* ===========================
   Error banner (in log)
   =========================== */
.err-msg {
  border-left: 2px solid var(--danger);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  color: var(--text);
  font-size: var(--sz-sm);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

/* ===========================
   Composer
   =========================== */
.composer {
  border-top: 1px solid var(--border);
  background: var(--bg);
  padding: var(--space-3) var(--space-4) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.attached-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.attached-files:empty { display: none; }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px 3px 10px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: var(--sz-xs);
  color: var(--text-muted);
  max-width: 100%;
}
.chip-name {
  font-family: var(--mono);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}
.chip-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px; height: 16px;
  border-radius: 50%;
  cursor: pointer;
  color: var(--text-muted);
  transition: background var(--duration) var(--ease), color var(--duration) var(--ease);
}
.chip-action:hover { background: var(--bg-sunken); color: var(--text); }

.input-shell {
  position: relative;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  padding: var(--space-3);
  transition: border-color var(--duration) var(--ease), box-shadow var(--duration) var(--ease);
}
.input-shell:focus-within {
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border-strong));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

textarea.input {
  width: 100%;
  min-height: 22px;
  max-height: 240px;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: var(--sz-base);
  line-height: 1.5;
  padding: 0;
  overflow-y: auto;
}
textarea.input::placeholder { color: var(--text-faint); }

.composer-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--sz-xs);
  color: var(--text-faint);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--sz-xs);
  color: var(--text-muted);
  flex: 1;
  min-width: 0;
}
.status-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
.status[data-state="thinking"] .status-dot,
.status[data-state="executing"] .status-dot,
.status[data-state="typing"] .status-dot {
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}
.status[data-state="done"] .status-dot { background: var(--success); }
.status[data-state="error"] .status-dot { background: var(--danger); }

@keyframes pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.85); }
  50%      { opacity: 1; transform: scale(1.15); }
}

.kbd-hint {
  font-size: 10px;
  color: var(--text-faint);
}
.kbd {
  font-family: var(--mono);
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 4px;
  background: var(--bg-sunken);
  color: var(--text-muted);
  margin: 0 2px;
}

.send-row { display: flex; gap: var(--space-2); }

/* ===========================
   Overlays (history / analytics)
   =========================== */
.overlay {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: var(--bg);
  z-index: 100;
  display: none;
  flex-direction: column;
  animation: fadeUp 200ms var(--ease) both;
}
.overlay.open { display: flex; }
.overlay-header {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  font-size: var(--sz-md);
}
.overlay-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
}

.history-item {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--sz-sm);
  color: var(--text);
  transition: background var(--duration) var(--ease);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-item:hover { background: var(--bg-raised); }
.history-item.active { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.history-empty { color: var(--text-muted); font-size: var(--sz-sm); padding: var(--space-4); text-align: center; }

.stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin-bottom: var(--space-3); }
.stat-card {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}
.stat-card.full { grid-column: 1 / -1; }
.stat-val {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.stat-label {
  font-size: var(--sz-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  margin-top: 4px;
}
.stat-section-title {
  font-size: var(--sz-sm);
  font-weight: 600;
  margin-bottom: var(--space-2);
}
.bar { height: 6px; background: var(--bg-sunken); border-radius: 3px; overflow: hidden; margin-top: 6px; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width var(--duration) var(--ease); }
.kv-row {
  display: flex;
  justify-content: space-between;
  font-size: var(--sz-sm);
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.kv-row:last-child { border-bottom: none; }

.event-item {
  font-size: var(--sz-sm);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border);
}
.event-item:last-child { border-bottom: none; }
.event-meta {
  display: flex;
  justify-content: space-between;
  font-size: var(--sz-xs);
  color: var(--text-muted);
  margin-bottom: 4px;
}
.event-row {
  display: flex;
  justify-content: space-between;
  font-size: var(--sz-sm);
}

/* ===========================
   Pinned context (collapsible)
   =========================== */
.pinned {
  padding: var(--space-2) var(--space-4) 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pinned:empty { display: none; }
.pinned .chip {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg-raised));
}

/* ===========================
   Workspace rules indicator
   =========================== */
#rulesBtn.active {
  background: color-mix(in srgb, var(--accent) 18%, var(--bg-raised));
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}

/* ===========================
   Attached image chips
   =========================== */
.attached-images {
  padding: var(--space-2) var(--space-4) 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.attached-images:empty { display: none; }
.img-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: color-mix(in srgb, var(--accent) 12%, var(--bg-raised));
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: var(--sz-xs);
  max-width: 220px;
}
.img-chip .img-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}
.img-chip .chip-action {
  cursor: pointer;
  opacity: 0.6;
  font-weight: 700;
  padding: 0 2px;
}
.img-chip .chip-action:hover { opacity: 1; color: var(--danger, #d33); }

/* Inline image strip inside user message bubble */
.msg-image-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.msg-image-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-radius: 10px;
  font-size: var(--sz-xs);
  color: var(--text-muted);
}

/* Drag-over highlight on textarea */
#input.drag {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}

/* ===========================
   Multi-file edits review panel
   =========================== */
.edits-panel {
  margin-top: var(--space-3);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-sunken);
  overflow: hidden;
}
.edits-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 8px var(--space-3);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-raised));
  border-bottom: 1px solid var(--border);
  font-size: var(--sz-sm);
}
.edits-title { font-weight: 600; flex: 1; }
.edits-totals { display: inline-flex; gap: 8px; font-family: var(--mono, ui-monospace, monospace); font-size: var(--sz-xs); }
.edits-totals .add { color: #4caf50; }
.edits-totals .del { color: #ef5350; }
.edits-list { display: flex; flex-direction: column; }
.edit-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-3);
  font-size: var(--sz-xs);
  border-bottom: 1px solid var(--border);
}
.edit-row:last-child { border-bottom: none; }
.edit-tag {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent);
  font-weight: 600;
}
.edit-tag.new { background: color-mix(in srgb, #4caf50 22%, transparent); color: #4caf50; }
.edit-path {
  flex: 1;
  font-family: var(--mono, ui-monospace, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.edit-stats { display: inline-flex; gap: 6px; font-family: var(--mono, ui-monospace, monospace); }
.edit-stats .add { color: #4caf50; }
.edit-stats .del { color: #ef5350; }
.edit-actions { display: inline-flex; gap: 4px; }
.code-action {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-raised);
  color: var(--text);
  cursor: pointer;
}
.code-action:hover { background: color-mix(in srgb, var(--accent) 14%, var(--bg-raised)); }
.code-action.danger:hover { background: color-mix(in srgb, #ef5350 22%, var(--bg-raised)); color: #ef5350; }

/* ===========================
   Handoff banner
   =========================== */
.handoff-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: var(--space-3) var(--space-4);
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-raised));
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--border));
  font-size: var(--sz-sm);
}
.handoff-banner .handoff-arrow {
  color: var(--accent);
  font-weight: 700;
}
.handoff-banner .handoff-text strong { color: var(--accent); }
.handoff-banner .handoff-reason {
  color: var(--text-muted);
  font-size: var(--sz-xs);
  font-style: italic;
}
`;
