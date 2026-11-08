// Downex - Content Script
//
// Adds an IDM-style "Download" button over <video> players and a button in the
// YouTube control bar. The script itself never downloads anything and never
// reads page media: it only asks the background script to send "the best thing
// for this tab" to the app (the background owns network sniffing, cookies and
// native messaging).
//
// Notes on what was removed from the previous version (all verified broken):
//  - fetch()/XMLHttpRequest monkey-patching: content scripts run in an isolated
//    world, so the page's own requests were never seen. webRequest in
//    background.js does this properly now.
//  - blob: URL reading into data URLs: freezes pages, cannot work for MSE.
//  - Button gating on `duration >= 10` at registration time: duration is NaN
//    until metadata loads, so the button almost never appeared.

(function () {
  'use strict';

  if (window.__rdmContentLoaded) return;
  window.__rdmContentLoaded = true;

  const MIN_DURATION = 10;          // seconds; live streams (Infinity) always qualify
  const MIN_WIDTH = 200;
  const MIN_HEIGHT = 120;
  const HIDE_AFTER_MS = 2500;

  const config = { enabled: true, showFloatingButton: true };

  const watched = new WeakSet();
  const videos = new Set();          // currently known <video> elements
  let host = null;                   // shadow host holding the floating button + toast
  let barEl = null;
  let button = null;
  let closeBtn = null;
  let countEl = null;
  let toastEl = null;
  let menuEl = null;
  let menuTitleEl = null;
  let menuList = null;
  let dismissedForUrl = null;        // X hides the bar until the page changes
  let activeVideo = null;
  let hideTimer = null;
  let rafPending = false;
  let menuKind = '';                 // 'media' | 'quality'
  let qualityMenuUrl = '';

  // Quality discovery. Formats are prefetched for video pages so the bar can
  // show "N qualities" and the menu opens instantly from cache.
  const formatCache = new Map();     // page URL -> { at, data }
  const FORMAT_TTL_MS = 5 * 60 * 1000;
  let visibleFormats = { url: '', entries: [], title: '' };
  let formatsPageUrl = location.href;
  let formatsLoadingUrl = null;
  let formatsAttemptedFor = '';
  let formatsError = null;
  let formatsTimer = null;

  const VIDEO_SITES = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|instagram\.com|facebook\.com|twitter\.com|x\.com|pornhub\.(com|org)|xvideos\.com|xnxx\.com|xhamster\.com|spankbang\.com|eporner\.com|youporn\.com|redtube\.com|beeg\.com|txxx\.com|mydaddy\.cc|doodstream\.com|streamtape\.com|voe\.sx|mixdrop\.[a-z]+)$/i;
  function isVideoSite() {
    return VIDEO_SITES.test(location.hostname);
  }
  const DOWNLOAD_FILE_RE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|dmg|pkg|exe|msi|iso|apk|deb|rpm|pdf|epub|mobi|mp3|m4a|aac|flac|ogg|wav|opus|mp4|m4v|webm|mkv|mov|avi|flv|wmv|ts|m3u8|mpd|torrent)(\?|#|$)/i;
  let stickyButton = false;

  // ---------------------------------------------------------------- messaging

  function send(message, callback) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          if (callback) callback(null);
          return;
        }
        if (callback) callback(response);
      });
    } catch (e) {
      // "Extension context invalidated" after the extension was reloaded.
      if (callback) callback(null);
    }
  }

  function requestDownload(src, direct, title) {
    send({ type: 'downloadBest', src: src || '', direct: !!direct, title: title || '' }, (response) => {
      if (response && response.success) {
        toast('Sent to Downex', false);
      } else {
        toast((response && response.error) || 'Could not reach Downex', true);
      }
    });
  }

  function requestVideoDownload(entry, url, title) {
    send({
      type: 'downloadVideo',
      url: url || location.href,
      title: title || document.title,
      quality: entry.quality,
      audioOnly: !!entry.audioOnly
    }, (response) => {
      if (response && response.success) {
        toast(entry.audioOnly ? 'Audio sent to Downex'
                              : 'Video sent to Downex', false);
      } else {
        toast((response && response.error) || 'Could not reach Downex', true);
      }
    });
  }

  function closeQualityMenu() {
    menuKind = '';
    qualityMenuUrl = '';
    if (!menuEl) return;
    menuEl.style.display = 'none';
    menuList.textContent = '';
  }

  function formatBytes(n) {
    if (!n || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function mediaName(item, tabTitle) {
    if (item.mediaType === 'page') return item.title || tabTitle || 'This page';
    try {
      const u = new URL(item.url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      return last || u.hostname;
    } catch (e) {
      return item.url || 'Video';
    }
  }

  function mediaMeta(item) {
    if (item.mediaType === 'page') return (item.platform || 'page') + ' video';
    if (item.mediaType === 'hls') return 'HLS stream';
    if (item.mediaType === 'dash') return 'DASH stream';
    return ['File', formatBytes(item.size)].filter(Boolean).join(' · ');
  }

  /** Decoded height of the playing video: the rendition the page actually loaded. */
  function loadedVideoHeight() {
    const h = activeVideo ? Math.round(activeVideo.videoHeight || 0) : 0;
    return h > 0 ? h : 0;
  }

  const QUALITY_PRESETS = [2160, 1440, 1080, 720, 480, 360, 240, 144];

  /** Snap the decoded height to the nearest standard quality so the label and
   *  the saved file name always agree. */
  function loadedQualityHeight() {
    const h = loadedVideoHeight();
    if (!h) return 0;
    return QUALITY_PRESETS.reduce(
      (best, p) => Math.abs(p - h) < Math.abs(best - h) ? p : best,
      QUALITY_PRESETS[0]);
  }

  function loadedQualityLabel() {
    const h = loadedQualityHeight();
    return h ? h + 'p' : '';
  }

  /** Page title without the trailing " - site" / " | site" suffix. */
  function pageTitleText(tabTitle) {
    const title = String(document.title || tabTitle || '').trim();
    const site = location.hostname.replace(/^www\./, '').split('.')[0];
    if (!title || !site) return title;
    const suffix = new RegExp('\\s*[-|–—]\\s*' +
      site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
    return title.replace(suffix, '').trim() || title;
  }

  /** The master playlist covers every rendition; the media playlists are its variants. */
  function primaryStream(manifests) {
    return manifests.find((m) => /master/i.test(m.url)) || manifests[0];
  }

  function qualityCountFor(result) {
    if (result && typeof result.qualityCount === 'number' && result.qualityCount >= 0) {
      return result.qualityCount;
    }
    const entries = (result && result.formats) || [];
    return entries.filter((entry) =>
      entry && !entry.audioOnly && Number(entry.quality) > 0
    ).length;
  }

  function friendlyFormatsError(result) {
    if (result && result.error && /yt-dlp not found/i.test(result.error)) {
      return result.error;
    }
    if (result && result.error &&
        !/^ERROR:|needs to be reloaded|player response|playability/i.test(result.error)) {
      return result.error;
    }
    return 'Could not load the video qualities. Reload the page, then press Retry.';
  }

  function rememberFormats(result) {
    if (!result || !result.success) return;
    const url = result.url || location.href;
    formatCache.set(url, { at: Date.now(), data: result });
    visibleFormats = {
      url,
      entries: result.formats || [],
      title: result.title || ''
    };
    updateCount();
  }

  function syncFormatsPage() {
    if (formatsPageUrl === location.href) return;
    formatsPageUrl = location.href;
    formatsAttemptedFor = '';
    formatsLoadingUrl = null;
    formatsError = null;
    visibleFormats = { url: '', entries: [], title: '' };
  }

  function requestQualityList(url, refresh) {
    send({ type: 'getFormats', url, refresh: !!refresh, referer: location.href }, (response) => {
      if (response && response.success) {
        rememberFormats(response);
      } else {
        formatsError = response;
      }
      if (!menuEl || menuKind !== 'quality' || qualityMenuUrl !== url) return;
      renderQualityMenu(response || { success: false, url });
    });
  }

  function prefetchFormats(force) {
    if (!config.enabled || !config.showFloatingButton) return;
    if (!isVideoSite()) return;
    syncFormatsPage();
    const url = location.href;
    const cached = formatCache.get(url);
    if (!force && cached && Date.now() - cached.at < FORMAT_TTL_MS) {
      rememberFormats(cached.data);
      return;
    }
    if (!force && formatsAttemptedFor === url) return;
    if (formatsLoadingUrl === url) return;
    formatsAttemptedFor = url;
    formatsLoadingUrl = url;
    send({ type: 'getFormats', url }, (response) => {
      if (formatsLoadingUrl === url) formatsLoadingUrl = null;
      if (url !== location.href) return;
      if (response && response.success) {
        formatsError = null;
        rememberFormats(response);
        if (menuKind === 'quality' && qualityMenuUrl === url) {
          renderQualityMenu(response);
        }
      } else {
        formatsError = response;
        if (menuKind === 'quality' && qualityMenuUrl === url) {
          renderQualityMenu(response || { success: false, url });
        }
      }
    });
  }

  function prefetchFormatsSoon() {
    if (formatsTimer) return;
    formatsTimer = setTimeout(() => {
      formatsTimer = null;
      prefetchFormats(false);
    }, 450);
  }

  // Same idea as the extension popup's media list: show what the background
  // sniffed for this tab, and hand the chosen item to the app.
  function openMediaMenu() {
    ensureHost();
    const rect = barEl.getBoundingClientRect();
    menuKind = 'media';
    qualityMenuUrl = '';
    menuTitleEl.textContent = 'Videos on this page';
    menuEl.style.display = 'block';
    menuList.textContent = '';
    const note = document.createElement('div');
    note.className = 'menu-note';
    note.textContent = 'Looking for videos…';
    menuList.appendChild(note);

    const width = 260, height = 320;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';

    send({ type: 'getTabMedia' }, (response) => {
      renderMediaMenu(response);
    });
  }

  function renderMediaMenu(result) {
    if (!menuEl || menuEl.style.display === 'none' || menuKind !== 'media') return;
    menuList.textContent = '';
    const items = (result && result.items) || [];
    if (items.length === 0) {
      const note = document.createElement('div');
      note.className = 'menu-note';
      note.textContent = 'No videos detected yet. Play the video, then click the bar again.';
      menuList.appendChild(note);
    }

    // Sniffed manifest URLs are the player's plumbing, not a choice: on a site
    // without yt-dlp support they say nothing to the user. Collapse them into
    // one row for the video that is actually playing, named after the page and
    // the rendition the page loaded.
    const manifests = items.filter((i) => i.mediaType === 'hls' || i.mediaType === 'dash');
    const collapseStreams = manifests.length > 0 && !items.some((i) => i.mediaType === 'page');
    if (collapseStreams) renderStreamRow(manifests, result);

    items.forEach((item) => {
      if (collapseStreams && (item.mediaType === 'hls' || item.mediaType === 'dash')) return;
      const row = document.createElement('div');
      row.className = 'menu-item';
      const label = document.createElement('span');
      label.textContent = mediaName(item, result && result.tabTitle);
      row.appendChild(label);
      const tag = document.createElement('span');
      tag.className = 'menu-tag';
      tag.textContent = mediaMeta(item);
      row.appendChild(tag);
      row.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeQualityMenu();
        sendItem(item);
      });
      menuList.appendChild(row);
    });

    const grab = document.createElement('div');
    grab.className = 'menu-item';
    const grabLabel = document.createElement('span');
    grabLabel.textContent = 'Grab video from this page';
    grab.appendChild(grabLabel);
    grab.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeQualityMenu();
      send({ type: 'grabPage' }, (response) => {
        if (response && response.ok) {
          toast('Sent to Downex', false);
        } else {
          toast((response && response.error) || 'Could not reach Downex', true);
        }
      });
    });
    menuList.appendChild(grab);
  }

  function renderStreamRow(manifests, result) {
    const item = primaryStream(manifests);
    const title = pageTitleText(result && result.tabTitle);
    const quality = loadedQualityLabel();
    const row = document.createElement('div');
    row.className = 'menu-item';
    const label = document.createElement('span');
    label.textContent = title || 'Video stream';
    row.appendChild(label);
    const tag = document.createElement('span');
    tag.className = 'menu-tag';
    tag.textContent = quality ? 'Stream · ' + quality : 'Stream';
    row.appendChild(tag);
    row.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeQualityMenu();
      // Name the file after the page and pin the rendition that is playing.
      sendItem(Object.assign({}, item, {
        quality: loadedQualityHeight() || null,
        title: title || item.title || document.title,
        preferTitle: true
      }));
    });
    menuList.appendChild(row);
  }

  function renderQualityMenu(result) {
    if (!menuEl || menuEl.style.display === 'none' || menuKind !== 'quality') return;
    menuList.textContent = '';
    const entries = (result && result.formats) || [];
    if (!result || !result.success || entries.length === 0) {
      menuTitleEl.textContent = 'Video quality';
      const note = document.createElement('div');
      note.className = 'menu-note';
      note.textContent = friendlyFormatsError(result);
      menuList.appendChild(note);

      const retry = document.createElement('div');
      retry.className = 'menu-item';
      const retryLabel = document.createElement('span');
      retryLabel.textContent = 'Retry';
      retry.appendChild(retryLabel);
      const retryTag = document.createElement('span');
      retryTag.className = 'menu-tag';
      retryTag.textContent = 'refresh session';
      retry.appendChild(retryTag);
      retry.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const target = qualityMenuUrl || location.href;
        menuList.textContent = '';
        const loading = document.createElement('div');
        loading.className = 'menu-note';
        loading.textContent = 'Refreshing the video session…';
        menuList.appendChild(loading);
        formatsAttemptedFor = '';
        requestQualityList(target, true);
      });
      menuList.appendChild(retry);

      // Not every site is supported by yt-dlp (e.g. embedded players). Offer the
      // direct file so the overlay still works there.
      const src = activeVideo ? (activeVideo.currentSrc || activeVideo.src || '') : '';
      if (/^https?:/i.test(src)) {
        const row = document.createElement('div');
        row.className = 'menu-item';
        const label = document.createElement('span');
        label.textContent = 'Download video file';
        row.appendChild(label);
        row.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeQualityMenu();
          requestDownload(src, true, document.title);
        });
        menuList.appendChild(row);
      }
      return;
    }

    rememberFormats(result);
    const count = qualityCountFor(result);
    menuTitleEl.textContent = count > 0
      ? 'Video quality · ' + count + (count === 1 ? ' quality' : ' qualities')
      : 'Video quality';
    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'menu-item';
      const label = document.createElement('span');
      label.textContent = entry.label || (entry.audioOnly ? 'Audio only' : 'Best available');
      row.appendChild(label);
      if (entry.audioOnly) {
        const tag = document.createElement('span');
        tag.className = 'menu-tag';
        tag.textContent = 'M4A';
        row.appendChild(tag);
      }
      row.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeQualityMenu();
        requestVideoDownload(entry, result.url, result.title);
      });
      menuList.appendChild(row);
    });
  }

  function placeMenu(rect) {
    const width = 230, height = 300;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
  }

  function openQualityList(anchor, target) {
    ensureHost();
    // Measure first: opening from a row clears that row (it lives in the menu).
    const anchorRect = anchor.getBoundingClientRect();
    menuKind = 'quality';
    qualityMenuUrl = target;
    menuTitleEl.textContent = 'Video quality';
    menuEl.style.display = 'block';
    menuList.textContent = '';
    placeMenu(anchorRect);

    // Open from content cache instantly when possible; only the first visit
    // waits for yt-dlp.
    const cached = formatCache.get(target);
    if (cached) {
      renderQualityMenu(cached.data);
      if (Date.now() - cached.at < FORMAT_TTL_MS) return;
    } else {
      const note = document.createElement('div');
      note.className = 'menu-note';
      renderQuickQualities(qualityMenuUrl);
    }
    requestQualityList(target, false);
  }

  // Shown at once while yt-dlp is still reading the page; the exact list replaces it.
  function renderQuickQualities(url) {
    const quick = [
      { label: 'Best available', quality: 0 },
      { label: '1080p', quality: 1080 },
      { label: '720p', quality: 720 },
      { label: '480p', quality: 480 },
      { label: '360p', quality: 360 },
      { label: 'Audio only', audioOnly: true }
    ];
    menuTitleEl.textContent = 'Video quality';
    menuList.textContent = '';
    quick.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'menu-item';
      const label = document.createElement('span');
      label.textContent = entry.label;
      row.appendChild(label);
      if (entry.audioOnly) {
        const tag = document.createElement('span');
        tag.className = 'menu-tag';
        tag.textContent = 'M4A';
        row.appendChild(tag);
      }
      row.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeQualityMenu();
        requestVideoDownload(entry, url, document.title);
      });
      menuList.appendChild(row);
    });
  }

  function openQualityMenu(anchor, url) {
    openQualityList(anchor, url || location.href);
  }

  function sendItem(item) {
    send({ type: 'sendMedia', item }, (response) => {
      if (response && response.ok) {
        toast('Sent to Downex', false);
      } else {
        toast((response && response.error) || 'Could not reach Downex', true);
      }
    });
  }

  // ---------------------------------------------------------------- UI

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .bar {
          position: fixed; display: none; align-items: center; gap: 2px;
          padding: 3px 4px 3px 7px; border-radius: 5px; min-width: 156px; box-sizing: border-box; cursor: pointer;
          background: linear-gradient(135deg, rgba(8,145,178,.96), rgba(16,185,129,.96)); color: #fff;
          font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          box-shadow: 0 2px 8px rgba(0,0,0,.35);
        }
        .bar:hover { background: linear-gradient(135deg, rgb(14,116,144), rgb(5,150,105)); }
        .logo { display: block; width: 20px; height: auto; }
        .btn {
          display: flex; align-items: center; gap: 6px; padding: 0 2px;
          border: 0; background: transparent; color: #fff; cursor: pointer;
          font: inherit;
        }
        .count {
          flex: 1 1 auto; padding: 0 8px; margin-left: 2px; border-left: 1px solid rgba(255,255,255,.3);
          font-size: 11px; font-weight: 500; color: rgba(255,255,255,.8); white-space: nowrap;
        }
        .close {
          flex: 0 0 auto; width: 16px; height: 16px; padding: 0; margin-left: 2px;
          border: 0; border-radius: 4px; display: flex; align-items: center;
          justify-content: center; background: rgba(255,255,255,.14);
          color: rgba(255,255,255,.92); cursor: pointer;
          font: 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .close:hover { background: rgba(255,255,255,.28); color: #fff; }
        .toast {
          position: fixed; top: 20px; right: 20px; display: none; padding: 10px 16px;
          border-radius: 8px; color: #fff; max-width: 320px;
          font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          box-shadow: 0 4px 12px rgba(0,0,0,.3);
        }
        .menu {
          position: fixed; display: none; min-width: 210px; padding: 6px;
          background: rgba(28,28,30,.98); border: 1px solid rgba(255,255,255,.14);
          border-radius: 8px; color: #fff;
          font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          box-shadow: 0 8px 24px rgba(0,0,0,.5);
        }
        .menu-title {
          padding: 6px 10px 4px; font-size: 11px; font-weight: 600;
          color: rgba(255,255,255,.55); text-transform: uppercase; letter-spacing: .05em;
        }
        .menu-item {
          display: flex; align-items: center; justify-content: space-between; gap: 14px;
          padding: 8px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
        }
        .menu-item:hover { background: rgba(8,145,178,.5); }
        .menu-note { padding: 8px 10px; color: rgba(255,255,255,.6); font-weight: 400; line-height: 1.35; }
        .menu-tag { color: rgba(255,255,255,.45); font-size: 11px; }
      </style>
      <div class="bar">
        <button class="btn" type="button" title="Download with Downex" aria-label="Download">
          <img class="logo" alt="Download" width="20" src="data:image/png;base64,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">
        </button>
        <span class="count">1 video</span>
        <button class="close" type="button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="toast"></div>
      <div class="menu">
        <div class="menu-title">Videos on this page</div>
        <div class="menu-list"></div>
      </div>`;
    barEl = root.querySelector('.bar');
    button = root.querySelector('.btn');
    closeBtn = root.querySelector('.close');
    countEl = root.querySelector('.count');
    toastEl = root.querySelector('.toast');
    menuEl = root.querySelector('.menu');
    menuTitleEl = root.querySelector('.menu-title');
    menuList = root.querySelector('.menu-list');
    barEl.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // YouTube: pick the quality (otherwise the app falls back to its default).
      if (/(^|\.)(youtube\.com|youtu\.be)$/.test(location.hostname)) openQualityMenu(barEl, location.href);
      else openMediaMenu();
    });
    closeBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissedForUrl = location.href;
      barEl.style.display = 'none';
      closeQualityMenu();
    });
    attachHost();
  }

  function attachHost() {
    const parent = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function toast(text, isError) {
    ensureHost();
    toastEl.textContent = text;
    toastEl.style.background = isError ? 'rgba(255,59,48,.92)' : 'rgba(52,199,89,.92)';
    toastEl.style.display = 'block';
    setTimeout(() => { if (toastEl) toastEl.style.display = 'none'; }, 3000);
  }

  function isEligible(video) {
    if (!config.enabled || !config.showFloatingButton) return false;
    const rect = video.getBoundingClientRect();
    if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return false;
    const d = video.duration;
    // NaN = metadata not loaded yet: wait for loadedmetadata/durationchange.
    return d === Infinity || (typeof d === 'number' && !isNaN(d) && d >= MIN_DURATION);
  }

  function detectedVideoCount() {
    let count = 0;
    for (const video of videos) {
      if (video.isConnected && isEligible(video)) count++;
    }
    return count;
  }

  function updateCount() {
    if (!countEl) return;
    const qualities = visibleFormats.url === location.href
      ? qualityCountFor({ formats: visibleFormats.entries })
      : 0;
    if (qualities > 0) {
      countEl.textContent = qualities + (qualities === 1 ? ' quality' : ' qualities');
      countEl.style.display = '';
      return;
    }
    const count = Math.max(detectedVideoCount(), activeVideo && isEligible(activeVideo) ? 1 : 0);
    countEl.textContent = count + (count === 1 ? ' video' : ' videos');
    countEl.style.display = count > 0 ? '' : 'none';
  }

  function placeButton(video) {
    if (!barEl) return;
    updateCount();
    if (dismissedForUrl === location.href) { barEl.style.display = 'none'; return; }
    const rect = video.getBoundingClientRect();
    const inView = rect.bottom > 0 && rect.right > 0 &&
                   rect.top < window.innerHeight && rect.left < window.innerWidth;
    if (!inView || !isEligible(video)) { barEl.style.display = 'none'; return; }
    barEl.style.display = 'flex';
    const margin = 10;
    const w = barEl.offsetWidth || 160;
    barEl.style.top = Math.max(0, rect.top + margin) + 'px';
    barEl.style.left = Math.max(0, Math.min(window.innerWidth - w - margin, rect.right - w - margin)) + 'px';
  }

  function showFor(video, keepVisible) {
    if (dismissedForUrl === location.href) return;
    ensureHost();
    attachHost();
    activeVideo = video;
    placeButton(video);
    prefetchFormatsSoon();
    clearTimeout(hideTimer);
    stickyButton = !!keepVisible || isVideoSite();
    if (!stickyButton) {
      hideTimer = setTimeout(() => { if (barEl) barEl.style.display = 'none'; }, HIDE_AFTER_MS);
    }
  }

  function hideButtonSoon() {
    stickyButton = false;
    clearTimeout(hideTimer);
    // IDM keeps its bar on video pages even while paused; only transient
    // buttons on ordinary sites fade out.
    if (isVideoSite()) return;
    hideTimer = setTimeout(() => { if (barEl) barEl.style.display = 'none'; }, 1200);
  }

  // Show the button while the pointer moves over a video (IDM behaviour).
  // Pointer events are checked against video rects because overlays often sit
  // on top of the <video> and swallow events meant for it.
  document.addEventListener('mousemove', (event) => {
    if (!config.enabled || !config.showFloatingButton || videos.size === 0) return;
    if (host && event.composedPath().indexOf(host) !== -1) {      // hovering our own button
      clearTimeout(hideTimer);
      stickyButton = true;
      return;
    }
    for (const video of videos) {
      if (!video.isConnected) { videos.delete(video); continue; }
      const r = video.getBoundingClientRect();
      if (event.clientX >= r.left && event.clientX <= r.right &&
          event.clientY >= r.top && event.clientY <= r.bottom && isEligible(video)) {
        showFor(video, stickyButton);   // stay visible while the video is playing
        return;
      }
    }
  }, true);

  // IDM-style link grab: clicking a file/download link is handed to the app
  // (with a Save/Cancel prompt) instead of letting Chrome save its own copy.
  // Modified clicks open a new tab/window as usual.
  document.addEventListener('click', (event) => {
    if (!config.enabled || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (host && event.composedPath().indexOf(host) !== -1) return;
    const target = event.target;
    const anchor = target && target.closest ? target.closest('a[href]') : null;
    if (!anchor) return;
    const href = anchor.href;
    if (!/^https?:/i.test(href)) return;
    let pathname = '';
    try { pathname = new URL(href).pathname; } catch (e) { return; }
    if (!anchor.hasAttribute('download') && !DOWNLOAD_FILE_RE.test(pathname)) return;
    event.preventDefault();
    event.stopPropagation();
    requestDownload(href, true);
  }, true);

  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (activeVideo && button && button.style.display !== 'none') placeButton(activeVideo);
    });
  }
  window.addEventListener('scroll', scheduleReposition, true);
  window.addEventListener('resize', scheduleReposition);
  document.addEventListener('fullscreenchange', () => {
    if (host) attachHost();
    scheduleReposition();
  });

  // ---------------------------------------------------------------- video discovery

  function maybeShow(video) {
    updateCount();
    if (!isEligible(video)) return;
    if (isVideoSite() || !video.paused) showFor(video, true);
  }

  function watch(video) {
    if (watched.has(video)) return;
    watched.add(video);
    videos.add(video);
    updateCount();
    // Re-evaluate whenever the info that gates the button becomes available.
    ['loadedmetadata', 'durationchange', 'canplay', 'playing', 'emptied'].forEach((name) => {
      video.addEventListener(name, scheduleReposition);
    });
    ['loadedmetadata', 'durationchange', 'canplay', 'playing'].forEach((name) => {
      video.addEventListener(name, () => maybeShow(video));
    });
    // Autoplay, SPA navigation and extension reloads can start playback before
    // this script is injected, so no event would ever fire. Check the current
    // state now instead of waiting for a playing event.
    maybeShow(video);
    video.addEventListener('pause', hideButtonSoon);
    video.addEventListener('ended', hideButtonSoon);
  }

  function bestVideo() {
    let best = null, area = 0;
    for (const video of videos) {
      if (!video.isConnected) { videos.delete(video); continue; }
      if (!isEligible(video)) continue;
      const r = video.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area) { area = a; best = video; }
    }
    return best;
  }

  function scan() {
    if (dismissedForUrl && dismissedForUrl !== location.href) dismissedForUrl = null;
    syncFormatsPage();
    document.querySelectorAll('video').forEach(watch);
    updateCount();
    prefetchFormatsSoon();
    // On dedicated video sites show the bar as soon as the player exists, even
    // while paused — that is the IDM behaviour users expect.
    if (isVideoSite()) {
      const v = bestVideo();
      if (v) showFor(v, true);
    }
  }

  let scanTimer = null;
  function scanSoon() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 300);
  }

  // ---------------------------------------------------------------- YouTube control-bar button

  function injectYouTubeButton() {
    if (window !== window.top || !/(^|\.)youtube\.com$/.test(location.hostname)) return;
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls || controls.querySelector('.rdm-yt-button')) return;

    const b = document.createElement('button');
    b.className = 'ytp-button rdm-yt-button';
    b.title = 'Download with Downex';
    b.innerHTML = '<svg height="100%" version="1.1" viewBox="0 0 36 36" width="100%">' +
      '<path d="M18 22L12 16h4V9h4v7h4l-6 6zm-8 4h16v2H10v-2z" fill="white"/></svg>';
    b.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // IDM-style quality menu; the app analyzes the *page* URL with yt-dlp.
      openQualityMenu(b, location.href);
    });
    controls.insertBefore(b, controls.firstChild);
  }

  function watchYouTube() {
    if (window !== window.top || !/(^|\.)youtube\.com$/.test(location.hostname)) return;
    injectYouTubeButton();
    document.addEventListener('yt-navigate-finish', () => setTimeout(injectYouTubeButton, 300));
    // The player is created late on first load.
    let tries = 0;
    const timer = setInterval(() => {
      injectYouTubeButton();
      if (++tries > 60 || document.querySelector('.rdm-yt-button')) clearInterval(timer);
    }, 500);
  }

  // ---------------------------------------------------------------- messages from extension

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message) return false;
      if (message.action === 'toggleFloatingButtons') {
        config.showFloatingButton = !!message.enabled;
        if (!config.showFloatingButton && barEl) barEl.style.display = 'none';
        sendResponse({ success: true });
        return false;
      }
      if (message.action === 'updateConfig') {
        Object.assign(config, message.config || {});
        sendResponse({ success: true });
        return false;
      }
      return false;
    });
  } catch (e) { /* extension context invalidated */ }

  // ---------------------------------------------------------------- close menu

  document.addEventListener('mousedown', (event) => {
    if (!menuEl || menuEl.style.display === 'none') return;
    if (event.composedPath().indexOf(host) !== -1) return;
    closeQualityMenu();
  }, true);
  window.addEventListener('scroll', closeQualityMenu, true);
  window.addEventListener('resize', closeQualityMenu);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeQualityMenu();
  }, true);

  // ---------------------------------------------------------------- init

  function init() {
    send({ type: 'getSettings' }, (response) => {
      const s = response && response.settings;
      if (s) {
        config.enabled = s.enabled !== false && !(s.videoGrabber && s.videoGrabber.enabled === false);
        if (s.videoGrabber) config.showFloatingButton = s.videoGrabber.showFloatingButton !== false;
        if (!config.enabled || !config.showFloatingButton) {
          if (barEl) barEl.style.display = 'none';
        } else if (isVideoSite()) {
          const v = bestVideo();
          if (v) showFor(v, true);
        }
      }
    });

    scan();
    const root = document.documentElement;
    if (root) {
      new MutationObserver(scanSoon).observe(root, { childList: true, subtree: true });
    }
    watchYouTube();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
