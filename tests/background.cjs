/**
 * 后台 Service Worker 的模拟测试：
 * 在 Node 中加载 js/*.js，用假的 chrome.* 与 fetch 验证消息路由、
 * 接口白名单、wbi 重试、归档代理的 URL 构造 / 校验 / 缓存。
 *
 *   node tests/background.cjs
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const calls = [];
let resourceShouldFail = true;

function jsonResponse(body, status) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const code = status || 200;
  return {
    ok: code >= 200 && code < 300,
    status: code,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-length'
          ? String(Buffer.byteLength(text))
          : null;
      }
    },
    text: async () => text
  };
}

async function mockFetch(url, options) {
  calls.push({ url: String(url), options: options || {} });
  const parsed = new URL(url);
  const pathname = parsed.pathname;

  if (parsed.hostname === 'api.bilibili.com') {
    if (pathname === '/x/web-interface/nav') {
      return jsonResponse({
        code: 0,
        data: {
          isLogin: true,
          mid: 1,
          uname: 'tester',
          face: '',
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
          }
        }
      });
    }
    if (pathname === '/x/v3/fav/folder/created/list-all') {
      return jsonResponse({
        code: 0,
        data: { count: 1, list: [{ id: 123, title: '默认收藏夹', media_count: 2 }] }
      });
    }
    if (pathname === '/x/v3/fav/resource/list') {
      if (resourceShouldFail && !parsed.searchParams.get('w_rid')) {
        resourceShouldFail = false;
        return jsonResponse({ code: -403, message: '访问权限不足' });
      }
      return jsonResponse({
        code: 0,
        data: {
          info: { id: 123, title: '默认收藏夹', media_count: 2 },
          medias: [{ id: 2, bvid: 'BV1xx411c7mD', title: '示例视频' }],
          has_more: false
        }
      });
    }
    if (pathname === '/x/v3/fav/folder/collected/list') {
      return jsonResponse({ code: 0, data: { count: 0, list: [], has_more: false } });
    }
    return jsonResponse({ code: -404, message: 'not found' }, 404);
  }

  if (parsed.hostname === 'www.biliplus.com') {
    if (pathname === '/api/aidinfo') {
      return jsonResponse({
        code: 0,
        data: {
          '3': {
            title: '【电影】后会无期',
            pic: 'https://img.biliplus.com/bfs/archive/9b53b363e0f6c16b3a73aa38f8a8c062eaff6187.jpg',
            created: 1295572149,
            author: 'AR·M⑨R',
            mid: 4694544
          }
        }
      });
    }
    if (pathname === '/api/view') {
      return jsonResponse({ code: 0, aid: 3, title: '【电影】后会无期', pic: 'https://i0.hdslb.com/a.jpg' });
    }
  }

  if (parsed.hostname === 'www.jijidown.com') {
    return jsonResponse({ code: 0, data: { title: 'jijidown 标题', pic: 'https://i0.hdslb.com/b.jpg' } });
  }

  return jsonResponse({ code: -1 }, 404);
}

const listeners = [];
const tabsCreated = [];
const installListeners = [];

const sandbox = {
  console,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  AbortController,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: mockFetch,
  importScripts: function () {
    Array.prototype.slice.call(arguments).forEach(function (file) {
      const full = path.join(root, 'js', file);
      vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: file });
    });
  },
  chrome: {
    runtime: {
      id: 'test-extension-id',
      getURL: function (relative) {
        return 'chrome-extension://test-extension-id/' + relative;
      },
      onMessage: {
        addListener: function (listener) {
          listeners.push(listener);
        }
      },
      onInstalled: {
        addListener: function (listener) {
          installListeners.push(listener);
        }
      }
    },
    tabs: {
      create: function (options, callback) {
        tabsCreated.push(options);
        if (callback) {
          callback();
        }
      }
    }
  }
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(path.join(root, 'js', 'background.js'), 'utf8'), sandbox, {
  filename: 'background.js'
});

function dispatch(message, sender) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (value) {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    let isAsync = false;
    listeners.forEach(function (listener) {
      let returned;
      try {
        returned = listener(message, sender || { id: 'test-extension-id' }, finish);
      } catch (error) {
        finish({ ok: false, code: -1, message: error.message });
        return;
      }
      if (returned === true) {
        isAsync = true;
      }
    });
    if (!isAsync && !done) {
      finish(undefined);
    }
  });
}

const apiCalls = () => calls.filter((call) => call.url.indexOf('api.bilibili.com') >= 0);
const archiveCalls = () => calls.filter((call) => call.url.indexOf('api.bilibili.com') < 0);

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.error('  ✗ ' + name);
    throw error;
  }
}

async function main() {
  await test('后台注册了消息与安装监听器', async () => {
    assert.ok(listeners.length >= 2, '应有 2 个消息监听器（路由 + 归档代理）');
    assert.equal(installListeners.length, 1);
  });

  await test('设置请求间隔', async () => {
    const response = await dispatch({ type: 'fav-set-interval', interval: 200 });
    assert.deepEqual({ ...response }, { ok: true });
  });

  await test('导航接口：登录状态与 cookie', async () => {
    calls.length = 0;
    const response = await dispatch({
      type: 'fav-api-request',
      path: '/x/web-interface/nav',
      params: {}
    });
    assert.equal(response.ok, true);
    assert.equal(response.data.isLogin, true);
    assert.equal(response.data.mid, 1);
    const call = apiCalls()[0];
    assert.ok(call, '应实际发起请求');
    assert.equal(call.options.credentials, 'include');
    assert.equal(call.options.cache, 'no-store');
  });

  await test('白名单之外的接口被拒绝且不发起请求', async () => {
    calls.length = 0;
    const response = await dispatch({
      type: 'fav-api-request',
      path: '/x/evil/path',
      params: {}
    });
    assert.equal(response.ok, false);
    assert.equal(response.code, -1);
    assert.match(response.message, /不允许/);
    assert.equal(calls.length, 0);
  });

  await test('收藏夹列表透传 data', async () => {
    const response = await dispatch({
      type: 'fav-api-request',
      path: '/x/v3/fav/folder/created/list-all',
      params: { up_mid: 1 }
    });
    assert.equal(response.ok, true);
    assert.equal(response.data.list[0].id, 123);
  });

  await test('403 时自动补 wbi 签名重试一次', async () => {
    calls.length = 0;
    const response = await dispatch({
      type: 'fav-api-request',
      path: '/x/v3/fav/resource/list',
      params: { media_id: 123, pn: 1, ps: 20 }
    });
    assert.equal(response.ok, true);
    assert.equal(response.data.medias.length, 1);
    const resourceCalls = calls.filter((call) => call.url.indexOf('/x/v3/fav/resource/list') >= 0);
    assert.equal(resourceCalls.length, 2, '应请求两次（直连 + 签名）');
    assert.ok(!resourceCalls[0].url.includes('w_rid='), '第一次不应带签名');
    assert.match(resourceCalls[1].url, /w_rid=[0-9a-f]{32}/, '第二次应带 32 位签名');
    const navCalls = calls.filter((call) => call.url.indexOf('/x/web-interface/nav') >= 0);
    assert.ok(navCalls.length >= 1, '签名前应获取 wbi 密钥');
  });

  await test('biliplus 批量归档：URL 与参数', async () => {
    calls.length = 0;
    const response = await dispatch({
      type: 'fav-archive-fetch',
      provider: 'biliplus-aidinfo',
      aids: ['3', '3', 'abc']
    });
    assert.equal(response.ok, true);
    assert.equal(response.json.data['3'].title, '【电影】后会无期');
    const call = archiveCalls()[0];
    const parsed = new URL(call.url);
    assert.equal(parsed.hostname, 'www.biliplus.com');
    assert.equal(parsed.pathname, '/api/aidinfo');
    assert.equal(parsed.searchParams.get('aid'), '3', '应去重并丢弃非法 aid');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
  });

  await test('归档结果命中内存缓存，不重复请求', async () => {
    const before = archiveCalls().length;
    const response = await dispatch({
      type: 'fav-archive-fetch',
      provider: 'biliplus-aidinfo',
      aids: ['3']
    });
    assert.equal(response.ok, true);
    assert.equal(archiveCalls().length, before, '第二次应直接命中缓存');
  });

  await test('归档代理拒绝非法 aid 与超量批次', async () => {
    const invalid = await dispatch({
      type: 'fav-archive-fetch',
      provider: 'biliplus-aidinfo',
      aids: ['not-a-number']
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error, 'invalid-aids');

    const tooMany = await dispatch({
      type: 'fav-archive-fetch',
      provider: 'biliplus-aidinfo',
      aids: Array.from({ length: 21 }, (_, index) => String(index + 1))
    });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error, 'invalid-aids');
  });

  await test('biliplus 单查与 jijidown 兜底地址', async () => {
    const view = await dispatch({
      type: 'fav-archive-fetch',
      provider: 'biliplus-view',
      aid: 3
    });
    assert.equal(view.ok, true);
    assert.equal(view.json.title, '【电影】后会无期');
    const viewUrl = new URL(archiveCalls().find((call) => call.url.indexOf('/api/view') >= 0).url);
    assert.equal(viewUrl.searchParams.get('id'), '3');

    const jiji = await dispatch({
      type: 'fav-archive-fetch',
      provider: 'jijidown-info',
      aid: '3'
    });
    assert.equal(jiji.ok, true);
    assert.equal(jiji.json.data.title, 'jijidown 标题');
    const jijiUrl = new URL(
      archiveCalls().find((call) => call.url.indexOf('jijidown.com') >= 0).url
    );
    assert.equal(jijiUrl.hostname, 'www.jijidown.com');
    assert.equal(jijiUrl.pathname, '/api/v1/video/get_info');
    assert.equal(jijiUrl.searchParams.get('id'), '3');
  });

  await test('未知数据源被拒绝', async () => {
    const response = await dispatch({
      type: 'fav-archive-fetch',
      provider: 'evil',
      aid: 3
    });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'unknown-provider');
  });

  await test('拒绝来自其他扩展的消息', async () => {
    const response = await dispatch(
      { type: 'fav-archive-fetch', provider: 'biliplus-view', aid: 3 },
      { id: 'another-extension' }
    );
    assert.equal(response.ok, false);
    assert.equal(response.error, 'blocked-sender');
  });

  await test('打开导出面板：参数拼接正确', async () => {
    tabsCreated.length = 0;
    const response = await dispatch({
      type: 'fav-open-exporter',
      uid: 123,
      fid: 456,
      folderType: 'col',
      auto: true
    });
    assert.equal(response.ok, true);
    assert.equal(tabsCreated.length, 1);
    const url = new URL(tabsCreated[0].url);
    assert.equal(url.protocol, 'chrome-extension:');
    assert.equal(url.searchParams.get('uid'), '123');
    assert.equal(url.searchParams.get('fid'), '456');
    assert.equal(url.searchParams.get('type'), 'col');
    assert.equal(url.searchParams.get('auto'), '1');
  });

  await test('安装时预热 wbi 密钥（不抛异常）', async () => {
    calls.length = 0;
    await Promise.all(
      installListeners.map(async (listener) => {
        await listener({ reason: 'install' });
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    const navCalls = calls.filter((call) => call.url.indexOf('/x/web-interface/nav') >= 0);
    assert.ok(navCalls.length >= 1, '应请求 nav 以预热');
  });

  console.log('\n通过 ' + passed + ' 项后台测试');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
