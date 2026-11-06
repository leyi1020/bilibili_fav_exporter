/**
 * 导出面板的交互逻辑。
 */
(function () {
  'use strict';

  var U = window.FavUtils;
  var Client = window.FavClient;
  var Recovery = window.InvalidRecovery;
  var History = window.FavHistory;
  var HtmlExporter = window.FavHtmlExporter;

  var PAGE_SIZE = 20;
  var SETTINGS_KEY = 'favx-settings';
  var MAX_LOG_LINES = 300;

  var PHASES = {
    fetch: [0, 58],
    recover: [58, 78],
    cover: [78, 96],
    build: [96, 100]
  };

  var state = {
    nav: null,
    uid: 0,
    userName: '',
    loadedUid: 0,
    folders: { fav: [], col: [] },
    tab: 'fav',
    selected: new Set(),
    exporting: false,
    abort: false,
    stats: { foldersDone: 0, foldersTotal: 0, videos: 0, invalid: 0, recovered: 0, skipped: 0 },
    settings: {
      skipScraped: true,
      embedCovers: true,
      recoverInvalid: true,
      saveJson: false,
      coverWidth: 480,
      interval: 600
    },
    result: null
  };

  var el = {};
  var saveSettingsTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    el.accountChip = byId('accountChip');
    el.accountAvatar = byId('accountAvatar');
    el.accountName = byId('accountName');
    el.toggleTheme = byId('toggleTheme');
    el.useMeBtn = byId('useMeBtn');
    el.uidInput = byId('uidInput');
    el.loadBtn = byId('loadBtn');
    el.accountHint = byId('accountHint');
    el.tabButtons = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
    el.favCount = byId('favCount');
    el.colCount = byId('colCount');
    el.folderSearch = byId('folderSearch');
    el.folderList = byId('folderList');
    el.selectAllBtn = byId('selectAllBtn');
    el.clearAllBtn = byId('clearAllBtn');
    el.optSkip = byId('optSkip');
    el.optEmbed = byId('optEmbed');
    el.optRecover = byId('optRecover');
    el.optJson = byId('optJson');
    el.optCoverWidth = byId('optCoverWidth');
    el.optSpeed = byId('optSpeed');
    el.clearCacheBtn = byId('clearCacheBtn');
    el.historyCount = byId('historyCount');
    el.historyHint = byId('historyHint');
    el.exportHistoryBtn = byId('exportHistoryBtn');
    el.importHistoryBtn = byId('importHistoryBtn');
    el.clearHistoryBtn = byId('clearHistoryBtn');
    el.historyFileInput = byId('historyFileInput');
    el.progressPanel = byId('progressPanel');
    el.progressPhase = byId('progressPhase');
    el.progressPercent = byId('progressPercent');
    el.progressBar = byId('progressBar');
    el.progressStats = byId('progressStats');
    el.log = byId('log');
    el.resultPanel = byId('resultPanel');
    el.resultSummary = byId('resultSummary');
    el.resultStats = byId('resultStats');
    el.downloadBtn = byId('downloadBtn');
    el.jsonBtn = byId('jsonBtn');
    el.selectionInfo = byId('selectionInfo');
    el.estimateInfo = byId('estimateInfo');
    el.abortBtn = byId('abortBtn');
    el.startBtn = byId('startBtn');
    el.toast = byId('toast');
  }

  /* ------------------------------ 通用 UI ------------------------------ */

  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      el.toast.classList.remove('is-visible');
    }, 2200);
  }

  function hint(message, type) {
    el.accountHint.textContent = message || '';
    el.accountHint.className = 'hint' + (type ? ' hint--' + type : '');
  }

  function appendLog(message, type) {
    var now = new Date();
    var line = document.createElement('div');
    line.className = 'log-line' + (type ? ' log-line--' + type : '');
    line.textContent =
      '[' +
      String(now.getHours()).padStart(2, '0') +
      ':' +
      String(now.getMinutes()).padStart(2, '0') +
      ':' +
      String(now.getSeconds()).padStart(2, '0') +
      '] ' +
      message;
    var atBottom = el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 24;
    el.log.appendChild(line);
    while (el.log.childNodes.length > MAX_LOG_LINES) {
      el.log.removeChild(el.log.firstChild);
    }
    if (atBottom) {
      el.log.scrollTop = el.log.scrollHeight;
    }
  }

  function clearLog() {
    el.log.textContent = '';
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value >= 1024 * 1024) {
      return (value / (1024 * 1024)).toFixed(1) + ' MB';
    }
    if (value >= 1024) {
      return (value / 1024).toFixed(0) + ' KB';
    }
    return value + ' B';
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  /* ------------------------------ 主题 / 设置 ------------------------------ */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var isDark = theme === 'dark';
    el.toggleTheme.textContent = isDark ? '☀' : '☾';
    el.toggleTheme.setAttribute('aria-label', isDark ? '切换到亮色主题' : '切换到暗色主题');
    try {
      localStorage.setItem('favx-theme', theme);
    } catch (error) {
      // 忽略
    }
  }

  function initTheme() {
    var stored = null;
    try {
      stored = localStorage.getItem('favx-theme');
    } catch (error) {
      stored = null;
    }
    var prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(stored || (prefersDark ? 'dark' : 'light'));
  }

  function loadSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(SETTINGS_KEY, function (data) {
          var saved = data && data[SETTINGS_KEY];
          if (saved && typeof saved === 'object') {
            Object.keys(state.settings).forEach(function (key) {
              if (typeof saved[key] === typeof state.settings[key]) {
                state.settings[key] = saved[key];
              }
            });
          }
          resolve();
        });
      } catch (error) {
        resolve();
      }
    });
  }

  function saveSettings() {
    clearTimeout(saveSettingsTimer);
    saveSettingsTimer = setTimeout(function () {
      try {
        var payload = {};
        payload[SETTINGS_KEY] = state.settings;
        chrome.storage.local.set(payload);
      } catch (error) {
        // 忽略
      }
    }, 250);
  }

  function applySettingsToUI() {
    el.optSkip.checked = state.settings.skipScraped;
    el.optEmbed.checked = state.settings.embedCovers;
    el.optRecover.checked = state.settings.recoverInvalid;
    el.optJson.checked = state.settings.saveJson;
    el.optCoverWidth.value = String(state.settings.coverWidth);
    el.optSpeed.value = String(state.settings.interval);
    el.optCoverWidth.disabled = !state.settings.embedCovers;
  }

  function syncSettingsFromUI() {
    state.settings.skipScraped = el.optSkip.checked;
    state.settings.embedCovers = el.optEmbed.checked;
    state.settings.recoverInvalid = el.optRecover.checked;
    state.settings.saveJson = el.optJson.checked;
    state.settings.coverWidth = Number(el.optCoverWidth.value) || 480;
    state.settings.interval = Number(el.optSpeed.value) || 600;
    el.optCoverWidth.disabled = !state.settings.embedCovers;
    saveSettings();
    updateEstimate();
  }

  /* ------------------------------ 收藏夹列表 ------------------------------ */

  function folderKey(folder) {
    return folder.type + ':' + folder.id;
  }

  function currentTabFolders() {
    return state.folders[state.tab] || [];
  }

  function selectedFolders() {
    var all = state.folders.fav.concat(state.folders.col);
    return all.filter(function (folder) {
      return state.selected.has(folderKey(folder));
    });
  }

  function folderRow(folder) {
    var key = folderKey(folder);
    var checked = state.selected.has(key);
    var isCollection = folder.type === 'col';
    return (
      '<div class="folder-row">' +
      '<label class="folder-check">' +
      '<input type="checkbox" data-key="' + key + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="folder-main">' +
      '<span class="folder-title" title="' + U.escapeHtml(folder.title) + '">' + U.escapeHtml(folder.title) + '</span>' +
      '<span class="folder-sub">' +
      (isCollection ? '订阅合集' : '自建收藏夹') +
      ' · ' + folder.mediaCount + ' 个视频' +
      (folder.intro ? ' · ' + U.escapeHtml(String(folder.intro).slice(0, 40)) : '') +
      '</span>' +
      '</span>' +
      '</label>' +
      (folder.link
        ? '<a class="folder-open" href="' + U.escapeHtml(folder.link) + '" target="_blank" rel="noopener noreferrer" title="在 B 站打开">↗</a>'
        : '') +
      '</div>'
    );
  }

  function renderFolders() {
    el.favCount.textContent = state.folders.fav.length;
    el.colCount.textContent = state.folders.col.length;
    el.tabButtons.forEach(function (button) {
      var isActive = button.getAttribute('data-tab') === state.tab;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    var query = el.folderSearch.value.trim().toLowerCase();
    var folders = currentTabFolders().filter(function (folder) {
      return !query || folder.title.toLowerCase().indexOf(query) >= 0;
    });

    if (folders.length === 0) {
      var isCollection = state.tab === 'col';
      el.folderList.innerHTML =
        '<div class="placeholder">' +
        '<span class="placeholder-icon" aria-hidden="true">' + (isCollection ? '▤' : '★') + '</span>' +
        '<p>' +
        (query
          ? '没有匹配「' + U.escapeHtml(el.folderSearch.value) + '」的' + (isCollection ? '合集' : '收藏夹')
          : state.loadedUid
            ? '这个账号没有' + (isCollection ? '订阅合集' : '自建收藏夹')
            : '输入 UID 并点击「加载收藏夹」') +
        '</p>' +
        '</div>';
      return;
    }
    el.folderList.innerHTML = folders.map(folderRow).join('');
  }

  function updateActionBar() {
    var folders = selectedFolders();
    var total = folders.reduce(function (sum, folder) {
      return sum + (Number(folder.mediaCount) || 0);
    }, 0);
    el.selectionInfo.textContent = folders.length
      ? '已选择 ' + folders.length + ' 个收藏夹 · 约 ' + total + ' 个视频'
      : '未选择收藏夹';
    updateEstimate(folders, total);
    el.startBtn.disabled = folders.length === 0 || state.exporting;
  }

  function updateEstimate(folders, total) {
    folders = folders || selectedFolders();
    total =
      typeof total === 'number'
        ? total
        : folders.reduce(function (sum, folder) {
            return sum + (Number(folder.mediaCount) || 0);
          }, 0);
    if (!folders.length) {
      el.estimateInfo.textContent = '';
      return;
    }
    if (state.settings.embedCovers) {
      var perCover =
        state.settings.coverWidth >= 640 ? 0.05 : state.settings.coverWidth <= 320 ? 0.018 : 0.033;
      var mb = total * perCover;
      el.estimateInfo.textContent = '含封面，预计 ' + Math.max(1, Math.round(mb)) + ' MB 左右';
    } else {
      el.estimateInfo.textContent = '不含封面，文件较小（查看封面需联网）';
    }
  }

  async function loadFolders(uid, options) {
    options = options || {};
    if (state.exporting) {
      return;
    }
    var value = String(uid || '').trim();
    if (!/^\d{1,12}$/.test(value)) {
      hint('请输入正确的数字 UID', 'warn');
      el.uidInput.focus();
      return;
    }
    uid = Number(value);
    if (state.loadedUid && state.loadedUid !== uid) {
      state.selected.clear();
    }
    state.loadedUid = uid;
    state.uid = uid;
    setLoadingFolders(true);
    hint('正在加载 UID ' + uid + ' 的收藏夹…');

    try {
      var fav = await Client.listCreatedFolders(uid);
      state.folders.fav = fav;
      renderFolders();
      updateActionBar();
      hint('已加载 ' + fav.length + ' 个自建收藏夹，正在加载订阅合集…');

      try {
        var col = await Client.listCollectedFolders(uid);
        state.folders.col = col;
        hint('已加载 ' + fav.length + ' 个自建收藏夹、' + col.length + ' 个订阅合集');
      } catch (error) {
        state.folders.col = [];
        hint('订阅合集加载失败：' + error.message, 'warn');
      }

      renderFolders();
      updateActionBar();

      if (options.autoSelectFid) {
        autoSelectFolder(options.autoSelectFid, options.autoSelectType);
      }
    } catch (error) {
      state.folders = { fav: [], col: [] };
      state.selected.clear();
      renderFolders();
      updateActionBar();
      hint(error.message || '加载收藏夹失败', 'error');
    } finally {
      setLoadingFolders(false);
    }
  }

  function autoSelectFolder(fid, type) {
    var candidates = [];
    if (type === 'col') {
      candidates = state.folders.col.filter(function (folder) {
        return Number(folder.id) === Number(fid);
      });
    } else {
      candidates = state.folders.fav.filter(function (folder) {
        return Number(folder.id) === Number(fid);
      });
      if (candidates.length === 0) {
        candidates = state.folders.col.filter(function (folder) {
          return Number(folder.id) === Number(fid);
        });
      }
    }
    if (candidates.length === 0) {
      return;
    }
    var folder = candidates[0];
    state.selected.add(folderKey(folder));
    state.tab = folder.type;
    renderFolders();
    updateActionBar();
    toast('已选中「' + folder.title + '」');
  }

  function setLoadingFolders(loading) {
    el.loadBtn.disabled = loading || state.exporting;
    el.loadBtn.textContent = loading ? '加载中…' : '加载收藏夹';
    el.uidInput.disabled = loading || state.exporting;
    el.folderList.classList.toggle('is-loading', loading);
  }

  /* ------------------------------ 账号 ------------------------------ */

  function renderAccount(nav) {
    if (!nav || !nav.isLogin) {
      el.accountChip.hidden = true;
      return;
    }
    el.accountChip.hidden = false;
    el.accountName.textContent = nav.uname + '（UID ' + nav.mid + '）';
    if (nav.face) {
      var face = nav.face.indexOf('//') === 0 ? 'https:' + nav.face : nav.face;
      el.accountAvatar.src = face;
      el.accountAvatar.hidden = false;
    } else {
      el.accountAvatar.hidden = true;
    }
  }

  async function initAccount() {
    var params = new URLSearchParams(location.search);
    var uidParam = Number(params.get('uid')) || 0;
    var fidParam = Number(params.get('fid')) || 0;
    var typeParam = params.get('type') === 'col' ? 'col' : 'fav';

    try {
      var nav = await Client.getNav();
      state.nav = nav;
      if (nav.isLogin) {
        state.userName = nav.uname;
        renderAccount(nav);
        el.useMeBtn.hidden = false;
        hint('已登录：' + nav.uname + '（UID ' + nav.mid + '）');
        if (!uidParam) {
          el.uidInput.value = String(nav.mid);
        }
      } else {
        hint('未检测到登录状态。读取私密收藏夹前请先登录 bilibili.com。', 'warn');
      }
    } catch (error) {
      hint('获取登录状态失败：' + error.message, 'warn');
    }

    var uid = uidParam || (state.nav && state.nav.isLogin ? state.nav.mid : 0);
    if (uid) {
      el.uidInput.value = String(uid);
      await loadFolders(uid, { autoSelectFid: fidParam, autoSelectType: typeParam });
    }
  }

  /* ------------------------------ 抓取 ------------------------------ */

  function mapMedia(media) {
    var aid = U.aidFromMedia(media);
    var bvid = U.normalizeBvid(media.bvid || media.bv_id) || (aid ? U.avToBv(aid) : '');
    var invalid = U.isInvalidMedia(media);
    var upper = media.upper || {};
    var cover = U.normalizeCoverUrl(media.cover || '');
    if (invalid && U.isPlaceholderCover(cover)) {
      cover = '';
    }
    var counts = media.cnt_info || {};
    return {
      aid: aid,
      bvid: bvid,
      title: String(media.title || '').trim(),
      cover: cover,
      coverRaw: '',
      coverData: '',
      intro: media.intro || '',
      duration: Number(media.duration) || 0,
      pubtime: Number(media.pubtime) || 0,
      favtime: Number(media.fav_time) || Number(media.pubtime) || 0,
      upper: {
        mid: Number(upper.mid) || 0,
        name: upper.name || ''
      },
      stats: {
        play: Number(counts.play) || 0,
        danmaku: Number(counts.danmaku) || 0,
        collect: Number(counts.collect) || 0
      },
      invalid: invalid,
      recovered: false,
      source: ''
    };
  }

  function makeAbortError() {
    var error = new Error('已停止导出');
    error.name = 'AbortError';
    return error;
  }

  function checkAbort() {
    if (state.abort) {
      throw makeAbortError();
    }
  }

  async function fetchFolder(folder, context) {
    var videos = [];
    var seen = new Set();
    var scanned = 0;
    var skipped = 0;
    var page = 1;
    var info = null;

    while (page <= 500) {
      checkAbort();
      var pageData =
        folder.type === 'col'
          ? await Client.getSeasonPage(folder.id, page, PAGE_SIZE)
          : await Client.getFavPage(folder.id, page, PAGE_SIZE);

      if (page === 1) {
        info = pageData && pageData.info ? pageData.info : null;
      }
      var medias = (pageData && pageData.medias) || [];
      medias.forEach(function (media) {
        var video = mapMedia(media);
        var dedupeKey = video.aid ? 'av' + video.aid : 'bv' + video.bvid;
        if (seen.has(dedupeKey)) {
          return;
        }
        seen.add(dedupeKey);
        scanned += 1;
        if (context.skipEnabled && video.bvid && History.has(context.skipFolder, video.bvid)) {
          skipped += 1;
          state.stats.skipped += 1;
          return;
        }
        videos.push(video);
        state.stats.videos += 1;
        if (video.invalid) {
          state.stats.invalid += 1;
        }
      });

      var fetched = context.scannedBefore + scanned;
      setProgress(
        'fetch',
        fetched,
        context.expectedTotal,
        '抓取「' + folder.title + '」' +
          (context.folderCount > 1 ? '（' + (context.index + 1) + '/' + context.folderCount + '）' : '') +
          '：已扫描 ' + fetched + ' / ' + context.expectedTotal + ' 个，新增 ' + videos.length + ' 个'
      );
      renderProgressStats();

      if (!pageData || !pageData.has_more || medias.length === 0) {
        break;
      }
      if (folder.mediaCount && scanned >= folder.mediaCount) {
        break;
      }
      page += 1;
    }

    var upper = (info && info.upper) || folder.upper || null;
    return {
      id: folder.id,
      type: folder.type,
      title: (info && info.title) || folder.title,
      historyTitle: folder.title,
      intro: (info && info.intro) || folder.intro || '',
      cover: U.normalizeCoverUrl((info && info.cover) || folder.cover || ''),
      mediaCount: videos.length,
      upper: upper
        ? { mid: Number(upper.mid) || 0, name: upper.name || '' }
        : { mid: 0, name: '' },
      link: folder.link || '',
      scanned: scanned,
      skipped: skipped,
      videos: videos
    };
  }

  /* ------------------------------ 失效还原 ------------------------------ */

  function applyRecovered(video, meta) {
    if (!meta) {
      return;
    }
    var providers = [];
    if (U.isUsableTitle(meta.title, video.aid)) {
      video.title = String(meta.title).trim();
      if (meta.titleSource) {
        providers.push(meta.titleSource);
      }
    }
    if (U.isGoodCoverUrl(meta.pic)) {
      video.cover = meta.pic;
      video.coverRaw = meta.picRaw || '';
      if (meta.coverSource) {
        providers.push(meta.coverSource);
      }
    }
    if (meta.ownerName) {
      video.upper.name = meta.ownerName;
    }
    if (meta.ownerMid > 0) {
      video.upper.mid = meta.ownerMid;
    }
    if (meta.bvid) {
      video.bvid = meta.bvid;
    }
    if (meta.pubtime && !video.pubtime) {
      video.pubtime = meta.pubtime;
    }
    if (meta.duration && !video.duration) {
      video.duration = meta.duration;
    }
    providers = providers
      .map(function (value) {
        return String(value).split(':')[0];
      })
      .filter(Boolean);
    video.source = Array.from(new Set(providers)).join(',');
    video.recovered = Boolean(video.source || meta.ownerName);
    if (video.recovered) {
      state.stats.recovered += 1;
    }
  }

  async function recoverInvalidVideos(data) {
    var invalidVideos = [];
    data.folders.forEach(function (folder) {
      folder.videos.forEach(function (video) {
        if (video.invalid) {
          invalidVideos.push(video);
        }
      });
    });
    if (invalidVideos.length === 0) {
      appendLog('没有失效视频，跳过还原。');
      return;
    }
    appendLog('开始还原 ' + invalidVideos.length + ' 个失效视频（biliplus / jijidown 归档）…');
    setProgress('recover', 0, invalidVideos.length, '还原失效视频：准备中…');

    var items = [];
    var seen = new Set();
    invalidVideos.forEach(function (video) {
      var aid = Number(video.aid) || (video.bvid ? U.bvToAv(video.bvid) : 0);
      if (!aid || seen.has(aid)) {
        return;
      }
      seen.add(aid);
      items.push({ aid: aid, bvid: video.bvid });
    });

    var metas;
    try {
      metas = await Recovery.recover(items, {
        shouldAbort: function () {
          return state.abort;
        },
        onProgress: function (progress) {
          setProgress('recover', progress.done, progress.total, progress.label || '还原失效视频…');
        }
      });
    } catch (error) {
      appendLog('还原失效视频时出错：' + error.message, 'error');
      return;
    }

    if (state.abort) {
      throw makeAbortError();
    }

    invalidVideos.forEach(function (video) {
      var aid = Number(video.aid) || (video.bvid ? U.bvToAv(video.bvid) : 0);
      applyRecovered(video, metas.get(aid));
    });

    renderProgressStats();
    appendLog(
      '失效视频还原完成：' + state.stats.recovered + ' / ' + invalidVideos.length + ' 个补全了标题 / 封面 / UP 主信息。',
      'ok'
    );
  }

  /* ------------------------------ 封面 ------------------------------ */

  function blobToDataUrl(blob) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(typeof reader.result === 'string' ? reader.result : '');
      };
      reader.onerror = function () {
        resolve('');
      };
      reader.readAsDataURL(blob);
    });
  }

  async function fetchOneCover(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 15000);
    try {
      var response = await fetch(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      if (!response.ok) {
        return '';
      }
      var type = response.headers.get('content-type') || '';
      if (type.indexOf('image/') !== 0) {
        return '';
      }
      var buffer = await response.arrayBuffer();
      if (!buffer.byteLength || buffer.byteLength > 4 * 1024 * 1024) {
        return '';
      }
      return await blobToDataUrl(new Blob([buffer], { type: type.split(';')[0] || 'image/jpeg' }));
    } catch (error) {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchCoverAsDataUrl(cover, coverRaw, width) {
    var candidates = U.coverCandidates(cover, coverRaw, width);
    for (var index = 0; index < candidates.length; index++) {
      var result = await fetchOneCover(candidates[index]);
      if (result) {
        return result;
      }
    }
    return '';
  }

  function mapLimit(items, limit, mapper) {
    return new Promise(function (resolve) {
      var results = new Array(items.length);
      var index = 0;
      var running = 0;
      var size = Math.min(Math.max(1, limit), items.length);
      if (size === 0) {
        resolve(results);
        return;
      }
      function next() {
        if (index >= items.length && running === 0) {
          resolve(results);
          return;
        }
        while (running < size && index < items.length) {
          (function (current) {
            running += 1;
            Promise.resolve()
              .then(function () {
                return mapper(items[current], current);
              })
              .then(
                function (value) {
                  results[current] = value;
                },
                function () {
                  results[current] = undefined;
                }
              )
              .then(function () {
                running -= 1;
                next();
              });
          })(index);
          index += 1;
        }
      }
      next();
    });
  }

  async function embedCovers(data) {
    var videos = [];
    data.folders.forEach(function (folder) {
      folder.videos.forEach(function (video) {
        if (video.cover || video.coverRaw) {
          videos.push(video);
        }
      });
    });
    if (videos.length === 0) {
      appendLog('没有可嵌入的封面。');
      return;
    }
    var concurrency = state.settings.interval <= 400 ? 6 : state.settings.interval >= 900 ? 2 : 4;
    var done = 0;
    var ok = 0;
    var failed = 0;
    appendLog('开始嵌入封面（' + videos.length + ' 张，尺寸 ' + state.settings.coverWidth + 'px）…');
    setProgress('cover', 0, videos.length, '嵌入封面：准备中…');

    await mapLimit(videos, concurrency, async function (video) {
      if (state.abort) {
        return;
      }
      var dataUrl = await fetchCoverAsDataUrl(
        video.cover,
        video.coverRaw,
        state.settings.coverWidth
      );
      if (dataUrl) {
        video.coverData = dataUrl;
        ok += 1;
      } else {
        video.coverData = '';
        failed += 1;
      }
      done += 1;
      if (done % 3 === 0 || done === videos.length) {
        setProgress('cover', done, videos.length, '嵌入封面 ' + done + ' / ' + videos.length);
      }
    });

    if (state.abort) {
      throw makeAbortError();
    }
    appendLog(
      '封面嵌入完成：成功 ' + ok + ' 张' + (failed ? '，' + failed + ' 张将使用远程地址' : '') + '。',
      failed ? 'warn' : 'ok'
    );
  }

  /* ------------------------------ 进度 ------------------------------ */

  function setProgress(phase, done, total, label) {
    var range = PHASES[phase] || [0, 100];
    var fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
    var percent = range[0] + (range[1] - range[0]) * fraction;
    el.progressBar.style.width = percent.toFixed(2) + '%';
    el.progressPercent.textContent = Math.round(percent) + '%';
    if (label) {
      el.progressPhase.textContent = label;
    }
  }

  function renderProgressStats() {
    var stats = state.stats;
    el.progressStats.innerHTML =
      '<span class="ps">收藏夹 <strong>' + stats.foldersDone + '/' + stats.foldersTotal + '</strong></span>' +
      '<span class="ps">新增视频 <strong>' + stats.videos + '</strong></span>' +
      (stats.skipped > 0
        ? '<span class="ps ps--skip">跳过已抓取 <strong>' + stats.skipped + '</strong></span>'
        : '') +
      '<span class="ps ps--warn">失效 <strong>' + stats.invalid + '</strong></span>' +
      '<span class="ps ps--ok">已还原 <strong>' + stats.recovered + '</strong></span>';
  }

  /* ------------------------------ 结果 ------------------------------ */

  function downloadBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 120000);
  }

  function buildMeta(data) {
    var total = 0;
    var invalid = 0;
    var recovered = 0;
    var embedded = 0;
    data.folders.forEach(function (folder) {
      folder.videos.forEach(function (video) {
        total += 1;
        if (video.invalid) {
          invalid += 1;
          if (video.recovered) {
            recovered += 1;
          }
        }
        if (video.coverData) {
          embedded += 1;
        }
      });
    });
    var version = '1.0.0';
    try {
      version = chrome.runtime.getManifest().version;
    } catch (error) {
      // 忽略
    }
    return {
      generator: '哔哩哔哩收藏夹导出（HTML）',
      version: version,
      exportedAt: Math.floor(Date.now() / 1000),
      uid: state.uid,
      userName: state.userName || '',
      folderCount: data.folders.length,
      videoCount: total,
      invalidCount: invalid,
      recoveredCount: recovered,
      skippedCount: state.stats.skipped,
      coverEmbedded: embedded,
      embedCovers: state.settings.embedCovers
    };
  }

  function showResult(result) {
    var meta = result.data.meta;
    el.resultPanel.hidden = false;
    el.resultSummary.textContent =
      '已导出 ' +
      meta.folderCount +
      ' 个收藏夹、' +
      meta.videoCount +
      ' 个视频' +
      (meta.invalidCount
        ? '（失效 ' + meta.invalidCount + ' 个，已还原 ' + meta.recoveredCount + ' 个）'
        : '') +
      (meta.skippedCount ? '，跳过 ' + meta.skippedCount + ' 个已抓取视频' : '') +
      '。';

    var rows = [
      ['HTML 文件', result.fileName],
      ['文件大小', formatBytes(result.blob.size)],
      ['视频数量', String(meta.videoCount)],
      ['跳过已抓取', meta.skippedCount ? String(meta.skippedCount) : '无'],
      ['失效 / 已还原', meta.invalidCount + ' / ' + meta.recoveredCount],
      ['内嵌封面', meta.embedCovers ? String(meta.coverEmbedded) : '未嵌入'],
      ['生成时间', U.formatDateTime(meta.exportedAt)]
    ];
    el.resultStats.innerHTML = rows
      .map(function (row) {
        return (
          '<div class="result-row">' +
          '<dt>' + U.escapeHtml(row[0]) + '</dt>' +
          '<dd title="' + U.escapeHtml(row[1]) + '">' + U.escapeHtml(row[1]) + '</dd>' +
          '</div>'
        );
      })
      .join('');
    el.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function jsonFileName(htmlFileName) {
    return String(htmlFileName || 'bilibili-favorites.html').replace(/\.html?$/i, '') + '.json';
  }

  function collectRecords(data) {
    var records = [];
    data.folders.forEach(function (folder) {
      var folderName = folder.historyTitle || folder.title;
      folder.videos.forEach(function (video) {
        if (video.bvid) {
          records.push({ folder: folderName, bvid: video.bvid, title: video.title });
        }
      });
    });
    return records;
  }

  function updateHistoryUI() {
    var count = History.size();
    el.historyCount.textContent = count + ' 个视频';
    var busy = state.exporting;
    el.exportHistoryBtn.disabled = busy || count === 0;
    el.clearHistoryBtn.disabled = busy || count === 0;
    el.importHistoryBtn.disabled = busy;
    el.historyHint.textContent = count
      ? '已记录 ' + count + ' 个视频。开启「跳过已抓取的视频」后，同一收藏夹内 BV 号相同的视频会被跳过。'
      : '还没有记录。每次导出成功后会自动记录收藏夹名称、BV 号与视频名称。';
  }

  /* ------------------------------ 导出主流程 ------------------------------ */

  function setUILocked(locked) {
    [
      el.uidInput,
      el.loadBtn,
      el.useMeBtn,
      el.selectAllBtn,
      el.clearAllBtn,
      el.folderSearch,
      el.optSkip,
      el.optEmbed,
      el.optRecover,
      el.optJson,
      el.optCoverWidth,
      el.optSpeed,
      el.clearCacheBtn,
      el.exportHistoryBtn,
      el.importHistoryBtn,
      el.clearHistoryBtn
    ].forEach(function (node) {
      node.disabled = locked;
    });
    el.tabButtons.forEach(function (button) {
      button.disabled = locked;
    });
    el.folderList.classList.toggle('is-locked', locked);
    if (!locked) {
      el.optCoverWidth.disabled = !state.settings.embedCovers;
      updateHistoryUI();
    }
  }

  async function startExport() {
    if (state.exporting) {
      return;
    }
    var folders = selectedFolders();
    if (folders.length === 0) {
      toast('请先选择要导出的收藏夹');
      return;
    }

    state.exporting = true;
    state.abort = false;
    state.stats = {
      foldersDone: 0,
      foldersTotal: folders.length,
      videos: 0,
      invalid: 0,
      recovered: 0,
      skipped: 0
    };
    state.result = null;

    el.resultPanel.hidden = true;
    el.progressPanel.hidden = false;
    el.abortBtn.hidden = false;
    el.abortBtn.disabled = false;
    el.startBtn.disabled = true;
    el.startBtn.textContent = '导出中…';
    clearLog();
    setUILocked(true);
    renderProgressStats();
    setProgress('fetch', 0, 1, '准备中…');
    el.progressPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    appendLog('开始导出：共 ' + folders.length + ' 个收藏夹。');

    var skipEnabled = Boolean(state.settings.skipScraped);
    if (skipEnabled) {
      await History.load(true);
      appendLog('已加载抓取记录：' + History.size() + ' 条。');
    }

    await Client.setInterval(state.settings.interval);

    var data = {
      meta: {},
      folders: []
    };
    var expectedTotal = folders.reduce(function (sum, folder) {
      return sum + Math.max(Number(folder.mediaCount) || 0, 20);
    }, 0);
    var scannedBefore = 0;
    var failedFolders = 0;

    try {
      for (var index = 0; index < folders.length; index++) {
        checkAbort();
        var folder = folders[index];
        appendLog('开始抓取「' + folder.title + '」（' + (index + 1) + '/' + folders.length + '）');
        try {
          var folderData = await fetchFolder(folder, {
            index: index,
            folderCount: folders.length,
            expectedTotal: expectedTotal,
            scannedBefore: scannedBefore,
            skipEnabled: skipEnabled,
            skipFolder: folder.title
          });
          scannedBefore += folderData.scanned;
          state.stats.foldersDone += 1;
          renderProgressStats();
          if (folderData.videos.length === 0) {
            appendLog(
              '「' + folder.title + '」没有需要导出的新视频' +
                (folderData.skipped ? '（' + folderData.skipped + ' 个已抓取）' : '') +
                '，跳过。',
              'ok'
            );
            continue;
          }
          data.folders.push(folderData);
          appendLog(
            '「' + folder.title + '」完成：新增 ' + folderData.videos.length + ' 个' +
              (folderData.skipped ? '，跳过 ' + folderData.skipped + ' 个已抓取' : '') +
              '。',
            'ok'
          );
        } catch (error) {
          if (error && error.name === 'AbortError') {
            throw error;
          }
          appendLog('「' + folder.title + '」抓取失败：' + error.message, 'error');
          failedFolders += 1;
        }
      }

      if (data.folders.length === 0) {
        if (state.stats.skipped > 0 && failedFolders === 0) {
          appendLog(
            '本次没有新的视频需要导出：' +
              state.stats.skipped +
              ' 个视频已在抓取记录中。可关闭「跳过已抓取的视频」后重新导出。',
            'warn'
          );
          el.progressPhase.textContent = '没有新的视频';
          toast('没有新的视频，全部已抓取过');
          return;
        }
        throw new Error('没有成功抓取到任何收藏夹，请检查登录状态或 UID。');
      }

      if (state.settings.recoverInvalid) {
        await recoverInvalidVideos(data);
      }

      if (state.settings.embedCovers) {
        await embedCovers(data);
      }

      checkAbort();
      setProgress('build', 0, 1, '正在生成 HTML 文档…');
      appendLog('正在生成 HTML 文档…');

      data.meta = buildMeta(data);
      var html = await HtmlExporter.build(data);
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var fileName = HtmlExporter.buildFileName(data);
      state.result = { blob: blob, fileName: fileName, data: data };

      setProgress('build', 1, 1, '生成完成');
      appendLog('HTML 已生成：' + fileName + '（' + formatBytes(blob.size) + '）', 'ok');
      downloadBlob(blob, fileName);
      appendLog('已开始下载 HTML 文件。');

      if (state.settings.saveJson) {
        var jsonBlob = new Blob([JSON.stringify(data, null, 2)], {
          type: 'application/json;charset=utf-8'
        });
        downloadBlob(jsonBlob, jsonFileName(fileName));
        appendLog('已开始下载 JSON 备份。');
      }

      var records = collectRecords(data);
      if (records.length > 0) {
        try {
          var saved = await History.addRecords(records);
          updateHistoryUI();
          appendLog(
            '抓取记录已更新：新增 ' + saved.added + ' 条' +
              (saved.updated ? '、更新 ' + saved.updated + ' 条' : '') +
              '，共 ' + saved.total + ' 条。',
            'ok'
          );
        } catch (error) {
          appendLog('写入抓取记录失败：' + error.message, 'warn');
        }
      }

      showResult(state.result);
      toast('导出完成');
    } catch (error) {
      if (error && error.name === 'AbortError') {
        appendLog('已停止导出。已抓取的内容不会保存。', 'warn');
        el.progressPhase.textContent = '已停止导出';
      } else {
        appendLog('导出失败：' + (error && error.message ? error.message : String(error)), 'error');
        el.progressPhase.textContent = '导出失败';
        toast('导出失败：' + (error && error.message ? error.message : error));
      }
    } finally {
      state.exporting = false;
      el.abortBtn.hidden = true;
      el.startBtn.textContent = '开始导出 HTML';
      setUILocked(false);
      updateActionBar();
    }
  }

  /* ------------------------------ 事件 ------------------------------ */

  function bindEvents() {
    el.toggleTheme.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    el.loadBtn.addEventListener('click', function () {
      loadFolders(el.uidInput.value);
    });

    el.uidInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        loadFolders(el.uidInput.value);
      }
    });

    el.useMeBtn.addEventListener('click', function () {
      if (!state.nav || !state.nav.isLogin) {
        return;
      }
      el.uidInput.value = String(state.nav.mid);
      loadFolders(state.nav.mid);
    });

    el.tabButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        if (state.exporting) {
          return;
        }
        state.tab = button.getAttribute('data-tab');
        renderFolders();
      });
    });

    el.folderSearch.addEventListener('input', function () {
      renderFolders();
    });

    el.folderList.addEventListener('change', function (event) {
      var checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox) {
        return;
      }
      var key = checkbox.getAttribute('data-key');
      if (checkbox.checked) {
        state.selected.add(key);
      } else {
        state.selected.delete(key);
      }
      updateActionBar();
    });

    el.selectAllBtn.addEventListener('click', function () {
      var checkboxes = el.folderList.querySelectorAll('input[type="checkbox"]');
      Array.prototype.forEach.call(checkboxes, function (checkbox) {
        checkbox.checked = true;
        state.selected.add(checkbox.getAttribute('data-key'));
      });
      updateActionBar();
    });

    el.clearAllBtn.addEventListener('click', function () {
      state.selected.clear();
      renderFolders();
      updateActionBar();
    });

    [el.optSkip, el.optEmbed, el.optRecover, el.optJson, el.optCoverWidth, el.optSpeed].forEach(function (node) {
      node.addEventListener('change', syncSettingsFromUI);
    });

    el.exportHistoryBtn.addEventListener('click', function () {
      if (History.size() === 0) {
        toast('还没有可导出的抓取记录');
        return;
      }
      var blob = new Blob([History.toJson()], { type: 'application/json;charset=utf-8' });
      downloadBlob(blob, History.fileName());
      toast('抓取记录已导出');
    });

    el.importHistoryBtn.addEventListener('click', function () {
      el.historyFileInput.click();
    });

    el.historyFileInput.addEventListener('change', async function () {
      var file = el.historyFileInput.files && el.historyFileInput.files[0];
      if (!file) {
        return;
      }
      try {
        var text = await file.text();
        var result = await History.importJson(text);
        updateHistoryUI();
        toast(
          '已导入 ' + result.added + ' 条记录（共 ' + result.total + ' 条）' +
            (result.invalid ? '，忽略 ' + result.invalid + ' 条无效数据' : '')
        );
      } catch (error) {
        toast('导入失败：' + error.message);
      } finally {
        el.historyFileInput.value = '';
      }
    });

    el.clearHistoryBtn.addEventListener('click', async function () {
      if (History.size() === 0) {
        return;
      }
      if (!window.confirm('确定清空全部抓取记录？清空后下次导出会重新抓取所有视频。')) {
        return;
      }
      try {
        await History.clear();
        updateHistoryUI();
        toast('抓取记录已清空');
      } catch (error) {
        toast('清空失败：' + error.message);
      }
    });

    el.clearCacheBtn.addEventListener('click', async function () {
      el.clearCacheBtn.disabled = true;
      try {
        await Recovery.clearCache();
        toast('已清除失效视频查询缓存');
      } catch (error) {
        toast('清除缓存失败：' + error.message);
      } finally {
        el.clearCacheBtn.disabled = false;
      }
    });

    el.abortBtn.addEventListener('click', function () {
      if (!state.exporting) {
        return;
      }
      state.abort = true;
      el.abortBtn.disabled = true;
      appendLog('正在停止，请等待当前请求结束…', 'warn');
    });

    el.startBtn.addEventListener('click', function () {
      startExport();
    });

    el.downloadBtn.addEventListener('click', function () {
      if (state.result) {
        downloadBlob(state.result.blob, state.result.fileName);
      }
    });

    el.jsonBtn.addEventListener('click', function () {
      if (!state.result) {
        return;
      }
      var blob = new Blob([JSON.stringify(state.result.data, null, 2)], {
        type: 'application/json;charset=utf-8'
      });
      downloadBlob(blob, jsonFileName(state.result.fileName));
    });
  }

  async function init() {
    cacheElements();
    initTheme();
    bindEvents();
    await loadSettings();
    applySettingsToUI();
    await History.load();
    updateHistoryUI();
    updateActionBar();
    await initAccount();
  }

  init();
})();
