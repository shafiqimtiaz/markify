/**
 * Background service worker — Markdown This Page v3.0
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
    await copyAndFlash(md, tab.id);
    return;
  }

  // --- Image → Markdown ---
  if (id === 'image-md') {
    const alt = info.selectionText || 'image';
    const md = '![' + alt + '](' + (info.srcUrl || '') + ')';
    await copyAndFlash(md, tab.id);
    return;
  }

  // --- Selection → Markdown ---
  if (id === 'selection-convert') {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'CONVERT_SELECTION' });
      if (resp?.result) await copyAndFlash(resp.result, tab.id);
    } catch (e) { console.error('Selection convert:', e); }
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
        if (id === 'page-convert-copy') {
          await copyAndFlash(resp.result, tab.id);
        } else {
          // Open popup so user sees the result
          // We can't programmatically open popup in MV3, so copy + flash as feedback
          await copyAndFlash(resp.result, tab.id);
        }
      }
    } catch (e) { console.error('Page convert:', e); }
    return;
  }
});

// --- Keyboard shortcuts ---
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id || !tab.url?.startsWith('http')) return;
  await ensureContentScript(tab);

  if (command === 'convert-page') {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: 'CONVERT',
        options: { includeTitle: true, includeMetadata: true, keepLinks: true, keepImages: true, codeBlocks: true, smartExtract: true }
      });
      if (resp?.result) await copyAndFlash(resp.result, tab.id);
    } catch (e) { console.error('Shortcut:', e); }
  }

  if (command === 'convert-selection') {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'CONVERT_SELECTION' });
      if (resp?.result) await copyAndFlash(resp.result, tab.id);
    } catch (e) { console.error('Shortcut sel:', e); }
  }
});

// --- Helpers ---
async function ensureContentScript(tab) {
  try { await chrome.tabs.sendMessage(tab.id, { type: 'PING' }); return; } catch {}
  if (tab.url?.startsWith('http')) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['turndown.js', 'turndown-plugin-gfm.js', 'content.js']
    });
  }
}

async function copyAndFlash(text, tabId) {
  // Use content script isolated world for clipboard (clipboardWrite permission applies)
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text });
  } catch {
    // Fallback: inject into page as last resort
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: t => navigator.clipboard.writeText(t),
        args: [text]
      });
    } catch {}
  }
  chrome.action.setBadgeText({ text: '✓ MD', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a', tabId });
  chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 1500);
}