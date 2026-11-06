/**
 * 后台 Service Worker：负责 B 站接口请求、归档查询代理与页面跳转。
 */
importScripts('md5.js', 'utils.js', 'bili-api.js', 'archive-proxy.js');

const api = FavBiliApiModule.create({ interval: 500 });
const apiModule = FavBiliApiModule;
const archiveProxy = FavArchiveProxy;

const MSG_API = 'fav-api-request';
const MSG_SET_INTERVAL = 'fav-set-interval';
const MSG_OPEN_EXPORTER = 'fav-open-exporter';

function sendAsync(promise, sendResponse) {
  Promise.resolve(promise)
    .then(sendResponse)
    .catch(error => {
      sendResponse({ ok: false, code: -1, message: (error && error.message) || String(error) });
    });
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  if (sender && sender.id && sender.id !== chrome.runtime.id) {
    return undefined;
  }

  switch (message.type) {
    case MSG_API: {
      const path = String(message.path || '');
      const params = message.params && typeof message.params === 'object' ? message.params : {};
      const sign = Boolean(message.sign);
      if (!apiModule.ALLOWED_PATHS.has(path)) {
        sendResponse({ ok: false, code: -1, message: '不允许的接口' });
        return false;
      }
      return sendAsync(
        api.request(path, params, { sign }).then(result => ({
          ok: Boolean(result && result.code === 0),
          code: result && typeof result.code === 'number' ? result.code : -1,
          message: (result && result.message) || '',
          data: result && result.data !== undefined ? result.data : null,
          status: result && result.status
        })),
        sendResponse
      );
    }
    case MSG_SET_INTERVAL: {
      api.setInterval(message.interval);
      sendResponse({ ok: true });
      return false;
    }
    case MSG_OPEN_EXPORTER: {
      const url = new URL(chrome.runtime.getURL('exporter.html'));
      if (message.uid) {
        url.searchParams.set('uid', String(message.uid));
      }
      if (message.fid) {
        url.searchParams.set('fid', String(message.fid));
      }
      if (message.folderType === 'col') {
        url.searchParams.set('type', 'col');
      }
      if (message.auto) {
        url.searchParams.set('auto', '1');
      }
      chrome.tabs.create({ url: url.toString() }, () => {
        sendResponse({ ok: true });
      });
      return true;
    }
    default:
      return undefined;
  }
});

archiveProxy.install();

chrome.runtime.onInstalled.addListener(() => {
  // 预热 wbi 密钥，失败不影响使用
  api.getNav(true).catch(() => {});
});
