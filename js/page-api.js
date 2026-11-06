/**
 * 扩展页面侧的接口封装：通过后台 Service Worker 请求 B 站接口与归档数据。
 */
(function (global) {
  'use strict';

  var MSG_API = 'fav-api-request';
  var MSG_SET_INTERVAL = 'fav-set-interval';
  var MSG_ARCHIVE = 'fav-archive-fetch';

  var CODE_MESSAGES = {
    '-1': '网络请求失败',
    '-101': '未登录或登录已过期，请先在浏览器中登录 bilibili.com',
    '-400': '请求参数错误',
    '-403': '访问权限不足（私密收藏夹或需要登录）',
    '-404': '收藏夹不存在或已被删除',
    '-412': '请求被 B 站拦截，请稍后重试',
    '-509': '请求过于频繁，请降低请求速度',
    '-352': '触发 B 站风控校验，请先在网页端完成验证',
    62002: '稿件不可见',
    62004: '稿件审核中',
    62012: '仅 UP 主自己可见'
  };

  function describeCode(code, message) {
    var text = CODE_MESSAGES[String(code)];
    if (code === -1 && message) {
      return message;
    }
    return text || message || ('接口错误（' + code + '）');
  }

  function ApiError(code, message) {
    this.name = 'ApiError';
    this.code = code;
    this.message = describeCode(code, message);
    this.rawMessage = message || '';
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function sendMessage(message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error('后台响应超时，请重试'));
      }, timeoutMs || 30000);

      function finish(callback, value) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        callback(value);
      }

      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            finish(reject, new Error(chrome.runtime.lastError.message || '扩展后台通信失败'));
            return;
          }
          if (!response) {
            finish(reject, new Error('扩展后台没有响应，请重新加载扩展'));
            return;
          }
          finish(resolve, response);
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function request(path, params, options) {
    var response = await sendMessage({
      type: MSG_API,
      path: path,
      params: params || {},
      sign: Boolean(options && options.sign)
    });
    if (!response || !response.ok) {
      throw new ApiError(
        response && typeof response.code !== 'undefined' ? response.code : -1,
        response && response.message
      );
    }
    return response.data;
  }

  async function requestRaw(path, params, options) {
    var response = await sendMessage({
      type: MSG_API,
      path: path,
      params: params || {},
      sign: Boolean(options && options.sign)
    });
    return response || { ok: false, code: -1, message: '后台没有响应', data: null };
  }

  var FavClient = {
    ApiError: ApiError,
    describeCode: describeCode,
    sendMessage: sendMessage,
    request: request,
    requestRaw: requestRaw,

    setInterval: function (interval) {
      return sendMessage({ type: MSG_SET_INTERVAL, interval: interval }).catch(function () {});
    },

    /** 当前登录信息 */
    getNav: async function () {
      var response = await requestRaw('/x/web-interface/nav');
      var data = response && response.data ? response.data : null;
      return {
        isLogin: Boolean(data && data.isLogin),
        mid: Number(data && data.mid) || 0,
        uname: (data && data.uname) || '',
        face: (data && data.face) || '',
        code: response && response.code,
        message: (response && response.message) || ''
      };
    },

    /** 用户自建收藏夹（含默认收藏夹） */
    listCreatedFolders: async function (mid) {
      var data = await request('/x/v3/fav/folder/created/list-all', { up_mid: mid });
      var list = (data && data.list) || [];
      return list.map(function (folder) {
        return {
          id: Number(folder.id || folder.fid),
          type: 'fav',
          title: folder.title || '未命名收藏夹',
          mediaCount: Number(folder.media_count) || 0,
          attr: Number(folder.attr) || 0,
          cover: folder.cover || '',
          intro: folder.intro || '',
          ctime: Number(folder.ctime) || 0,
          mtime: Number(folder.mtime) || 0,
          link: 'https://space.bilibili.com/' + mid + '/favlist?fid=' + (folder.id || folder.fid)
        };
      });
    },

    /** 订阅合集 */
    listCollectedFolders: async function (mid, hooks) {
      var folders = [];
      var page = 1;
      var pageSize = 20;
      while (page <= 50) {
        var data = await request('/x/v3/fav/folder/collected/list', {
          pn: page,
          ps: pageSize,
          up_mid: mid,
          platform: 'web'
        });
        var list = (data && data.list) || [];
        list.forEach(function (folder) {
          var folderId = Number(folder.id || folder.sid || folder.season_id) || 0;
          folders.push({
            id: folderId,
            type: 'col',
            title: folder.title || '未命名合集',
            mediaCount: Number(folder.media_count) || 0,
            cover: folder.cover || '',
            intro: folder.intro || '',
            ctime: Number(folder.ctime) || 0,
            mtime: Number(folder.mtime) || 0,
            upper: folder.upper || null,
            link:
              folder.link ||
              (folderId
                ? 'https://space.bilibili.com/' + mid + '/lists/' + folderId + '?type=season'
                : '')
          });
        });
        if (hooks && hooks.onPage) {
          hooks.onPage(folders.length);
        }
        var hasMore = Boolean(data && data.has_more);
        if (!hasMore || list.length === 0 || folders.length >= Number(data && data.count)) {
          break;
        }
        page += 1;
      }
      return folders;
    },

    /** 收藏夹内容分页 */
    getFavPage: function (mediaId, page, pageSize) {
      return request('/x/v3/fav/resource/list', {
        media_id: mediaId,
        pn: page,
        ps: pageSize,
        keyword: '',
        order: 'mtime',
        type: 0,
        tid: 0,
        platform: 'web'
      });
    },

    /** 订阅合集内容分页 */
    getSeasonPage: function (seasonId, page, pageSize) {
      return request('/x/space/fav/season/list', {
        season_id: seasonId,
        pn: page,
        ps: pageSize,
        keyword: '',
        order: 'mtime',
        type: 0,
        tid: 0,
        platform: 'web'
      });
    },

    /** 稿件分 P 列表（失效视频可用其分 P 标题作弱标题） */
    getPageList: async function (aid) {
      var response = await requestRaw('/x/player/pagelist', { aid: aid });
      return response && response.code === 0 && Array.isArray(response.data) ? response.data : [];
    },

    /** 官方稿件信息 */
    getVideoView: function (options) {
      var params = {};
      if (options && options.bvid) {
        params.bvid = options.bvid;
      } else if (options && options.aid) {
        params.aid = options.aid;
      }
      return requestRaw('/x/web-interface/view', params);
    },

    /** 归档查询：biliplus 批量 / biliplus 单查 / jijidown */
    archive: function (payload) {
      return sendMessage(Object.assign({ type: MSG_ARCHIVE }, payload), 20000);
    }
  };

  global.FavClient = FavClient;
})(window);
