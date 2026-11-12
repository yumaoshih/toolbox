/*
 * 無損移除照片中的中繼資料（位元組層處理，不重新編碼）。
 *   MetaStrip.detect(u8) -> 'jpeg' | 'png' | 'webp' | 'heic' | null
 *   MetaStrip.orientation(u8) -> 1..8（找不到回傳 1）
 *   MetaStrip.strip(u8) -> { bytes: Uint8Array, removed: string[], keptOrientation: number }
 * Orientation ≠ 1 時只保留一個最小的 EXIF（只含方向），讓照片不會轉向。
 * Node 與瀏覽器皆可使用。
 */
(function (root) {
  'use strict';

  function ascii(u8, off, n) { return String.fromCharCode.apply(null, u8.subarray(off, off + n)); }
  function be16(u8, o) { return (u8[o] << 8) | u8[o + 1]; }
  function be32(u8, o) { return ((u8[o] << 24) >>> 0) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3]; }
  function le32(u8, o) { return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0; }

  function concat(parts) {
    var n = parts.reduce(function (a, p) { return a + p.length; }, 0), out = new Uint8Array(n), off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }

  function detect(u8) {
    if (u8.length < 12) return null;
    if (u8[0] === 0xFF && u8[1] === 0xD8) return 'jpeg';
    if (be32(u8, 0) === 0x89504E47) return 'png';
    if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WEBP') return 'webp';
    if (ascii(u8, 4, 4) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(ascii(u8, 8, 4))) return 'heic';
    return null;
  }

  /* ── TIFF（EXIF 本體）── */
  function tiffOrientation(u8, t) {
    if (t + 8 > u8.length) return 1;
    var le = u8[t] === 0x49, rd16 = function (o) { return le ? u8[o] | (u8[o + 1] << 8) : be16(u8, o); };
    var rd32 = function (o) { return le ? le32(u8, o) : be32(u8, o); };
    var ifd = t + rd32(t + 4);
    if (ifd + 2 > u8.length) return 1;
    var n = rd16(ifd);
    for (var i = 0; i < n; i++) {
      var e = ifd + 2 + i * 12;
      if (e + 12 > u8.length) break;
      if (rd16(e) === 0x0112) { var v = rd16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
    }
    return 1;
  }

  function minimalTiff(o) {
    return Uint8Array.of(0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0);
  }
  var EXIF_HDR = [0x45, 0x78, 0x69, 0x66, 0, 0];  // "Exif\0\0"

  /* ── JPEG ── */
  function jpegSegments(u8, visit) {
    var off = 2;
    while (off + 4 <= u8.length) {
      if (u8[off] !== 0xFF) throw new Error('JPEG 結構異常');
      var m = u8[off + 1];
      if (m === 0xFF) { off++; continue; }
      if (m === 0xD9 || m === 0xDA) return visit(m, off, u8.length, true);
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { visit(m, off, off + 2, false); off += 2; continue; }
      var end = off + 2 + be16(u8, off + 2);
      if (end > u8.length) throw new Error('JPEG 檔案不完整');
      visit(m, off, end, false);
      off = end;
    }
  }

  function jpegOrientation(u8) {
    var o = 1;
    jpegSegments(u8, function (m, off, end, last) {
      if (!last && m === 0xE1 && o === 1 && ascii(u8, off + 4, 4) === 'Exif') o = tiffOrientation(u8, off + 10);
    });
    return o;
  }

  var APP_NAMES = { 0xE1: 'EXIF／XMP', 0xE2: 'MPF', 0xED: 'IPTC／Photoshop', 0xFE: '註解' };

  function stripJpeg(u8) {
    var orient = jpegOrientation(u8), parts = [u8.subarray(0, 2)], removed = {}, inserted = orient === 1;
    var mini = orient === 1 ? null : concat([Uint8Array.of(0xFF, 0xE1, 0, 2 + 6 + 26), Uint8Array.from(EXIF_HDR), minimalTiff(orient)]);
    jpegSegments(u8, function (m, off, end, last) {
      var isApp = m >= 0xE0 && m <= 0xEF;
      var keep = !(isApp || m === 0xFE)
        || (m === 0xE0 && ascii(u8, off + 4, 4) === 'JFIF')
        || (m === 0xE2 && ascii(u8, off + 4, 11) === 'ICC_PROFILE')
        || (m === 0xEE && ascii(u8, off + 4, 5) === 'Adobe');
      if (!inserted && m !== 0xE0) { parts.push(mini); inserted = true; }
      if (keep) parts.push(u8.subarray(off, end));
      else removed[APP_NAMES[m] || ('APP' + (m - 0xE0))] = 1;
    });
    return { bytes: concat(parts), removed: Object.keys(removed), keptOrientation: orient };
  }

  /* ── PNG ── */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function u32be(n) { return Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
  function pngChunk(type, data) {
    var td = concat([Uint8Array.from(type, function (c) { return c.charCodeAt(0); }), data]);
    return concat([u32be(data.length), td, u32be(crc32(td))]);
  }
  var PNG_DROP = { eXIf: 'EXIF', tEXt: '文字資訊', iTXt: '文字資訊（含 XMP）', zTXt: '壓縮文字資訊', tIME: '修改時間' };

  function pngChunks(u8, visit) {
    var off = 8;
    while (off + 12 <= u8.length) {
      var len = be32(u8, off), type = ascii(u8, off + 4, 4), end = off + 12 + len;
      if (end > u8.length) throw new Error('PNG 檔案不完整');
      visit(type, off, end);
      if (type === 'IEND') return;
      off = end;
    }
  }

  function stripPng(u8) {
    var orient = 1, parts = [u8.subarray(0, 8)], removed = {};
    pngChunks(u8, function (type, off) { if (type === 'eXIf' && orient === 1) orient = exifBlobOrientation(u8, off + 8); });
    var inserted = orient === 1;
    pngChunks(u8, function (type, off, end) {
      if (!inserted && type === 'IDAT') { parts.push(pngChunk('eXIf', minimalTiff(orient))); inserted = true; }
      if (PNG_DROP[type]) removed[PNG_DROP[type]] = 1; else parts.push(u8.subarray(off, end));
    });
    return { bytes: concat(parts), removed: Object.keys(removed), keptOrientation: orient };
  }

  /* 有些寫入工具在 EXIF 區塊前多加 "Exif\0\0" */
  function exifBlobOrientation(u8, start) {
    return tiffOrientation(u8, ascii(u8, start, 4) === 'Exif' ? start + 6 : start);
  }

  /* ── WebP ── */
  function webpChunks(u8, visit) {
    var off = 12;
    while (off + 8 <= u8.length) {
      var size = le32(u8, off + 4), end = off + 8 + size + (size & 1);
      visit(ascii(u8, off, 4), off, Math.min(end, u8.length));
      off = end;
    }
  }

  function stripWebp(u8) {
    var orient = 1, parts = [], removed = {}, vp8x = null;
    webpChunks(u8, function (fourcc, off) { if (fourcc === 'EXIF' && orient === 1) orient = exifBlobOrientation(u8, off + 8); });
    webpChunks(u8, function (fourcc, off, end) {
      if (fourcc === 'EXIF') { removed.EXIF = 1; return; }
      if (fourcc === 'XMP ') { removed.XMP = 1; return; }
      var chunk = u8.slice(off, end);
      if (fourcc === 'VP8X') vp8x = chunk;
      parts.push(chunk);
    });
    if (vp8x) {
      vp8x[8] = (vp8x[8] & ~0x0C) | (orient !== 1 ? 0x08 : 0);
      if (orient !== 1) { var t = minimalTiff(orient); parts.push(concat([Uint8Array.from('EXIF', function (c) { return c.charCodeAt(0); }), Uint8Array.of(t.length, 0, 0, 0), t])); }
    } else orient = 1;
    var body = concat(parts), size = body.length + 4;
    var head = Uint8Array.of(0x52, 0x49, 0x46, 0x46, size & 255, (size >>> 8) & 255, (size >>> 16) & 255, size >>> 24, 0x57, 0x45, 0x42, 0x50);
    return { bytes: concat([head, body]), removed: Object.keys(removed), keptOrientation: orient };
  }

  /** PNG／WebP 內的 EXIF 本體（TIFF 格式），可直接交給 exifr 解析；找不到回傳 null */
  function exifTiff(u8) {
    var k = detect(u8), found = null;
    var pick = function (start, end) {
      if (found) return;
      var s = ascii(u8, start, 4) === 'Exif' ? start + 6 : start;
      found = u8.slice(s, end);
    };
    if (k === 'png') pngChunks(u8, function (type, off, end) { if (type === 'eXIf') pick(off + 8, end - 4); });
    if (k === 'webp') webpChunks(u8, function (fourcc, off) { if (fourcc === 'EXIF') pick(off + 8, off + 8 + le32(u8, off + 4)); });
    return found;
  }

  function orientation(u8) {
    var k = detect(u8);
    if (k === 'jpeg') return jpegOrientation(u8);
    if (k === 'png') return stripPng(u8).keptOrientation;
    if (k === 'webp') return stripWebp(u8).keptOrientation;
    return 1;
  }

  function strip(u8) {
    var k = detect(u8);
    if (k === 'jpeg') return stripJpeg(u8);
    if (k === 'png') return stripPng(u8);
    if (k === 'webp') return stripWebp(u8);
    throw new Error(k === 'heic' ? 'HEIC' : '不支援的格式');
  }

  var api = { detect: detect, orientation: orientation, strip: strip, exifTiff: exifTiff };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MetaStrip = api;
})(typeof self !== 'undefined' ? self : this);
