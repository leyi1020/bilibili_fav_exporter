/**
 * 自实现的 MD5（UTF-8 输入，32 位小写十六进制输出）。
 * 仅用于 B 站 wbi 接口签名，避免引入第三方库。
 */
(function (global) {
  'use strict';

  var SHIFT = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  var TABLE = new Int32Array(64);
  for (var i = 0; i < 64; i++) {
    TABLE[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }

  function utf8Bytes(text) {
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i++;
        }
      }
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 63),
          0x80 | ((code >> 6) & 63),
          0x80 | (code & 63)
        );
      }
    }
    return bytes;
  }

  function add(a, b) {
    return (a + b) | 0;
  }

  function rotateLeft(value, count) {
    return (value << count) | (value >>> (32 - count));
  }

  function wordToHex(word) {
    var hex = '';
    for (var i = 0; i < 4; i++) {
      hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return hex;
  }

  function md5Hex(input) {
    var message = utf8Bytes(String(input));
    var bitLength = message.length * 8;
    message.push(0x80);
    while (message.length % 64 !== 56) {
      message.push(0);
    }
    var low = bitLength >>> 0;
    var high = Math.floor(bitLength / 4294967296) >>> 0;
    for (var i = 0; i < 4; i++) {
      message.push((low >>> (i * 8)) & 0xff);
    }
    for (var j = 0; j < 4; j++) {
      message.push((high >>> (j * 8)) & 0xff);
    }

    var a0 = 0x67452301;
    var b0 = 0xefcdab89 | 0;
    var c0 = 0x98badcfe | 0;
    var d0 = 0x10325476;

    for (var offset = 0; offset < message.length; offset += 64) {
      var words = new Int32Array(16);
      for (var k = 0; k < 16; k++) {
        words[k] =
          message[offset + k * 4] |
          (message[offset + k * 4 + 1] << 8) |
          (message[offset + k * 4 + 2] << 16) |
          (message[offset + k * 4 + 3] << 24);
      }

      var a = a0;
      var b = b0;
      var c = c0;
      var d = d0;

      for (var step = 0; step < 64; step++) {
        var f;
        var g;
        if (step < 16) {
          f = (b & c) | (~b & d);
          g = step;
        } else if (step < 32) {
          f = (d & b) | (~d & c);
          g = (5 * step + 1) % 16;
        } else if (step < 48) {
          f = b ^ c ^ d;
          g = (3 * step + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          g = (7 * step) % 16;
        }
        f = add(add(f, a), add(TABLE[step], words[g]));
        a = d;
        d = c;
        c = b;
        b = add(b, rotateLeft(f, SHIFT[step]));
      }

      a0 = add(a0, a);
      b0 = add(b0, b);
      c0 = add(c0, c);
      d0 = add(d0, d);
    }

    return wordToHex(a0) + wordToHex(b0) + wordToHex(c0) + wordToHex(d0);
  }

  global.md5Hex = md5Hex;
  if (typeof module === 'object' && module.exports) {
    module.exports = md5Hex;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
