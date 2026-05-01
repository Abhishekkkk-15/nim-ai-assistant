/**
 * NIM Agent — Webview client script.
 *
 * Organized as small "components": ChatLog, MessageView, AgentActivity, FilePreview,
 * StatusIndicator, Composer, Overlay, etc. They communicate with the extension host
 * via the existing postMessage protocol — no protocol changes here.
 */
export function buildScript(): string {
  return `
const vscode = acquireVsCodeApi();

/* ============================================================
   Tiny DOM helpers
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const utob = (s) => btoa(unescape(encodeURIComponent(s)));
const btou = (s) => decodeURIComponent(escape(atob(s)));
function timeNow() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* ============================================================
   Markdown-ish formatter with file-preview code blocks
   ============================================================ */
function formatBody(text) {
  if (!text) return '';
  // Strip any inline tool-call JSON the model might have emitted.
  let h = text.replace(/\\{[\\s\\S]*?"tool"\\s*:\\s*"[\\s\\S]*?\\}/g, '');
  h = escapeHtml(h);

  const fence = String.fromCharCode(96).repeat(3); // \`\`\`
  const re = new RegExp(fence + '(\\\\w*)(?:[ \\\\t]+([^\\\\n]+))?\\\\n([\\\\s\\\\S]*?)' + fence, 'g');

  let totalAdds = 0, totalDels = 0;
  h = h.replace(re, (_m, lang, fileName, body) => {
    const lines = body.split('\\n').map((ln) => {
      if (ln.startsWith('+') && !ln.startsWith('+++')) { totalAdds++; return '<span class="diff-add">' + ln + '</span>'; }
      if (ln.startsWith('-') && !ln.startsWith('---')) { totalDels++; return '<span class="diff-del">' + ln + '</span>'; }
      return ln;
    }).join('\\n');
    const language = (lang || '').trim();
    const name = (fileName || '').trim();
    return renderCodeBlock({ language, fileName: name, body: body, rendered: lines });
  });

  // Inline code
  h = h.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
  // Bold
  h = h.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  // Lightweight list
  h = h.replace(/^(?:[*-])\\s+(.*)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>.*<\\/li>\\n?)+/g, (m) => '<ul>' + m + '</ul>');
  // Newlines
  h = h.replace(/\\n{2,}/g, '</p><p>');
  h = h.replace(/\\n/g, '<br/>');
  h = '<p>' + h + '</p>';

  if (totalAdds || totalDels) {
    h += '<div class="diff-stats"><span class="add">+' + totalAdds + '</span><span class="del">-' + totalDels + '</span></div>';
  }
  return h;
}

function renderCodeBlock({ language, fileName, body, rendered }) {
  const safeBody = body == null ? '' : body;
  const encoded = utob(safeBody);
  const headerName = fileName || (language ? language + ' snippet' : 'snippet');
  const langTag = language ? '<span class="code-lang">' + escapeHtml(language) + '</span>' : '';
  return (
    '<div class="code-block">' +
      '<div class="code-header">' +
        '<span class="code-file-icon">' + (fileName ? '\u{1F4C4}' : '\u276F') + '</span>' +
        '<span class="code-file-name">' + escapeHtml(headerName) + '</span>' +
        langTag +
        '<span class="code-actions">' +
          '<button class="code-action" data-action="copy-code" data-code="' + encoded + '">Copy</button>' +
          '<button class="code-action primary" data-action="apply-code" data-code="' + encoded + '">Apply</button>' +
        '</span>' +
      '</div>' +
      '<pre>' + (rendered != null ? rendered : escapeHtml(safeBody)) + '</pre>' +
    '</div>'
  );
}

/* ============================================================
   ChatLog — owns rendering of all messages in the conversation
   ============================================================ */
const ChatLog = (() => {
  const root = $('#log');

  function clear() { root.innerHTML = ''; renderEmptyState(); }
  function renderEmptyState() {
    if (root.children.length > 0) return;
    root.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-title' }, ['How can I help you build today?']),
      el('div', { class: 'empty-sub' }, ['Ask a question, request a refactor, or describe a feature. The agent will plan, use tools, and edit files for you.']),
    ]));
  }

  function removeEmptyState() {
    const e = root.querySelector('.empty-state');
    if (e) e.remove();
  }

  function pushUser(text) {
    removeEmptyState();
    const node = MessageView.user(text);
    root.appendChild(node);
    scrollToEnd();
    return node;
  }

  function pushAssistantShell(agentLabel) {
    removeEmptyState();
    const node = MessageView.assistantShell(agentLabel);
    root.appendChild(node);
    scrollToEnd();
    return node;
  }

  function pushPermission(payload) {
    removeEmptyState();
    const node = PermissionView.render(payload);
    root.appendChild(node);
    scrollToEnd();
    return node;
  }

  function pushError(text) {
    removeEmptyState();
    root.appendChild(el('div', { class: 'err-msg' }, ['Error: ' + text]));
    scrollToEnd();
  }

  function loadSession(messages) {
    root.innerHTML = '';
    if (!messages || messages.length === 0) {
      renderEmptyState();
      return;
    }
    for (const m of messages) {
      if (m.role === 'user') root.appendChild(MessageView.user(m.content, ''));
      else root.appendChild(MessageView.assistantStatic(m.role, m.content));
    }
    scrollToEnd();
  }

  function scrollToEnd() {
    requestAnimationFrame(() => { root.scrollTop = root.scrollHeight; });
  }

  return { clear, renderEmptyState, pushUser, pushAssistantShell, pushPermission, pushError, loadSession, scrollToEnd };
})();

/* ============================================================
   MessageView — user / assistant message factory
   ============================================================ */
const MessageView = {
  user(text, time) {
    const t = time === undefined ? timeNow() : time;
    return el('div', { class: 'msg user' }, [
      el('div', { class: 'msg-meta' }, [
        el('span', { class: 'role-pill user', html: '<span class="role-glyph"></span>You' }),
        t ? el('span', { class: 'msg-time' }, [t]) : null,
      ]),
      el('div', { class: 'msg-body', html: formatBody(text) }),
    ]);
  },

  assistantShell(agentLabel) {
    const node = el('div', { class: 'msg assistant' }, [
      el('div', { class: 'msg-meta' }, [
        el('span', { class: 'role-pill assistant', html: '<span class="role-glyph"></span>' + escapeHtml(agentLabel || 'Agent') }),
        el('span', { class: 'msg-time' }, [timeNow()]),
      ]),
      el('div', { class: 'msg-body' }),
    ]);
    return node;
  },

  assistantStatic(role, content) {
    return el('div', { class: 'msg assistant' }, [
      el('div', { class: 'msg-meta' }, [
        el('span', { class: 'role-pill assistant', html: '<span class="role-glyph"></span>' + escapeHtml(role) }),
      ]),
      el('div', { class: 'msg-body', html: formatBody(content) }),
    ]);
  },
};

/* ============================================================
   AgentActivity — collapsible step list attached to a message
   ============================================================ */
const AgentActivity = {
  ensure(messageNode) {
    let activity = messageNode.querySelector('.activity');
    if (activity) return activity;
    activity = el('div', { class: 'activity' }, [
      el('div', { class: 'activity-header', dataset: { action: 'toggle-activity' } }, [
        el('span', { class: 'activity-icon' }, ['\u26A1']),
        el('span', { class: 'activity-title' }, ['Agent steps']),
        el('span', { class: 'activity-count' }, ['0']),
        el('span', { class: 'activity-chevron' }),
      ]),
      el('div', { class: 'activity-steps' }),
    ]);
    messageNode.appendChild(activity);
    return activity;
  },

  addStep(messageNode, name) {
    const activity = AgentActivity.ensure(messageNode);
    const steps = activity.querySelector('.activity-steps');
    const step = el('div', { class: 'step', dataset: { name: name } }, [
      el('span', { class: 'step-status running', title: 'running' }),
      el('div', { class: 'step-content' }, [
        el('div', { class: 'step-name' }, [name]),
        el('div', { class: 'step-detail' }),
      ]),
    ]);
    steps.appendChild(step);
    AgentActivity._updateCount(activity);
    return step;
  },

  finishStep(stepNode, { ok, detail }) {
    if (!stepNode) return;
    const status = stepNode.querySelector('.step-status');
    status.classList.remove('running');
    if (ok === false) {
      status.classList.add('failed');
      status.textContent = '\u2715';
      status.title = 'failed';
    } else {
      status.classList.add('done');
      status.textContent = '\u2713';
      status.title = 'completed';
    }
    if (detail) {
      stepNode.querySelector('.step-detail').textContent = detail;
    }
  },

  _updateCount(activity) {
    const n = activity.querySelectorAll('.step').length;
    activity.querySelector('.activity-count').textContent = String(n);
  },
};

/* ============================================================
   PermissionView
   ============================================================ */
const PermissionView = {
  render(payload) {
    const tool = payload && payload.tool ? payload.tool : 'tool';
    const input = payload && payload.input ? payload.input : {};
    return el('div', { class: 'perm' }, [
      el('div', { class: 'perm-title' }, ['Permission requested']),
      el('div', {}, [
        'The agent wants to use ',
        el('strong', {}, [tool]),
        ' with:',
      ]),
      el('div', { class: 'perm-tool' }, [JSON.stringify(input, null, 2)]),
      el('div', { class: 'perm-actions' }, [
        el('button', { class: 'btn', dataset: { action: 'perm-allow' } }, ['Allow once']),
        el('button', { class: 'btn secondary', dataset: { action: 'perm-deny' } }, ['Deny']),
      ]),
    ]);
  },
};

/* ============================================================
   StatusIndicator — small animated dot + text near composer
   ============================================================ */
const StatusIndicator = (() => {
  const root = $('#status');
  function set(state, text) {
    root.dataset.state = state || 'idle';
    root.querySelector('.status-text').textContent = text || '';
  }
  return { set };
})();

/* ============================================================
   Composer — autoresizing textarea + Enter/Shift+Enter
   ============================================================ */
const Composer = (() => {
  const input = $('#input');
  const sendBtn = $('#sendBtn');
  const cancelBtn = $('#cancelBtn');

  function autoresize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 240) + 'px';
  }

  function clear() { input.value = ''; autoresize(); }
  function focus() { input.focus(); }

  input.addEventListener('input', autoresize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text: text, agent: $('#agentSel').value, model: $('#modelSel').value });
    clear();
  });

  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  function showCancel(show) { cancelBtn.style.display = show ? 'inline-flex' : 'none'; }

  return { clear, focus, autoresize, showCancel };
})();

/* ============================================================
   Overlay — generic open/close for history & analytics panes
   ============================================================ */
const Overlay = {
  open(id) {
    Overlay.closeAll();
    const ov = document.getElementById(id);
    if (ov) ov.classList.add('open');
  },
  toggle(id) {
    const ov = document.getElementById(id);
    if (!ov) return;
    if (ov.classList.contains('open')) ov.classList.remove('open');
    else Overlay.open(id);
  },
  closeAll() { $$('.overlay').forEach(o => o.classList.remove('open')); },
};

/* ============================================================
   Streaming state machine for assistant tokens
   ============================================================ */
function newStreamState() {
  return {
    isJson: false,
    buffer: '',
    isFinal: false,
    finalExtracted: '',
  };
}

let activeMessage = null;        // current assistant message DOM node
let activeBody = null;           // current assistant message body
let activeStepByTool = new Map(); // map of tool name -> step DOM node (most recent)
let lastStepNode = null;
let stream = newStreamState();
let hasEdits = false;

/* ============================================================
   Top-level click handler — delegates by data-action
   ============================================================ */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action], .activity-header, .history-item, .perm-allow, .perm-deny');
  if (!t) return;
  const action = t.dataset.action;

  if (action === 'apply-code') {
    vscode.postMessage({ type: 'applyCode', code: btou(t.dataset.code) });
  } else if (action === 'copy-code') {
    navigator.clipboard?.writeText(btou(t.dataset.code));
    const original = t.textContent;
    t.textContent = 'Copied';
    setTimeout(() => { t.textContent = original; }, 1200);
  } else if (action === 'toggle-activity') {
    t.parentElement.classList.toggle('collapsed');
  } else if (action === 'review-changes') {
    vscode.postMessage({ type: 'diffReview' });
  } else if (action === 'commit') {
    const m = prompt('Commit message:', 'feat: update');
    if (m) vscode.postMessage({ type: 'commitChanges', text: m });
  } else if (action === 'perm-allow' || action === 'perm-deny') {
    const allowed = action === 'perm-allow';
    vscode.postMessage({ type: 'permissionResponse', allowed: allowed });
    t.parentElement.innerHTML = '<em style="color: var(--text-muted); font-size: var(--sz-sm)">' + (allowed ? 'Allowed' : 'Denied') + '</em>';
  } else if (action === 'pin') {
    vscode.postMessage({ type: 'pinFile', path: t.dataset.path });
  } else if (action === 'unpin') {
    vscode.postMessage({ type: 'unpinFile', path: t.dataset.path });
  } else if (action === 'detach') {
    vscode.postMessage({ type: 'detachFile', path: t.dataset.path });
  } else if (action === 'load-session') {
    vscode.postMessage({ type: 'loadSession', sessionId: t.dataset.id });
    Overlay.closeAll();
  } else if (action === 'reset-analytics') {
    vscode.postMessage({ type: 'clearAnalytics' });
  }
});

/* ============================================================
   Top bar wiring
   ============================================================ */
$('#historyBtn').addEventListener('click', () => { Overlay.toggle('historyOverlay'); });
$('#analyticsBtn').addEventListener('click', () => {
  if ($('#analyticsOverlay').classList.contains('open')) {
    Overlay.closeAll();
  } else {
    Overlay.open('analyticsOverlay');
    vscode.postMessage({ type: 'getAnalytics' });
  }
});
$('#newChatBtn').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
$('#planBtn').addEventListener('click', () => vscode.postMessage({ type: 'togglePlanMode' }));
$('#autoBtn').addEventListener('click', () => vscode.postMessage({ type: 'toggleAutoPermit' }));
$('#reviewBtn').addEventListener('click', () => vscode.postMessage({ type: 'reviewFile' }));
$('#attachBtn').addEventListener('click', () => vscode.postMessage({ type: 'attachFile' }));
$('#clearBtn').addEventListener('click', () => {
  if (confirm('Clear ALL chat history?')) vscode.postMessage({ type: 'clearMemory' });
});
$$('.overlay-close').forEach(b => b.addEventListener('click', () => Overlay.closeAll()));

/* ============================================================
   Inbound message router
   ============================================================ */
window.addEventListener('message', (e) => {
  const m = e.data;
  switch (m.type) {
    case 'state':       return handleState(m.payload);
    case 'analytics':   return handleAnalytics(m.payload);
    case 'session_loaded': {
      ChatLog.loadSession(m.payload.messages || []);
      activeMessage = null; activeBody = null; activeStepByTool.clear(); lastStepNode = null;
      stream = newStreamState();
      StatusIndicator.set('idle', '');
      Composer.showCancel(false);
      return;
    }
    case 'user': {
      ChatLog.pushUser(m.payload);
      return;
    }
    case 'assistant_start': {
      const agentLabel = (m.payload && m.payload.agent) || 'Agent';
      activeMessage = ChatLog.pushAssistantShell(agentLabel);
      activeBody = activeMessage.querySelector('.msg-body');
      activeStepByTool.clear();
      lastStepNode = null;
      stream = newStreamState();
      hasEdits = false;
      StatusIndicator.set('thinking', 'Thinking');
      Composer.showCancel(true);
      return;
    }
    case 'assistant_token': {
      handleToken(m.payload);
      return;
    }
    case 'assistant_end': {
      Composer.showCancel(false);
      StatusIndicator.set('done', 'Completed');
      setTimeout(() => StatusIndicator.set('idle', ''), 1800);
      if (activeBody) activeBody.innerHTML = formatBody(m.payload.content);
      if (hasEdits && activeBody) {
        const row = el('div', { class: 'action-row' }, [
          el('button', { class: 'btn', dataset: { action: 'review-changes' } }, ['Review changes']),
          el('button', { class: 'btn secondary', dataset: { action: 'commit' } }, ['Commit']),
        ]);
        activeBody.appendChild(row);
      }
      return;
    }
    case 'permission_request': {
      ChatLog.pushPermission(m.payload);
      StatusIndicator.set('executing', 'Awaiting permission');
      return;
    }
    case 'step': {
      handleStep(m.payload);
      return;
    }
    case 'info': {
      StatusIndicator.set('done', m.payload);
      setTimeout(() => StatusIndicator.set('idle', ''), 2400);
      return;
    }
    case 'error': {
      Composer.showCancel(false);
      StatusIndicator.set('error', 'Error');
      setTimeout(() => StatusIndicator.set('idle', ''), 3000);
      ChatLog.pushError(m.payload);
      return;
    }
  }
});

function handleState(p) {
  // Agent + model dropdowns
  const agentSel = $('#agentSel');
  agentSel.innerHTML = (p.agents || []).map(a =>
    '<option value="' + a.role + '"' + (a.role === p.activeAgent ? ' selected' : '') + '>' + escapeHtml(a.label) + '</option>'
  ).join('');
  const modelSel = $('#modelSel');
  modelSel.innerHTML = (p.models || []).map(m =>
    '<option value="' + m.name + '"' + (m.name === p.activeModel ? ' selected' : '') + '>' + escapeHtml(m.name) + '</option>'
  ).join('');

  // Toggle states
  $('#planBtn').classList.toggle('active', !!p.planMode);
  $('#autoBtn').classList.toggle('active', !!p.autoPermit);

  // Attached + pinned files
  $('#attachedFiles').innerHTML = (p.attachedFiles || []).map(path =>
    '<span class="chip">' +
      '<span class="chip-name" title="' + escapeHtml(path) + '">' + escapeHtml(path) + '</span>' +
      '<span class="chip-action" data-action="pin" data-path="' + escapeHtml(path) + '" title="Pin to context">\u{1F4CC}</span>' +
      '<span class="chip-action" data-action="detach" data-path="' + escapeHtml(path) + '" title="Detach">\u00D7</span>' +
    '</span>'
  ).join('');

  $('#pinnedFiles').innerHTML = (p.pinnedFiles || []).map(path =>
    '<span class="chip">' +
      '<span class="chip-name" title="' + escapeHtml(path) + '">' + escapeHtml(path) + '</span>' +
      '<span class="chip-action" data-action="unpin" data-path="' + escapeHtml(path) + '" title="Unpin">\u00D7</span>' +
    '</span>'
  ).join('');

  // History sidebar list
  const sessions = p.sessions || [];
  $('#historyList').innerHTML = sessions.length
    ? sessions.map(s =>
        '<div class="history-item' + (s.id === p.currentSessionId ? ' active' : '') + '" data-action="load-session" data-id="' + s.id + '">' +
          escapeHtml(s.title) +
        '</div>'
      ).join('')
    : '<div class="history-empty">No saved chats yet.</div>';
}

function handleAnalytics(payload) {
  const summary = payload.summary || {};
  const events = payload.events || [];
  const total = summary.totalTokens || 1;

  const modelUsage = Object.entries(summary.modelUsage || {});
  const keyHealth = Object.entries(summary.keyHealth || {});

  const card = (val, label) =>
    '<div class="stat-card"><div class="stat-val">' + val + '</div><div class="stat-label">' + label + '</div></div>';

  const html =
    '<div class="stat-grid">' +
      card(summary.totalTokens || 0, 'Total tokens') +
      card(((summary.successRate || 0).toFixed(1)) + '%', 'Success rate') +
    '</div>' +
    '<div class="stat-card full">' +
      '<div class="stat-section-title">Model usage</div>' +
      (modelUsage.length
        ? modelUsage.map(([k, v]) =>
            '<div style="margin-top:8px; font-size: var(--sz-sm);">' +
              '<div style="display:flex; justify-content: space-between;"><span>' + escapeHtml(k) + '</span><span>' + v + '</span></div>' +
              '<div class="bar"><div class="bar-fill" style="width:' + ((v / total) * 100).toFixed(0) + '%"></div></div>' +
            '</div>').join('')
        : '<div style="color: var(--text-muted); font-size: var(--sz-sm);">No usage yet.</div>') +
    '</div>' +
    '<div class="stat-card full">' +
      '<div class="stat-section-title">API key health</div>' +
      (keyHealth.length
        ? keyHealth.map(([k, v]) =>
            '<div class="kv-row"><span>' + escapeHtml(k) + '</span><span>' + ((v.success / Math.max(v.total, 1)) * 100).toFixed(0) + '% (' + v.total + ')</span></div>'
          ).join('')
        : '<div style="color: var(--text-muted); font-size: var(--sz-sm);">No keys recorded.</div>') +
    '</div>' +
    '<div class="stat-card full">' +
      '<div class="stat-section-title">Recent activity</div>' +
      (events.length
        ? events.slice(0, 10).map(ev =>
            '<div class="event-item">' +
              '<div class="event-meta"><span>' + escapeHtml(ev.model) + '</span><span>' + new Date(ev.timestamp).toLocaleTimeString() + '</span></div>' +
              '<div class="event-row"><span>' + escapeHtml(ev.status) + ' · ' + ev.retries + ' retries</span><span>' + (ev.tokensIn + ev.tokensOut) + ' tokens</span></div>' +
            '</div>'
          ).join('')
        : '<div style="color: var(--text-muted); font-size: var(--sz-sm);">No requests yet.</div>') +
    '</div>' +
    '<button id="resetAnalyticsBtn" class="btn secondary" data-action="reset-analytics" style="width:100%; margin-top:16px;">Reset all data</button>';

  $('#analyticsContent').innerHTML = html;
}

function handleToken(token) {
  if (!activeBody) return;
  StatusIndicator.set('typing', 'Streaming');
  stream.buffer += token;

  const fence = String.fromCharCode(96).repeat(3);
  if (!stream.isJson && (stream.buffer.indexOf(fence + 'json') !== -1 || stream.buffer.indexOf('{"tool"') !== -1)) {
    stream.isJson = true;
    activeBody.textContent = activeBody.textContent.trim();
  }

  if (stream.isJson) {
    if (!stream.isFinal && stream.buffer.indexOf('"final"') !== -1) stream.isFinal = true;
    if (stream.isFinal) {
      const match = stream.buffer.match(/"final":\\s*"([^"]*)/);
      if (match && match[1]) {
        const newContent = match[1].replace(/\\\\n/g, '\\n');
        const delta = newContent.slice(stream.finalExtracted.length);
        if (delta) {
          activeBody.textContent += delta;
          stream.finalExtracted = newContent;
        }
      }
    }
  } else {
    activeBody.textContent += token;
  }
  ChatLog.scrollToEnd();
}

function handleStep(s) {
  if (!activeMessage) return;
  if (s.type === 'tool_call') {
    StatusIndicator.set('executing', 'Running ' + s.name);
    const node = AgentActivity.addStep(activeMessage, s.name);
    if (s.payload) {
      let preview = String(s.payload);
      if (preview.length > 220) preview = preview.slice(0, 220) + '\u2026';
      node.querySelector('.step-detail').textContent = preview;
    }
    activeStepByTool.set(s.name, node);
    lastStepNode = node;
    if (s.name === 'write_file' || s.name === 'replace_file_content' || s.name === 'multi_replace_file_content') {
      hasEdits = true;
    }
  } else if (s.type === 'tool_result') {
    StatusIndicator.set('thinking', 'Thinking');
    let detail = String(s.payload);
    if (s.name === 'read_file') {
      const lines = detail.split('\\n').length;
      detail = 'Read ' + lines + ' lines';
    } else if (detail.length > 200) {
      detail = detail.slice(0, 200) + '\u2026';
    }
    const node = activeStepByTool.get(s.name) || lastStepNode;
    AgentActivity.finishStep(node, { ok: s.ok !== false, detail: detail });
  }
}

/* ============================================================
   Boot
   ============================================================ */
ChatLog.renderEmptyState();
StatusIndicator.set('idle', '');
Composer.autoresize();
Composer.focus();
vscode.postMessage({ type: 'ready' });
`;
}
