/**
 * 生成导出面板的离线演示页：注入一个模拟 chrome.* 的桩，
 * 让 exporter.html 在 file:// 下也能渲染出收藏夹列表，便于布局与交互检查。
 *
 *   node tests/build-demo.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'samples');

const STUB = `
<script>
/* 仅用于离线演示 / 测试的 chrome API 桩 */
window.chrome = (function () {
  var store = {};
  var folders = {
    fav: [
      { id: 1001, title: '默认收藏夹', media_count: 128, cover: '', intro: '平时收藏的视频', ctime: 1600000000, mtime: 1700000000 },
      { id: 1002, title: '学习 / 算法与数据结构', media_count: 32, cover: '', intro: '课程与题解', ctime: 1600000000, mtime: 1700000000 },
      { id: 1003, title: '音乐', media_count: 7, cover: '', intro: '', ctime: 1600000000, mtime: 1700000000 },
      { id: 1004, title: '空收藏夹', media_count: 0, cover: '', intro: '', ctime: 1600000000, mtime: 1700000000 }
    ],
    col: [
      { id: 2001, title: '某 UP 的系列合集', media_count: 12, cover: '', intro: '合集简介', upper: { mid: 42, name: '示例UP' }, link: 'https://space.bilibili.com/42/lists/2001?type=season' },
      { id: 2002, title: '另一个合集', media_count: 5, cover: '', intro: '', upper: { mid: 43, name: '另一个UP' }, link: '' }
    ]
  };

  function reply(message, callback) {
    setTimeout(function () {
      var response = { ok: false, code: -1, message: '演示桩未实现：' + (message && message.type) };
      if (message && message.type === 'fav-api-request') {
        var params = message.params || {};
        if (message.path === '/x/web-interface/nav') {
          response = { ok: true, code: 0, data: { isLogin: true, mid: 12345678, uname: '示例用户', face: '' } };
        } else if (message.path === '/x/v3/fav/folder/created/list-all') {
          response = { ok: true, code: 0, data: { count: folders.fav.length, list: folders.fav } };
        } else if (message.path === '/x/v3/fav/folder/collected/list') {
          response = {
            ok: true,
            code: 0,
            data: { count: folders.col.length, list: params.pn === 1 ? folders.col : [], has_more: false }
          };
        }
      } else if (message && message.type === 'fav-set-interval') {
        response = { ok: true };
      }
      callback(response);
    }, 30);
  }

  return {
    runtime: {
      id: 'demo',
      lastError: null,
      getURL: function (relative) {
        return new URL('../' + relative, location.href).href;
      },
      getManifest: function () {
        return { version: '1.0.0-demo' };
      },
      sendMessage: reply
    },
    storage: {
      local: {
        get: function (keys, callback) {
          var out = {};
          if (keys === null || keys === undefined) {
            out = Object.assign({}, store);
          } else if (typeof keys === 'string') {
            if (keys in store) { out[keys] = store[keys]; }
          } else if (Array.isArray(keys)) {
            keys.forEach(function (key) { if (key in store) { out[key] = store[key]; } });
          }
          setTimeout(function () { callback(out); }, 0);
        },
        set: function (items, callback) {
          Object.assign(store, items || {});
          if (callback) { setTimeout(callback, 0); }
        },
        remove: function (keys, callback) {
          (Array.isArray(keys) ? keys : [keys]).forEach(function (key) { delete store[key]; });
          if (callback) { setTimeout(callback, 0); }
        }
      }
    },
    tabs: {
      create: function () {},
      query: function () { return Promise.resolve([]); }
    }
  };
})();
</script>
`;

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const source = fs.readFileSync(path.join(root, 'exporter.html'), 'utf8');

  let html = source
    .replace('href="css/exporter.css"', 'href="../css/exporter.css"')
    .replace(/src="js\//g, 'src="../js/')
    .replace('<script src="../js/utils.js"></script>', STUB + '  <script src="../js/utils.js"></script>');

  if (html.indexOf('../js/exporter.js') < 0) {
    throw new Error('未能重写脚本路径');
  }
  if (html.indexOf('演示桩') < 0) {
    throw new Error('未能注入 chrome 桩');
  }

  const target = path.join(outDir, 'demo-exporter.html');
  fs.writeFileSync(target, html, 'utf8');
  console.log('已生成：' + target);
}

main();
