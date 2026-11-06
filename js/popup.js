/**
 * 工具栏弹窗：显示登录状态，提供打开导出面板的入口。
 */
(function () {
  'use strict';

  var U = window.FavUtils;
  var navMid = 0;
  var locationInfo = { uid: 0, fid: 0, type: 'fav', isFavPage: false };
  var elements = {};

  function send(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || '后台通信失败'));
            return;
          }
          resolve(response || null);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function setStatus(text, state, faceUrl) {
    elements.status.className = 'status' + (state ? ' is-' + state : '');
    elements.statusText.textContent = text;
    if (faceUrl) {
      if (!elements.avatar) {
        elements.avatar = document.createElement('img');
        elements.avatar.alt = '';
        elements.status.insertBefore(elements.avatar, elements.status.firstChild);
      }
      elements.avatar.src = faceUrl;
      elements.avatar.hidden = false;
    } else if (elements.avatar) {
      elements.avatar.hidden = true;
    }
  }

  async function detectCurrentTab() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var tab = tabs && tabs[0];
      locationInfo = U.parseBilibiliLocation(tab && tab.url);
      if (locationInfo.isFavPage) {
        elements.contextBtn.hidden = false;
        elements.contextBtn.textContent = locationInfo.fid
          ? '导出当前收藏夹（ID ' + locationInfo.fid + '）'
          : '导出当前页面的收藏夹';
      }
    } catch (error) {
      locationInfo = { uid: 0, fid: 0, type: 'fav', isFavPage: false };
    }
  }

  async function loadAccount() {
    try {
      var response = await send({
        type: 'fav-api-request',
        path: '/x/web-interface/nav',
        params: {}
      });
      var data = response && response.data;
      if (data && data.isLogin) {
        navMid = Number(data.mid) || 0;
        var face = data.face || '';
        if (face.indexOf('//') === 0) {
          face = 'https:' + face;
        }
        setStatus('已登录：' + (data.uname || '') + '（UID ' + navMid + '）', 'online', face);
      } else {
        setStatus('未登录。读私密收藏夹前请先登录 bilibili.com', 'offline');
      }
    } catch (error) {
      setStatus('无法连接扩展后台，请重新加载扩展', 'offline');
    }
  }

  function openExporter(options) {
    var url = chrome.runtime.getURL('exporter.html');
    var params = new URLSearchParams();
    if (options.uid) {
      params.set('uid', String(options.uid));
    }
    if (options.fid) {
      params.set('fid', String(options.fid));
    }
    if (options.type) {
      params.set('type', options.type);
    }
    if (options.auto) {
      params.set('auto', '1');
    }
    var query = params.toString();
    if (query) {
      url += '?' + query;
    }
    chrome.tabs.create({ url: url });
    window.close();
  }

  function bindEvents() {
    elements.openBtn.addEventListener('click', function () {
      openExporter({
        uid: locationInfo.uid || navMid,
        fid: locationInfo.fid,
        type: locationInfo.type,
        auto: true
      });
    });

    elements.contextBtn.addEventListener('click', function () {
      openExporter({
        uid: locationInfo.uid || navMid,
        fid: locationInfo.fid,
        type: locationInfo.type,
        auto: true
      });
    });
  }

  async function init() {
    elements.status = document.getElementById('status');
    elements.statusText = document.getElementById('statusText');
    elements.openBtn = document.getElementById('openBtn');
    elements.contextBtn = document.getElementById('contextBtn');
    elements.version = document.getElementById('version');

    try {
      elements.version.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (error) {
      elements.version.textContent = '';
    }

    bindEvents();
    await detectCurrentTab();
    await loadAccount();

    if (!locationInfo.isFavPage && locationInfo.uid) {
      elements.contextBtn.hidden = false;
      elements.contextBtn.textContent = '导出该用户的收藏夹（UID ' + locationInfo.uid + '）';
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
