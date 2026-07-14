/* Markify v3.0 — Popup Script */
let currentMarkdown = '';
let detectedSiteType = '';

document.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  loadHistory();
  setupTabs();
  setupConvertButtons();
  setupOutputActions();
  setupThemeToggle();
  setupSettingsBtn();
  setupHistoryActions();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    document.getElementById('pageTitle').textContent = tab.title || 'Untitled';
    document.getElementById('pageUrl').textContent = tab.url || '';

    try { await chrome.tabs.sendMessage(tab.id, { type: 'PING' }); }
    catch {
      if (tab.url?.startsWith('http')) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['turndown.js', 'turndown-plugin-gfm.js', 'content.js']
        });
      }
    }

    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'DETECT' });
      if (resp?.siteType) {
        detectedSiteType = resp.siteType;
        document.getElementById('siteTypeLabel').textContent = formatSiteType(resp.siteType);
        document.querySelector('.site-type-dot').classList.add('detected');
      }
    } catch (_) {}
  } catch (e) { console.error('Init:', e); }
});

function formatSiteType(t) {
  const map = {
    'github': 'GitHub', 'github-issue': 'GitHub Issue', 'github-wiki': 'GitHub Wiki',
    'stackoverflow': 'Stack Overflow', 'webmail': 'Webmail', 'reddit': 'Reddit', 'twitter': 'Twitter / X',
    'wiki': 'Wikipedia', 'blog': 'Blog', 'news': 'News', 'docs': 'Documentation',
    'product': 'Product Page', 'academic': 'Academic Paper', 'forum': 'Forum',
    'generic': 'Generic Page'
  };
  return map[t] || t;
}

/* ---- Tabs ---- */
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });
}

/* ---- Options ---- */
// Loads user-defined settings (custom selectors, YAML template) from
// chrome.storage.local and merges them with the per-conversion checkbox
// options. Returns a Promise because chrome.storage is async.
function getOptions() {
  const checkboxOpts = {
    includeTitle: document.getElementById('optTitle').checked,
    includeMetadata: document.getElementById('optMetadata').checked,
    keepLinks: document.getElementById('optLinks').checked,
    keepImages: document.getElementById('optImages').checked,
    codeBlocks: document.getElementById('optCodeBlocks').checked,
    smartExtract: document.getElementById('optSmartExtract').checked,
  };
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (r) => {
      const s = r.settings || {};
      resolve({
        ...checkboxOpts,
        extraInclude: s.extraInclude || '',
        extraExclude: s.extraExclude || '',
        yamlTemplate: s.yamlTemplate || '',
      });
    });
  });
}

/* ---- Convert ---- */
function setupConvertButtons() {
  document.getElementById('convertBtn').addEventListener('click', () => doConvert('page'));
  document.getElementById('convertSelBtn').addEventListener('click', () => doConvert('selection'));
}

async function doConvert(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('http')) { showStatus('Cannot convert this page.', 'error'); return; }

  const isPage = mode === 'page';
  const btn = isPage ? document.getElementById('convertBtn') : document.getElementById('convertSelBtn');
  const opts = isPage ? await getOptions() : { keepLinks: true, keepImages: true, codeBlocks: true };

  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Converting...';
  hideStatus();

  const outputEl = isPage ? document.getElementById('outputSection') : document.getElementById('selectionOutput');
  outputEl.hidden = true;

  try {
    const msg = isPage
      ? { type: 'CONVERT', options: opts }
      : { type: 'CONVERT_SELECTION' };

    const resp = await chrome.tabs.sendMessage(tab.id, msg);
    if (resp?.result) {
      const md = resp.result;
      if (isPage) {
        currentMarkdown = md;
        document.getElementById('editor').value = md;
        updateStats(md);
      } else {
        document.getElementById('selEditor').value = md;
        document.getElementById('selStat').textContent = md.length.toLocaleString() + ' chars';
        document.getElementById('selectionHint').classList.add('hidden');
      }
      outputEl.hidden = false;

      // Collapse options to free space for output
      if (isPage) {
        const details = document.getElementById('optionsDetails');
        if (details && details.open) details.open = false;
      }

      showStatus('Converted' + (detectedSiteType ? ' (' + formatSiteType(detectedSiteType) + ')' : ''), 'success');
      if (isPage) saveToHistory(tab.title, tab.url, md);
    } else {
      showStatus(resp?.error || (isPage ? 'No content extracted.' : 'No text selected.'), 'error');
    }
  } catch (e) {
    showStatus('Failed. Try refreshing the page.', 'error');
  } finally {
    btn.disabled = false;
    const label = isPage ? 'Convert to Markdown' : 'Convert Selection';
    const sz = isPage ? 16 : 14;
    btn.innerHTML = '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> ' + label;
  }
}

/* ---- Stats ---- */
function updateStats(text) {
  document.getElementById('statChars').textContent = text.length.toLocaleString() + ' chars';
  document.getElementById('statWords').textContent = text.split(/\s+/).filter(Boolean).length.toLocaleString() + ' words';
  document.getElementById('statLines').textContent = text.split('\n').length.toLocaleString() + ' lines';
  document.getElementById('statHeadings').textContent = (text.match(/^#{1,6}\s/gm) || []).length + ' h';
}

/* ---- Output actions ---- */
function setupOutputActions() {
  document.getElementById('copyBtn').addEventListener('click', () => copyText(currentMarkdown, 'copyBtn'));
  document.getElementById('downloadBtn').addEventListener('click', () => downloadMd(currentMarkdown));
  document.getElementById('previewBtn').addEventListener('click', () => togglePreview());
  document.getElementById('selCopyBtn').addEventListener('click', () => copyText(
    document.getElementById('selEditor').value, 'selCopyBtn'
  ));
  document.getElementById('editor').addEventListener('input', e => {
    currentMarkdown = e.target.value;
    updateStats(currentMarkdown);
  });
}

async function copyText(text, btnId) {
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById(btnId);
    const orig = btn.innerHTML;
    btn.classList.add('copied');
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Done';
    setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = orig; }, 1500);
  } catch { showStatus('Copy failed.', 'error'); }
}

function downloadMd(text) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const name = (tabs[0]?.title || 'page').replace(/[^a-zA-Z0-9\s\-_.]/g, '').replace(/\s+/g, '-').substring(0, 80).toLowerCase();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    a.download = name + '.md';
    a.click();
  });
}

function togglePreview() {
  const editor = document.getElementById('editor');
  const preview = document.getElementById('preview');
  const btn = document.getElementById('previewBtn');
  const isPreviewing = !preview.hidden;

  if (isPreviewing) {
    preview.hidden = true;
    editor.hidden = false;
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Preview';
    btn.classList.remove('active');
  } else {
    const md = editor.value || currentMarkdown;
    if (!md.trim()) return;
    preview.innerHTML = marked.parse(md);
    editor.hidden = true;
    preview.hidden = false;
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Edit';
    btn.classList.add('active');
  }
}

/* ---- Theme ---- */
function loadTheme() {
  chrome.storage.local.get(['theme'], r => {
    if (r.theme === 'dark') document.body.dataset.theme = 'dark';
  });
}

function setupThemeToggle() {
  document.getElementById('themeToggle').addEventListener('click', () => {
    const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    chrome.storage.local.set({ theme: next });
  });
}

function setupSettingsBtn() {
  document.getElementById('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

/* ---- History ---- */
function saveToHistory(title, url, content) {
  chrome.storage.local.get(['history'], r => {
    const h = r.history || [];
    h.unshift({ title: title || 'Untitled', url: url || '', length: content.length, content, time: Date.now() });
    if (h.length > 50) h.length = 50;
    chrome.storage.local.set({ history: h }, () => loadHistory());
  });
}

function loadHistory() {
  chrome.storage.local.get(['history'], r => {
    const list = document.getElementById('historyList');
    const h = r.history || [];
    if (!h.length) { list.innerHTML = '<div class="history-empty">No conversions yet</div>'; return; }
    list.innerHTML = h.map((item, i) => {
      const d = new Date(item.time);
      const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const D = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return '<div class="history-item" data-idx="' + i + '"><div class="history-info"><div class="history-item-title">' + escHtml(item.title) + '</div><div class="history-item-meta">' + D + ' ' + t + ' &middot; ' + item.length.toLocaleString() + ' chars</div></div><div class="history-item-actions"><button class="btn-sm hist-copy" data-idx="' + i + '">Copy</button><button class="btn-sm hist-dl" data-idx="' + i + '">Save</button><button class="btn-sm btn-danger hist-del" data-idx="' + i + '">&times;</button></div></div>';
    }).join('');
  });
}

function setupHistoryActions() {
  document.getElementById('historyList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-idx]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    const { history } = await chrome.storage.local.get(['history']);
    const item = history?.[idx];
    if (!item) return;
    if (btn.classList.contains('hist-copy')) {
      await navigator.clipboard.writeText(item.content);
      btn.textContent = 'Done'; setTimeout(() => btn.textContent = 'Copy', 1200);
    } else if (btn.classList.contains('hist-dl')) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([item.content], { type: 'text/markdown;charset=utf-8' }));
      a.download = item.title.replace(/[^a-zA-Z0-9\s\-_.]/g, '').replace(/\s+/g, '-').substring(0, 80).toLowerCase() + '.md';
      a.click();
    } else if (btn.classList.contains('hist-del')) {
      history.splice(idx, 1);
      await chrome.storage.local.set({ history });
      loadHistory();
    }
  });
  document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
    await chrome.storage.local.set({ history: [] });
    loadHistory();
  });
}

/* ---- Utils ---- */
function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
  el.hidden = false;
}
function hideStatus() { document.getElementById('status').hidden = true; }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }