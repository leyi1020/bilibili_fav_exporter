/**
 * 用本机 Chrome 无头模式检查：
 *   1. 示例导出 HTML（静态文档）：结构、必备字段、图片、响应式；
 *   2. 演示导出面板（chrome 桩）：收藏夹渲染与交互；
 *   3. 真实扩展页面：Chrome 加载扩展后检查 exporter.html，并验证后台消息链路。
 *
 *   node tests/inspect-pages.cjs
 *
 * 可用环境变量 CHROME_PATH 指定 Chrome，CDP_PORT 指定调试端口。
 */
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE_TIMEOUT = 15000;

const results = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, intervalMs) {
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
    await sleep(intervalMs || 150);
  }
  throw new Error('等待超时' + (lastError ? '：' + lastError.message : ''));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function fileUrl(filePath) {
  return 'file:///' + filePath.replace(/\\/g, '/');
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Map();
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
      if (message.method) {
        this.events.push(message);
        const listeners = this.listeners.get(message.method) || [];
        listeners.forEach((listener) => listener(message.params));
      }
    });
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
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
      const text =
        (details.exception && (details.exception.description || details.exception.value)) ||
        details.text ||
        '页面脚本异常';
      throw new Error(text);
    }
    return result.result.value;
  }

  jsErrors() {
    const errors = [];
    this.events.forEach((event) => {
      if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params.exceptionDetails || {};
        const description =
          (details.exception && (details.exception.description || details.exception.value)) ||
          details.text ||
          '未知异常';
        errors.push('未捕获异常：' + String(description).split('\n')[0]);
      }
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        const text = (event.params.args || [])
          .map((arg) => arg.value || arg.description || '')
          .join(' ');
        if (text) {
          errors.push('console.error：' + text.split('\n')[0]);
        }
      }
    });
    return errors;
  }

  close() {
    try {
      this.ws.close();
    } catch (error) {
      // 忽略
    }
  }
}

async function openPage(base, url) {
  const response = await fetch(base + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  if (!response.ok) {
    throw new Error('新建标签页失败：HTTP ' + response.status);
  }
  const target = await response.json();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await waitFor(
    async () => (await cdp.evaluate('document.readyState')) === 'complete',
    PAGE_TIMEOUT
  );
  return { cdp, targetId: target.id };
}

async function closePage(base, targetId, cdp) {
  cdp.close();
  try {
    await fetch(base + '/json/close/' + targetId);
  } catch (error) {
    // 忽略
  }
}

function record(section, checks, errors) {
  const failed = checks.filter((check) => !check.ok);
  results.push({ section, checks, errors, failed: failed.length });
  console.log('\n== ' + section + ' ==');
  checks.forEach((check) => {
    console.log((check.ok ? '  ✓ ' : '  ✗ ') + check.name + (check.detail ? '（' + check.detail + '）' : ''));
  });
  if (errors.length) {
    console.log('  脚本错误：');
    errors.forEach((error) => console.log('    - ' + error));
  }
}

async function setViewport(cdp, width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: Boolean(mobile)
  });
  await sleep(250);
}

async function clearViewport(cdp) {
  await cdp.send('Emulation.clearDeviceMetricsOverride');
}

async function checkSample(base) {
  const url = fileUrl(path.join(root, 'samples', 'sample-export.html')) + '?v=' + Date.now();
  const { cdp, targetId } = await openPage(base, url);
  await sleep(600);

  const desktop = await cdp.evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const imgs = Array.from(document.images);
    const grid = document.querySelector('.grid');
    const widths = cards.map(c => Math.round(c.getBoundingClientRect().width));
    const text = (node) => (node && node.textContent ? node.textContent.trim() : '');
    return {
      title: document.title,
      folders: document.querySelectorAll('section.folder').length,
      cards: cards.length,
      withCover: cards.filter(c => c.querySelector('.thumb img')).length,
      withEmptyCover: cards.filter(c => c.querySelector('.thumb-empty-text')).length,
      withTitle: cards.filter(c => text(c.querySelector('.card-title'))).length,
      withBv: cards.filter(c => /^BV1[0-9A-Za-z]{9}$/.test(text(c.querySelector('.bv')))).length,
      withUid: cards.filter(c => /UID\\s*(\\d+|未知)/.test(c.textContent)).length,
      withUp: cards.filter(c => c.querySelector('.up-name')).length,
      invalidBadges: document.querySelectorAll('.badge--invalid').length,
      okBadges: document.querySelectorAll('.badge--ok').length,
      scripts: document.querySelectorAll('script').length,
      images: imgs.length,
      imagesLoaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      minCardWidth: widths.length ? Math.min.apply(null, widths) : 0,
      hasEscapedText: document.body.textContent.indexOf('<script>alert(1)</script>') >= 0
    };
  })()`);

  const checks = [
    { name: '页面标题', ok: /收藏夹导出/.test(desktop.title), detail: desktop.title },
    { name: '3 个收藏夹分区', ok: desktop.folders === 3, detail: String(desktop.folders) },
    { name: '11 张视频卡片', ok: desktop.cards === 11, detail: String(desktop.cards) },
    { name: '每张卡片有标题', ok: desktop.withTitle === 11, detail: String(desktop.withTitle) },
    { name: '每张卡片有 BV 号', ok: desktop.withBv === 11, detail: String(desktop.withBv) },
    { name: '每张卡片有 UID', ok: desktop.withUid === 11, detail: String(desktop.withUid) },
    { name: '每张卡片有 UP 主', ok: desktop.withUp === 11, detail: String(desktop.withUp) },
    { name: '封面图 + 占位图数量', ok: desktop.withCover === 9 && desktop.withEmptyCover === 2, detail: desktop.withCover + ' + ' + desktop.withEmptyCover },
    { name: '内嵌封面全部加载成功', ok: desktop.images === 9 && desktop.imagesLoaded === 9, detail: desktop.imagesLoaded + '/' + desktop.images },
    { name: '失效标记 3 个', ok: desktop.invalidBadges === 3, detail: String(desktop.invalidBadges) },
    { name: '已还原标记 2 个', ok: desktop.okBadges === 2, detail: String(desktop.okBadges) },
    { name: '不含脚本', ok: desktop.scripts === 0, detail: String(desktop.scripts) },
    { name: '特殊字符按文本显示', ok: desktop.hasEscapedText === true, detail: String(desktop.hasEscapedText) },
    { name: '桌面端无横向溢出', ok: desktop.overflowX <= 1, detail: String(desktop.overflowX) + 'px' },
    { name: '桌面端多列网格', ok: desktop.gridColumns >= 3, detail: String(desktop.gridColumns) + ' 列' }
  ];

  await setViewport(cdp, 390, 844, true);
  const mobile = await cdp.evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const widths = cards.map(c => Math.round(c.getBoundingClientRect().width));
    const grid = document.querySelector('.grid');
    return {
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      minCardWidth: widths.length ? Math.min.apply(null, widths) : 0
    };
  })()`);
  checks.push({
    name: '手机端无横向溢出',
    ok: mobile.overflowX <= 1,
    detail: String(mobile.overflowX) + 'px'
  });
  checks.push({
    name: '手机端单列布局',
    ok: mobile.gridColumns === 1 && mobile.minCardWidth > 300,
    detail: mobile.gridColumns + ' 列 / ' + mobile.minCardWidth + 'px'
  });

  const errors = cdp.jsErrors();
  record('导出 HTML 文档', checks, errors);
  await clearViewport(cdp);
  await closePage(base, targetId, cdp);
  return errors;
}

async function checkDemo(base) {
  const url = fileUrl(path.join(root, 'samples', 'demo-exporter.html')) + '?v=' + Date.now();
  const { cdp, targetId } = await openPage(base, url);
  await sleep(900);

  const initial = await cdp.evaluate(`(() => ({
    rows: document.querySelectorAll('#folderList .folder-row').length,
    favCount: document.getElementById('favCount').textContent,
    colCount: document.getElementById('colCount').textContent,
    accountName: document.getElementById('accountName').textContent,
    accountVisible: !document.getElementById('accountChip').hidden,
    hint: document.getElementById('accountHint').textContent,
    selection: document.getElementById('selectionInfo').textContent,
    startDisabled: document.getElementById('startBtn').disabled,
    historyCount: document.getElementById('historyCount').textContent,
    historyExportDisabled: document.getElementById('exportHistoryBtn').disabled,
    skipChecked: document.getElementById('optSkip').checked,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    theme: document.documentElement.getAttribute('data-theme')
  }))()`);

  await cdp.evaluate(`document.getElementById('selectAllBtn').click()`);
  await sleep(120);
  const afterSelect = await cdp.evaluate(`(() => ({
    selection: document.getElementById('selectionInfo').textContent,
    estimate: document.getElementById('estimateInfo').textContent,
    startDisabled: document.getElementById('startBtn').disabled,
    checked: document.querySelectorAll('#folderList input[type="checkbox"]:checked').length
  }))()`);

  await cdp.evaluate(`document.querySelector('[data-tab="col"]').click()`);
  await sleep(120);
  const afterTab = await cdp.evaluate(
    `document.querySelectorAll('#folderList .folder-row').length`
  );

  await cdp.evaluate(`document.getElementById('toggleTheme').click()`);
  await sleep(120);
  const afterTheme = await cdp.evaluate(`document.documentElement.getAttribute('data-theme')`);

  await cdp.evaluate(`document.getElementById('clearAllBtn').click()`);
  await sleep(120);
  const afterClear = await cdp.evaluate(`(() => ({
    selection: document.getElementById('selectionInfo').textContent,
    startDisabled: document.getElementById('startBtn').disabled
  }))()`);

  await setViewport(cdp, 390, 844, true);
  const mobile = await cdp.evaluate(
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`
  );

  const checks = [
    { name: '自动加载 4 个自建收藏夹', ok: initial.rows === 4, detail: initial.rows + ' 行' },
    { name: '收藏夹计数正确', ok: initial.favCount === '4' && initial.colCount === '2', detail: initial.favCount + ' / ' + initial.colCount },
    { name: '登录账号已显示', ok: initial.accountVisible === true && /示例用户/.test(initial.accountName), detail: initial.accountName },
    { name: '初始未选择', ok: initial.startDisabled === true && /未选择/.test(initial.selection) },
    { name: '跳过已抓取默认开启', ok: initial.skipChecked === true },
    { name: '抓取记录初始为空', ok: initial.historyCount === '0 个视频' && initial.historyExportDisabled === true, detail: initial.historyCount },
    { name: '全选后启用导出', ok: afterSelect.checked === 4 && afterSelect.startDisabled === false, detail: afterSelect.selection },
    { name: '显示体积预估', ok: /MB/.test(afterSelect.estimate), detail: afterSelect.estimate },
    { name: '切换到订阅合集', ok: afterTab === 2, detail: afterTab + ' 行' },
    { name: '主题切换生效', ok: afterTheme === 'dark' || afterTheme === 'light', detail: String(afterTheme) },
    { name: '清空选择后禁用导出', ok: afterClear.startDisabled === true && /未选择/.test(afterClear.selection) },
    { name: '桌面端无横向溢出', ok: initial.overflowX <= 1, detail: initial.overflowX + 'px' },
    { name: '手机端无横向溢出', ok: mobile <= 1, detail: mobile + 'px' }
  ];

  const errors = cdp.jsErrors();
  record('导出面板（模拟后台）', checks, errors);
  await clearViewport(cdp);
  await closePage(base, targetId, cdp);
  return errors;
}

async function getExtensionId(browserCdp) {
  const found = await browserCdp.send('Target.getTargets');
  const workers = (found.targetInfos || []).filter(
    (info) => info.type === 'service_worker' && /^chrome-extension:\/\//.test(info.url)
  );
  const ours = workers.find((info) => /\/js\/background\.js$/.test(info.url)) || workers[0];
  return ours ? new URL(ours.url).host : '';
}

async function loadExtension(browserCdp) {
  try {
    const result = await browserCdp.send('Extensions.loadUnpacked', { path: root });
    return (result && result.id) || '';
  } catch (error) {
    return '';
  }
}

async function checkExtension(base, browserCdp) {
  const loadedId = await loadExtension(browserCdp);
  const extensionId =
    loadedId || (await waitFor(() => getExtensionId(browserCdp), 8000, 250).catch(() => ''));
  if (!extensionId) {
    record(
      '扩展页面',
      [{ name: '扩展成功加载', ok: false, detail: '无法通过 CDP 加载扩展' }],
      []
    );
    return [];
  }

  const url = 'chrome-extension://' + extensionId + '/exporter.html';
  const { cdp, targetId } = await openPage(base, url);
  await sleep(700);

  const shell = await cdp.evaluate(`(() => ({
    title: document.title,
    hasStart: !!document.getElementById('startBtn'),
    uidValue: document.getElementById('uidInput') ? document.getElementById('uidInput').value : null,
    hint: document.getElementById('accountHint').textContent,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cssLoaded: getComputedStyle(document.querySelector('.panel')).borderRadius !== '0px',
    workers: true
  }))()`);

  const nav = await cdp
    .evaluate(`new Promise((resolve) => chrome.runtime.sendMessage(
      { type: 'fav-api-request', path: '/x/web-interface/nav', params: {} },
      (response) => resolve(response ? {
        ok: !!response.ok,
        code: response.code,
        message: response.message || '',
        isLogin: !!(response.data && response.data.isLogin)
      } : null)
    ))`)
    .catch((error) => ({ error: error.message }));

  const archive = await cdp
    .evaluate(`new Promise((resolve) => chrome.runtime.sendMessage(
      { type: 'fav-archive-fetch', provider: 'biliplus-aidinfo', aids: ['3'] },
      (response) => resolve(response ? {
        ok: !!response.ok,
        error: response.error || '',
        title: response.json && response.json.data && response.json.data['3'] ? response.json.data['3'].title : ''
      } : null)
    ))`)
    .catch((error) => ({ error: error.message }));

  const checks = [
    { name: '扩展页面标题', ok: /导出/.test(shell.title), detail: shell.title },
    { name: '样式已加载', ok: shell.cssLoaded === true },
    { name: '导出面板已渲染', ok: shell.hasStart === true },
    { name: '无横向溢出', ok: shell.overflowX <= 1, detail: shell.overflowX + 'px' },
    { name: '账号接口可调用', ok: Boolean(nav && (nav.ok || nav.code === -101)), detail: nav ? (nav.ok ? '已登录' : '未登录（code ' + nav.code + '）') : '无响应' },
    { name: '归档代理可调用', ok: Boolean(archive && (archive.ok || archive.error)), detail: archive ? (archive.ok ? 'aid=3 → ' + archive.title : archive.error) : '无响应' }
  ];

  const errors = cdp.jsErrors();
  await closePage(base, targetId, cdp);

  // 工具栏弹窗也检查一次
  const popupUrl = 'chrome-extension://' + extensionId + '/popup.html';
  const popup = await openPage(base, popupUrl);
  await sleep(600);
  const popupState = await popup.cdp.evaluate(`(() => ({
    status: document.getElementById('statusText').textContent,
    hasOpen: !!document.getElementById('openBtn'),
    openLabel: document.getElementById('openBtn').textContent,
    width: document.body.getBoundingClientRect().width,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    version: document.getElementById('version').textContent
  }))()`);
  checks.push({ name: '弹窗渲染', ok: popupState.hasOpen === true, detail: popupState.openLabel });
  checks.push({ name: '弹窗状态文案', ok: /登录|无法连接/.test(popupState.status), detail: popupState.status });
  checks.push({ name: '弹窗宽度固定', ok: popupState.width > 300 && popupState.width < 400, detail: Math.round(popupState.width) + 'px' });
  checks.push({ name: '弹窗版本号', ok: /^v\d/.test(popupState.version), detail: popupState.version });
  const popupErrors = popup.cdp.jsErrors();
  await closePage(base, popup.targetId, popup.cdp);

  record('扩展页面（真实加载）', checks, errors.concat(popupErrors));
  console.log('  接口探测：nav=' + JSON.stringify(nav) + '，archive=' + JSON.stringify(archive));
  return errors.concat(popupErrors);
}

async function main() {
  if (typeof WebSocket !== 'function') {
    throw new Error('当前 Node 不支持 WebSocket，请使用 Node 22+');
  }
  if (!fs.existsSync(CHROME)) {
    throw new Error('未找到 Chrome：' + CHROME + '（可用 CHROME_PATH 指定）');
  }

  // 确保示例页面是最新的
  execFileSync(process.execPath, [path.join(__dirname, 'build-sample.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'build-demo.cjs')], { stdio: 'inherit' });

  const port = Number(process.env.CDP_PORT) || (await freePort());
  const base = 'http://127.0.0.1:' + port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'favx-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + port,
    '--remote-allow-origins=*',
    '--user-data-dir=' + profile,
    '--window-size=1400,1000',
    '--allow-file-access-from-files',
    '--enable-unsafe-extension-debugging',
    'about:blank'
  ];

  console.log('启动 Chrome：' + CHROME);
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  let browserCdp = null;

  try {
    const version = await waitFor(
      async () => {
        const response = await fetch(base + '/json/version');
        return response.ok ? response.json() : null;
      },
      20000,
      200
    );

    browserCdp = new CDP(version.webSocketDebuggerUrl);
    await browserCdp.connect();
    await browserCdp.send('Runtime.enable').catch(() => {});

    const sampleErrors = await checkSample(base);
    const demoErrors = await checkDemo(base);
    const extensionErrors = await checkExtension(base, browserCdp);

    const allErrors = sampleErrors.concat(demoErrors, extensionErrors);
    const failed = results.reduce((sum, item) => sum + item.failed, 0);

    console.log('\n检查结果：' + (results.length ? results.length : 0) + ' 组，失败 ' + failed + ' 项，脚本错误 ' + allErrors.length + ' 条。');
    if (failed > 0 || allErrors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (browserCdp) {
      browserCdp.close();
    }
    chrome.kill();
    await sleep(600);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      // 配置目录偶尔会被占用，忽略
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
