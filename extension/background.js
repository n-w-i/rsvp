const READER = 'app/index.html';
const isPdfUrl = (url = '') => /^https?:/.test(url) && /\.pdf(\?|#|$)/i.test(url);

function openReader(query = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(READER) + query });
}

chrome.action.onClicked.addListener((tab) => {
  openReader(isPdfUrl(tab.url) ? `?src=${encodeURIComponent(tab.url)}` : '');
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'flash-link',
      title: 'Read this PDF with Flash',
      contexts: ['link'],
      targetUrlPatterns: ['*://*/*.pdf*'],
    });
    chrome.contextMenus.create({
      id: 'flash-selection',
      title: 'Read selection with Flash',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'flash-link' && info.linkUrl) {
    openReader(`?src=${encodeURIComponent(info.linkUrl)}`);
  } else if (info.menuItemId === 'flash-selection' && info.selectionText) {
    // Too large for a URL parameter, so hand it over through extension storage.
    await chrome.storage.local.set({ selection: info.selectionText });
    openReader('?selection=1');
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'open-pdf' && msg.url) openReader(`?src=${encodeURIComponent(msg.url)}`);
});
