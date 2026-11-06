/**
 * 失效视频归档查询代理（运行在后台 Service Worker）。
 *
 * 页面只提交数据源名称与 aid，由后台构造 URL、限速、超时与体积校验，
 * 避免页面拿到任意 URL 的请求能力，也便于统一节流。
 *
 * 数据源：
 *   - biliplus-aidinfo : https://www.biliplus.com/api/aidinfo?aid=1,2,3
 *   - biliplus-view    : https://www.biliplus.com/api/view?id=aid
 *   - jijidown-info    : https://www.jijidown.com/api/v1/video/get_info?id=aid
 */
(function (global) {
  'use strict';

  var MESSAGE_TYPE = 'fav-archive-fetch';
  var MAX_BATCH_SIZE = 20;
  var MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  var REQUEST_TIMEOUT_MS = 10000;

  var queues = {
    'biliplus-aidinfo': { gap: 400, nextAt: 0, chain: Promise.resolve() },
    'biliplus-view': { gap: 400, nextAt: 0, chain: Promise.resolve() },
    'jijidown-info': { gap: 1200, nextAt: 0, chain: Promise.resolve() }
  };

  var memoryCache = new Map();
  var MEMORY_TTL = 10 * 60 * 1000;
  var MEMORY_MAX = 300;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function normalizeAid(value) {
    var text = String(value === null || value === undefined ? '' : value).trim();
    if (!/^[1-9]\d{0,15}$/.test(text)) {
      return null;
    }
    var number = Number(text);
    return Number.isSafeInteger(number) ? String(number) : null;
  }

  function buildArchiveUrl(message) {
    switch (message && message.provider) {
      case 'biliplus-aidinfo': {
        if (!Array.isArray(message.aids)) {
          throw new Error('invalid-aids');
        }
        var aids = [];
        message.aids.forEach(function (value) {
          var aid = normalizeAid(value);
          if (aid && aids.indexOf(aid) < 0) {
            aids.push(aid);
          }
        });
        if (aids.length === 0 || aids.length > MAX_BATCH_SIZE) {
          throw new Error('invalid-aids');
        }
        var batchUrl = new URL('https://www.biliplus.com/api/aidinfo');
        batchUrl.searchParams.set('aid', aids.join(','));
        return batchUrl.toString();
      }
      case 'biliplus-view': {
        var viewAid = normalizeAid(message.aid);
        if (!viewAid) {
          throw new Error('invalid-aid');
        }
        var viewUrl = new URL('https://www.biliplus.com/api/view');
        viewUrl.searchParams.set('id', viewAid);
        return viewUrl.toString();
      }
      case 'jijidown-info': {
        var jijiAid = normalizeAid(message.aid);
        if (!jijiAid) {
          throw new Error('invalid-aid');
        }
        var jijiUrl = new URL('https://www.jijidown.com/api/v1/video/get_info');
        jijiUrl.searchParams.set('id', jijiAid);
        return jijiUrl.toString();
      }
      default:
        throw new Error('unknown-provider');
    }
  }

  function bodySize(text) {
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(text).byteLength;
    }
    return text.length;
  }

  async function fetchJson(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      var response = await fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        return { ok: false, error: 'http-' + response.status, status: response.status };
      }
      var declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        return { ok: false, error: 'response-too-large', status: response.status };
      }
      var text = await response.text();
      if (bodySize(text) > MAX_RESPONSE_BYTES) {
        return { ok: false, error: 'response-too-large', status: response.status };
      }
      try {
        return { ok: true, status: response.status, json: JSON.parse(text) };
      } catch (error) {
        return { ok: false, error: 'invalid-json', status: response.status };
      }
    } catch (error) {
      return {
        ok: false,
        error: error && error.name === 'AbortError' ? 'timeout' : 'fetch-failed'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function enqueue(provider, task) {
    var queue = queues[provider];
    var run = queue.chain.then(async function () {
      var wait = Math.max(0, queue.nextAt - Date.now());
      if (wait > 0) {
        await sleep(wait);
      }
      queue.nextAt = Date.now() + queue.gap;
      return task();
    });
    queue.chain = run.then(
      function () {},
      function () {}
    );
    return run;
  }

  function readMemoryCache(url) {
    var hit = memoryCache.get(url);
    if (!hit) {
      return null;
    }
    if (Date.now() - hit.at > MEMORY_TTL) {
      memoryCache.delete(url);
      return null;
    }
    return hit.value;
  }

  function writeMemoryCache(url, value) {
    if (memoryCache.size >= MEMORY_MAX) {
      var oldestKey = memoryCache.keys().next().value;
      memoryCache.delete(oldestKey);
    }
    memoryCache.set(url, { at: Date.now(), value: value });
    return value;
  }

  function requestArchive(message) {
    var url = buildArchiveUrl(message);
    var cached = readMemoryCache(url);
    if (cached) {
      return Promise.resolve(cached);
    }
    return enqueue(message.provider, function () {
      return fetchJson(url).then(function (result) {
        return writeMemoryCache(url, result);
      });
    });
  }

  function install() {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.type !== MESSAGE_TYPE) {
        return undefined;
      }
      if (sender && sender.id && sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: 'blocked-sender' });
        return false;
      }
      Promise.resolve()
        .then(function () {
          return requestArchive(message);
        })
        .then(sendResponse)
        .catch(function (error) {
          sendResponse({ ok: false, error: (error && error.message) || 'invalid-request' });
        });
      return true;
    });
  }

  var ArchiveProxy = {
    MESSAGE_TYPE: MESSAGE_TYPE,
    MAX_BATCH_SIZE: MAX_BATCH_SIZE,
    normalizeAid: normalizeAid,
    buildArchiveUrl: buildArchiveUrl,
    fetchJson: fetchJson,
    install: install
  };

  global.FavArchiveProxy = ArchiveProxy;
  if (typeof module === 'object' && module.exports) {
    module.exports = ArchiveProxy;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
