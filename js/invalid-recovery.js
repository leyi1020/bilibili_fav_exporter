/**
 * 失效视频信息还原。
 *
 * 管线（参考 biliplus 的 invalid-video-info）：
 *   本地缓存 → 分 P 标题（弱标题）→ biliplus 批量 aidinfo → biliplus 单查 view → jijidown 归档
 *
 * 只在最长 30 天内复用缓存：拿到部分信息 30 分钟后重试，空结果 12 小时内不重试。
 */
(function (global) {
  'use strict';

  var U = global.FavUtils;
  var C = global.FavClient;

  var CACHE_PREFIX = 'favx-meta-v1-';
  var CACHE_PARTIAL_TTL = 30 * 60 * 1000;
  var CACHE_EMPTY_TTL = 12 * 60 * 60 * 1000;
  var CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  var CACHE_MAX_ENTRIES = 300;

  var memoryCache = new Map();

  function storageGet(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(key, function (data) {
        resolve(data ? data[key] : undefined);
      });
    });
  }

  function storageSet(object) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(object, function () {
        resolve();
      });
    });
  }

  function storageRemove(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.remove(keys, function () {
        resolve();
      });
    });
  }

  function mapLimit(items, limit, mapper) {
    return new Promise(function (resolve) {
      var results = new Array(items.length);
      var index = 0;
      var size = Math.min(Math.max(1, limit), items.length);
      if (size === 0) {
        resolve(results);
        return;
      }
      var running = 0;
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

  function emptyMeta(aid, bvid) {
    return {
      aid: aid ? Number(aid) : null,
      bvid: U.normalizeBvid(bvid) || (aid ? U.avToBv(aid) : ''),
      title: '',
      pic: '',
      picRaw: '',
      ownerName: '',
      ownerMid: 0,
      pubtime: 0,
      duration: 0,
      titleSource: '',
      coverSource: '',
      source: '',
      weakTitle: false
    };
  }

  function mergeMeta(base, extra, source) {
    if (!extra) {
      return base;
    }
    var next = Object.assign({}, base || emptyMeta(extra.aid, extra.bvid));
    var aid = extra.aid || next.aid;

    if (U.isUsableTitle(extra.title, aid) && (!U.isUsableTitle(next.title, aid) || next.weakTitle)) {
      next.title = String(extra.title).trim();
      next.weakTitle = false;
      next.titleSource = source;
      next.source = next.source || source;
    }

    var pic = U.normalizeCoverUrl(extra.pic || extra.cover || extra.img);
    if (U.isGoodCoverUrl(pic) && !U.isGoodCoverUrl(next.pic)) {
      next.pic = pic;
      next.picRaw = String(extra.pic || extra.cover || extra.img || '');
      next.coverSource = source;
      next.source = next.source || source;
    }

    var firstFrame = U.normalizeCoverUrl(extra.first_frame);
    if (!U.isGoodCoverUrl(next.pic) && U.isGoodCoverUrl(firstFrame)) {
      next.pic = firstFrame;
      next.picRaw = String(extra.first_frame || '');
      next.coverSource = source + ':first_frame';
      next.source = next.source || source;
    }

    var ownerName =
      (extra.owner && extra.owner.name) || extra.author || extra.ownerName || '';
    if (ownerName && !next.ownerName) {
      next.ownerName = String(ownerName).trim();
      next.source = next.source || source;
    }
    var mid = Number((extra.owner && extra.owner.mid) || extra.mid || extra.ownerMid || 0);
    if (mid > 0 && !next.ownerMid) {
      next.ownerMid = mid;
    }

    var pubtime = Number(extra.pubtime || extra.created || 0);
    if (pubtime > 0 && !next.pubtime) {
      next.pubtime = pubtime;
    }

    var duration = Number(extra.duration || 0);
    if (duration > 0 && !next.duration) {
      next.duration = duration;
    }

    var bvid = U.normalizeBvid(extra.bvid);
    if (bvid) {
      next.bvid = bvid;
    }
    if (extra.aid) {
      next.aid = Number(extra.aid);
    }
    if (!next.bvid && next.aid) {
      next.bvid = U.avToBv(next.aid);
    }
    return next;
  }

  function isComplete(meta) {
    return Boolean(
      meta &&
        U.isUsableTitle(meta.title, meta.aid) &&
        U.isGoodCoverUrl(meta.pic) &&
        meta.ownerName &&
        Number(meta.ownerMid) > 0
    );
  }

  function hasSomeInfo(meta) {
    return Boolean(meta && (U.isUsableTitle(meta.title, meta.aid) || U.isGoodCoverUrl(meta.pic)));
  }

  function isFreshCache(meta) {
    if (!meta || !meta.cachedAt) {
      return false;
    }
    var ttl = hasSomeInfo(meta) ? CACHE_PARTIAL_TTL : CACHE_EMPTY_TTL;
    return Date.now() - meta.cachedAt < ttl;
  }

  function cacheKey(aid) {
    return CACHE_PREFIX + aid;
  }

  async function readCache(aid) {
    if (!aid) {
      return null;
    }
    var key = String(aid);
    if (memoryCache.has(key)) {
      return memoryCache.get(key);
    }
    var saved = await storageGet(cacheKey(aid));
    if (saved && typeof saved === 'object') {
      memoryCache.set(key, saved);
      return saved;
    }
    return null;
  }

  async function pruneCache() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      return;
    }
    var all = await new Promise(function (resolve) {
      chrome.storage.local.get(null, function (data) {
        resolve(data || {});
      });
    });
    var now = Date.now();
    var entries = Object.keys(all)
      .filter(function (key) {
        return key.indexOf(CACHE_PREFIX) === 0;
      })
      .map(function (key) {
        return [key, all[key]];
      });
    var stale = entries
      .filter(function (entry) {
        var value = entry[1];
        if (!value || typeof value !== 'object') {
          return true;
        }
        if (!value.cachedAt) {
          return !U.isUsableTitle(value.title, value.aid);
        }
        return now - value.cachedAt > CACHE_MAX_AGE;
      })
      .map(function (entry) {
        return entry[0];
      });

    var staleSet = new Set(stale);
    entries
      .filter(function (entry) {
        return !staleSet.has(entry[0]);
      })
      .sort(function (left, right) {
        return Number(right[1].cachedAt || 0) - Number(left[1].cachedAt || 0);
      })
      .slice(CACHE_MAX_ENTRIES)
      .forEach(function (entry) {
        stale.push(entry[0]);
      });

    if (stale.length) {
      await storageRemove(stale);
    }
  }

  function parseBiliplusView(response) {
    if (!response || !response.ok || !response.json) {
      return null;
    }
    var json = response.json;
    if (json.code === -404 || json.code === -403 || json.code === -503) {
      return null;
    }
    var v2 = json.v2_app_api || {};
    return {
      aid: Number(json.aid || json.id || 0),
      bvid: v2.bvid || json.bvid || '',
      title: v2.title || json.title || '',
      pic: v2.pic || json.pic || '',
      first_frame: v2.first_frame || json.first_frame || '',
      author: (v2.owner && v2.owner.name) || json.author || '',
      mid: (v2.owner && v2.owner.mid) || json.mid || 0,
      owner: v2.owner || null,
      created: Number(json.created || 0),
      duration: Number(v2.duration || json.duration || 0)
    };
  }

  function parseJijidown(response) {
    if (!response || !response.ok || !response.json) {
      return null;
    }
    var json = response.json;
    var data = json.data && typeof json.data === 'object' && !Array.isArray(json.data) ? json.data : json;
    if (
      json.msg === 'loading' ||
      data.msg === 'loading' ||
      json.title === '正在加载数据...' ||
      data.title === '正在加载数据...'
    ) {
      return { loading: true };
    }
    var upid = Number(data.upid || (data.up && (data.up.uid || data.up.mid)) || 0);
    if (!(upid > 0)) {
      return null;
    }
    if (!U.isUsableTitle(data.title, 0) && !data.img) {
      return null;
    }
    return {
      aid: Number(data.aid || 0),
      bvid: data.bvid || '',
      title: data.title || '',
      pic: data.img || data.pic || data.cover || '',
      author: (data.up && (data.up.author || data.up.name)) || data.author || '',
      mid: upid,
      created: Number(data.pubtime || data.created || data.ctime || 0),
      duration: Number(data.duration || 0)
    };
  }

  async function fetchJijidown(aid, hooks) {
    for (var attempt = 0; attempt <= 2; attempt++) {
      if (hooks && hooks.shouldAbort && hooks.shouldAbort()) {
        return null;
      }
      var response;
      try {
        response = await C.archive({ provider: 'jijidown-info', aid: aid });
      } catch (error) {
        return null;
      }
      var parsed = parseJijidown(response);
      if (parsed && parsed.loading) {
        if (attempt < 2) {
          await U.sleep(1200);
          continue;
        }
        return null;
      }
      return parsed;
    }
    return null;
  }

  /**
   * 批量还原失效视频信息。
   * @param {Array<{aid:number,bvid:string}>} items
   * @param {{onProgress?:Function, shouldAbort?:Function}} hooks
   * @returns {Promise<Map<number, object>>}
   */
  async function recover(items, hooks) {
    hooks = hooks || {};
    var report = function (done, total, label) {
      if (hooks.onProgress) {
        hooks.onProgress({ done: done, total: total, label: label || '' });
      }
    };
    var aborted = function () {
      return Boolean(hooks.shouldAbort && hooks.shouldAbort());
    };

    var unique = [];
    var seen = new Set();
    (items || []).forEach(function (item) {
      var aid = Number(item && item.aid) || (item && item.bvid ? U.bvToAv(item.bvid) : 0);
      if (!aid || seen.has(aid)) {
        return;
      }
      seen.add(aid);
      unique.push({
        aid: aid,
        bvid: U.normalizeBvid(item.bvid) || U.avToBv(aid)
      });
    });

    var metas = new Map();
    if (unique.length === 0) {
      report(0, 0, '没有需要还原的失效视频');
      return metas;
    }

    report(0, unique.length, '读取本地缓存');
    await pruneCache();

    var pending = [];
    for (var i = 0; i < unique.length; i++) {
      var item = unique[i];
      var cached = await readCache(item.aid);
      if (cached && isComplete(cached)) {
        metas.set(item.aid, cached);
        continue;
      }
      if (cached && isFreshCache(cached)) {
        metas.set(item.aid, Object.assign(emptyMeta(item.aid, item.bvid), cached));
        continue;
      }
      pending.push({
        aid: item.aid,
        bvid: item.bvid,
        meta: cached ? Object.assign(emptyMeta(item.aid, item.bvid), cached) : emptyMeta(item.aid, item.bvid)
      });
    }

    var skipped = unique.length - pending.length;
    report(skipped, unique.length, '已从缓存读取 ' + skipped + ' 个');

    if (pending.length > 0 && !aborted()) {
      // 1) 分 P 标题：能拿到一个弱标题，至少让导出结果可读
      await mapLimit(pending, 3, async function (entry) {
        if (aborted() || U.isUsableTitle(entry.meta.title, entry.aid)) {
          return;
        }
        var pages = await C.getPageList(entry.aid);
        if (pages.length === 1 && U.isUsableTitle(pages[0].part, entry.aid)) {
          entry.meta.title = pages[0].part;
          entry.meta.weakTitle = true;
          entry.meta.titleSource = entry.meta.titleSource || 'pagelist';
          entry.meta.source = entry.meta.source || 'pagelist';
        }
      });
    }

    // 2) biliplus 批量接口（每批 20 个 aid）
    var needArchive = pending.filter(function (entry) {
      return !isComplete(entry.meta);
    });
    if (needArchive.length > 0 && !aborted()) {
      report(skipped, unique.length, '查询 biliplus 归档（批量）');
      for (var start = 0; start < needArchive.length; start += 20) {
        if (aborted()) {
          break;
        }
        var chunk = needArchive.slice(start, start + 20);
        var batchResponse;
        try {
          batchResponse = await C.archive({
            provider: 'biliplus-aidinfo',
            aids: chunk.map(function (entry) {
              return entry.aid;
            })
          });
        } catch (error) {
          batchResponse = null;
        }
        var batchJson = batchResponse && batchResponse.ok ? batchResponse.json : null;
        if (batchJson && batchJson.code === 0 && batchJson.data) {
          chunk.forEach(function (entry) {
            var info = batchJson.data[String(entry.aid)];
            if (!info) {
              return;
            }
            entry.meta = mergeMeta(
              entry.meta,
              {
                aid: entry.aid,
                title: info.title,
                pic: info.pic,
                author: info.author,
                mid: info.mid,
                created: info.created
              },
              'biliplus'
            );
          });
        }
        report(
          Math.min(skipped + start + chunk.length, unique.length),
          unique.length,
          'biliplus 批量归档 ' + Math.min(start + 20, needArchive.length) + '/' + needArchive.length
        );
      }
    }

    // 3) biliplus 单查
    var needView = pending.filter(function (entry) {
      return !isComplete(entry.meta);
    });
    if (needView.length > 0 && !aborted()) {
      var viewDone = 0;
      await mapLimit(needView, 3, async function (entry) {
        if (aborted()) {
          return;
        }
        var response;
        try {
          response = await C.archive({ provider: 'biliplus-view', aid: entry.aid });
        } catch (error) {
          response = null;
        }
        entry.meta = mergeMeta(entry.meta, parseBiliplusView(response), 'biliplus');
        viewDone += 1;
        report(
          Math.min(skipped + needArchive.length + viewDone, unique.length),
          unique.length,
          'biliplus 单查 ' + viewDone + '/' + needView.length
        );
      });
    }

    // 4) jijidown 归档（后台已串行 + 节流，这里逐个等待即可）
    var needJiji = pending.filter(function (entry) {
      return !isComplete(entry.meta);
    });
    if (needJiji.length > 0 && !aborted()) {
      var jijiDone = 0;
      for (var index = 0; index < needJiji.length; index++) {
        if (aborted()) {
          break;
        }
        var entry = needJiji[index];
        var jijiMeta = await fetchJijidown(entry.aid, hooks);
        entry.meta = mergeMeta(entry.meta, jijiMeta, 'jijidown');
        jijiDone += 1;
        report(
          Math.min(skipped + needArchive.length + needView.length + jijiDone, unique.length),
          unique.length,
          'jijidown 归档 ' + jijiDone + '/' + needJiji.length
        );
      }
    }

    // 5) 写缓存（合并成少量 storage.set，避免触发写入频率限制）
    var writes = {};
    pending.forEach(function (entry) {
      var meta = Object.assign({}, entry.meta, { cachedAt: Date.now() });
      if (meta.aid) {
        memoryCache.set(String(meta.aid), meta);
        writes[cacheKey(meta.aid)] = meta;
      }
    });
    var keys = Object.keys(writes);
    for (var offset = 0; offset < keys.length; offset += 50) {
      var batch = {};
      keys.slice(offset, offset + 50).forEach(function (key) {
        batch[key] = writes[key];
      });
      await storageSet(batch);
    }

    pending.forEach(function (entry) {
      metas.set(entry.aid, entry.meta);
    });

    var recoveredCount = 0;
    metas.forEach(function (meta) {
      if (U.isUsableTitle(meta.title, meta.aid) && U.isGoodCoverUrl(meta.pic)) {
        recoveredCount += 1;
      }
    });
    report(unique.length, unique.length, '还原完成：' + recoveredCount + '/' + unique.length + ' 个有标题与封面');
    return metas;
  }

  async function clearCache() {
    memoryCache.clear();
    var all = await new Promise(function (resolve) {
      chrome.storage.local.get(null, function (data) {
        resolve(data || {});
      });
    });
    var keys = Object.keys(all).filter(function (key) {
      return key.indexOf(CACHE_PREFIX) === 0;
    });
    if (keys.length) {
      await storageRemove(keys);
    }
  }

  global.InvalidRecovery = {
    recover: recover,
    clearCache: clearCache,
    mergeMeta: mergeMeta,
    parseBiliplusView: parseBiliplusView,
    parseJijidown: parseJijidown,
    isComplete: isComplete,
    emptyMeta: emptyMeta,
    cacheKey: cacheKey
  };
})(window);
