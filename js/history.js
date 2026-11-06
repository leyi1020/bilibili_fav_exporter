/**
 * 抓取记录：按「收藏夹名称 + BV 号」记录已经导出过的视频。
 *
 * - 数据以 JSON 结构保存在 chrome.storage.local，可整体导出为 .json 文件，或从文件导入；
 * - 每条记录只包含三件事：所属收藏夹、BV 号、视频名称；
 * - 用于增量导出：开启「跳过已抓取」后，同一收藏夹内 BV 号相同的视频不再导出。
 */
(function (global) {
  'use strict';

  var U = global.FavUtils;

  var STORAGE_KEY = 'favx-history-v1';
  var MAX_ENTRIES = 20000;

  var cache = null;
  var loadPromise = null;
  var writeChain = Promise.resolve();
  var index = new Map();
  var folderCounts = new Map();

  function emptyDoc() {
    return { version: 1, updatedAt: 0, videos: [] };
  }

  function keyOf(folder, bvid) {
    return String(folder) + '\u0000' + String(bvid);
  }

  function normalizeFolder(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  function normalizeTitle(value) {
    return String(value === null || value === undefined ? '' : value)
      .trim()
      .slice(0, 300);
  }

  function normalizeRecord(record) {
    if (!record || typeof record !== 'object') {
      return null;
    }
    var folder = normalizeFolder(record.folder || record.folderName || record.name);
    var bvid = U.normalizeBvid(record.bvid || record.bv || record.bv_id);
    if (!folder || !bvid) {
      return null;
    }
    return {
      folder: folder,
      bvid: bvid,
      title: normalizeTitle(record.title || record.name || '')
    };
  }

  function rebuildIndex() {
    index = new Map();
    folderCounts = new Map();
    (cache && cache.videos ? cache.videos : []).forEach(function (record) {
      index.set(keyOf(record.folder, record.bvid), record);
      folderCounts.set(record.folder, (folderCounts.get(record.folder) || 0) + 1);
    });
  }

  function parseDocument(raw) {
    if (raw === null || raw === undefined || raw === '') {
      return { doc: emptyDoc(), invalid: 0 };
    }
    var data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch (error) {
        return null;
      }
    }
    if (!data || typeof data !== 'object') {
      return null;
    }
    var list = Array.isArray(data) ? data : data.videos;
    if (!Array.isArray(list)) {
      return null;
    }
    var seenKeys = new Set();
    var videos = [];
    var invalid = 0;
    list.forEach(function (item) {
      var record = normalizeRecord(item);
      if (!record) {
        invalid += 1;
        return;
      }
      var key = keyOf(record.folder, record.bvid);
      if (seenKeys.has(key)) {
        return;
      }
      seenKeys.add(key);
      videos.push(record);
    });
    return {
      doc: {
        version: 1,
        updatedAt: Number(data.updatedAt) || 0,
        videos: videos
      },
      invalid: invalid
    };
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function readStorage() {
    return new Promise(function (resolve, reject) {
      if (!hasStorage()) {
        resolve(undefined);
        return;
      }
      try {
        chrome.storage.local.get(STORAGE_KEY, function (data) {
          var error = chrome.runtime && chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message || '读取抓取记录失败'));
          } else {
            resolve(data ? data[STORAGE_KEY] : undefined);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function writeStorage(doc) {
    return new Promise(function (resolve, reject) {
      if (!hasStorage()) {
        resolve();
        return;
      }
      try {
        var payload = {};
        payload[STORAGE_KEY] = doc;
        chrome.storage.local.set(payload, function () {
          var error = chrome.runtime && chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message || '保存抓取记录失败'));
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function load(force) {
    if (!force && cache) {
      return Promise.resolve(cache);
    }
    if (!force && loadPromise) {
      return loadPromise;
    }
    loadPromise = readStorage()
      .then(function (stored) {
        var parsed = parseDocument(stored);
        cache = parsed ? parsed.doc : emptyDoc();
        rebuildIndex();
        loadPromise = null;
        return cache;
      })
      .catch(function () {
        cache = emptyDoc();
        rebuildIndex();
        loadPromise = null;
        return cache;
      });
    return loadPromise;
  }

  function persist(doc) {
    if (doc.videos.length > MAX_ENTRIES) {
      doc.videos = doc.videos.slice(-MAX_ENTRIES);
    }
    doc.updatedAt = Math.floor(Date.now() / 1000);
    cache = doc;
    rebuildIndex();
    writeChain = writeChain.catch(function () {}).then(function () {
      return writeStorage(doc);
    });
    return writeChain.then(function () {
      return doc;
    });
  }

  function ensureCache() {
    return cache || emptyDoc();
  }

  function size() {
    return ensureCache().videos.length;
  }

  function has(folder, bvid) {
    var normalizedFolder = normalizeFolder(folder);
    var normalizedBvid = U.normalizeBvid(bvid);
    if (!normalizedFolder || !normalizedBvid) {
      return false;
    }
    return index.has(keyOf(normalizedFolder, normalizedBvid));
  }

  function folderCount(folder) {
    var normalizedFolder = normalizeFolder(folder);
    return normalizedFolder ? folderCounts.get(normalizedFolder) || 0 : 0;
  }

  /**
   * 合并记录。相同「收藏夹 + BV」不会重复写入，只在新标题非空时更新标题。
   * @returns {Promise<{added:number, updated:number, total:number}>}
   */
  function addRecords(records) {
    return load().then(function () {
      var doc = ensureCache();
      var added = 0;
      var updated = 0;
      (records || []).forEach(function (item) {
        var record = normalizeRecord(item);
        if (!record) {
          return;
        }
        var key = keyOf(record.folder, record.bvid);
        var existing = index.get(key);
        if (existing) {
          if (record.title && existing.title !== record.title) {
            existing.title = record.title;
            updated += 1;
          }
          return;
        }
        index.set(key, record);
        folderCounts.set(record.folder, (folderCounts.get(record.folder) || 0) + 1);
        doc.videos.push(record);
        added += 1;
      });
      if (added === 0 && updated === 0) {
        return { added: 0, updated: 0, total: doc.videos.length };
      }
      return persist(doc).then(function () {
        return { added: added, updated: updated, total: doc.videos.length };
      });
    });
  }

  /** 从 JSON 文本导入并合并记录 */
  function importJson(text) {
    var parsed = parseDocument(text);
    if (!parsed) {
      return Promise.reject(new Error('JSON 格式不正确：需要包含 videos 数组'));
    }
    return load().then(function () {
      var doc = ensureCache();
      var added = 0;
      var updated = 0;
      parsed.doc.videos.forEach(function (record) {
        var key = keyOf(record.folder, record.bvid);
        var existing = index.get(key);
        if (existing) {
          if (record.title && existing.title !== record.title) {
            existing.title = record.title;
            updated += 1;
          }
          return;
        }
        index.set(key, record);
        folderCounts.set(record.folder, (folderCounts.get(record.folder) || 0) + 1);
        doc.videos.push(record);
        added += 1;
      });
      var finish = function () {
        return {
          added: added,
          updated: updated,
          invalid: parsed.invalid,
          total: doc.videos.length
        };
      };
      if (added === 0 && updated === 0) {
        return finish();
      }
      return persist(doc).then(finish);
    });
  }

  function toJson() {
    var doc = ensureCache();
    return JSON.stringify(
      {
        version: 1,
        generator: '哔哩哔哩收藏夹导出（HTML）',
        updatedAt: doc.updatedAt || 0,
        count: doc.videos.length,
        videos: doc.videos
      },
      null,
      2
    );
  }

  function fileName(date) {
    return 'bilibili-fav-history-' + U.timestampTag(date || new Date()) + '.json';
  }

  function clear() {
    var doc = emptyDoc();
    return persist(doc).then(function () {
      return { total: 0 };
    });
  }

  global.FavHistory = {
    STORAGE_KEY: STORAGE_KEY,
    MAX_ENTRIES: MAX_ENTRIES,
    load: load,
    size: size,
    has: has,
    folderCount: folderCount,
    addRecords: addRecords,
    importJson: importJson,
    toJson: toJson,
    fileName: fileName,
    clear: clear,
    normalizeRecord: normalizeRecord,
    parseDocument: parseDocument
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = global.FavHistory;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
