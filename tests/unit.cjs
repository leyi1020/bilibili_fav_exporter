/**
 * 纯函数单元测试（Node 运行，不依赖 Chrome）：
 *   node tests/unit.cjs
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const md5Hex = require('../js/md5.js');
const FavUtils = require('../js/utils.js');
const biliModule = require('../js/bili-api.js');
const ArchiveProxy = require('../js/archive-proxy.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.error('  ✗ ' + name);
    throw error;
  }
}

console.log('MD5');
[
  '',
  'abc',
  'The quick brown fox jumps over the lazy dog',
  '中文测试🚀 emoji',
  'a'.repeat(1000),
  'x'.repeat(55),
  'y'.repeat(56),
  'z'.repeat(64)
].forEach((input) => {
  test('md5(' + JSON.stringify(input.slice(0, 18)) + ')', () => {
    const expected = crypto.createHash('md5').update(input, 'utf8').digest('hex');
    assert.equal(md5Hex(input), expected);
  });
});

console.log('BV / av 互转');
[
  [2, 'BV1xx411c7mD'],
  [170001, 'BV17x411w7KC'],
  [545479594, 'BV11q4y1J7UA']
].forEach(([aid, bvid]) => {
  test('av' + aid + ' <-> ' + bvid, () => {
    assert.equal(FavUtils.avToBv(aid), bvid);
    assert.equal(FavUtils.bvToAv(bvid), aid);
  });
});
test('随机 aid 往返', () => {
  for (let i = 0; i < 300; i++) {
    const aid = Math.floor(Math.random() * 1e12) + 1;
    const bvid = FavUtils.avToBv(aid);
    assert.match(bvid, /^BV1[0-9A-Za-z]{9}$/);
    assert.equal(FavUtils.bvToAv(bvid), aid);
  }
});
test('非法 BV 返回 0', () => {
  assert.equal(FavUtils.bvToAv('BV0000000000'), 0);
  assert.equal(FavUtils.bvToAv('hello'), 0);
  assert.equal(FavUtils.avToBv(-1), '');
});

console.log('wbi 签名');
test('查询串已排序且带 w_rid / wts', () => {
  const query = biliModule.encWbi(
    { z: 1, a: 'x y', mid: 42 },
    '7cd084941338484aae1ad9425b84077c',
    '4932caff0ff746eab6f01bf08b70ac45'
  );
  const parts = query.split('&');
  const keys = parts.map((part) => part.split('=')[0]);
  assert.deepEqual(keys.slice(0, -1), ['a', 'mid', 'wts', 'z']);
  assert.match(parts[parts.length - 1], /^w_rid=[0-9a-f]{32}$/);
});
test('mixinKey 取前 32 位', () => {
  const key = biliModule.getMixinKey(
    '7cd084941338484aae1ad9425b84077c4932caff0ff746eab6f01bf08b70ac45'
  );
  assert.equal(key, 'ea1db124af3c7062474693fa704f4ff8');
});
test('与 B 站文档示例的签名一致', () => {
  const realNow = Date.now;
  Date.now = () => 1702204169000;
  try {
    assert.equal(
      biliModule.encWbi(
        { foo: '114', bar: '514', zab: '1919810' },
        '7cd084941338484aae1ad9425b84077c',
        '4932caff0ff746eab6f01bf08b70ac45'
      ),
      'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4'
    );
  } finally {
    Date.now = realNow;
  }
});

console.log('封面地址');
test('biliplus 归档封面改写为 hdslb', () => {
  assert.equal(
    FavUtils.normalizeCoverUrl('https://img.biliplus.com/bfs/archive/abc.jpg'),
    'https://i0.hdslb.com/bfs/archive/abc.jpg'
  );
});
test('协议相对地址补 https', () => {
  assert.equal(
    FavUtils.normalizeCoverUrl('//i0.hdslb.com/bfs/archive/a.jpg'),
    'https://i0.hdslb.com/bfs/archive/a.jpg'
  );
  assert.equal(
    FavUtils.normalizeCoverUrl('http://i0.hdslb.com/bfs/archive/a.jpg'),
    'https://i0.hdslb.com/bfs/archive/a.jpg'
  );
});
test('缩放地址与兜底候选', () => {
  assert.equal(
    FavUtils.resizedCoverUrl('https://i0.hdslb.com/bfs/archive/a.jpg', 480),
    'https://i0.hdslb.com/bfs/archive/a.jpg@480w_300h_1c.webp'
  );
  assert.deepEqual(
    FavUtils.coverCandidates(
      'https://i0.hdslb.com/bfs/archive/a.jpg',
      'https://img.biliplus.com/bfs/archive/a.jpg',
      480
    ),
    [
      'https://i0.hdslb.com/bfs/archive/a.jpg@480w_300h_1c.webp',
      'https://i0.hdslb.com/bfs/archive/a.jpg',
      'https://img.biliplus.com/bfs/archive/a.jpg'
    ]
  );
});
test('灰色占位封面不算有效封面', () => {
  assert.equal(
    FavUtils.isGoodCoverUrl(
      'http://i0.hdslb.com/bfs/archive/be27fd62c99036dce67efface486fb0a88ffed06.jpg'
    ),
    false
  );
});

console.log('失效判定');
test('已失效视频标题', () => {
  assert.equal(FavUtils.isInvalidMedia({ title: '已失效视频' }), true);
  assert.equal(FavUtils.isInvalidMedia({ title: '视频去哪了呢？' }), true);
});
test('占位封面', () => {
  assert.equal(
    FavUtils.isInvalidMedia({
      title: '正常标题',
      cover: 'http://i0.hdslb.com/bfs/archive/be27fd62c99036dce67efface486fb0a88ffed06.jpg'
    }),
    true
  );
});
test('正常视频不误判', () => {
  assert.equal(
    FavUtils.isInvalidMedia({
      id: 123,
      title: '普通视频',
      cover: 'https://i0.hdslb.com/bfs/archive/aaa.jpg',
      bvid: 'BV1xx411c7mD'
    }),
    false
  );
});

console.log('格式化');
test('时长', () => {
  assert.equal(FavUtils.formatDuration(0), '0:00');
  assert.equal(FavUtils.formatDuration(65), '1:05');
  assert.equal(FavUtils.formatDuration(3725), '1:02:05');
});
test('计数', () => {
  assert.equal(FavUtils.formatCount(999), '999');
  assert.equal(FavUtils.formatCount(12345), '1.2 万');
  assert.equal(FavUtils.formatCount(123456789), '1.2 亿');
});
test('转义', () => {
  assert.equal(FavUtils.escapeHtml('<b>"x"</b>&'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;&amp;');
});
test('收藏夹页 URL 解析', () => {
  assert.deepEqual(FavUtils.parseBilibiliLocation('https://space.bilibili.com/42/favlist?fid=99'), {
    uid: 42,
    fid: 99,
    type: 'fav',
    isFavPage: true,
    isSpace: true
  });
  assert.equal(FavUtils.parseBilibiliLocation('https://www.bilibili.com/list/ml123').fid, 123);
  assert.deepEqual(
    FavUtils.parseBilibiliLocation('https://space.bilibili.com/42/lists/789?type=season'),
    {
      uid: 42,
      fid: 789,
      type: 'col',
      isFavPage: true,
      isSpace: true
    }
  );
  assert.equal(FavUtils.parseBilibiliLocation('https://www.bilibili.com/video/BV1xx411c7mD').uid, 0);
});

console.log('归档代理 URL 构造');
test('biliplus 批量 aidinfo', () => {
  assert.equal(
    ArchiveProxy.buildArchiveUrl({ provider: 'biliplus-aidinfo', aids: ['3', 3, '5'] }),
    'https://www.biliplus.com/api/aidinfo?aid=3%2C5'
  );
});
test('biliplus view', () => {
  assert.equal(
    ArchiveProxy.buildArchiveUrl({ provider: 'biliplus-view', aid: 3 }),
    'https://www.biliplus.com/api/view?id=3'
  );
});
test('jijidown', () => {
  assert.equal(
    ArchiveProxy.buildArchiveUrl({ provider: 'jijidown-info', aid: '170001' }),
    'https://www.jijidown.com/api/v1/video/get_info?id=170001'
  );
});
test('非法 aid 抛出', () => {
  assert.throws(() => ArchiveProxy.buildArchiveUrl({ provider: 'biliplus-view', aid: '3;drop' }));
  assert.throws(() => ArchiveProxy.buildArchiveUrl({ provider: 'unknown', aid: 3 }));
  assert.throws(() => ArchiveProxy.buildArchiveUrl({ provider: 'biliplus-aidinfo', aids: [] }));
});

console.log('失效视频信息合并');
function loadRecoveryModule() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    TextEncoder,
    chrome: {
      storage: {
        local: {
          get(_key, callback) {
            callback({});
          },
          set(_obj, callback) {
            if (callback) callback();
          },
          remove(_keys, callback) {
            if (callback) callback();
          }
        }
      },
      runtime: { lastError: null, sendMessage() {} }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ['js/utils.js', 'js/page-api.js', 'js/invalid-recovery.js'].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  });
  return sandbox;
}
const sandbox = loadRecoveryModule();
const InvalidRecovery = sandbox.InvalidRecovery;

test('biliplus aidinfo 结果合并出标题 / 封面 / UP', () => {
  const meta = InvalidRecovery.mergeMeta(
    InvalidRecovery.emptyMeta(3, ''),
    {
      aid: 3,
      title: '【电影】后会无期',
      pic: 'https://img.biliplus.com/bfs/archive/9b53b363e0f6c16b3a73aa38f8a8c062eaff6187.jpg',
      author: 'AR·M⑨R',
      mid: 4694544,
      created: 1295572149
    },
    'biliplus'
  );
  assert.equal(meta.title, '【电影】后会无期');
  assert.equal(meta.pic, 'https://i0.hdslb.com/bfs/archive/9b53b363e0f6c16b3a73aa38f8a8c062eaff6187.jpg');
  assert.equal(meta.picRaw, 'https://img.biliplus.com/bfs/archive/9b53b363e0f6c16b3a73aa38f8a8c062eaff6187.jpg');
  assert.equal(meta.ownerName, 'AR·M⑨R');
  assert.equal(meta.ownerMid, 4694544);
  assert.equal(meta.bvid, 'BV1xx411c7mS');
  assert.equal(meta.pubtime, 1295572149);
  assert.equal(meta.titleSource, 'biliplus');
  assert.equal(InvalidRecovery.isComplete(meta), true);
});
test('不覆盖已有的好标题，弱标题会被替换', () => {
  const base = Object.assign(InvalidRecovery.emptyMeta(100, ''), { title: '分P弱标题', weakTitle: true });
  const merged = InvalidRecovery.mergeMeta(base, { title: '真实标题', pic: '', author: '' }, 'biliplus');
  assert.equal(merged.title, '真实标题');
  assert.equal(merged.weakTitle, false);
});
test('不会把「已失效视频」当成有效标题', () => {
  const base = InvalidRecovery.emptyMeta(100, '');
  const merged = InvalidRecovery.mergeMeta(base, { title: '已失效视频', pic: '' }, 'jijidown');
  assert.equal(merged.title, '');
});
test('封面缺失时用首帧图兜底', () => {
  const meta = InvalidRecovery.mergeMeta(
    InvalidRecovery.emptyMeta(100, ''),
    { title: 't', pic: '', first_frame: 'https://i0.hdslb.com/bfs/storyframe/abc.jpg', mid: 1 },
    'biliplus'
  );
  assert.equal(meta.pic, 'https://i0.hdslb.com/bfs/storyframe/abc.jpg');
  assert.equal(meta.coverSource, 'biliplus:first_frame');
});
test('解析 biliplus view（夜间归档结构）', () => {
  const parsed = InvalidRecovery.parseBiliplusView({
    ok: true,
    json: {
      code: 0,
      aid: 3,
      title: '【电影】后会无期',
      pic: 'https://img.biliplus.com/bfs/archive/9b53.jpg',
      author: 'AR·M⑨R',
      mid: 4694544,
      created: 1295572149,
      v2_app_api: { bvid: '', owner: { mid: 4694544, name: 'AR·M⑨R' } }
    }
  });
  assert.equal(parsed.title, '【电影】后会无期');
  assert.equal(parsed.mid, 4694544);
  assert.equal(parsed.owner.name, 'AR·M⑨R');
});
test('解析 jijidown（loading / 正常）', () => {
  const loading = InvalidRecovery.parseJijidown({ ok: true, json: { msg: 'loading' } });
  assert.equal(loading.loading, true);
  const parsed = InvalidRecovery.parseJijidown({
    ok: true,
    json: { title: '某个老视频', img: 'https://i2.hdslb.com/bfs/archive/x.jpg', upid: 123, up: { author: 'UP' } }
  });
  assert.equal(parsed.title, '某个老视频');
  assert.equal(parsed.pic, 'https://i2.hdslb.com/bfs/archive/x.jpg');
  assert.equal(parsed.mid, 123);
  assert.equal(parsed.author, 'UP');
  assert.equal(InvalidRecovery.parseJijidown({ ok: true, json: { upid: 0 } }), null);
});

console.log('\n通过 ' + passed + ' 项测试');
