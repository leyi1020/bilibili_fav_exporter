/**
 * B 站官方接口客户端（运行在后台 Service Worker）。
 *
 * - 只允许访问白名单内的 /x/... 接口；
 * - 统一限速，避免触发风控；
 * - 需要 wbi 签名的接口（部分收藏夹 / 合集接口）先直连，遇到 -403 自动补签名重试一次。
 */
(function (global) {
  'use strict';

  var API_BASE = 'https://api.bilibili.com';

  var ALLOWED_PATHS = new Set([
    '/x/web-interface/nav',
    '/x/web-interface/view',
    '/x/player/pagelist',
    '/x/v3/fav/folder/created/list-all',
    '/x/v3/fav/folder/collected/list',
    '/x/v3/fav/resource/list',
    '/x/space/fav/season/list'
  ]);

  var MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
  ];

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function getMixinKey(original) {
    var output = '';
    for (var i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) {
      output += original[MIXIN_KEY_ENC_TAB[i]] || '';
    }
    return output.slice(0, 32);
  }

  function encWbi(params, imgKey, subKey) {
    var mixinKey = getMixinKey(imgKey + subKey);
    var now = Math.round(Date.now() / 1000);
    var all = {};
    Object.keys(params || {}).forEach(function (key) {
      all[key] = params[key];
    });
    all.wts = now;
    var query = Object.keys(all)
      .sort()
      .map(function (key) {
        var value = String(all[key] === null || all[key] === undefined ? '' : all[key]).replace(/[!'()*]/g, '');
        return encodeURIComponent(key) + '=' + encodeURIComponent(value);
      })
      .join('&');
    var signature = global.md5Hex ? global.md5Hex(query + mixinKey) : '';
    return query + '&w_rid=' + signature;
  }

  function FavBiliApi(options) {
    this.interval = Math.max(200, Number(options && options.interval) || 500);
    this._nextAt = 0;
    this._wbi = null;
    this._wbiAt = 0;
    this._nav = null;
    this._navAt = 0;
  }

  FavBiliApi.prototype.setInterval = function (interval) {
    this.interval = Math.max(200, Number(interval) || 500);
  };

  FavBiliApi.prototype._waitTurn = async function () {
    var now = Date.now();
    var wait = Math.max(0, this._nextAt - now);
    this._nextAt = Math.max(now, this._nextAt) + this.interval;
    if (wait > 0) {
      await sleep(wait);
    }
  };

  FavBiliApi.prototype._fetchJson = async function (url) {
    var response;
    try {
      response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json, text/plain, */*'
        }
      });
    } catch (error) {
      return { code: -1, message: '网络请求失败：' + ((error && error.message) || error), data: null };
    }
    if (!response.ok) {
      return { code: -1, message: 'HTTP ' + response.status, data: null, status: response.status };
    }
    var text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      return { code: -1, message: '接口返回的不是 JSON（可能被风控拦截）', data: null };
    }
  };

  FavBiliApi.prototype._requestOnce = async function (path, params, sign) {
    await this._waitTurn();
    var query;
    if (sign) {
      var keys = await this._getWbiKeys();
      query = encWbi(params, keys.imgKey, keys.subKey);
    } else {
      query = new URLSearchParams(params || {}).toString();
    }
    var url = API_BASE + path + (query ? '?' + query : '');
    var json = await this._fetchJson(url);
    if (!json || typeof json !== 'object') {
      return { code: -1, message: '接口响应异常', data: null };
    }
    return json;
  };

  /**
   * 请求白名单内的接口。返回 { code, message, data }。
   * code === 0 表示成功，其余为 B 站错误码或 -1（网络 / 解析失败）。
   */
  FavBiliApi.prototype.request = async function (path, params, options) {
    if (!ALLOWED_PATHS.has(path)) {
      return { code: -1, message: '不允许的接口：' + path, data: null };
    }
    var signed = Boolean(options && options.sign);
    var result = await this._requestOnce(path, params, signed);
    if (!signed && (result.code === -403 || result.code === -401)) {
      try {
        var retried = await this._requestOnce(path, params, true);
        if (retried && retried.code === 0) {
          return retried;
        }
        if (retried && retried.code && retried.code !== -403) {
          return retried;
        }
      } catch (error) {
        // 签名失败时保留原始响应
      }
    }
    return result;
  };

  FavBiliApi.prototype._getWbiKeys = async function () {
    if (this._wbi && Date.now() - this._wbiAt < 30 * 60 * 1000) {
      return this._wbi;
    }
    await this._waitTurn();
    var json = await this._fetchJson(API_BASE + '/x/web-interface/nav');
    var data = json && json.data ? json.data : null;
    var wbi = data && data.wbi_img ? data.wbi_img : null;
    if (!wbi || !wbi.img_url || !wbi.sub_url) {
      throw new Error('无法获取 wbi 签名密钥，请确认已登录 B 站');
    }
    var imgKey = wbi.img_url.slice(wbi.img_url.lastIndexOf('/') + 1, wbi.img_url.lastIndexOf('.'));
    var subKey = wbi.sub_url.slice(wbi.sub_url.lastIndexOf('/') + 1, wbi.sub_url.lastIndexOf('.'));
    this._wbi = { imgKey: imgKey, subKey: subKey };
    this._wbiAt = Date.now();
    return this._wbi;
  };

  FavBiliApi.prototype.getNav = async function (force) {
    if (!force && this._nav && Date.now() - this._navAt < 60 * 1000) {
      return this._nav;
    }
    await this._waitTurn();
    var json = await this._fetchJson(API_BASE + '/x/web-interface/nav');
    this._nav = json;
    this._navAt = Date.now();
    return json;
  };

  var FavBiliApiClass = FavBiliApi;
  var FavBiliApiModule = {
    API_BASE: API_BASE,
    ALLOWED_PATHS: ALLOWED_PATHS,
    FavBiliApi: FavBiliApiClass,
    encWbi: encWbi,
    getMixinKey: getMixinKey,
    create: function (options) {
      return new FavBiliApiClass(options);
    }
  };

  global.FavBiliApiModule = FavBiliApiModule;
  if (typeof module === 'object' && module.exports) {
    module.exports = FavBiliApiModule;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
