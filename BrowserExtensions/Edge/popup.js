// Downex - Popup Script

let settings = {
  enabled: true,
  autoCapture: true,
  minFileSize: 1048576
};

let stats = {
  intercepted: 0,
  captured: 0
};

// Load settings on popup open
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  checkConnection();
  loadStats();
  setupEventListeners();
  loadMedia();
});

function loadSettings() {
  chrome.runtime.sendMessage({ type: 'getSettings' }, (response) => {
    if (response && response.settings) {
      settings = response.settings;
      updateUI();
    }
  });
}

function updateUI() {
  const toggleEnabled = document.getElementById('toggleEnabled');
  const toggleAutoCapture = document.getElementById('toggleAutoCapture');
  
  toggleEnabled.classList.toggle('active', settings.enabled);
  toggleAutoCapture.classList.toggle('active', settings.autoCapture);
}

function checkConnection() {
  const statusDiv = document.getElementById('connectionStatus');
  const statusText = document.getElementById('statusText');
  
  chrome.runtime.sendMessage({ type: 'testConnection' }, (response) => {
    if (response && response.success && response.connected) {
      statusDiv.classList.remove('status-disconnected');
      statusDiv.classList.add('status-connected');
      statusText.textContent = 'Connected';
      statusText.style.color = '#10b981';
    } else {
      statusDiv.classList.remove('status-connected');
      statusDiv.classList.add('status-disconnected');
      statusText.textContent = 'Not Connected';
      statusText.style.color = '#ef4444';
    }
  });
}

function loadStats() {
  chrome.storage.local.get(['stats'], (result) => {
    if (result.stats) {
      stats = result.stats;
      document.getElementById('statIntercepted').textContent = stats.intercepted || 0;
      document.getElementById('statCaptured').textContent = stats.captured || 0;
    }
  });
}

function setupEventListeners() {
  // Toggle enabled
  document.getElementById('toggleEnabled').addEventListener('click', () => {
    settings.enabled = !settings.enabled;
    chrome.runtime.sendMessage({
      type: 'updateSettings',
      settings: { enabled: settings.enabled }
    });
    updateUI();
  });
  
  // Toggle auto-capture
  document.getElementById('toggleAutoCapture').addEventListener('click', () => {
    settings.autoCapture = !settings.autoCapture;
    chrome.runtime.sendMessage({
      type: 'updateSettings',
      settings: { autoCapture: settings.autoCapture }
    });
    updateUI();
  });
  
  // Open app button — send a native message asking the host to bring the app to front
  document.getElementById('btnOpenApp').addEventListener('click', () => {
    chrome.runtime.sendNativeMessage('com.rapiddownload.native', { type: 'openApp' }, (response) => {
      if (chrome.runtime.lastError) {
        alert('Could not open Download Manager.\nMake sure the app is running and Browser Integration is installed.');
      }
    });
  });
  
  // Settings button — re-run connection check as a status refresh
  document.getElementById('btnSettings').addEventListener('click', () => {
    checkConnection();
  });
}

// ---------------------------------------------------------------------------
// Media detected on the current tab
// ---------------------------------------------------------------------------

let activeTabId = null;

function withActiveTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    activeTabId = tab ? tab.id : null;
    callback(tab || null);
  });
}

function formatBytes(n) {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function describeItem(item) {
  switch (item.mediaType) {
    case 'page': return (item.platform || 'page') + ' video';
    case 'hls': return 'HLS stream';
    case 'dash': return 'DASH stream';
    default: return ['File', formatBytes(item.size)].filter(Boolean).join(' - ');
  }
}

function shortName(item) {
  if (item.mediaType === 'page' && item.title) return item.title;
  try {
    const u = new URL(item.url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return (last || u.hostname) + (item.title ? '  (' + item.title + ')' : '');
  } catch (e) {
    return item.url;
  }
}

function renderMedia(items) {
  const list = document.getElementById('mediaList');
  list.textContent = '';
  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No media detected yet. Play the video, then reopen this popup.';
    list.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'media-item';

    const info = document.createElement('div');
    info.className = 'media-info';
    const title = document.createElement('div');
    title.className = 'media-title';
    title.textContent = shortName(item);      // textContent: page-controlled strings, never innerHTML
    title.title = item.url;
    const meta = document.createElement('div');
    meta.className = 'media-meta';
    meta.textContent = describeItem(item);
    info.appendChild(title);
    info.appendChild(meta);

    const btn = document.createElement('button');
    btn.className = 'media-btn';
    btn.textContent = 'Download';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      chrome.runtime.sendMessage({ type: 'sendMedia', tabId: activeTabId, item }, (result) => {
        btn.textContent = result && result.ok ? 'Sent' : 'Failed';
        if (!(result && result.ok)) btn.disabled = false;
      });
    });

    row.appendChild(info);
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function loadMedia() {
  withActiveTab((tab) => {
    if (!tab) { renderMedia([]); return; }
    chrome.runtime.sendMessage({ type: 'getTabMedia', tabId: tab.id }, (response) => {
      renderMedia(response && response.items);
    });
  });

  document.getElementById('btnGrabPage').addEventListener('click', (event) => {
    const btn = event.currentTarget;
    if (activeTabId == null) return;
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: 'grabPage', tabId: activeTabId }, (result) => {
      btn.textContent = result && result.ok ? 'Sent to Download Manager' : 'Failed: ' + ((result && result.error) || 'unknown');
      setTimeout(() => { btn.textContent = 'Grab video from this page'; btn.disabled = false; }, 2500);
    });
  });
}
