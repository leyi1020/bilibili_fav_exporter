/**
 * 通用工具：BV/av 互转、封面地址处理、失效判定、格式化。
 * 供扩展页面、后台 Service Worker 与导出的 HTML 共用（导出时会内联到 HTML 中）。
 */
(function (global) {
  'use strict';

  var BV_XOR_CODE = 23442827791579n;
  var BV_MASK_CODE = 2251799813685247n;
  var BV_MAX_AID = 1n << 51n;
  var BV_BASE = 58n;
  var BV_ALPHABET = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
  var BV_DIGIT_MAP = [0, 1, 2, 9, 7, 5, 6, 4, 8, 3, 10, 11];

  // B 站各接口对「已失效」的占位标题
  var INVALID_TITLE_SET = new Set([
    '已失效视频',
    '失效视频',
    '视频已失效',
    '（视频已删除）',
    '视频去哪了呢？',
    '该视频或许已经被删除了'
  ]);

  // 收藏夹接口给失效视频使用的灰色占位封面
  var PLACEHOLDER_COVER_TOKEN = 'be27fd62c99036dce67efface486fb0a88ffed06';

  function avToBv(aid) {
    if (aid === null || aid === undefined || aid === '') {
      return '';
    }
    var avid;
    try {
      avid = BigInt(aid);
    } catch (error) {
      return '';
    }
    if (avid < 0n) {
      return '';
    }
    var bytes = ['B', 'V', '1', '', '', '', '', '', '', '', '', ''];
    var index = bytes.length - 1;
    var temp = (BV_MAX_AID | avid) ^ BV_XOR_CODE;
    while (temp !== 0n) {
      bytes[BV_DIGIT_MAP[index]] = BV_ALPHABET[Number(temp % BV_BASE)];
      temp /= BV_BASE;
      index -= 1;
    }
    return bytes.join('');
  }

  function bvToAv(bvid) {
    if (!bvid) {
      return 0;
    }
    var id = String(bvid).trim();
    if (/^1[A-Za-z0-9]{9}$/.test(id)) {
      id = 'BV' + id;
    }
    if (!/^[Bb][Vv]1/.test(id) || id.length !== 12) {
      return 0;
    }
    id = 'BV' + id.slice(2);
    var result = 0n;
    for (var i = 3; i < 12; i++) {
      var index = BV_ALPHABET.indexOf(id[BV_DIGIT_MAP[i]]);
      if (index < 0) {
        return 0;
      }
      result = result * BV_BASE + BigInt(index);
    }
    return Number((result & BV_MASK_CODE) ^ BV_XOR_CODE);
  }

  function normalizeBvid(bvid) {
    var value = String(bvid || '').trim();
    if (!value) {
      return '';
    }
    var match = /^bv(1[0-9a-z]{9})$/i.exec(value);
    if (match) {
      return 'BV' + match[1];
    }
    return /^BV1[0-9A-Za-z]{9}$/.test(value) ? value : '';
  }

  function isInvalidTitle(title) {
    return INVALID_TITLE_SET.has(String(title || '').trim());
  }

  function isUsableTitle(title, aid) {
    var text = String(title || '').trim();
    if (!text || INVALID_TITLE_SET.has(text)) {
      return false;
    }
    if (aid !== null && aid !== undefined && text === String(aid)) {
      return false;
    }
    return true;
  }

  function isPlaceholderCover(url) {
    return String(url || '').indexOf(PLACEHOLDER_COVER_TOKEN) >= 0;
  }

  /** 收藏夹条目是否失效 */
  function isInvalidMedia(media) {
    if (!media || typeof media !== 'object') {
      return false;
    }
    if (isInvalidTitle(media.title)) {
      return true;
    }
    if (isPlaceholderCover(media.cover)) {
      return true;
    }
    var hasBvid = Boolean(normalizeBvid(media.bvid || media.bv_id));
    if (Number(media.attr) === 9 && !hasBvid && !isUsableTitle(media.title, media.id)) {
      return true;
    }
    return false;
  }

  function aidFromMedia(media) {
    if (!media || typeof media !== 'object') {
      return 0;
    }
    var direct = Number(media.id || media.aid || media.avid);
    if (Number.isFinite(direct) && direct > 0) {
      return direct;
    }
    var link = String(media.link || '');
    var avMatch = /av(\d+)/i.exec(link) || /video\/(\d+)/.exec(link);
    if (avMatch) {
      return Number(avMatch[1]);
    }
    var bvid = normalizeBvid(media.bvid || media.bv_id);
    return bvid ? bvToAv(bvid) : 0;
  }

  function normalizeCoverUrl(url) {
    if (!url) {
      return '';
    }
    var value = String(url).trim();
    if (!value) {
      return '';
    }
    if (value.indexOf('//') === 0) {
      value = 'https:' + value;
    } else if (value.slice(0, 7).toLowerCase() === 'http://') {
      value = 'https://' + value.slice(7);
    }
    try {
      var parsed = new URL(value);
      var host = parsed.hostname.toLowerCase();
      var isBiliplusArchive =
        parsed.protocol === 'https:' &&
        host === 'img.biliplus.com' &&
        !parsed.username &&
        !parsed.password &&
        /^\/bfs\/(archive|storyframe)\//i.test(parsed.pathname);
      if (isBiliplusArchive) {
        // biliplus 的归档图与 B 站 CDN 使用同一路径，改写回 hdslb；
        // 原始地址仍会作为下载封面时的兜底候选保留。
        parsed.hostname = 'i0.hdslb.com';
        parsed.port = '';
        value = parsed.toString();
      }
    } catch (error) {
      // 交给 isGoodCoverUrl 判定
    }
    return value;
  }

  function isGoodCoverUrl(url) {
    var value = normalizeCoverUrl(url);
    if (!value || isPlaceholderCover(value)) {
      return false;
    }
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== 'https:') {
        return false;
      }
      var host = parsed.hostname.toLowerCase();
      var isHdslb = host === 'hdslb.com' || host.slice(-10) === '.hdslb.com';
      return isHdslb;
    } catch (error) {
      return false;
    }
  }

  /** 给 hdslb 封面加缩放参数，减小体积；不支持的地址返回空串 */
  function resizedCoverUrl(url, width) {
    var value = normalizeCoverUrl(url);
    if (!value || value.indexOf('@') >= 0) {
      return '';
    }
    if (!/hdslb\.com/i.test(value)) {
      return '';
    }
    var path = value.split('?')[0];
    if (!/\.(jpe?g|png|webp|gif)$/i.test(path)) {
      return '';
    }
    var height = Math.max(1, Math.round(width * 0.625));
    return value + '@' + width + 'w_' + height + 'h_1c.webp';
  }

  /** 下载封面时依次尝试的地址：缩放地址 → 原地址 → 归档原始地址 */
  function coverCandidates(cover, coverRaw, width) {
    var list = [];
    var push = function (candidate) {
      var value = String(candidate || '').trim();
      if (!value) {
        return;
      }
      if (value.indexOf('//') === 0) {
        value = 'https:' + value;
      } else if (value.slice(0, 7).toLowerCase() === 'http://') {
        value = 'https://' + value.slice(7);
      }
      if (list.indexOf(value) < 0) {
        list.push(value);
      }
    };
    var small = resizedCoverUrl(cover, width || 480);
    if (small) {
      push(small);
    }
    push(normalizeCoverUrl(cover));
    if (coverRaw && coverRaw !== cover) {
      push(normalizeCoverUrl(coverRaw));
      push(coverRaw);
    }
    return list;
  }

  function weservCoverUrl(url) {
    var value = normalizeCoverUrl(url);
    if (!value) {
      return '';
    }
    return 'https://images.weserv.nl/?url=' + encodeURIComponent(value.replace(/^https?:\/\//i, ''));
  }

  function formatDuration(seconds) {
    var total = Math.max(0, Math.round(Number(seconds) || 0));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    if (hours > 0) {
      return String(hours) + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
    }
    return String(minutes) + ':' + String(secs).padStart(2, '0');
  }

  function formatCount(value) {
    var number = Number(value) || 0;
    if (number >= 100000000) {
      return (number / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
    }
    if (number >= 10000) {
      return (number / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
    }
    return String(number);
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatDate(timestamp) {
    var number = Number(timestamp) || 0;
    if (!number) {
      return '';
    }
    var date = new Date(number * 1000);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function formatDateTime(timestamp) {
    var number = Number(timestamp) || 0;
    if (!number) {
      return '';
    }
    var date = new Date(number * 1000);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return formatDate(number) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function parseBilibiliLocation(url) {
    var result = { uid: 0, fid: 0, type: 'fav', isFavPage: false, isSpace: false };
    if (!url) {
      return result;
    }
    var parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      return result;
    }
    var host = parsed.hostname.toLowerCase();
    if (host !== 'space.bilibili.com' && host !== 'www.bilibili.com' && host !== 'm.bilibili.com') {
      return result;
    }
    if (host === 'space.bilibili.com') {
      result.isSpace = true;
      var spaceMatch = /^\/(\d+)/.exec(parsed.pathname);
      if (spaceMatch) {
        result.uid = Number(spaceMatch[1]);
      }
      if (/\/favlist/.test(parsed.pathname)) {
        result.isFavPage = true;
        var fid = parsed.searchParams.get('fid');
        if (fid && /^\d+$/.test(fid)) {
          result.fid = Number(fid);
        }
        result.type = 'fav';
      } else {
        // 合集页面：/123456/lists/789?type=season
        var listMatch = /^\/\d+\/lists\/(\d+)/.exec(parsed.pathname);
        if (listMatch) {
          result.isFavPage = true;
          result.fid = Number(listMatch[1]);
          result.type = 'col';
        }
      }
    } else {
      var mlMatch = /^\/list\/ml(\d+)/.exec(parsed.pathname);
      if (mlMatch) {
        result.isFavPage = true;
        result.fid = Number(mlMatch[1]);
        result.type = 'fav';
      }
    }
    return result;
  }

  function safeFileName(name, fallback) {
    var value = String(name || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return value || fallback || 'bilibili-favorites';
  }

  function timestampTag(date) {
    var now = date || new Date();
    return (
      now.getFullYear() +
      pad2(now.getMonth() + 1) +
      pad2(now.getDate()) +
      '_' +
      pad2(now.getHours()) +
      pad2(now.getMinutes())
    );
  }

  var FavUtils = {
    INVALID_TITLE_SET: INVALID_TITLE_SET,
    PLACEHOLDER_COVER_TOKEN: PLACEHOLDER_COVER_TOKEN,
    avToBv: avToBv,
    bvToAv: bvToAv,
    normalizeBvid: normalizeBvid,
    isInvalidTitle: isInvalidTitle,
    isUsableTitle: isUsableTitle,
    isPlaceholderCover: isPlaceholderCover,
    isInvalidMedia: isInvalidMedia,
    aidFromMedia: aidFromMedia,
    normalizeCoverUrl: normalizeCoverUrl,
    isGoodCoverUrl: isGoodCoverUrl,
    resizedCoverUrl: resizedCoverUrl,
    coverCandidates: coverCandidates,
    weservCoverUrl: weservCoverUrl,
    formatDuration: formatDuration,
    formatCount: formatCount,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    escapeHtml: escapeHtml,
    sleep: sleep,
    parseBilibiliLocation: parseBilibiliLocation,
    safeFileName: safeFileName,
    timestampTag: timestampTag
  };

  global.FavUtils = FavUtils;
  if (typeof module === 'object' && module.exports) {
    module.exports = FavUtils;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
