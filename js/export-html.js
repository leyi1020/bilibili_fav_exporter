/**
 * 把抓取结果构建成一个纯静态、自包含的 HTML 文档。
 *
 * - 不使用任何 JavaScript，双击即可查看；
 * - 样式与数据全部内联，封面按需转成 data URL 嵌入；
 * - 每个视频都包含封面、标题、BV 号、UP 主名称与 UID。
 */
(function (global) {
  'use strict';

  var U = global.FavUtils;
  var assetCache = null;

  async function fetchText(path) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
      throw new Error('当前环境无法读取扩展资源：' + path);
    }
    var response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) {
      throw new Error('读取扩展资源失败：' + path);
    }
    return response.text();
  }

  /** 只允许 http(s) 链接；封面额外允许 data:image */
  function safeHref(value, allowDataImage) {
    var text = String(value || '').trim();
    if (!text) {
      return '';
    }
    if (allowDataImage && /^data:image\//i.test(text)) {
      return text;
    }
    if (text.indexOf('//') === 0) {
      text = 'https:' + text;
    }
    return /^https?:\/\//i.test(text) ? text : '';
  }

  async function loadAssets() {
    if (assetCache) {
      return assetCache;
    }
    assetCache = { css: await fetchText('css/export-document.css') };
    return assetCache;
  }

  function favicon() {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="16" fill="#fb7299"/>' +
      '<text x="32" y="44" font-family="Arial,sans-serif" font-size="38" font-weight="bold" fill="#fff" text-anchor="middle">B</text>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function buildTitle(data) {
    var folders = (data && data.folders) || [];
    if (folders.length === 1) {
      return folders[0].title + ' - 收藏夹导出';
    }
    if (folders.length > 1) {
      return '收藏夹导出（' + folders.length + ' 个）';
    }
    return '收藏夹导出';
  }

  function videoUrl(video) {
    if (video.bvid) {
      return 'https://www.bilibili.com/video/' + video.bvid;
    }
    if (video.aid) {
      return 'https://www.bilibili.com/video/av' + video.aid;
    }
    return '';
  }

  function upUrl(video) {
    var mid = video.upper && Number(video.upper.mid);
    return mid > 0 ? 'https://space.bilibili.com/' + mid : '';
  }

  function folderUrl(folder, uid) {
    if (folder.link) {
      return folder.link;
    }
    if (folder.type === 'fav' && uid) {
      return 'https://space.bilibili.com/' + uid + '/favlist?fid=' + folder.id;
    }
    return '';
  }

  function sourceLabel(video) {
    if (!video.invalid) {
      return '';
    }
    var map = {
      biliplus: 'biliplus 归档',
      jijidown: 'jijidown 归档',
      pagelist: '分 P 标题',
      official: 'B 站接口'
    };
    var providers = String(video.source || '')
      .split(',')
      .map(function (item) {
        return item.trim();
      })
      .filter(Boolean);
    if (providers.length === 0) {
      return video.recovered ? '第三方归档' : '';
    }
    return providers
      .map(function (item) {
        return map[item] || item;
      })
      .join(' + ');
  }

  function coverMarkup(video, url) {
    var src = safeHref(video.coverData, true) || safeHref(video.cover, false);
    var safeUrl = safeHref(url, false);
    var duration = Number(video.duration) > 0 ? U.formatDuration(video.duration) : '';
    var badges = [];
    if (video.invalid) {
      badges.push('<span class="badge badge--invalid">已失效</span>');
      if (video.recovered) {
        badges.push('<span class="badge badge--ok">信息已还原</span>');
      }
    }
    var open = safeUrl
      ? '<a class="thumb" href="' + U.escapeHtml(safeUrl) + '" target="_blank" rel="noopener noreferrer">'
      : '<span class="thumb">';
    var close = safeUrl ? '</a>' : '</span>';
    var inner;
    if (src) {
      inner =
        '<img src="' + U.escapeHtml(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' +
        (duration ? '<span class="duration">' + duration + '</span>' : '') +
        (badges.length ? '<span class="badges">' + badges.join('') + '</span>' : '');
    } else {
      inner =
        '<span class="thumb--empty">' +
        '<span class="thumb-empty-text">' + (video.invalid ? '封面已失效' : '暂无封面') + '</span>' +
        '</span>' +
        (duration ? '<span class="duration">' + duration + '</span>' : '') +
        (badges.length ? '<span class="badges">' + badges.join('') + '</span>' : '');
    }
    return open + inner + close;
  }

  function cardMarkup(video) {
    var url = safeHref(videoUrl(video), false);
    var spaceUrl = safeHref(upUrl(video), false);
    var title = video.title || '未命名视频';
    var upName = (video.upper && video.upper.name) || '未知 UP 主';
    var upMid = (video.upper && Number(video.upper.mid)) || 0;
    var bvid = video.bvid || '';
    var bvText = bvid || (video.aid ? 'av' + video.aid : '无 BV 号');
    var favDate = U.formatDate(video.favtime);
    var source = sourceLabel(video);
    var invalidNote = '';
    if (video.invalid) {
      invalidNote = source
        ? '已失效 · 信息来自 ' + source
        : '已失效 · 未找到归档信息';
    }
    var titleOpen = url
      ? '<a href="' + U.escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" title="' + U.escapeHtml(title) + '">'
      : '<span>';
    var titleClose = url ? '</a>' : '</span>';

    return (
      '<article class="card' + (video.invalid ? ' card--invalid' : '') + '">' +
      coverMarkup(video, url) +
      '<div class="card-body">' +
      '<h3 class="card-title">' + titleOpen + U.escapeHtml(title) + titleClose + '</h3>' +
      '<p class="card-up">' +
      '<span class="up-label">UP</span>' +
      (spaceUrl
        ? '<a class="up-name" href="' + spaceUrl + '" target="_blank" rel="noopener noreferrer" title="' + U.escapeHtml(upName) + '">' + U.escapeHtml(upName) + '</a>'
        : '<span class="up-name">' + U.escapeHtml(upName) + '</span>') +
      '<span class="up-uid">' + (upMid > 0 ? 'UID ' + upMid : 'UID 未知') + '</span>' +
      '</p>' +
      '<p class="card-foot">' +
      (url
        ? '<a class="bv" href="' + U.escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" title="' + U.escapeHtml(bvText) + '">' + U.escapeHtml(bvText) + '</a>'
        : '<span class="bv">' + U.escapeHtml(bvText) + '</span>') +
      (favDate ? '<span class="fav-date">收藏于 ' + favDate + '</span>' : '') +
      '</p>' +
      (invalidNote ? '<p class="invalid-note">' + U.escapeHtml(invalidNote) + '</p>' : '') +
      '</div>' +
      '</article>'
    );
  }

  function folderMarkup(folder, index, uid) {
    var videos = Array.isArray(folder.videos) ? folder.videos : [];
    var invalidCount = 0;
    var recoveredCount = 0;
    videos.forEach(function (video) {
      if (video.invalid) {
        invalidCount += 1;
        if (video.recovered) {
          recoveredCount += 1;
        }
      }
    });
    var anchor = 'folder-' + (index + 1);
    var link = safeHref(folderUrl(folder, uid), false);
    var subParts = [videos.length + ' 个视频'];
    if (invalidCount > 0) {
      subParts.push('失效 ' + invalidCount + ' 个' + (recoveredCount ? '（已还原 ' + recoveredCount + ' 个）' : ''));
    }
    var cards = videos.length
      ? videos.map(cardMarkup).join('')
      : '<p class="folder-empty">这个收藏夹没有视频。</p>';
    return (
      '<section class="folder" id="' + anchor + '">' +
      '<div class="folder-head">' +
      '<div>' +
      '<h2 class="folder-title"><span class="folder-index">' + (index + 1) + '.</span>' + U.escapeHtml(folder.title || '未命名收藏夹') + '</h2>' +
      '<p class="folder-sub">' + U.escapeHtml(subParts.join(' · ')) + '</p>' +
      '</div>' +
      (link
        ? '<a class="folder-link" href="' + U.escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">在 B 站打开 →</a>'
        : '') +
      '</div>' +
      (videos.length ? '<div class="grid">' + cards + '</div>' : cards) +
      '</section>'
    );
  }

  async function build(data, options) {
    options = options || {};
    var assets = options.assets || (await loadAssets());
    var meta = data.meta || {};
    var folders = Array.isArray(data.folders) ? data.folders : [];
    var uid = meta.uid || 0;
    var totalVideos = 0;
    var totalInvalid = 0;
    var totalRecovered = 0;
    folders.forEach(function (folder) {
      var videos = Array.isArray(folder.videos) ? folder.videos : [];
      totalVideos += videos.length;
      videos.forEach(function (video) {
        if (video.invalid) {
          totalInvalid += 1;
          if (video.recovered) {
            totalRecovered += 1;
          }
        }
      });
    });

    var heading = folders.length === 1 ? folders[0].title : folders.length > 1 ? '共 ' + folders.length + ' 个收藏夹' : '收藏夹导出';
    var metaParts = [
      meta.userName
        ? '<strong>' + U.escapeHtml(meta.userName) + '</strong>（UID ' + U.escapeHtml(uid) + '）'
        : uid
          ? 'UID <strong>' + U.escapeHtml(uid) + '</strong>'
          : '',
      '导出于 <strong>' + U.escapeHtml(U.formatDateTime(meta.exportedAt)) + '</strong>',
      '共 <strong>' + totalVideos + '</strong> 个视频',
      Number(meta.skippedCount) > 0
        ? '已跳过 <strong>' + Number(meta.skippedCount) + '</strong> 个已抓取视频'
        : '',
      totalInvalid > 0
        ? '失效 <strong>' + totalInvalid + '</strong> 个' + (totalRecovered ? '（已还原 ' + totalRecovered + ' 个）' : '')
        : ''
    ].filter(Boolean);

    var toc =
      folders.length > 1
        ? '<nav class="toc" aria-label="收藏夹目录">' +
          folders
            .map(function (folder, index) {
              var count = (folder.videos || []).length;
              return (
                '<a class="toc-link" href="#folder-' + (index + 1) + '">' +
                U.escapeHtml(folder.title || '未命名收藏夹') +
                '<span class="toc-count">' + count + '</span>' +
                '</a>'
              );
            })
            .join('') +
          '</nav>'
        : '';

    var body = folders
      .map(function (folder, index) {
        return folderMarkup(folder, index, uid);
      })
      .join('\n');

    return (
      '<!DOCTYPE html>\n' +
      '<html lang="zh-CN">\n' +
      '<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<meta name="referrer" content="no-referrer">\n' +
      '<meta name="generator" content="' + U.escapeHtml(meta.generator || 'Bilibili Favorites HTML Exporter') + '">\n' +
      '<title>' + U.escapeHtml(buildTitle(data)) + '</title>\n' +
      '<link rel="icon" href="' + favicon() + '">\n' +
      '<style>\n' + assets.css + '\n</style>\n' +
      '</head>\n' +
      '<body>\n' +
      '<header class="doc-header">\n' +
      '  <div class="wrap">\n' +
      '    <p class="eyebrow">Bilibili Favorites</p>\n' +
      '    <h1>' + U.escapeHtml(heading) + '</h1>\n' +
      '    <p class="doc-meta">' + metaParts.join('<span class="dot">·</span>') + '</p>\n' +
      '    ' + toc + '\n' +
      '  </div>\n' +
      '</header>\n' +
      '<main class="wrap">\n' +
      body + '\n' +
      '</main>\n' +
      '<footer class="doc-footer">\n' +
      '  <div class="wrap">\n' +
      '    <p>由「' + U.escapeHtml(meta.generator || 'B 站收藏夹导出') + '」生成 · ' + U.escapeHtml(U.formatDateTime(meta.exportedAt)) + '</p>\n' +
      '    <p>已失效视频的封面与信息来自 biliplus / jijidown 公开归档；未收录的视频显示为占位封面。</p>\n' +
      '  </div>\n' +
      '</footer>\n' +
      '</body>\n' +
      '</html>\n'
    );
  }

  function buildFileName(data) {
    var folders = (data && data.folders) || [];
    var name = folders.length === 1 ? folders[0].title : '收藏夹';
    return (
      'bilibili-' +
      U.safeFileName(name, 'favorites') +
      '-' +
      ((data.meta && data.meta.uid) || 'unknown') +
      '-' +
      U.timestampTag(new Date()) +
      '.html'
    );
  }

  global.FavHtmlExporter = {
    build: build,
    buildTitle: buildTitle,
    buildFileName: buildFileName,
    loadAssets: loadAssets
  };
})(window);
