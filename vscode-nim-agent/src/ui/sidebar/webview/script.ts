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

  function pushUser(payload) {
    removeEmptyState();
    let text = '';
    let images;
    if (payload && typeof payload === 'object') {
      text = payload.text || '';
      images = payload.images || [];
    } else {
      text = String(payload || '');
    }
    const node = MessageView.user(text, undefined, images);
    root.appendChild(node);
    scrollToEnd();
    return node;
  }

  function pushHandoffBanner(from, to, reason) {
    removeEmptyState();
    const node = el('div', { class: 'handoff-banner' }, [
      el('span', { class: 'handoff-arrow' }, ['\u2192']),
      el('span', { class: 'handoff-text' }, [
        el('strong', {}, [from || '?']),
        ' handed off to ',
        el('strong', {}, [to || '?']),
      ]),
      reason ? el('span', { class: 'handoff-reason' }, [reason]) : null,
    ]);
    root.appendChild(node);
    scrollToEnd();
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

  return { clear, renderEmptyState, pushUser, pushHandoffBanner, pushAssistantShell, pushPermission, pushError, loadSession, scrollToEnd };
})();

/* ============================================================
   EditsPanel — multi-file diff review attached to assistant turn
   ============================================================ */
const EditsPanel = {
  render(messageNode, edits) {
    if (!messageNode) return;
    // Remove any existing panel from this turn
    const existing = messageNode.querySelector('.edits-panel');
    if (existing) existing.remove();
    if (!edits || edits.length === 0) return;

    const totalAdds = edits.reduce((s, e) => s + (e.added || 0), 0);
    const totalDels = edits.reduce((s, e) => s + (e.removed || 0), 0);

    const list = el('div', { class: 'edits-list' });
    for (const e of edits) {
      const tag = e.created
        ? el('span', { class: 'edit-tag new' }, ['NEW'])
        : el('span', { class: 'edit-tag' }, ['MOD']);
      const stats = el('span', { class: 'edit-stats' }, [
        el('span', { class: 'add' }, ['+' + (e.added || 0)]),
        el('span', { class: 'del' }, ['-' + (e.removed || 0)]),
      ]);
      const actions = el('span', { class: 'edit-actions' }, [
        el('button', { class: 'code-action', dataset: { action: 'open-edit-diff', path: e.path } }, ['Diff']),
        el('button', { class: 'code-action danger', dataset: { action: 'revert-edit', path: e.path } }, ['Revert']),
      ]);
      list.appendChild(el('div', { class: 'edit-row' }, [
        tag,
        el('span', { class: 'edit-path', title: e.path }, [e.path]),
        stats,
        actions,
      ]));
    }

    const panel = el('div', { class: 'edits-panel' }, [
      el('div', { class: 'edits-header' }, [
        el('span', { class: 'edits-title' }, [
          '\u{1F4DD} ' + edits.length + ' file' + (edits.length === 1 ? '' : 's') + ' changed',
        ]),
        el('span', { class: 'edits-totals' }, [
          el('span', { class: 'add' }, ['+' + totalAdds]),
          el('span', { class: 'del' }, ['-' + totalDels]),
        ]),
        el('button', { class: 'code-action danger', dataset: { action: 'revert-all-edits' } }, ['Revert all']),
      ]),
      list,
    ]);
    messageNode.appendChild(panel);
  },
};

/* ============================================================
   DesignerView — UI Designer overlay (form, progress, result)
   ============================================================ */
const DesignerView = (function () {
  let lastResult = null; // { document, variations, modelUsed, rawJson }
  let activeDoc = null;

  function open() {
    Overlay.open('designOverlay');
    showSection('form');
  }
  function showSection(which) {
    $('#designForm').style.display = which === 'form' ? '' : 'none';
    $('#designProgress').style.display = which === 'progress' ? '' : 'none';
    $('#designError').style.display = which === 'error' ? '' : 'none';
    $('#designResult').style.display = which === 'result' ? '' : 'none';
  }
  function progress(msg) {
    showSection('progress');
    $('#designProgressMsg').textContent = msg || 'Generating design\u2026';
  }
  function error(msg) {
    showSection('error');
    $('#designError').textContent = 'Design generation failed: ' + (msg || 'unknown error');
  }
  function setResult(payload) {
    lastResult = payload || {};
    const sel = $('#designVariantSel');
    const allDocs = [lastResult.document].concat(lastResult.variations || []).filter(Boolean);
    if (allDocs.length > 1) {
      sel.style.display = '';
      sel.innerHTML = allDocs.map((d, i) =>
        '<option value="' + i + '">' + (i === 0 ? 'Primary' : 'Variation ' + i) + ' \u2014 ' + escapeHtml(d.meta?.name || 'Untitled') + '</option>'
      ).join('');
      sel.value = '0';
    } else {
      sel.style.display = 'none';
    }
    setActiveIndex(0);
    showSection('result');
  }
  function setActiveIndex(i) {
    if (!lastResult) return;
    const docs = [lastResult.document].concat(lastResult.variations || []);
    activeDoc = docs[i] || docs[0];
    renderActive();
  }
  function renderActive() {
    if (!activeDoc) return;
    renderVisual(activeDoc);
    renderTree(activeDoc);
    renderJson(activeDoc);
  }
  function renderVisual(doc) {
    const root = $('#designTabVisual');
    const meta = doc.meta || {};
    const ds = doc.designSystem || {};
    const colors = ds.colors || [];
    const typo = ds.typography || [];
    const spacing = ds.spacing || [];
    const radii = ds.radii || [];
    const screens = doc.screens || [];

    let html = '';
    html += '<div class="design-meta">';
    html += '<div class="design-name">' + escapeHtml(meta.name || 'Untitled') + '</div>';
    html += '<div class="design-pills">';
    html += '<span class="design-pill">' + escapeHtml(meta.appType || '') + '</span>';
    html += '<span class="design-pill">' + escapeHtml(meta.style || '') + '</span>';
    html += '<span class="design-pill subtle">model: ' + escapeHtml(lastResult?.modelUsed || '') + '</span>';
    html += '</div>';
    if (meta.summary) html += '<div class="design-summary">' + escapeHtml(meta.summary) + '</div>';
    html += '</div>';

    if (colors.length) {
      html += '<div class="design-section"><div class="design-section-title">Colors</div><div class="swatch-grid">';
      for (const c of colors) {
        html += '<div class="swatch"><span class="swatch-chip" style="background:' + escapeHtml(c.value) + '"></span>' +
          '<div class="swatch-meta"><div class="swatch-name">' + escapeHtml(c.name) + '</div>' +
          '<div class="swatch-value">' + escapeHtml(c.value) + '</div>' +
          (c.usage ? '<div class="swatch-usage">' + escapeHtml(c.usage) + '</div>' : '') +
          '</div></div>';
      }
      html += '</div></div>';
    }
    if (typo.length) {
      html += '<div class="design-section"><div class="design-section-title">Typography</div><div class="typo-grid">';
      for (const t of typo) {
        html += '<div class="typo-row"><span class="typo-role">' + escapeHtml(t.role) + '</span>' +
          '<span class="typo-sample" style="font-family:' + escapeHtml(t.family) + '; font-weight:' + escapeHtml(t.weight || '400') + '">' +
          escapeHtml(t.family) + (t.size ? ' \u00B7 ' + escapeHtml(t.size) : '') + '</span></div>';
      }
      html += '</div></div>';
    }
    if (spacing.length || radii.length) {
      html += '<div class="design-section"><div class="design-section-title">Spacing &amp; radii</div><div class="token-grid">';
      for (const s of spacing) html += '<div class="token-chip"><span class="token-key">' + escapeHtml(s.token) + '</span><span class="token-val">' + escapeHtml(s.value) + '</span></div>';
      for (const r of radii) html += '<div class="token-chip"><span class="token-key">r/' + escapeHtml(r.token) + '</span><span class="token-val">' + escapeHtml(r.value) + '</span></div>';
      html += '</div></div>';
    }

    if (screens.length) {
      html += '<div class="design-section"><div class="design-section-title">Screens (' + screens.length + ')</div>';
      for (const s of screens) {
        html += '<details class="screen-card" open><summary>' + escapeHtml(s.name) + '</summary>';
        if (s.description) html += '<div class="screen-desc">' + escapeHtml(s.description) + '</div>';
        for (const sec of (s.sections || [])) {
          html += '<div class="section-card"><div class="section-name">' + escapeHtml(sec.name) + '</div>';
          if (sec.description) html += '<div class="section-desc">' + escapeHtml(sec.description) + '</div>';
          html += '<div class="section-components">';
          for (const c of (sec.components || [])) html += renderComponentCard(c);
          html += '</div></div>';
        }
        html += '</details>';
      }
      html += '</div>';
    }
    root.innerHTML = html;
  }
  function renderComponentCard(c) {
    const props = c.props ? Object.entries(c.props).map(([k, v]) =>
      '<span class="prop"><span class="prop-key">' + escapeHtml(k) + '</span>=<span class="prop-val">' + escapeHtml(formatPropVal(v)) + '</span></span>'
    ).join('') : '';
    let html = '<div class="component-card">' +
      '<div class="component-head"><span class="component-type">' + escapeHtml(c.type) + '</span>' +
      (c.name ? '<span class="component-name">' + escapeHtml(c.name) + '</span>' : '') + '</div>';
    if (props) html += '<div class="component-props">' + props + '</div>';
    if (c.children && c.children.length) {
      html += '<div class="component-children">';
      for (const ch of c.children) html += renderComponentCard(ch);
      html += '</div>';
    }
    return html + '</div>';
  }
  function formatPropVal(v) {
    if (v == null) return String(v);
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  function renderTree(doc) {
    const root = $('#designTabTree');
    let html = '<ul class="tree-root">';
    for (const s of (doc.screens || [])) {
      html += '<li><span class="tree-screen">\u{1F5A5}\uFE0F ' + escapeHtml(s.name) + '</span><ul>';
      for (const sec of (s.sections || [])) {
        html += '<li><span class="tree-section">\u25A2 ' + escapeHtml(sec.name) + '</span><ul>';
        for (const c of (sec.components || [])) html += treeNode(c);
        html += '</ul></li>';
      }
      html += '</ul></li>';
    }
    html += '</ul>';
    root.innerHTML = html;
  }
  function treeNode(c) {
    let html = '<li><span class="tree-component">\u25CB ' + escapeHtml(c.type) +
      (c.name ? ' \u2022 ' + escapeHtml(c.name) : '') + '</span>';
    if (c.children && c.children.length) {
      html += '<ul>';
      for (const ch of c.children) html += treeNode(ch);
      html += '</ul>';
    }
    return html + '</li>';
  }
  function renderJson(doc) {
    const root = $('#designTabJson');
    root.innerHTML = '<pre class="design-json">' + escapeHtml(JSON.stringify(doc, null, 2)) + '</pre>';
  }
  function activateTab(name) {
    $$('#designResult .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $('#designTabVisual').style.display = name === 'visual' ? '' : 'none';
    $('#designTabTree').style.display = name === 'tree' ? '' : 'none';
    $('#designTabJson').style.display = name === 'json' ? '' : 'none';
  }

  // Wire form events.
  $('#designForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const features = String($('#designFeatures').value || '')
      .split(/\\r?\\n/).map(s => s.trim()).filter(Boolean);
    const spec = {
      appType: $('#designAppType').value,
      style: $('#designStyle').value,
      features,
      notes: $('#designNotes').value || '',
      variations: parseInt($('#designVariations').value || '1', 10),
    };
    progress('Generating design with NIM\u2026');
    vscode.postMessage({ type: 'runDesign', designSpec: spec });
  });
  $('#designNewBtn').addEventListener('click', () => showSection('form'));
  $('#designVariantSel').addEventListener('change', (e) => setActiveIndex(parseInt(e.target.value, 10) || 0));
  $('#designResult').addEventListener('click', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('tab-btn')) activateTab(t.dataset.tab);
  });

  return { open, progress, error, setResult };
})();

/* ============================================================
   BuilderView — Smart Feature Builder overlay
   ============================================================ */
const BuilderView = (function () {
  let lastFiles = [];
  let lastResult = null;
  let activeMode = 'auto';
  const stepEls = new Map();

  function open() {
    Overlay.open('builderOverlay');
    showSection('form');
    resetProgress();
  }

  function showSection(which) {
    $('#builderForm').style.display     = which === 'form'     ? '' : 'none';
    $('#builderProgress').style.display = which === 'progress' ? '' : 'none';
    $('#builderError').style.display    = which === 'error'    ? '' : 'none';
    $('#builderResult').style.display   = which === 'result'   ? '' : 'none';
  }

  function resetProgress() {
    stepEls.clear();
    $('#builderStepsList').innerHTML = '';
    $('#builderScopeCard').style.display = 'none';
    $('#builderPlanBlock').style.display = 'none';
    $('#builderArchBlock').style.display = 'none';
    $('#builderReviewBlock').style.display = 'none';
    $('#builderStatusText').textContent = 'Starting\u2026';
    lastFiles = [];
    lastResult = null;
  }

  function start(prompt, mode) {
    activeMode = mode;
    showSection('progress');
    resetProgress();
    $('#builderStatusText').textContent = mode === 'auto'
      ? 'Analyzing scope\u2026'
      : 'Running ' + modeLabel(mode) + '\u2026';
  }

  function modeLabel(mode) {
    if (mode === 'quick') return 'Quick Fix';
    if (mode === 'build') return 'Build Feature';
    if (mode === 'plan')  return 'Plan First';
    return 'Auto';
  }

  function setError(msg) {
    showSection('error');
    $('#builderError').textContent = 'Smart Builder failed: ' + (msg || 'unknown error');
  }

  function onScope(scope) {
    const card = $('#builderScopeCard');
    card.style.display = '';
    card.innerHTML =
      '<div class="builder-scope-row">' +
        '<span>Detected scope</span>' +
        '<span class="builder-scope-pill ' + escapeHtml(scope.intent) + '">' + escapeHtml(String(scope.intent || '').toUpperCase()) + '</span>' +
        '<span class="builder-scope-conf">confidence ' + Math.round((scope.confidence || 0) * 100) + '%</span>' +
        '<span class="builder-scope-source">(' + escapeHtml(scope.source || 'analyzer') + ')</span>' +
      '</div>' +
      '<div class="builder-scope-reason">' + escapeHtml(scope.reason || '') + '</div>';
    $('#builderStatusText').textContent = 'Scope: ' + String(scope.intent || '').toUpperCase();
  }

  function onStep(step) {
    const id = step.id;
    let row = stepEls.get(id);
    if (!row) {
      row = el('div', { class: 'builder-step-row' }, [
        el('span', { class: 'builder-step-status pending' }),
        el('span', { class: 'builder-step-label' }, [step.label || step.agent || id]),
        el('span', { class: 'builder-step-detail' }),
      ]);
      $('#builderStepsList').appendChild(row);
      stepEls.set(id, row);
    }
    const status = row.querySelector('.builder-step-status');
    status.classList.remove('pending', 'running', 'done', 'failed', 'skipped');
    status.classList.add(step.status || 'pending');
    if (step.status === 'done')   { status.textContent = '\u2713'; }
    else if (step.status === 'failed') { status.textContent = '\u2715'; }
    else if (step.status === 'running') { status.textContent = ''; }
    else { status.textContent = ''; }
    if (step.detail) row.querySelector('.builder-step-detail').textContent = step.detail;
    if (step.eventType === 'step_start') {
      $('#builderStatusText').textContent = step.label || ('Running ' + (step.agent || ''));
    }
  }

  function onPlan(plan) {
    const block = $('#builderPlanBlock');
    block.style.display = '';
    let html = '<div class="builder-block-title">Plan</div><div class="builder-block-body">';
    if (plan.summary) html += '<div>' + escapeHtml(plan.summary) + '</div>';
    if (plan.steps && plan.steps.length) {
      html += '<ol>';
      for (const s of plan.steps) {
        html += '<li><strong>' + escapeHtml(s.title || ('Step ' + s.id)) + '</strong>';
        if (s.description) html += '<span class="bb-desc">' + escapeHtml(s.description) + '</span>';
        html += '</li>';
      }
      html += '</ol>';
    }
    if (plan.risks && plan.risks.length) {
      html += '<div style="margin-top:8px;"><em>Risks:</em><ul>';
      for (const r of plan.risks) html += '<li>' + escapeHtml(r) + '</li>';
      html += '</ul></div>';
    }
    html += '</div>';
    block.innerHTML = html;
  }

  function onArchitecture(arch) {
    const block = $('#builderArchBlock');
    block.style.display = '';
    let html = '<div class="builder-block-title">Architecture</div><div class="builder-block-body">';
    if (arch.notes) html += '<div>' + escapeHtml(arch.notes) + '</div>';
    if (arch.files && arch.files.length) {
      html += '<ul>';
      for (const f of arch.files) {
        html += '<li><strong>' + escapeHtml(f.path) + '</strong> — ' + escapeHtml(f.purpose || '');
        html += ' <span class="builder-file-tag ' + (f.kind || 'create') + '" style="margin-left:6px;">' + escapeHtml((f.kind || 'create').toUpperCase()) + '</span></li>';
      }
      html += '</ul>';
    }
    html += '</div>';
    block.innerHTML = html;
  }

  function onReview(review) {
    const block = $('#builderReviewBlock');
    block.style.display = '';
    let html = '<div class="builder-block-title">Review ' + (review.approved ? '\u2014 Approved \u2713' : '\u2014 Changes requested') + '</div><div class="builder-block-body">';
    if (review.issues && review.issues.length) {
      for (const i of review.issues) {
        html += '<div class="builder-issue-row">' +
          '<span class="builder-issue-sev ' + escapeHtml(i.severity) + '">' + escapeHtml(String(i.severity || '').toUpperCase()) + '</span>' +
          '<div><span class="builder-issue-msg">' + escapeHtml(i.message) + '</span>';
        if (i.path) html += ' <span class="builder-issue-path">' + escapeHtml(i.path) + '</span>';
        html += '</div></div>';
      }
    } else {
      html += '<div>No issues found.</div>';
    }
    if (review.suggestions && review.suggestions.length) {
      html += '<div style="margin-top:8px;"><em>Suggestions:</em><ul>';
      for (const s of review.suggestions) html += '<li>' + escapeHtml(s) + '</li>';
      html += '</ul></div>';
    }
    html += '</div>';
    block.innerHTML = html;
  }

  function onFiles(files) {
    lastFiles = Array.isArray(files) ? files : [];
  }

  function onComplete(result) {
    lastResult = result || {};
    lastFiles = (result && result.files) || lastFiles;
    showSection('result');
    renderFilesList();
    $('#builderResultTitle').textContent =
      'Generated ' + lastFiles.length + ' file' + (lastFiles.length === 1 ? '' : 's') +
      ' \u2014 model: ' + (result && result.modelUsed ? result.modelUsed : '?');
  }

  function renderFilesList() {
    const root = $('#builderFilesList');
    if (!lastFiles.length) {
      root.innerHTML = '<div style="color: var(--text-muted); font-size: var(--sz-sm); padding: 12px;">No files were generated.</div>';
      return;
    }
    let html = '';
    for (let i = 0; i < lastFiles.length; i++) {
      const f = lastFiles[i];
      const diff = simpleDiff(f.originalContent || '', f.content || '');
      html +=
        '<div class="builder-file-card" data-idx="' + i + '">' +
          '<div class="builder-file-head" data-action="builder-toggle-file">' +
            '<span class="builder-file-tag ' + (f.kind || 'create') + '">' + escapeHtml(String(f.kind || 'create').toUpperCase()) + '</span>' +
            '<span class="builder-file-path" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</span>' +
            '<span class="builder-file-stats"><span class="add">+' + diff.added + '</span><span class="del">-' + diff.removed + '</span></span>' +
            '<span class="builder-file-actions">' +
              '<button class="code-action" data-action="builder-copy-file" data-idx="' + i + '">Copy</button>' +
              '<button class="code-action primary" data-action="builder-apply-file" data-idx="' + i + '">Apply</button>' +
            '</span>' +
          '</div>' +
          '<div class="builder-file-body"><pre>' + diff.html + '</pre></div>' +
        '</div>';
    }
    root.innerHTML = html;
  }

  function simpleDiff(oldText, newText) {
    if (!oldText) {
      const lines = String(newText || '').split('\\n');
      const html = lines.map(l => '<span class="diff-add">+ ' + escapeHtml(l) + '</span>').join('\\n');
      return { added: lines.length, removed: 0, html };
    }
    const oldLines = String(oldText).split('\\n');
    const newLines = String(newText || '').split('\\n');
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let added = 0, removed = 0;
    const out = [];
    const max = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < max; i++) {
      const o = oldLines[i];
      const n = newLines[i];
      if (o === n) {
        if (o !== undefined) out.push('<span class="diff-ctx">  ' + escapeHtml(o) + '</span>');
      } else {
        if (o !== undefined && !newSet.has(o)) { out.push('<span class="diff-del">- ' + escapeHtml(o) + '</span>'); removed++; }
        if (n !== undefined && !oldSet.has(n)) { out.push('<span class="diff-add">+ ' + escapeHtml(n) + '</span>'); added++; }
      }
    }
    return { added, removed, html: out.join('\\n') };
  }

  // Wire form
  $('#builderForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const prompt = String($('#builderPrompt').value || '').trim();
    if (!prompt) return;
    const modeInput = document.querySelector('input[name="builderMode"]:checked');
    const mode = modeInput ? modeInput.value : 'auto';
    start(prompt, mode);
    vscode.postMessage({
      type: 'runSmartBuilder',
      text: prompt,
      builderMode: mode,
      model: $('#modelSel').value,
    });
  });

  $('#builderCancelBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelSmartBuilder' });
    setError('Cancelled by user.');
  });
  $('#builderRestartBtn').addEventListener('click', () => {
    showSection('form');
    resetProgress();
  });
  $('#builderApplyBtn').addEventListener('click', () => {
    if (!lastFiles.length) return;
    vscode.postMessage({
      type: 'applySmartBuild',
      builderFiles: lastFiles.map(f => ({ path: f.path, content: f.content, kind: f.kind })),
    });
  });

  $('#builderFilesList').addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    if (action === 'builder-toggle-file') {
      const card = t.closest('.builder-file-card');
      if (card) card.classList.toggle('open');
    } else if (action === 'builder-copy-file') {
      e.stopPropagation();
      const idx = parseInt(t.dataset.idx, 10) || 0;
      const f = lastFiles[idx];
      if (f) navigator.clipboard?.writeText(f.content || '');
      const orig = t.textContent; t.textContent = 'Copied'; setTimeout(() => { t.textContent = orig; }, 1200);
    } else if (action === 'builder-apply-file') {
      e.stopPropagation();
      const idx = parseInt(t.dataset.idx, 10) || 0;
      const f = lastFiles[idx];
      if (f) vscode.postMessage({ type: 'applySmartBuild', builderFiles: [{ path: f.path, content: f.content, kind: f.kind }] });
    }
  });

  return { open, start, setError, onScope, onStep, onPlan, onArchitecture, onReview, onFiles, onComplete };
})();

/* ============================================================
   MessageView — user / assistant message factory
   ============================================================ */
const MessageView = {
  user(text, time, images) {
    const t = time === undefined ? timeNow() : time;
    const meta = el('div', { class: 'msg-meta' }, [
      el('span', { class: 'role-pill user', html: '<span class="role-glyph"></span>You' }),
      t ? el('span', { class: 'msg-time' }, [t]) : null,
    ]);
    const body = el('div', { class: 'msg-body', html: formatBody(text) });
    const node = el('div', { class: 'msg user' }, [meta, body]);
    if (images && images.length) {
      const strip = el('div', { class: 'msg-image-strip' });
      for (const img of images) {
        strip.appendChild(el('span', { class: 'msg-image-chip', title: img.name }, [
          '\u{1F5BC}\uFE0F ' + (img.name || 'image')
        ]));
      }
      node.appendChild(strip);
    }
    return node;
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
let lastTurnTail = null;         // last assistant message in current user turn (for edits panel)
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
  } else if (action === 'open-edit-diff') {
    vscode.postMessage({ type: 'openEditDiff', path: t.dataset.path });
  } else if (action === 'revert-edit') {
    vscode.postMessage({ type: 'revertEdit', path: t.dataset.path });
  } else if (action === 'revert-all-edits') {
    if (confirm('Revert ALL files changed in this turn?')) {
      vscode.postMessage({ type: 'revertAllEdits' });
    }
  } else if (action === 'detach-image') {
    vscode.postMessage({ type: 'detachImage', imageId: t.dataset.id });
  } else if (action === 'open-rules') {
    vscode.postMessage({ type: 'openRulesFile', text: t.dataset.name || '' });
  } else if (action === 'create-rules') {
    vscode.postMessage({ type: 'createRulesFile' });
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
$('#agentSel').addEventListener('change', (e) => vscode.postMessage({ type: 'selectAgent', agent: e.target.value }));
$('#modelSel').addEventListener('change', (e) => vscode.postMessage({ type: 'selectModel', model: e.target.value }));
$('#newChatBtn').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
$('#planBtn').addEventListener('click', () => vscode.postMessage({ type: 'togglePlanMode' }));
$('#autoBtn').addEventListener('click', () => vscode.postMessage({ type: 'toggleAutoPermit' }));
$('#reviewBtn').addEventListener('click', () => vscode.postMessage({ type: 'reviewFile' }));
$('#attachBtn').addEventListener('click', () => vscode.postMessage({ type: 'attachFile' }));
$('#imageBtn').addEventListener('click', () => $('#imageFileInput').click());
$('#rulesBtn').addEventListener('click', () => vscode.postMessage({ type: 'openRulesFile' }));
$('#designBtn').addEventListener('click', () => DesignerView.open());
$('#builderBtn').addEventListener('click', () => BuilderView.open());
$('#clearBtn').addEventListener('click', () => {
  if (confirm('Clear ALL chat history?')) vscode.postMessage({ type: 'clearMemory' });
});
$$('.overlay-close').forEach(b => b.addEventListener('click', () => Overlay.closeAll()));

/* ============================================================
   Image attach: file input, paste, drag-drop
   ============================================================ */
function readAndAttachImageFiles(files) {
  for (const f of Array.from(files || [])) {
    if (!f.type || !f.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = () => {
      vscode.postMessage({
        type: 'attachImage',
        imageDataUrl: String(reader.result || ''),
        imageName: f.name || ('pasted-' + Date.now() + '.png'),
      });
    };
    reader.readAsDataURL(f);
  }
}
$('#imageFileInput').addEventListener('change', (e) => {
  readAndAttachImageFiles(e.target.files);
  e.target.value = '';
});
const inputEl = $('#input');
inputEl.addEventListener('paste', (e) => {
  const items = e.clipboardData ? e.clipboardData.items : null;
  if (!items) return;
  const files = [];
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f && f.type.startsWith('image/')) files.push(f);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    readAndAttachImageFiles(files);
  }
});
inputEl.addEventListener('dragover', (e) => { if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) { e.preventDefault(); inputEl.classList.add('drag'); } });
inputEl.addEventListener('dragleave', () => inputEl.classList.remove('drag'));
inputEl.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
  e.preventDefault();
  inputEl.classList.remove('drag');
  readAndAttachImageFiles(e.dataTransfer.files);
});

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
      lastTurnTail = null;
      stream = newStreamState();
      StatusIndicator.set('idle', '');
      Composer.showCancel(false);
      return;
    }
    case 'user': {
      lastTurnTail = null;
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
      // Remember which assistant message owns the edits panel for this turn.
      lastTurnTail = activeMessage;
      return;
    }
    case 'handoff': {
      const p = m.payload || {};
      ChatLog.pushHandoffBanner(p.from, p.to, p.reason);
      return;
    }
    case 'design_progress': {
      DesignerView.progress(m.payload && m.payload.message);
      return;
    }
    case 'design_result': {
      DesignerView.setResult(m.payload || {});
      return;
    }
    case 'design_error': {
      DesignerView.error(m.payload && m.payload.message);
      return;
    }
    case 'builder_progress': {
      const text = (m.payload && (m.payload.message || m.payload)) || '';
      $('#builderStatusText').textContent = String(text);
      return;
    }
    case 'builder_scope': {
      BuilderView.onScope(m.payload || {});
      return;
    }
    case 'builder_step': {
      BuilderView.onStep(m.payload || {});
      return;
    }
    case 'builder_plan': {
      BuilderView.onPlan(m.payload || {});
      return;
    }
    case 'builder_architecture': {
      BuilderView.onArchitecture(m.payload || {});
      return;
    }
    case 'builder_files': {
      BuilderView.onFiles((m.payload && m.payload.files) || m.payload || []);
      return;
    }
    case 'builder_review': {
      BuilderView.onReview(m.payload || {});
      return;
    }
    case 'builder_complete': {
      BuilderView.onComplete(m.payload || {});
      return;
    }
    case 'builder_applied': {
      const p = m.payload || {};
      const written = (p.written || []).length;
      StatusIndicator.set('done', 'Applied ' + written + ' file' + (written === 1 ? '' : 's'));
      setTimeout(() => StatusIndicator.set('idle', ''), 2400);
      return;
    }
    case 'builder_error': {
      BuilderView.setError(m.payload && (m.payload.message || m.payload));
      return;
    }
    case 'edits_summary': {
      const target = lastTurnTail || activeMessage;
      EditsPanel.render(target, (m.payload && m.payload.edits) || []);
      ChatLog.scrollToEnd();
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

  // Workspace rules indicator
  const rulesBtn = $('#rulesBtn');
  const rules = p.workspaceRules || [];
  if (rules.length > 0) {
    rulesBtn.classList.add('active');
    rulesBtn.title = 'Workspace rules loaded: ' + rules.join(', ') + ' (click to open)';
    rulesBtn.textContent = 'RULES \u2022 ' + rules.length;
  } else {
    rulesBtn.classList.remove('active');
    rulesBtn.title = 'No workspace rules. Click to create AGENTS.md.';
    rulesBtn.textContent = 'RULES';
  }

  // Attached images
  const imgRow = $('#attachedImages');
  const imgs = p.attachedImages || [];
  imgRow.innerHTML = imgs.map(img =>
    '<span class="img-chip" title="' + escapeHtml(img.name) + ' (' + Math.round((img.size || 0) / 1024) + ' KB)">' +
      '<span class="img-glyph">\u{1F5BC}\uFE0F</span>' +
      '<span class="img-name">' + escapeHtml(img.name) + '</span>' +
      '<span class="chip-action" data-action="detach-image" data-id="' + escapeHtml(img.id) + '" title="Remove">\u00D7</span>' +
    '</span>'
  ).join('');

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

  if (p.currentSessionMessages) {
    ChatLog.loadSession(p.currentSessionMessages);
  }
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
