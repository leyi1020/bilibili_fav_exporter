# 哔哩哔哩收藏夹导出（HTML）

一个 Chrome / Edge 浏览器扩展：抓取 B 站（bilibili.com）的**收藏夹**与**订阅合集**，导出成**单个静态 HTML 文件**。每个视频都会带上：

- 视频封面
- 视频标题
- 视频 BV 号
- UP 主名称与 UID

对收藏夹里**已失效**的视频，会自动查询 biliplus、jijidown 的公开归档，尽量补全封面、标题、UP 主与发布时间，并在导出页上标注来源。

支持**抓取记录 / 增量导出**：每次导出成功后按「收藏夹名称 + BV 号」记录视频，下次可以只抓取并导出新增内容，跳过已经导出的视频；记录可导出为 JSON 文件备份、导入或清空，跳过功能随时可以关闭。

> 导出的 HTML 不含任何 JavaScript，样式与数据全部内联，双击即可离线查看，也可以直接发给别人。

---

## 安装

1. 下载或克隆本目录，得到 `bilibili-fav-html-exporter` 文件夹。
2. 打开 Chrome，地址栏输入 `chrome://extensions/`。
3. 打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择 `bilibili-fav-html-exporter` 文件夹。
5. 建议先把扩展固定到工具栏，方便打开导出面板。

Edge 同理：`edge://extensions/` → 开发者模式 → 加载解压缩的扩展。

---

## 使用

### 方式一：从收藏夹页面开始

1. 登录 bilibili.com，打开任意收藏夹页面，例如  
   `https://space.bilibili.com/<UID>/favlist?fid=<收藏夹ID>`
2. 点击工具栏里的扩展图标 → 「导出当前收藏夹」。
3. 导出面板会自动填好 UID、加载收藏夹并勾选当前收藏夹。

### 方式二：手动选择

1. 点击扩展图标 → 「打开导出面板」。
2. 面板会自动识别当前登录账号；也可以手动填写任意用户的 UID 导出其**公开**收藏夹。
3. 点击「加载收藏夹」，在「自建收藏夹 / 订阅合集」里勾选要导出的收藏夹（可多选）。
4. 按需调整导出选项：
   - **跳过已抓取的视频**：默认开启，按「收藏夹名称 + BV 号」匹配抓取记录，命中的视频不再重复导出；关闭后导出全部视频。
   - **把封面嵌入 HTML**：默认开启，离线也能看到封面，文件会变大（每张约 15–40 KB）。
   - **还原失效视频信息**：默认开启，查询 biliplus / jijidown 归档。
   - **同时保存 JSON 备份**：额外下载一份原始数据，便于以后重新生成。
   - **封面尺寸 / 请求速度**：收藏夹很大或经常被风控时，把速度调慢。
5. 点击「开始导出 HTML」，等待进度完成，浏览器会自动下载 HTML 文件。
6. 面板下方的「抓取记录」可以查看记录数量、导出记录 JSON、导入记录或清空记录。

### 导出结果

- 文件名形如 `bilibili-收藏夹名-12345678-20250101_1200.html`。
- 顶部汇总：账号、导出时间、收藏夹数、视频数、失效数、已还原数；使用增量导出时还会标注跳过的数量。
- 多收藏夹时顶部有目录，按收藏夹分区展示。
- 每张卡片：封面（含时长与失效标记）、标题、UP 主名称、`UID`、BV 号、收藏时间。
- 已失效视频会显示「已失效」标记；还原成功时额外显示「信息已还原」与来源（biliplus / jijidown / 分 P 标题）。

---

## 抓取记录与增量导出

每次 HTML 导出成功后，扩展会把本次导出的视频写入**抓取记录**。每条视频记录只保存三个字段：

```json
{
  "version": 1,
  "updatedAt": 1730000000,
  "count": 2,
  "videos": [
    { "folder": "默认收藏夹", "bvid": "BV17x411w7KC", "title": "视频标题" },
    { "folder": "稍后再看", "bvid": "BV1xx411c7mD", "title": "另一个视频" }
  ]
}
```

匹配规则：

- 只有**收藏夹名称与 BV 号完全相同**才算已抓取；同一个视频收藏在不同收藏夹里不会互相影响。
- 收藏夹改名后会被视为新的收藏夹，原记录不再匹配；需要完整导出时关闭开关即可。
- 开启「跳过已抓取的视频」后，命中的视频不会进入新的 HTML，也不会重复下载封面、查询失效归档，所以第二次导出通常只需处理新增视频。
- 收藏夹列表分页仍会读取（否则无法知道 BV 号），但被跳过的视频不再产生封面与归档请求。
- 关闭开关后重新导出，会导出所选收藏夹的全部视频；记录本身不会丢失。
- 如果本次全部视频都已抓取过，面板会提示「没有新的视频」，不会生成空文件。

记录保存在 `chrome.storage.local`（键名 `favx-history-v1`），只存在本机：

- **导出记录 JSON**：下载当前记录，便于备份或换电脑迁移；
- **导入记录**：合并导入，同一「收藏夹 + BV」不会重复，标题以新导入的为准；
- **清空记录**：下次导出会重新抓取全部视频。

单条记录很小，最多保留 20000 条（超过后丢弃最早的记录）。

---

## 失效视频是怎么还原的

参考了 [biliplus](https://github.com/laplaceliu/biliplus) 的「失效视频信息」实现，按以下顺序回退，全部通过只带 av 号的公开接口查询：

1. **本地缓存**（`chrome.storage.local`）  
   有完整信息直接复用；部分信息 30 分钟后重试；空结果 12 小时内不重试；最长保留 30 天，最多 300 条。
2. **分 P 标题**（B 站 `x/player/pagelist`）  
   单 P 稿件偶尔还能拿到分 P 标题，作为弱标题使用。
3. **biliplus 批量归档**（`https://www.biliplus.com/api/aidinfo?aid=1,2,3`）  
   一次最多 20 个 aid，返回标题、封面、UP 主名称与 UID。
4. **biliplus 单查**（`https://www.biliplus.com/api/view?id=<aid>`）  
   取标题、封面、首帧图、UP 主与发布时间。
5. **jijidown 归档**（`https://www.jijidown.com/api/v1/video/get_info?id=<aid>`）  
   最后兜底，遇到 `loading` 会轮询两次。

封面地址会做规范化：`//` 与 `http://` 补成 `https://`；`img.biliplus.com/bfs/archive/...` 会同时保留原地址，下载失败时回退。  
所有归档请求都由扩展后台统一构造 URL、限速（biliplus 400ms、jijidown 1200ms）、10 秒超时、2MB 体积上限，页面无法指定任意 URL。

如果所有来源都没有收录，该视频会显示「已失效」与占位封面，但 BV 号、av 号仍然保留（由 aid 反推），不会从导出结果里丢失。

---

## 权限与隐私

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存导出选项、抓取记录与失效视频查询缓存 |
| `*://api.bilibili.com/*`、`*://*.bilibili.com/*` | 读取收藏夹、合集与视频信息 |
| `*://*.hdslb.com/*` | 下载封面并转成 data URL 嵌入 HTML |
| `https://www.biliplus.com/*` | 查询失效视频归档 |
| `https://www.jijidown.com/*` | 查询失效视频归档 |

- 不在任何网页注入内容脚本。
- 不上传、不收集任何数据；所有内容只在本机处理。
- 归档查询只发送 av 号，不发送 Cookie、UID 或账号信息。
- 导出的 HTML 完全自包含，不含追踪代码。

---

## 常见问题

**提示「未登录或登录已过期」**  
先在浏览器里登录 bilibili.com 并刷新收藏夹页面，再重新打开导出面板。私密收藏夹必须登录；公开收藏夹可以只填 UID。

**提示「访问权限不足」**  
该收藏夹是私密的，或不属于当前账号。

**加载订阅合集失败**  
订阅合集接口偶尔会触发风控，稍后重试或把请求速度调慢；自建收藏夹不受影响。

**封面没有嵌入 / 显示占位图**  
封面下载失败时会回退到远程地址，离线打开就看不到；可重新导出。极少数归档封面本身已经 404，只能用占位图。

**导出很慢**  
失效视频查询与封面下载都是逐个进行的。选择「保守」速度、减少一次导出的收藏夹数量，或分多次导出。

**HTML 太大**  
关闭「把封面嵌入 HTML」可以显著减小体积；也可以在选项里把封面尺寸调小（320px）。

**想重新生成**  
勾选「同时保存 JSON 备份」，以后可用同一份 JSON 重新生成（数据格式见下）。

**第二次导出为什么只有新视频？**  
「跳过已抓取的视频」默认开启，之前导出过的「收藏夹 + BV」会被跳过。需要完整导出时，关闭该开关再导出即可。

**换电脑后如何保留抓取记录？**  
在旧电脑上点「导出记录 JSON」，在新电脑的导出面板点「导入记录」选择该文件。清空记录后，下次导出会重新抓取全部视频。

**抓取记录会占用很多空间吗？**  
每条记录只有收藏夹名称、BV 号与标题，20000 条约几 MB，保存在浏览器本地，不会上传。

---

## 导出的 HTML 数据

导出结果是一个静态文档，结构大致为：

```html
<header class="doc-header">…账号 / 统计 / 目录…</header>
<main>
  <section class="folder" id="folder-1">
    <div class="folder-head">…收藏夹标题 / 数量 / 跳转…</div>
    <div class="grid">
      <article class="card">
        <a class="thumb"><img src="data:image/webp;base64,…">…</a>
        <div class="card-body">
          <h3 class="card-title"><a href="https://www.bilibili.com/video/BV…">标题</a></h3>
          <p class="card-up">UP 主名 <span>UID 123</span></p>
          <p class="card-foot"><a class="bv">BV…</a><span>收藏于 …</span></p>
        </div>
      </article>
      …
    </div>
  </section>
</main>
```

对应的 JSON 备份结构：

```json
{
  "meta": {
    "generator": "哔哩哔哩收藏夹导出（HTML）",
    "exportedAt": 1730000000,
    "uid": 12345678,
    "userName": "示例用户",
    "folderCount": 1,
    "videoCount": 100,
    "invalidCount": 2,
    "recoveredCount": 1,
    "skippedCount": 0,
    "coverEmbedded": 98
  },
  "folders": [
    {
      "id": 123,
      "type": "fav",
      "title": "默认收藏夹",
      "videos": [
        {
          "aid": 170001,
          "bvid": "BV17x411w7KC",
          "title": "视频标题",
          "cover": "https://i0.hdslb.com/bfs/archive/xxx.jpg",
          "coverData": "data:image/webp;base64,…",
          "duration": 120,
          "pubtime": 1600000000,
          "favtime": 1700000000,
          "upper": { "mid": 1, "name": "UP 主" },
          "stats": { "play": 1000, "danmaku": 10, "collect": 20 },
          "invalid": false,
          "recovered": false,
          "source": ""
        }
      ]
    }
  ]
}
```

---

## 目录结构

```
bilibili-fav-html-exporter/
├─ manifest.json            # MV3 清单
├─ popup.html / js/popup.js # 工具栏弹窗
├─ exporter.html            # 导出面板
├─ css/
│  ├─ exporter.css          # 导出面板样式
│  └─ export-document.css   # 导出 HTML 的样式（构建时内联）
├─ js/
│  ├─ background.js         # Service Worker：消息路由
│  ├─ bili-api.js           # B 站接口客户端 + wbi 签名
│  ├─ archive-proxy.js      # biliplus / jijidown 归档代理（限速、超时）
│  ├─ md5.js                # 自实现 MD5（wbi 用）
│  ├─ utils.js              # BV/av 转换、封面处理、失效判定、格式化
│  ├─ page-api.js           # 页面侧消息封装
│  ├─ invalid-recovery.js   # 失效视频还原管线与缓存
│  ├─ history.js            # 抓取记录（增量导出、JSON 导入导出）
│  ├─ export-html.js        # 静态 HTML 生成器
│  └─ exporter.js           # 导出面板交互
├─ icons/                   # 扩展图标
├─ tools/make_icons.py      # 图标生成脚本
└─ tests/                   # 单元测试与页面检查脚本
```

---

## 开发与测试

```bash
# 单元测试（MD5、BV/av、wbi 签名、封面处理、URL 解析、归档解析）
node tests/unit.cjs

# 后台逻辑测试（模拟 chrome.* 与 fetch：消息路由、白名单、403 补签名、归档代理缓存）
node tests/background.cjs

# 抓取记录测试（合并、去重、导入导出、持久化）
node tests/history.cjs

# 生成示例导出 HTML（不访问网络）
node tests/build-sample.cjs

# 无头 Chrome 检查：静态文档布局、导出面板交互、真实扩展加载
node tests/inspect-pages.cjs

# 端到端导出：拦截网络，跑通首次导出 → 跳过已抓取 → 关闭开关全量导出
node tests/e2e-export.cjs
```

说明：

- `inspect-pages.cjs` 与 `e2e-export.cjs` 使用本机 Chrome 的 CDP 接口，并通过
  `Extensions.loadUnpacked` 加载扩展。Chrome 137 起已移除 `--load-extension` 命令行开关，
  脚本会自动带上 `--enable-unsafe-extension-debugging`，无需手动操作。
- 默认使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`，可用环境变量
  `CHROME_PATH` 指定其他 Chromium 内核浏览器。
- 测试产物写入 `samples/`（示例 HTML、示例 JSON、演示面板），可以留作手工检查。

---

## 说明

- 本项目只读取 B 站公开接口与 biliplus / jijidown 的公开归档，不绕过付费、权限或登录限制。
- 接口可能随 B 站调整而变化；遇到问题时先确认在网页端能正常打开对应收藏夹。
- 请合理控制导出频率，避免给第三方归档站点造成压力。

## License

MIT
