/**
 * 端到端导出测试：
 *   通过 CDP 加载真实扩展，拦截后台与页面的网络请求，模拟一个包含
 *   「正常视频 + 失效视频」的收藏夹，驱动导出面板完成导出并下载 HTML。
 *
 *   覆盖三条路径：
 *     1. 首次导出：3 个视频，失效视频由 biliplus 归档还原；
 *     2. 第二次导出：新增 1 个视频，按「收藏夹 + BV」跳过已抓取的 3 个；
 *     3. 关闭「跳过已抓取」：重新导出全部 4 个视频。
 *
 *   每次导出使用新页面，避免 Chrome 对同一页面的多文件自动下载限制。
 *
 *   node tests/e2e-export.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs, intervalMs, label) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs || 200);
  }
  throw new Error((label || '等待超时') + (lastError ? '：' + lastError.message : ''));
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.errors = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 错误'));
      });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || 'CDP 调用失败'));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails || {};
        this.errors.push(
          'Runtime.exceptionThrown：' +
            ((details.exception && (details.exception.description || details.exception.value)) ||
              details.text ||
              '')
        );
      }
      if (message.method === 'Log.entryAdded') {
        const entry = message.params.entry || {};
        if (entry.level === 'error') {
          this.errors.push('Log.entryAdded：' + (entry.text || ''));
        }
      }
      (this.listeners.get(message.method) || []).forEach((listener) => listener(message.params));
    });
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, []);
    }
    this.listeners.get(method).push(listener);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(
        (details.exception && (details.exception.description || details.exception.value)) ||
          details.text ||
          '页面脚本异常'
      );
    }
    return result.result.value;
  }

  // 带用户手势执行：连续触发下载时 Chrome 需要 user activation
  async evaluateWithGesture(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(
        (details.exception && (details.exception.description || details.exception.value)) ||
          details.text ||
          '页面脚本异常'
      );
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch (error) {
      // 忽略
    }
  }
}

const MOCK_COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

async function fulfill(cdp, requestId, body, contentType) {
  await cdp.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: contentType || 'application/json; charset=utf-8' },
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Cache-Control', value: 'no-store' }
    ],
    body: Buffer.from(body).toString('base64')
  });
}

const VALID_COVER_1 = 'https://i0.hdslb.com/bfs/archive/mock-cover-1.jpg';
const VALID_COVER_2 = 'https://i0.hdslb.com/bfs/archive/mock-cover-2.jpg';
const VALID_COVER_4 = 'https://i0.hdslb.com/bfs/archive/mock-cover-4.jpg';
const ARCHIVE_COVER = 'https://img.biliplus.com/bfs/archive/mock-cover-3.jpg';

// 抓取记录测试会往这个数组里追加视频，模拟「第二次导出时收藏夹里多了新视频」
const mockState = {
  medias: [
    {
      id: 100,
      bvid: 'BV1xx411c7mD',
      title: '正常视频一',
      cover: VALID_COVER_1,
      duration: 60,
      pubtime: 1600000000,
      fav_time: 1700000000,
      upper: { mid: 1, name: 'UP 一' },
      cnt_info: { play: 10, danmaku: 2, collect: 3 },
      attr: 0
    },
    {
      id: 101,
      bvid: 'BV1xx411c7mS',
      title: '正常视频二',
      cover: VALID_COVER_2,
      duration: 120,
      pubtime: 1600000001,
      fav_time: 1700000001,
      upper: { mid: 2, name: 'UP 二' },
      cnt_info: { play: 20, danmaku: 3, collect: 4 },
      attr: 0
    },
    {
      id: 102,
      bvid: '',
      title: '已失效视频',
      cover:
        'https://i0.hdslb.com/bfs/archive/be27fd62c99036dce67efface486fb0a88ffed06.jpg',
      duration: 0,
      pubtime: 0,
      fav_time: 1700000002,
      upper: { mid: 0, name: '' },
      cnt_info: { play: 0, danmaku: 0, collect: 0 },
      attr: 9
    }
  ],
  added: {
    id: 103,
    bvid: 'BV1xx411c7mT',
    title: '第二次导出时新增的视频',
    cover: VALID_COVER_4,
    duration: 90,
    pubtime: 1600000004,
    fav_time: 1700000004,
    upper: { mid: 4, name: 'UP 四' },
    cnt_info: { play: 40, danmaku: 4, collect: 5 },
    attr: 0
  }
};

function mockApiResponse(url) {
  const parsed = new URL(url);
  const pathname = parsed.pathname;

  if (parsed.hostname === 'api.bilibili.com') {
    if (pathname === '/x/web-interface/nav') {
      return {
        code: 0,
        message: 'OK',
        data: { isLogin: true, mid: 12345678, uname: '测试用户', face: '' }
      };
    }
    if (pathname === '/x/v3/fav/folder/created/list-all') {
      return {
        code: 0,
        message: 'OK',
        data: {
          count: 1,
          list: [
            {
              id: 1001,
              title: '测试收藏夹',
              media_count: mockState.medias.length,
              cover: '',
              intro: 'E2E 测试'
            }
          ]
        }
      };
    }
    if (pathname === '/x/v3/fav/folder/collected/list') {
      return { code: 0, message: 'OK', data: { count: 0, list: [], has_more: false } };
    }
    if (pathname === '/x/v3/fav/resource/list') {
      return {
        code: 0,
        message: 'OK',
        data: {
          info: {
            id: 1001,
            title: '测试收藏夹',
            media_count: mockState.medias.length,
            cover: '',
            intro: 'E2E 测试',
            upper: { mid: 12345678, name: '测试用户' }
          },
          medias: mockState.medias,
          has_more: false
        }
      };
    }
    if (pathname === '/x/player/pagelist') {
      return { code: 0, message: 'OK', data: [] };
    }
    if (pathname === '/x/web-interface/view') {
      return { code: 62002, message: '稿件不可见', data: null };
    }
  }

  if (parsed.hostname === 'www.biliplus.com') {
    if (pathname === '/api/aidinfo') {
      return {
        code: 0,
        data: {
          '102': {
            title: '【归档】被删除的测试视频',
            pic: ARCHIVE_COVER,
            created: 1200000000,
            author: '归档UP',
            mid: 999
          }
        }
      };
    }
    if (pathname === '/api/view') {
      return {
        code: 0,
        aid: 102,
        title: '【归档】被删除的测试视频',
        pic: ARCHIVE_COVER,
        author: '归档UP',
        mid: 999,
        created: 1200000000
      };
    }
  }

  if (parsed.hostname === 'www.jijidown.com') {
    return {
      code: 0,
      data: { title: '【归档】被删除的测试视频', pic: ARCHIVE_COVER }
    };
  }

  return { code: -404, message: 'mock 未实现：' + url };
}

async function enableSwInterception(cdp) {
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://api.bilibili.com/*' },
      { urlPattern: 'https://www.biliplus.com/*' },
      { urlPattern: 'https://www.jijidown.com/*' }
    ]
  });
  cdp.on('Fetch.requestPaused', (params) => {
    fulfill(cdp, params.requestId, jsonBody(mockApiResponse(params.request.url))).catch((error) => {
      console.error('mock 响应失败：' + error.message);
    });
  });
}

async function waitForServiceWorker(base) {
  const targets = await (await fetch(base + '/json/list')).json();
  const worker = targets.find(
    (target) => target.type === 'service_worker' && /\/js\/background\.js$/.test(target.url)
  );
  return worker || null;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    throw new Error('未找到 Chrome：' + CHROME);
  }

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'favx-e2e-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favx-dl-'));

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=' + port,
      '--remote-allow-origins=*',
      '--user-data-dir=' + profile,
      '--enable-unsafe-extension-debugging',
      '--window-size=1280,900',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  const closers = [];
  let passed = 0;
  const failures = [];
  const pageErrors = [];

  function check(name, ok, detail) {
    if (ok) {
      passed += 1;
      console.log('  ✓ ' + name + (detail ? '（' + detail + '）' : ''));
    } else {
      failures.push(name + (detail ? '（' + detail + '）' : ''));
      console.log('  ✗ ' + name + (detail ? '（' + detail + '）' : ''));
    }
  }

  function htmlDownloads() {
    return fs
      .readdirSync(downloadDir)
      .filter((file) => /\.html$/i.test(file) && !/\.crdownload$/i.test(file))
      .map((file) => path.join(downloadDir, file))
      .filter((filePath) => fs.statSync(filePath).size > 1000)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  }

  function waitForNewDownload(previousCount, timeout) {
    return waitFor(
      () => {
        const files = htmlDownloads();
        return files.length > previousCount ? files[0] : null;
      },
      timeout || 90000,
      300,
      '等待第 ' + (previousCount + 1) + ' 个 HTML 下载超时'
    );
  }

  try {
    const version = await waitFor(
      async () => {
        const response = await fetch(base + '/json/version');
        return response.ok ? response.json() : null;
      },
      20000,
      200,
      'Chrome 启动超时'
    );

    const browser = new CDP(version.webSocketDebuggerUrl);
    await browser.connect();
    closers.push(() => browser.close());

    await browser
      .send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
        eventsEnabled: true
      })
      .catch(() => {});

    const loaded = await browser.send('Extensions.loadUnpacked', { path: root });
    console.log('扩展已加载：' + loaded.id);

    const worker = await waitFor(
      () => waitForServiceWorker(base),
      10000,
      150,
      '未发现后台 Service Worker'
    );
    const sw = new CDP(worker.webSocketDebuggerUrl);
    await sw.connect();
    await sw.send('Runtime.enable').catch(() => {});
    await sw.send('Log.enable').catch(() => {});
    await enableSwInterception(sw);
    closers.push(() => sw.close());

    const openExporter = async () => {
      const info = await (
        await fetch(
          base +
            '/json/new?' +
            encodeURIComponent(
              'chrome-extension://' + loaded.id + '/exporter.html?uid=12345678&auto=1'
            ),
          { method: 'PUT' }
        )
      ).json();
      const page = new CDP(info.webSocketDebuggerUrl);
      await page.connect();
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Log.enable');
      await page.send('Fetch.enable', {
        patterns: [{ urlPattern: 'https://i0.hdslb.com/*' }]
      });
      page.on('Fetch.requestPaused', (params) => {
        fulfill(page, params.requestId, MOCK_COVER_PNG, 'image/png').catch((error) => {
          console.error('封面 mock 失败：' + error.message);
        });
      });
      // 拦截生成的 Blob 与下载文件名，用于验证第 2/3 次导出
      await page.evaluate(`(() => {
        window.__captured = [];
        window.__lastDownload = null;
        const originalCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = function (blob) {
          const url = originalCreate(blob);
          window.__captured.push({ url: url, blob: blob });
          return url;
        };
        const originalClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download) {
            window.__lastDownload = { name: this.download, href: this.href };
          }
          return originalClick.apply(this, arguments);
        };
      })()`);
      await waitFor(
        async () => (await page.evaluate('document.readyState')) === 'complete',
        15000,
        100,
        '导出面板加载超时'
      );
      await waitFor(
        async () =>
          (await page.evaluate('document.querySelectorAll("#folderList .folder-row").length')) === 1,
        15000,
        150,
        '收藏夹列表未加载'
      );
      return page;
    };

    const closePage = async (page) => {
      await page.send('Page.close').catch(() => {});
      pageErrors.push.apply(pageErrors, page.errors);
      page.close();
    };

    const waitForCapture = async (page) => {
      const meta = await waitFor(
        async () =>
          page.evaluate(`(() => {
            if (!window.__lastDownload) return null;
            const item = window.__captured.find((entry) => entry.url === window.__lastDownload.href);
            return item ? { name: window.__lastDownload.name } : null;
          })()`),
        90000,
        200,
        '等待导出生成 HTML'
      );
      const text = await page.evaluate(
        `window.__captured.find((entry) => entry.url === window.__lastDownload.href).blob.text()`
      );
      return { name: meta.name, text: text };
    };

    const selectAllAndStart = async (page) => {
      await page.evaluate('document.getElementById("selectAllBtn").click()');
      await waitFor(
        async () => !(await page.evaluate('document.getElementById("startBtn").disabled')),
        5000,
        100,
        '导出按钮未启用'
      );
      await page.evaluateWithGesture('document.getElementById("startBtn").click()');
    };

    // ---------------- 第一次导出 ----------------
    let page = await openExporter();
    closers.push(() => page.close());

    const folderTitle = await page.evaluate(
      'document.querySelector("#folderList .folder-title").textContent'
    );
    check('收藏夹已加载', folderTitle === '测试收藏夹', folderTitle);

    await selectAllAndStart(page);
    const firstFile = await waitForNewDownload(0);
    await waitFor(
      async () => !(await page.evaluate('document.getElementById("startBtn").disabled')),
      30000,
      150,
      '首次导出未结束'
    );

    const firstLog = await page.evaluate('document.getElementById("log").textContent');
    const firstHtml = fs.readFileSync(firstFile, 'utf8');
    const fileName = path.basename(firstFile);

    check('结果面板显示', (await page.evaluate('!document.getElementById("resultPanel").hidden')) === true);
    check(
      '文件名包含 UID 与时间戳',
      /^bilibili-.*-12345678-\d{8}_\d{4}\.html$/.test(fileName),
      fileName
    );
    check('包含 3 张卡片', (firstHtml.match(/class="card[ "]/g) || []).length === 3);
    check('保留 BV 号', firstHtml.indexOf('BV1xx411c7mD') >= 0);
    check('正常视频 UP 与 UID', firstHtml.indexOf('UID 1') >= 0 && firstHtml.indexOf('UID 2') >= 0);
    check('失效视频已还原标题', firstHtml.indexOf('【归档】被删除的测试视频') >= 0);
    check('失效视频已还原 UP 与 UID', firstHtml.indexOf('归档UP') >= 0 && firstHtml.indexOf('UID 999') >= 0);
    check('失效 / 已还原标记', firstHtml.indexOf('badge--invalid') >= 0 && firstHtml.indexOf('badge--ok') >= 0);
    check('3 张封面已内嵌', (firstHtml.match(/data:image\/png;base64,/g) || []).length === 3);
    check('导出文档不含脚本', /<script\b/i.test(firstHtml) === false);
    check('日志包含还原记录', /还原完成/.test(firstLog));
    check('日志包含封面嵌入记录', /封面嵌入完成/.test(firstLog));

    const readHistory = (target) =>
      target.evaluate(
        'new Promise((resolve) => chrome.storage.local.get("favx-history-v1", (data) => resolve(data["favx-history-v1"] || null)))'
      );

    const historyAfterFirst = await readHistory(page);
    check(
      '首次导出写入 3 条抓取记录',
      Boolean(historyAfterFirst) && historyAfterFirst.videos.length === 3,
      historyAfterFirst ? historyAfterFirst.videos.length + ' 条' : '无'
    );
    check(
      '记录只含收藏夹 / BV / 名称',
      historyAfterFirst.videos.every(
        (item) => Object.keys(item).sort().join(',') === 'bvid,folder,title'
      )
    );
    const historyCountText = await page.evaluate(
      'document.getElementById("historyCount").textContent'
    );
    check('抓取记录面板显示 3 个视频', historyCountText === '3 个视频', historyCountText);

    await closePage(page);

    // ---------------- 第二次导出：只导出新增视频 ----------------
    mockState.medias.push(mockState.added);
    page = await openExporter();
    closers.push(() => page.close());
    await waitFor(
      async () => (await page.evaluate('document.getElementById("historyCount").textContent')) === '3 个视频',
      10000,
      150,
      '抓取记录未跨页面保留'
    );
    check(
      '重新打开面板后记录仍为 3 条',
      (await page.evaluate('document.getElementById("historyCount").textContent')) === '3 个视频'
    );

    await selectAllAndStart(page);
    const second = await waitForCapture(page);
    await waitFor(
      async () => /抓取记录已更新/.test(await page.evaluate('document.getElementById("log").textContent')),
      30000,
      150,
      '第二次导出未写入记录'
    );

    const secondLog = await page.evaluate('document.getElementById("log").textContent');
    const secondHtml = second.text;
    const secondCards = (secondHtml.match(/class="card[ "]/g) || []).length;

    check('第二次只导出 1 个新视频', secondCards === 1, secondCards + ' 张卡片');
    check('第二次导出文件名正常', /^bilibili-.*-12345678-\d{8}_\d{4}\.html$/.test(second.name), second.name);
    check('第二次跳过 3 个已抓取视频', /跳过 3 个已抓取/.test(secondLog));
    check('增量导出文档标注已跳过', secondHtml.indexOf('已跳过') >= 0);
    check('新视频出现在增量导出中', secondHtml.indexOf('第二次导出时新增的视频') >= 0);

    const historyAfterSecond = await readHistory(page);
    check('抓取记录增加到 4 条', historyAfterSecond.videos.length === 4);

    await closePage(page);

    // ---------------- 第三次导出：关闭开关，导出全部 ----------------
    page = await openExporter();
    closers.push(() => page.close());
    await page.evaluate('document.getElementById("optSkip").click()');
    const skipChecked = await page.evaluate('document.getElementById("optSkip").checked');
    check('跳过开关可关闭', skipChecked === false);

    await selectAllAndStart(page);
    const third = await waitForCapture(page);
    await waitFor(
      async () => !(await page.evaluate('document.getElementById("startBtn").disabled')),
      30000,
      150,
      '第三次导出未结束'
    );

    const thirdHtml = third.text;
    const thirdCards = (thirdHtml.match(/class="card[ "]/g) || []).length;
    check('关闭跳过后导出全部 4 个视频', thirdCards === 4, thirdCards + ' 张卡片');
    check('关闭跳过后文档不再标注跳过', thirdHtml.indexOf('已跳过') < 0);

    const historyAfterThird = await readHistory(page);
    check('关闭跳过后记录仍为 4 条', historyAfterThird.videos.length === 4);

    await closePage(page);

    // ---------------- 第四次导出：全部已抓取，不生成空文件 ----------------
    const downloadsBeforeNoNew = htmlDownloads().length;
    page = await openExporter();
    closers.push(() => page.close());
    await page.evaluate('document.getElementById("optSkip").click()');
    check(
      '跳过开关可重新开启',
      (await page.evaluate('document.getElementById("optSkip").checked')) === true
    );

    await selectAllAndStart(page);
    await waitFor(
      async () => /没有新的视频/.test(await page.evaluate('document.getElementById("log").textContent')),
      30000,
      150,
      '未提示「没有新的视频」'
    );
    const noNewLog = await page.evaluate('document.getElementById("log").textContent');
    check('全部已抓取时提示没有新视频', /没有新的视频/.test(noNewLog));
    check(
      '全部已抓取时不生成新文件',
      htmlDownloads().length === downloadsBeforeNoNew,
      htmlDownloads().length + ' 个文件'
    );
    check(
      '全部已抓取时结果面板不显示',
      (await page.evaluate('document.getElementById("resultPanel").hidden')) === true
    );

    await closePage(page);

    const jsErrors = pageErrors.concat(sw.errors);
    check('无脚本异常', jsErrors.length === 0, jsErrors.join(' | '));

    console.log('\n通过 ' + passed + ' 项检查，失败 ' + failures.length + ' 项。');
    if (failures.length) {
      console.log('失败项：\n - ' + failures.join('\n - '));
      process.exitCode = 1;
    }
  } finally {
    closers.forEach((close) => {
      try {
        close();
      } catch (error) {
        // 忽略
      }
    });
    chrome.kill();
    await sleep(700);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      // 忽略
    }
    try {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    } catch (error) {
      // 忽略
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
