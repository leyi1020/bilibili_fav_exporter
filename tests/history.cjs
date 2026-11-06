/**
 * 抓取记录（js/history.js）的单元测试：合并、匹配、导入导出与持久化。
 *
 *   node tests/history.cjs
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const store = {};

const chromeStub = {
  runtime: { lastError: null },
  storage: {
    local: {
      get(key, callback) {
        setTimeout(() => {
          if (typeof key === 'string') {
            callback(key in store ? { [key]: store[key] } : {});
          } else {
            callback({ ...store });
          }
        }, 0);
      },
      set(items, callback) {
        Object.assign(store, items);
        setTimeout(() => callback && callback(), 0);
      },
      remove(keys, callback) {
        (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete store[key]);
        setTimeout(() => callback && callback(), 0);
      }
    }
  }
};

const sandbox = { console, chrome: chromeStub, URL, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
['js/utils.js', 'js/history.js'].forEach((file) => {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
});

const History = sandbox.FavHistory;
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
  await test('初始为空', async () => {
    await History.load(true);
    assert.equal(History.size(), 0);
    assert.equal(History.has('默认收藏夹', 'BV1xx411c7mD'), false);
  });

  await test('新增记录并按「收藏夹 + BV」去重', async () => {
    const result = await History.addRecords([
      { folder: '默认收藏夹', bvid: 'BV1xx411c7mD', title: '视频 A' },
      { folder: '默认收藏夹', bvid: 'BV1xx411c7mD', title: '视频 A' },
      { folder: '另一个收藏夹', bvid: 'BV1xx411c7mD', title: '视频 A' },
      { folder: '默认收藏夹', bvid: '不是BV号', title: '无效' }
    ]);
    assert.equal(result.added, 2);
    assert.equal(result.total, 2);
    assert.equal(History.size(), 2);
    assert.equal(History.has('默认收藏夹', 'BV1xx411c7mD'), true);
    assert.equal(History.has('另一个收藏夹', 'BV1xx411c7mD'), true);
    assert.equal(History.has('默认收藏夹', 'BV1xx411c7mS'), false);
  });

  await test('同一 BV 号在不同收藏夹互不影响', async () => {
    assert.equal(History.has('不存在的收藏夹', 'BV1xx411c7mD'), false);
    assert.equal(History.folderCount('默认收藏夹'), 1);
    assert.equal(History.folderCount('另一个收藏夹'), 1);
  });

  await test('重复记录只更新标题', async () => {
    const result = await History.addRecords([
      { folder: '默认收藏夹', bvid: 'BV1xx411c7mD', title: '视频 A（新标题）' }
    ]);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 1);
    const doc = JSON.parse(History.toJson());
    const record = doc.videos.find((item) => item.folder === '默认收藏夹');
    assert.equal(record.title, '视频 A（新标题）');
  });

  await test('导出的 JSON 每条只含收藏夹 / BV / 名称', async () => {
    const doc = JSON.parse(History.toJson());
    assert.equal(doc.count, 2);
    doc.videos.forEach((record) => {
      assert.deepEqual(Object.keys(record).sort(), ['bvid', 'folder', 'title']);
    });
  });

  await test('导入 JSON：合并、去重、忽略无效条目', async () => {
    const text = JSON.stringify({
      videos: [
        { folder: '默认收藏夹', bvid: 'BV1xx411c7mS', title: '导入 1' },
        { folder: '默认收藏夹', bvid: 'bv1xx411c7mS', title: '重复' },
        { folder: '', bvid: 'BV1xx411c7mT', title: '无效' },
        { folder: '新收藏夹', bvid: 'BV1xx411c7mT', title: '导入 2' }
      ]
    });
    const result = await History.importJson(text);
    assert.equal(result.added, 2);
    assert.equal(result.invalid, 1);
    assert.equal(result.total, 4);
    assert.equal(History.has('默认收藏夹', 'BV1xx411c7mS'), true);
    assert.equal(History.has('新收藏夹', 'BV1xx411c7mT'), true);
  });

  await test('拒绝格式错误的 JSON', async () => {
    await assert.rejects(() => History.importJson('{"foo": 1}'), /JSON 格式不正确/);
    await assert.rejects(() => History.importJson('not json'), /JSON 格式不正确/);
  });

  await test('写入后重新读取仍然存在', async () => {
    assert.ok(store[History.STORAGE_KEY], '应写入 storage');
    await History.load(true);
    assert.equal(History.size(), 4);
    assert.equal(History.has('新收藏夹', 'BV1xx411c7mT'), true);
  });

  await test('记录文件名带时间戳', async () => {
    assert.match(History.fileName(), /^bilibili-fav-history-\d{8}_\d{4}\.json$/);
  });

  await test('清空记录', async () => {
    await History.clear();
    assert.equal(History.size(), 0);
    assert.equal(History.has('默认收藏夹', 'BV1xx411c7mD'), false);
  });

  console.log('\n通过 ' + passed + ' 项抓取记录测试');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
