/**
 * Background service worker — Markify v3.0
 * Markdown-only context menus + keyboard shortcuts
 */

chrome.runtime.onInstalled.addListener(() => {
  // Page actions
  chrome.contextMenus.create({ id: 'page-convert', title: '📄 Convert page to Markdown', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'page-convert-copy', title: '📋 Convert page & copy to clipboard', contexts: ['page'] });

  // Selection
  chrome.contextMenus.create({ id: 'selection-convert', title: '📝 Convert selection to Markdown', contexts: ['selection'] });

  // Link
  chrome.contextMenus.create({ id: 'link-md', title: '🔗 Copy link as Markdown', contexts: ['link'] });

  // Image
  chrome.contextMenus.create({ id: 'image-md', title: '🖼️ Copy image as Markdown', contexts: ['image'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  await ensureContentScript(tab);

  const id = info.menuItemId;

  // --- Link → Markdown ---
  if (id === 'link-md') {
    const text = info.selectionText || info.linkUrl || '';
    const md = '[' + text + '](' + (info.linkUrl || '') + ')';
    await copyAndFlash(md, tab);
    return;
  }

  // --- Image → Markdown ---
  if (id === 'image-md') {
    const alt = info.selectionText || 'image';
    const md = '![' + alt + '](' + (info.srcUrl || '') + ')';
    await copyAndFlash(md, tab);
    return;
  }

  // --- Selection → Markdown ---
  if (id === 'selection-convert') {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'CONVERT_SELECTION' });
      if (resp?.result) await copyAndFlash(resp.result, tab);
    } catch (e) { flashBadge('✗', '#dc2626', tab.id); }
    return;
  }

  // --- Page → Markdown ---
  if (id === 'page-convert' || id === 'page-convert-copy') {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: 'CONVERT',
        options: { includeTitle: true, includeMetadata: true, keepLinks: true, keepImages: true, codeBlocks: true, smartExtract: true }
      });
      if (resp?.result) {
        await copyAndFlash(resp.result, tab);
      } else if (resp?.error) {
        flashBadge('✗', '#dc2626', tab.id);
      }
    } catch (e) { flashBadge('✗', '#dc2626', tab.id); }
    return;
  }
});

// --- Keyboard shortcuts ---
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) return;
  await ensureContentScript(tab);

  if (command === 'convert-page') {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: 'CONVERT',
        options: { includeTitle: true, includeMetadata: true, keepLinks: true, keepImages: true, codeBlocks: true, smartExtract: true }
      });
      if (resp?.result) await copyAndFlash(resp.result, tab);
      else if (resp?.error) flashBadge('✗', '#dc2626', tab.id);
    } catch (e) { flashBadge('✗', '#dc2626', tab.id); }
    return;
  }

  if (command === 'convert-selection') {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'CONVERT_SELECTION' });
      if (resp?.result) await copyAndFlash(resp.result, tab);
    } catch (e) { flashBadge('✗', '#dc2626', tab.id); }
  }
});

// --- Helpers ---
async function ensureContentScript(tab) {
  try { await chrome.tabs.sendMessage(tab.id, { type: 'PING' }); return; } catch {}
  // tab.url may be undefined in MV3 callbacks (no 'tabs' permission).
  // Just try injecting — executeScript fails gracefully on non-HTTP pages.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['turndown.js', 'turndown-plugin-gfm.js', 'content.js']
    });
  } catch {}
}

async function copyAndFlash(text, tab) {
  const tabId = tab.id;

  // Copy to clipboard via content script isolated world
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: t => navigator.clipboard.writeText(t),
        args: [text]
      });
    } catch {}
  }

  // Save to history
  try {
    const { history = [] } = await chrome.storage.local.get(['history']);
    history.unshift({
      title: tab.title || 'Untitled',
      url: tab.url || '',
      length: text.length,
      content: text,
      time: Date.now()
    });
    if (history.length > 50) history.length = 50;
    await chrome.storage.local.set({ history });
  } catch {}

  // Green check badge covering the icon
  chrome.action.setBadgeText({ text: '✓', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a', tabId });
  chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });

  // Toast notification
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Markify',
      message: 'Markdown copied to clipboard'
    });
  } catch {}

  // Clear badge after 2s
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 2000);
}

function flashBadge(text, color, tabId) {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 2000);
}
