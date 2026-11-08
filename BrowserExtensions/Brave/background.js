// Downex - Background script (Chrome/Edge MV3 service worker,
// also loaded as a Firefox MV2 background script).
//
// Responsibilities
//   1. Capture browser downloads (IDM-style) and hand them to the app.
//   2. Sniff HLS/DASH manifests and direct media files per tab (webRequest),
//      show a per-tab badge, and let the popup / page button send them to the app.
//   3. Hand every request to the app with Referer, Cookie and User-Agent so
//      login-gated links work.
//
// App hand-off contract (native host turns this into a URL-scheme call):
//   downloadmanager://add?url=&filename=&referer=&cookie=&ua=&kind=<file|video>
//   kind=file  -> direct file, multi-segment engine
//   kind=video -> page / manifest URL, yt-dlp video pipeline

'use strict';

const NATIVE_HOST_NAME = 'com.rapiddownload.native';
const MAX_COOKIE_HEADER = 6000;
const MIN_DIRECT_MEDIA_BYTES = 512 * 1024;   // ignore tiny clips / ads / sprites
// Once a tab has a manifest, small direct media responses are its HLS/DASH
// fragments (the player fetches them one by one), not separate videos.
const STREAM_FRAGMENT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_PER_TAB = 40;
const MEDIA_TTL_MS = 60 * 60 * 1000;

// Firefox MV2 exposes browserAction, Chrome MV3 exposes action.
const actionApi = chrome.action || chrome.browserAction || null;

const DEFAULT_SETTINGS = {
  enabled: true,
  autoCapture: true,
  minFileSize: 0, // bytes, 0 = capture all sizes (unknown sizes are never filtered)
  blacklist: [],
  whitelist: [],
  videoGrabber: {
    enabled: true,
    showFloatingButton: true,
    monitorNetworkRequests: true,
    detectEmbeddedVideos: true,
    showNotifications: false
  }
};

let settings = cloneSettings(DEFAULT_SETTINGS);

function cloneSettings(s) {
  return JSON.parse(JSON.stringify(s));
}

function mergeSettings(base, saved) {
  const out = cloneSettings(base);
  if (!saved || typeof saved !== 'object') return out;
  for (const key of Object.keys(saved)) {
    if (key === 'videoGrabber' && saved.videoGrabber && typeof saved.videoGrabber === 'object') {
      out.videoGrabber = Object.assign({}, out.videoGrabber, saved.videoGrabber);
    } else {
      out[key] = saved[key];
    }
  }
  return out;
}

// Handlers await this so a service-worker cold start never runs with defaults.
const settingsReady = new Promise((resolve) => {
  try {
    chrome.storage.local.get(['settings'], (result) => {
      if (!chrome.runtime.lastError && result && result.settings) {
        settings = mergeSettings(DEFAULT_SETTINGS, result.settings);
      }
      resolve();
    });
  } catch (e) {
    resolve();
  }
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests at the bottom of the file)
// ---------------------------------------------------------------------------

const DIRECT_MEDIA_EXT = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv',
                          'mp3', 'm4a', 'flac', 'ogg', 'opus', 'wav'];
// Chunks of a segmented stream: never offered to the user.
const SEGMENT_EXT = ['ts', 'm4s', 'cmfv', 'cmfa', 'cmft', 'm4f', 'aac', 'vtt', 'webvtt',
                     'srt', 'key', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'css', 'js'];
// Hosts whose raw media requests are range-chunks of a page-level player.
// Those are downloaded through the page URL + yt-dlp instead.
const CHUNK_ONLY_HOSTS = [/(^|\.)googlevideo\.com$/i, /(^|\.)ytimg\.com$/i];

function urlPathExt(url) {
  try {
    const p = new URL(url).pathname;
    const m = /\.([A-Za-z0-9]{1,6})$/.exec(p);
    return m ? m[1].toLowerCase() : '';
  } catch (e) {
    return '';
  }
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function isHostBlocked(url) {
  try {
    const host = new URL(url).hostname;
    return CHUNK_ONLY_HOSTS.some((re) => re.test(host));
  } catch (e) {
    return false;
  }
}

function headerValue(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h && h.name && h.name.toLowerCase() === lower) return h.value || '';
  }
  return '';
}

function totalBytesFromHeaders(headers) {
  const range = headerValue(headers, 'content-range');
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) return parseInt(m[1], 10);
  }
  const len = parseInt(headerValue(headers, 'content-length'), 10);
  return Number.isFinite(len) ? len : 0;
}

/**
 * Decide whether a finished response header set is downloadable media.
 * Returns {url, mediaType: 'hls'|'dash'|'file', size} or null.
 */
function classifyResponse(details) {
  const url = details.url;
  if (!isHttpUrl(url) || isHostBlocked(url)) return null;
  if (details.statusCode && details.statusCode >= 400) return null;
  if (details.method && details.method !== 'GET') return null;

  const ext = urlPathExt(url);
  if (SEGMENT_EXT.indexOf(ext) !== -1) return null;

  const ctype = headerValue(details.responseHeaders, 'content-type').toLowerCase().split(';')[0].trim();

  const isHls = ext === 'm3u8' || /mpegurl/.test(ctype);
  if (isHls) return { url, mediaType: 'hls', size: 0 };

  const isDash = ext === 'mpd' || ctype === 'application/dash+xml';
  if (isDash) return { url, mediaType: 'dash', size: 0 };

  const looksMediaType = /^(video|audio)\//.test(ctype) && ctype !== 'video/mp2t';
  const looksMediaExt = DIRECT_MEDIA_EXT.indexOf(ext) !== -1;
  if (!looksMediaType && !looksMediaExt) return null;
  // video/* with no known extension is usually an anonymous range-chunk; require size.
  const size = totalBytesFromHeaders(details.responseHeaders);
  if (size < MIN_DIRECT_MEDIA_BYTES) return null;
  return { url, mediaType: 'file', size };
}

/** Normalise a page URL on a known video platform, or return null. */
function detectPlatformPage(pageUrl) {
  let u;
  try { u = new URL(pageUrl); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const path = u.pathname;

  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (path === '/watch' && v) return { platform: 'youtube', url: 'https://www.youtube.com/watch?v=' + v };
    const sm = /^\/(shorts|live)\/([\w-]{6,})/.exec(path);
    if (sm) return { platform: 'youtube', url: 'https://www.youtube.com/' + sm[1] + '/' + sm[2] };
    return null;
  }
  if (host === 'youtu.be') {
    const id = path.split('/')[1];
    return id ? { platform: 'youtube', url: 'https://www.youtube.com/watch?v=' + id } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    return /\/(video\/)?\d+/.test(path) ? { platform: 'vimeo', url: u.href } : null;
  }
  if (host === 'dailymotion.com') {
    return /^\/video\//.test(path) ? { platform: 'dailymotion', url: u.href } : null;
  }
  if (host === 'twitch.tv') {
    const first = path.split('/')[1] || '';
    const reserved = ['directory', 'settings', 'downloads', 'jobs', 'p', 'turbo', 'store',
                      'subscriptions', 'wallet', 'inventory', 'friends', 'drops', 'search', 'videos'];
    const isVod = /^\/videos\/\d+/.test(path);
    const isClip = /^\/[\w]+\/clip\//.test(path);
    const isChannel = /^\/[\w]+\/?$/.test(path) && reserved.indexOf(first.toLowerCase()) === -1;
    return (isVod || isClip || isChannel) ? { platform: 'twitch', url: u.href } : null;
  }
  if (host === 'tiktok.com') {
    return /\/video\/\d+/.test(path) ? { platform: 'tiktok', url: u.href } : null;
  }
  if (host === 'twitter.com' || host === 'x.com') {
    return /\/status\/\d+/.test(path) ? { platform: 'twitter', url: u.href } : null;
  }
  if (host === 'instagram.com') {
    return /^\/(p|reel|reels|tv)\//.test(path) ? { platform: 'instagram', url: u.href } : null;
  }
  if (host === 'facebook.com' || host === 'fb.watch') {
    return (host === 'fb.watch' || /\/(videos|watch|reel)\b/.test(path)) ? { platform: 'facebook', url: u.href } : null;
  }
  return null;
}

/** Build "a=1; b=2" from cookie objects, never exceeding `limit` characters. */
function buildCookieHeader(cookies, limit) {
  const max = typeof limit === 'number' ? limit : MAX_COOKIE_HEADER;
  const parts = [];
  let len = 0;
  for (const c of cookies || []) {
    if (!c || !c.name) continue;
    const piece = c.name + '=' + (c.value || '');
    const add = piece.length + (parts.length ? 2 : 0); // "; " separator
    if (len + add > max) continue; // skip oversized cookie, keep trying smaller ones
    parts.push(piece);
    len += add;
  }
  return parts.join('; ');
}

function sanitizeFilename(title) {
  let name = String(title || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
  if (name.length > 200) name = name.substring(0, 200);
  return name;
}

/** Strip " - YouTube" style site suffixes from a tab title. */
function cleanTitle(title) {
  return String(title || '').replace(/\s*[-|–—]\s*(YouTube|Vimeo|Dailymotion|Twitch|TikTok|Facebook|Instagram)\s*$/i, '').trim();
}

function basename(pathOrName) {
  if (!pathOrName) return '';
  const parts = String(pathOrName).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/** Params for downloadmanager://add — mirrors what the native host builds. */
function buildSchemeUrl(req) {
  const q = [];
  const put = (k, v) => { if (v) q.push(k + '=' + encodeURIComponent(v)); };
  put('url', req.url);
  put('filename', req.filename);
  put('referer', req.referer);
  put('cookie', req.cookie ? req.cookie.substring(0, MAX_COOKIE_HEADER) : '');
  put('ua', req.userAgent);
  put('kind', req.kind === 'video' ? 'video' : 'file');
  if (req.kind === 'video') {
    if (req.quality != null) put('quality', String(req.quality));
    if (req.audioOnly) put('audio', '1');
  }
  return 'downloadmanager://add?' + q.join('&');
}

function isBlockedByLists(url) {
  if (settings.blacklist.length > 0 && settings.blacklist.some((d) => url.includes(d))) return true;
  if (settings.whitelist.length > 0 && !settings.whitelist.some((d) => url.includes(d))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Native messaging
// ---------------------------------------------------------------------------

function sendNative(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message, transport: true });
        } else {
          resolve(response || { success: false, error: 'Empty response from native host', transport: true });
        }
      });
    } catch (e) {
      resolve({ success: false, error: String(e && e.message || e), transport: true });
    }
  });
}

async function getCookieHeader(url) {
  if (!isHttpUrl(url) || !chrome.cookies) return '';
  try {
    const cookies = await new Promise((resolve) => {
      chrome.cookies.getAll({ url }, (list) => {
        if (chrome.runtime.lastError) resolve([]); else resolve(list || []);
      });
    });
    return buildCookieHeader(cookies, MAX_COOKIE_HEADER);
  } catch (e) {
    return '';
  }
}

/**
 * Cookie objects for the native host. The host writes them to a private
 * Netscape cookie file for yt-dlp, so the app never needs to read the browser's
 * Keychain-encrypted cookie DB (which prompts for the login password).
 * chrome.cookies returns plaintext values without any Keychain access.
 */
async function getCookieObjects(url) {
  if (!isHttpUrl(url) || !chrome.cookies) return [];
  const request = (target) => new Promise((resolve) => {
    chrome.cookies.getAll({ url: target }, (list) => {
      if (chrome.runtime.lastError) resolve([]); else resolve(list || []);
    });
  });
  try {
    const targets = [url];
    // YouTube sessions also need the .google.com account cookies (SID/HSID/
    // SAPISID). chrome.cookies.getAll({url: youtube}) does not return them,
    // which made yt-dlp see a signed-out session and fail with
    // "The page needs to be reloaded".
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (host === 'youtube.com' || host.endsWith('.youtube.com') ||
          host === 'youtu.be' || host.endsWith('.youtu.be')) {
        targets.push('https://www.google.com/');
      }
    } catch (e) { /* keep the page URL cookies */ }

    const lists = await Promise.all(targets.map(request));
    const merged = new Map();
    for (const cookie of lists.flat()) {
      const key = [cookie.domain, cookie.path || '/', cookie.name].join('\t');
      if (!merged.has(key)) merged.set(key, cookie);
    }
    return [...merged.values()].map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      hostOnly: !!c.hostOnly,
      expirationDate: c.expirationDate || 0
    }));
  } catch (e) {
    return [];
  }
}

function currentUserAgent() {
  try { return navigator.userAgent || ''; } catch (e) { return ''; }
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title,
      message
    }, () => { void chrome.runtime.lastError; });
  } catch (e) { /* notifications are best-effort */ }
}

async function bumpStats(field) {
  try {
    const result = await new Promise((resolve) => chrome.storage.local.get(['stats'], resolve));
    const stats = Object.assign({ intercepted: 0, captured: 0 }, result && result.stats);
    stats[field] = (stats[field] || 0) + 1;
    chrome.storage.local.set({ stats });
  } catch (e) { /* ignore */ }
}

/**
 * Send one request to the app.
 * Resolves {ok, error?}. ok === true only when the host reported the app accepted it.
 */
async function sendToApp(req) {
  const kind = req.kind === 'video' ? 'video' : 'file';
  const cookie = req.cookie !== undefined ? req.cookie : await getCookieHeader(req.url);
  const cookies = kind === 'video' ? await getCookieObjects(req.url) : null;
  const payload = {
    url: req.url,
    filename: req.filename || null,
    referer: req.referer || null,
    cookie: cookie || null,
    cookies,
    userAgent: req.userAgent || currentUserAgent() || null,
    kind,
    quality: req.quality != null ? req.quality : null,
    audioOnly: !!req.audioOnly,
    mimeType: req.mimeType || null,
    contentLength: req.contentLength || null
  };
  const response = await sendNative({ type: 'downloadRequest', data: payload });
  if (response && response.success) return { ok: true };
  return { ok: false, error: (response && response.error) || 'Unknown error', transport: !!(response && response.transport) };
}

// ---------------------------------------------------------------------------
// 1. Browser download capture
// ---------------------------------------------------------------------------

chrome.downloads.onCreated.addListener((downloadItem) => {
  captureBrowserDownload(downloadItem).catch((e) => console.error('[RDM] capture error', e));
});

/** Pictures ("Save image as…") are the browser's own business: no capture window. */
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|ico|svg|tiff?|heic)$/i;
function isImageDownload(item, url) {
  if (item.mime && /^image\//i.test(item.mime)) return true;
  const name = item.filename || '';
  if (IMAGE_EXT.test(name)) return true;
  try { return IMAGE_EXT.test(new URL(url).pathname); } catch (e) { return false; }
}

async function captureBrowserDownload(item) {
  await settingsReady;
  if (!settings.enabled || !settings.autoCapture) return;
  if (item.incognito) return;                       // never leak private browsing to the app
  if (item.state && item.state !== 'in_progress') return;

  const url = item.finalUrl || item.url;
  if (!isHttpUrl(url)) return;                      // blob:/data:/file: cannot be fetched by the app
  if (isImageDownload(item, url)) return;           // Save image as... stays with the browser
  if (isBlockedByLists(url)) return;
  // fileSize is -1/0 while unknown at onCreated: only filter when it is really known.
  if (item.fileSize > 0 && item.fileSize < settings.minFileSize) return;

  bumpStats('intercepted');

  const result = await sendToApp({
    url,
    filename: basename(item.filename) || null,
    referer: item.referrer || null,
    kind: 'file',
    mimeType: item.mime || null,
    contentLength: item.fileSize > 0 ? item.fileSize : null
  });

  if (result.ok) {
    bumpStats('captured');
    // Only now that the app owns the download do we remove the browser's copy.
    if (item.id != null) {
      chrome.downloads.cancel(item.id, () => {
        void chrome.runtime.lastError;
        chrome.downloads.erase({ id: item.id }, () => { void chrome.runtime.lastError; });
      });
    }
  } else {
    // Failure path: leave the browser download untouched so nothing is lost.
    console.error('[RDM] App did not accept download, browser keeps it:', result.error);
    if (result.transport) {
      notify('Downex not reachable',
        'The browser is downloading this file itself. Open the app and run Browser Integration > Install Native Host. (' + result.error + ')');
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Per-tab media detection (HLS / DASH / direct media) via webRequest
// ---------------------------------------------------------------------------

// tabId -> { url: string, items: Map<url, item> }
const tabMedia = new Map();
const hasSessionStorage = !!(chrome.storage && chrome.storage.session);
let persistTimer = null;

const mediaStateReady = (async () => {
  if (!hasSessionStorage) return;
  try {
    const data = await new Promise((resolve) => chrome.storage.session.get(['tabMedia'], resolve));
    const saved = data && data.tabMedia;
    if (saved) {
      for (const id of Object.keys(saved)) {
        const entry = saved[id];
        const items = new Map();
        (entry.items || []).forEach((it) => items.set(it.url, it));
        tabMedia.set(Number(id), { url: entry.url || '', items });
      }
    }
  } catch (e) { /* memory-only fallback */ }
})();

function persistMediaSoon() {
  if (!hasSessionStorage) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const out = {};
    for (const [id, entry] of tabMedia.entries()) {
      out[id] = { url: entry.url, items: Array.from(entry.items.values()) };
    }
    try { chrome.storage.session.set({ tabMedia: out }); } catch (e) { /* ignore */ }
  }, 500);
}

function getEntry(tabId) {
  let entry = tabMedia.get(tabId);
  if (!entry) {
    entry = { url: '', items: new Map() };
    tabMedia.set(tabId, entry);
  }
  return entry;
}

function pruneEntry(entry) {
  const cutoff = Date.now() - MEDIA_TTL_MS;
  for (const [key, it] of entry.items.entries()) {
    if (it.detectedAt < cutoff) entry.items.delete(key);
  }
  while (entry.items.size > MAX_MEDIA_PER_TAB) {
    const oldest = entry.items.keys().next().value;
    entry.items.delete(oldest);
  }
}

function hasStreamManifest(entry) {
  if (!entry) return false;
  for (const item of entry.items.values()) {
    if (item.mediaType === 'hls' || item.mediaType === 'dash') return true;
  }
  return false;
}

/** Items worth offering: a manifest already covers the whole stream, so the
 *  player's small direct fragment responses are dropped. */
function visibleMediaItems(entry) {
  const items = entry ? Array.from(entry.items.values()) : [];
  if (!hasStreamManifest(entry)) return items;
  return items.filter((it) => it.mediaType !== 'file' || it.size >= STREAM_FRAGMENT_MAX_BYTES);
}

function pageItemFor(tabUrl, tabTitle) {
  const page = detectPlatformPage(tabUrl);
  if (!page) return null;
  return {
    url: page.url, mediaType: 'page', platform: page.platform,
    title: tabTitle || page.platform, size: 0, kind: 'video'
  };
}

function updateBadge(tabId) {
  if (!actionApi || tabId == null || tabId < 0) return;
  const entry = tabMedia.get(tabId);
  const sniffed = visibleMediaItems(entry).length;
  const platform = entry && entry.url && detectPlatformPage(entry.url) ? 1 : 0;
  const count = sniffed + platform;
  try {
    actionApi.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
    if (count > 0 && actionApi.setBadgeBackgroundColor) {
      actionApi.setBadgeBackgroundColor({ tabId, color: '#007AFF' });
    }
  } catch (e) { /* tab may be gone */ }
}

function recordMedia(tabId, found) {
  const entry = getEntry(tabId);
  if (entry.items.has(found.url)) return;
  // Skip fragments of a stream we already know about.
  if (found.mediaType === 'file' && found.size > 0 &&
      found.size < STREAM_FRAGMENT_MAX_BYTES && hasStreamManifest(entry)) {
    return;
  }
  entry.items.set(found.url, {
    url: found.url,
    mediaType: found.mediaType,           // hls | dash | file
    size: found.size || 0,
    title: '',
    detectedAt: Date.now(),
    kind: found.mediaType === 'file' ? 'file' : 'video'
  });
  pruneEntry(entry);
  persistMediaSoon();
  updateBadge(tabId);
  // Fill in the tab title/url lazily (best effort).
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    entry.url = tab.url || entry.url;
    const it = entry.items.get(found.url);
    if (it) it.title = tab.title || '';
    updateBadge(tabId);
  });
}

if (chrome.webRequest && chrome.webRequest.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId == null || details.tabId < 0) return;
      // Fire-and-forget; never block the request.
      settingsReady.then(() => {
        if (!settings.enabled || !settings.videoGrabber.enabled || !settings.videoGrabber.monitorNetworkRequests) return;
        return mediaStateReady.then(() => {
          const found = classifyResponse(details);
          if (found) recordMedia(details.tabId, found);
        });
      });
    },
    { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
    ['responseHeaders']
  );
}

// Reset a tab's list when it navigates to a different page (incl. SPA navigation).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) {
    if (changeInfo.status === 'complete') updateBadge(tabId);
    return;
  }
  const entry = getEntry(tabId);
  let samePage = false;
  try {
    const a = new URL(entry.url), b = new URL(changeInfo.url);
    samePage = a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch (e) { /* different */ }
  if (!samePage) entry.items.clear();
  entry.url = changeInfo.url;
  persistMediaSoon();
  updateBadge(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  persistMediaSoon();
});

async function getTabMedia(tabId) {
  await mediaStateReady;
  const tab = await new Promise((resolve) => chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t)));
  const entry = tabMedia.get(tabId);
  if (entry) pruneEntry(entry);
  const items = visibleMediaItems(entry);
  const tabUrl = (tab && tab.url) || (entry && entry.url) || '';
  const page = pageItemFor(tabUrl, tab && tab.title);
  const out = [];
  if (page) out.push(page);
  // Manifests first (most useful), then big direct files by size.
  items.sort((a, b) => {
    const rank = (x) => (x.mediaType === 'file' ? 1 : 0);
    return rank(a) - rank(b) || (b.size - a.size) || (b.detectedAt - a.detectedAt);
  });
  // TikTok serves the video as many tiny signed chunks that never play on
  // their own. The page row ("Grab this video from this page") is the only
  // entry that works, so show just that one there.
  try {
    const host = new URL(tabUrl).hostname.replace(/^www\./, '');
    if ((host === 'tiktok.com' || host.endsWith('.tiktok.com')) && page) {
      return { tabUrl, tabTitle: (tab && tab.title) || '', items: [page] };
    }
  } catch (_) {}
  return { tabUrl, tabTitle: (tab && tab.title) || '', items: out.concat(items) };
}

// ---------------------------------------------------------------------------
// 3. Sending media to the app
// ---------------------------------------------------------------------------

// Streaming CDNs often name files after the quality ("720p.mp4"). When the
// user picks such a stream we already know the page title: use it.
function looksLikeQualityLabel(name) {
  return /^\d{2,4}p?$/i.test(String(name || '').trim());
}

function titleFileName(title, ext) {
  let name = sanitizeFilename(title || '')
    .replace(/\.(mp4|m4v|mkv|webm|mov|avi|flv|wmv|mp3|m4a|flac|ogg|opus|wav)$/i, '')
    .trim();
  if (!name || looksLikeQualityLabel(name)) return '';
  return ext ? name + '.' + ext : name;
}

function fileNameForDirect(url, title, preferTitle) {
  const base = basename(decodeURIComponentSafe(new URL(url).pathname));
  const ext = urlPathExt(url);
  if (preferTitle && ext && DIRECT_MEDIA_EXT.indexOf(ext) !== -1) {
    const named = titleFileName(title, ext);
    if (named) return named;
  }
  if (/\.[A-Za-z0-9]{2,5}$/.test(base)) return sanitizeFilename(base);
  const name = sanitizeFilename(title || base || 'video');
  return ext ? name + '.' + ext : name;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

/** Send one media item. `item` = {url, kind, title?, mediaType?}. */
async function sendMediaItem(item, tab) {
  const tabUrl = (tab && tab.url) || '';
  const title = cleanTitle(item.title || (tab && tab.title) || '');
  const kind = item.kind === 'file' ? 'file' : 'video';
  const filename = kind === 'file'
    ? fileNameForDirect(item.url, title, item.preferTitle === true)
    : (sanitizeFilename(title) || null);      // no extension: yt-dlp picks container
  const result = await sendToApp({
    url: item.url,
    filename,
    referer: tabUrl || null,
    kind,
    quality: item.quality,
    audioOnly: item.audioOnly
  });
  if (result.ok) {
    bumpStats('captured');
  } else {
    notify('Could not send to Downex', result.error || 'Unknown error');
  }
  return result;
}

/** Choose the best thing to download for a tab (used by page buttons / context menu). */
async function pickBestForTab(tab, hintSrc) {
  const media = await getTabMedia(tab.id);
  // On YouTube & friends the real quality list comes from yt-dlp, never from a
  // page element (which can be a poster / preview image).
  const platformPage = detectPlatformPage(tab.url);
  if (platformPage) {
    return { url: platformPage.url, kind: 'video', title: tab.title, mediaType: 'page' };
  }
  if (isHttpUrl(hintSrc) && DIRECT_MEDIA_EXT.indexOf(urlPathExt(hintSrc)) !== -1 && !isHostBlocked(hintSrc)) {
    return { url: hintSrc, kind: 'file', title: tab.title, mediaType: 'file', preferTitle: true };
  }
  const page = media.items.find((i) => i.mediaType === 'page');
  if (page) return page;
  const manifest = media.items.find((i) => i.mediaType === 'hls' || i.mediaType === 'dash');
  if (manifest) return Object.assign({}, manifest, { title: manifest.title || tab.title });
  const file = media.items.find((i) => i.mediaType === 'file');
  if (file) return Object.assign({}, file, { title: file.title || tab.title });
  // Last resort: let yt-dlp try the page (it supports thousands of sites).
  if (isHttpUrl(tab.url)) return { url: tab.url, kind: 'video', title: tab.title, mediaType: 'page' };
  return null;
}

// ---------------------------------------------------------------------------
// Quality discovery (IDM-style menu)
// ---------------------------------------------------------------------------

const formatCache = new Map();          // page URL -> { at, data }
const formatInflight = new Map();       // page URL -> Promise<response>
const FORMAT_TTL_MS = 5 * 60 * 1000;

const RETRYABLE_FORMAT_ERROR = /needs to be reloaded|playability|player response|unable to extract|sign in|not a bot|login|403|timed out|temporarily unavailable/i;

function friendlyFormatError(response) {
  const raw = (response && response.error) || '';
  if (/yt-dlp not found/i.test(raw)) return raw;
  if (/needs to be reloaded|playability|player response|unable to extract/i.test(raw)) {
    return 'The site asked for a fresh session. Reload the video page, then press Retry.';
  }
  if (/sign in|not a bot|bot|login/i.test(raw)) {
    return 'This video needs a signed-in browser session. Sign in, reload the page, then press Retry.';
  }
  if (/403|forbidden/i.test(raw)) {
    return 'The site denied access to this video. Open it in the browser, then press Retry.';
  }
  if (/timed out|temporarily unavailable/i.test(raw)) {
    return 'The site took too long to respond. Press Retry in a moment.';
  }
  return 'Could not read this video. Reload the page, then press Retry.';
}

async function requestFormats(url, refresh, referer) {
  const send = async () => {
    // Re-reading chrome.cookies here is what refreshes the session: a video
    // that failed with a stale cookie/player response gets the current ones.
    const cookies = await getCookieObjects(url);
    return sendNative({
      type: 'formats',
      data: {
        url,
        cookies,
        referer: referer || null,
        userAgent: currentUserAgent() || null,
        refresh: !!refresh
      }
    });
  };

  let response = await send();
  if (response && response.success) return response;

  const raw = (response && response.error) || '';
  const retryable = (response && response.retryable) || RETRYABLE_FORMAT_ERROR.test(raw);
  if (retryable && !/yt-dlp not found/i.test(raw)) {
    // One automatic retry after a short pause, with freshly read cookies.
    await new Promise((resolve) => setTimeout(resolve, 650));
    response = await send();
    if (response && response.success) return response;
  }

  return {
    success: false,
    error: friendlyFormatError(response),
    retryable: true,
    autoRetried: retryable
  };
}

async function getFormatsFor(url, options) {
  if (!isHttpUrl(url)) return { success: false, error: 'No page URL' };
  const refresh = !!(options && options.refresh);
  const referer = (options && options.referer) || '';
  if (!refresh) {
    const hit = formatCache.get(url);
    if (hit && Date.now() - hit.at < FORMAT_TTL_MS) return hit.data;
  } else {
    formatCache.delete(url);
  }

  const inflightKey = (refresh ? url + '#refresh' : url) + '|' + referer;
  if (formatInflight.has(inflightKey)) return formatInflight.get(inflightKey);

  const task = requestFormats(url, refresh, referer)
    .then((response) => {
      if (response && response.success) {
        formatCache.set(url, { at: Date.now(), data: response });
      }
      return response;
    })
    .finally(() => formatInflight.delete(inflightKey));

  formatInflight.set(inflightKey, task);
  return task;
}

// ---------------------------------------------------------------------------
// Messages from popup and content scripts
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'getSettings') {
    settingsReady.then(() => sendResponse({ settings }));
    return true;
  }
  if (message.type === 'updateSettings') {
    settingsReady.then(() => {
      settings = mergeSettings(settings, message.settings);
      chrome.storage.local.set({ settings }, () => sendResponse({ success: true }));
    });
    return true;
  }
  if (message.type === 'testConnection') {
    sendNative({ type: 'ping' }).then((response) => {
      if (response && response.success) sendResponse({ success: true, connected: true, response });
      else sendResponse({ success: false, error: response && response.error });
    });
    return true;
  }
  if (message.type === 'getTabMedia') {
    // Popup passes a tabId; the floating bar omits it and gets its sender tab.
    const tabId = message.tabId != null ? message.tabId : (sender.tab && sender.tab.id);
    if (tabId == null) { sendResponse({ items: [] }); return false; }
    getTabMedia(tabId).then(sendResponse);
    return true;
  }
  if (message.type === 'sendMedia') {
    // Explicit item chosen by the user (popup or the floating bar's list).
    const tabId = message.tabId != null ? message.tabId : (sender.tab && sender.tab.id);
    if (tabId == null) { sendResponse({ ok: false, error: 'No tab' }); return false; }
    chrome.tabs.get(tabId, (tab) => {
      const t = chrome.runtime.lastError ? null : tab;
      // Explicit media-list pick: the page title beats a CDN quality name.
      sendMediaItem(Object.assign({}, message.item, { preferTitle: true }), t)
        .then(sendResponse);
    });
    return true;
  }
  if (message.type === 'downloadBest' && sender && sender.tab) {
    // A clicked download link: hand this exact URL to the app. Without the
    // direct flag the page itself would be sent to yt-dlp (wrong for archives).
    const src = typeof message.src === 'string' ? message.src : '';
    if (message.direct && isHttpUrl(src)) {
      const ext = urlPathExt(src);
      const kind = (ext === 'm3u8' || ext === 'mpd') ? 'video' : 'file';
      sendMediaItem({
        url: src,
        kind,
        title: message.title || sender.tab.title,
        mediaType: 'file',
        // Only the overlay's "Download video file" fallback passes a title;
        // clicked download links keep their own file name.
        preferTitle: !!message.title
      }, sender.tab).then((r) => sendResponse({ success: r.ok, error: r.error }));
      return true;
    }
    // From the page button (content script): hint is the <video> src when it is a plain http(s) file.
    pickBestForTab(sender.tab, message.src).then((item) => {
      if (!item) { sendResponse({ success: false, error: 'No downloadable media found on this page' }); return; }
      return sendMediaItem(item, sender.tab).then((r) => sendResponse({ success: r.ok, error: r.error }));
    });
    return true;
  }
  if (message.type === 'getFormats') {
    const url = message.url || (sender && sender.tab && sender.tab.url) || '';
    const referer = message.referer || (sender && sender.tab && sender.tab.url) || '';
    getFormatsFor(url, { refresh: !!message.refresh, referer }).then(sendResponse);
    return true;
  }
  if (message.type === 'downloadVideo' && sender && sender.tab) {
    chrome.tabs.get(sender.tab.id, (tab) => {
      const t = chrome.runtime.lastError ? sender.tab : tab;
      const url = message.url || (t && t.url) || '';
      sendMediaItem({
        url,
        kind: 'video',
        title: message.title || (t && t.title),
        quality: message.quality,
        audioOnly: !!message.audioOnly,
        mediaType: 'page'
      }, t).then((r) => sendResponse({ success: r.ok, error: r.error }));
    });
    return true;
  }
  if (message.type === 'grabPage') {
    // Popup passes a tabId; the floating bar uses its sender tab.
    const tabId = message.tabId != null ? message.tabId : (sender.tab && sender.tab.id);
    if (tabId == null) { sendResponse({ ok: false, error: 'No page to grab' }); return false; }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || !isHttpUrl(tab.url)) { sendResponse({ ok: false, error: 'No page to grab' }); return; }
      const page = detectPlatformPage(tab.url);
      sendMediaItem({ url: page ? page.url : tab.url, kind: 'video', title: tab.title, mediaType: 'page' }, tab).then(sendResponse);
    });
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Context menus (permission "contextMenus" is required in the manifest)
// ---------------------------------------------------------------------------

function createContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    const make = (props) => chrome.contextMenus.create(props, () => { void chrome.runtime.lastError; });
    make({ id: 'rdmLink', title: 'Download with Downex', contexts: ['link'] });
    make({ id: 'rdmMedia', title: 'Download Video/Audio with Downex', contexts: ['video', 'audio'] });
    make({ id: 'rdmPage', title: 'Grab video from this page with Downex', contexts: ['page'] });
  });
}

createContextMenus();

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab) return;
    if (info.menuItemId === 'rdmLink' && info.linkUrl && isHttpUrl(info.linkUrl)) {
      sendToApp({
        url: info.linkUrl,
        filename: basename(decodeURIComponentSafe(new URL(info.linkUrl).pathname)) || null,
        referer: tab.url || null,
        kind: 'file'
      }).then((r) => { if (!r.ok) notify('Could not send to Downex', r.error); });
    } else if (info.menuItemId === 'rdmMedia') {
      pickBestForTab(tab, info.srcUrl).then((item) => item && sendMediaItem(item, tab));
    } else if (info.menuItemId === 'rdmPage' && isHttpUrl(tab.url)) {
      const page = detectPlatformPage(tab.url);
      sendMediaItem({ url: page ? page.url : tab.url, kind: 'video', title: tab.title, mediaType: 'page' }, tab);
    }
  });
}

// Test hook: never defined inside the browser, so this is inert in production.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyResponse, detectPlatformPage, buildCookieHeader, buildSchemeUrl,
    sanitizeFilename, cleanTitle, basename, urlPathExt, totalBytesFromHeaders, mergeSettings,
    fileNameForDirect, DEFAULT_SETTINGS, MAX_COOKIE_HEADER
  };
}
