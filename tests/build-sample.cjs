/**
 * 生成示例导出 HTML（不访问网络），用于检查静态文档的布局与转义。
 *
 *   node tests/build-sample.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const samplesDir = path.join(root, 'samples');

function svgCover(label, color) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300">' +
    '<rect width="480" height="300" fill="' + color + '"/>' +
    '<text x="240" y="150" font-size="28" fill="#ffffff" text-anchor="middle" ' +
    'font-family="sans-serif">' + label + '</text>' +
    '<text x="240" y="190" font-size="16" fill="#ffffff" opacity="0.75" text-anchor="middle" ' +
    'font-family="sans-serif">SAMPLE COVER</text>' +
    '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function video(overrides) {
  const base = {
    aid: 170001,
    bvid: 'BV17x411w7KC',
    title: '示例视频',
    cover: '',
    coverData: '',
    coverRaw: '',
    intro: '这是示例简介。',
    duration: 125,
    pubtime: 1600000000,
    favtime: 1700000000,
    upper: { mid: 42, name: '示例UP主' },
    stats: { play: 12345, danmaku: 67, collect: 890 },
    invalid: false,
    recovered: false,
    source: ''
  };
  return Object.assign(base, overrides);
}

function buildData() {
  const favVideos = [
    video({
      aid: 2,
      bvid: 'BV1xx411c7mD',
      title: '【4K 60帧】这是一支画质很好的示例视频',
      coverData: svgCover('4K 示例', '#5b8def'),
      duration: 3725,
      upper: { mid: 10001, name: '影视飓风' }
    }),
    video({
      aid: 170002,
      bvid: 'BV17x411w7KD',
      title: '这是一支标题非常非常长的视频，用来测试卡片标题在两行之后是否正确截断，以及是否会撑破整个网格布局',
      coverData: svgCover('长标题', '#7c5cff'),
      duration: 754,
      upper: { mid: 10002, name: '一个名字也很长的UP主名称测试' }
    }),
    video({
      aid: 170003,
      bvid: 'BV17x411w7KE',
      title: '<script>alert(1)</script> 标题里的特殊字符 & "引号" 与 \'单引号\'',
      coverData: svgCover('转义测试', '#f97316'),
      duration: 61,
      upper: { mid: 10003, name: 'A&B <工作室>' }
    }),
    video({
      aid: 170004,
      bvid: 'BV17x411w7KF',
      title: '🎉 带 emoji 的标题 🚀 收藏夹导出测试',
      coverData: svgCover('Emoji', '#14b8a6'),
      duration: 45,
      upper: { mid: 10004, name: '表情包UP' }
    }),
    video({
      aid: 170005,
      bvid: 'BV17x411w7KG',
      title: '没有封面的视频（应显示暂无封面占位）',
      duration: 30,
      upper: { mid: 10005, name: '未知封面UP' }
    }),
    video({
      aid: 170006,
      bvid: 'BV17x411w7KH',
      title: '刚刚收藏的短视频',
      coverData: svgCover('短视频', '#e11d48'),
      duration: 12,
      favtime: 1730000000,
      upper: { mid: 10006, name: '生活区UP' }
    })
  ];

  const invalidVideos = [
    video({
      aid: 3,
      bvid: 'BV1xx411c7mS',
      title: '【电影】后会无期',
      coverData: svgCover('biliplus 归档', '#b45309'),
      cover: 'https://i0.hdslb.com/bfs/archive/9b53b363e0f6c16b3a73aa38f8a8c062eaff6187.jpg',
      coverRaw: 'https://img.biliplus.com/bfs/archive/9b53b363e0f6c16b3a73aa38f8a8c062eaff6187.jpg',
      duration: 0,
      pubtime: 1295572149,
      favtime: 1700000001,
      upper: { mid: 4694544, name: 'AR·M⑨R' },
      stats: { play: 123126, danmaku: 0, collect: 82 },
      invalid: true,
      recovered: true,
      source: 'biliplus'
    }),
    video({
      aid: 1700010,
      bvid: 'BV17x411w7KJ',
      title: '某个被删除的舞蹈视频（jijidown 还原）',
      coverData: svgCover('jijidown 归档', '#047857'),
      duration: 193,
      pubtime: 1500000000,
      favtime: 1700000002,
      upper: { mid: 55001, name: '舞蹈区UP' },
      invalid: true,
      recovered: true,
      source: 'jijidown'
    }),
    video({
      aid: 999999,
      bvid: 'BV1xx411c7mD'.replace('mD', 'mT'),
      title: '已失效视频（av999999）',
      duration: 0,
      pubtime: 0,
      favtime: 1700000003,
      upper: { mid: 0, name: '' },
      stats: { play: 0, danmaku: 0, collect: 0 },
      invalid: true,
      recovered: false,
      source: ''
    })
  ];

  const collectionVideos = [
    video({
      aid: 2000001,
      bvid: 'BV1xx411c7mA',
      title: '合集第 1 集：开场介绍',
      coverData: svgCover('合集 P1', '#0284c7'),
      duration: 300,
      upper: { mid: 42, name: '示例UP主' }
    }),
    video({
      aid: 2000002,
      bvid: 'BV1xx411c7mB',
      title: '合集第 2 集：深入实现',
      coverData: svgCover('合集 P2', '#0f766e'),
      duration: 620,
      upper: { mid: 42, name: '示例UP主' }
    })
  ];

  return {
    meta: {
      generator: '哔哩哔哩收藏夹导出（HTML）',
      version: '1.0.0',
      exportedAt: 1730361600,
      uid: 12345678,
      userName: '示例用户',
      folderCount: 3,
      videoCount: favVideos.length + invalidVideos.length + collectionVideos.length,
      invalidCount: invalidVideos.length,
      recoveredCount: 2,
      coverEmbedded: favVideos.length + invalidVideos.length + collectionVideos.length - 2,
      embedCovers: true
    },
    folders: [
      {
        id: 1001,
        type: 'fav',
        title: '默认收藏夹',
        intro: '平时收藏的视频',
        mediaCount: favVideos.length,
        link: 'https://space.bilibili.com/12345678/favlist?fid=1001',
        videos: favVideos
      },
      {
        id: 1002,
        type: 'fav',
        title: '失效视频测试',
        intro: '用于验证归档还原效果',
        mediaCount: invalidVideos.length,
        link: 'https://space.bilibili.com/12345678/favlist?fid=1002',
        videos: invalidVideos
      },
      {
        id: 2001,
        type: 'col',
        title: '某 UP 的系列合集',
        intro: '合集简介',
        mediaCount: collectionVideos.length,
        link: 'https://space.bilibili.com/42/lists/2001?type=season',
        videos: collectionVideos
      }
    ]
  };
}

function loadBuilder() {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    Blob,
    chrome: {
      runtime: {
        getURL: function (relative) {
          return 'file:///' + path.join(root, relative).replace(/\\/g, '/');
        }
      }
    },
    fetch: async function (url) {
      const file = decodeURIComponent(String(url).replace(/^file:\/\/\//, ''));
      const text = await fs.promises.readFile(file, 'utf8');
      return { ok: true, text: async function () { return text; } };
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ['js/utils.js', 'js/export-html.js'].forEach(function (file) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  });
  return sandbox;
}

async function main() {
  fs.mkdirSync(samplesDir, { recursive: true });
  const data = buildData();
  const sandbox = loadBuilder();
  const html = await sandbox.FavHtmlExporter.build(data);

  const htmlPath = path.join(samplesDir, 'sample-export.html');
  const jsonPath = path.join(samplesDir, 'sample-data.json');
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

  const checks = [
    ['不含 script 标签', !/<script\b/i.test(html)],
    ['包含 11 张卡片', (html.match(/class="card[ "]/g) || []).length === 11],
    ['包含嵌入封面', html.indexOf('data:image/svg+xml') >= 0],
    ['包含 biliplus 归档 UP 的 UID', html.indexOf('UID 4694544') >= 0],
    ['保留失效标记', (html.match(/class="badge badge--invalid"/g) || []).length === 3],
    ['保留已还原标记', (html.match(/class="badge badge--ok"/g) || []).length === 2],
    ['标题特殊字符被转义', html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') >= 0],
    ['目录锚点存在', html.indexOf('href="#folder-2"') >= 0]
  ];

  let failed = 0;
  checks.forEach(function (check) {
    console.log((check[1] ? '  ✓ ' : '  ✗ ') + check[0]);
    if (!check[1]) {
      failed += 1;
    }
  });

  console.log('\n生成：' + htmlPath + '（' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB）');
  console.log('生成：' + jsonPath);
  if (failed > 0) {
    throw new Error(failed + ' 项检查失败');
  }
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
