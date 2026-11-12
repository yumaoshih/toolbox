/* 繁簡轉換：opencc-js 即時轉換＋字數統計 */
(function () {
  'use strict';

  var OPENCC_URL = 'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js';
  var DEBOUNCE_MS = 150;
  var MAX_DIFF_STEPS = 4000; // 變動字數的計算上限（編輯距離），超過就顯示「大量」

  var $ = Kit.$;
  var els = {
    modes: $('modes'), input: $('input'), output: $('output'), inBox: $('in-box'),
    file: $('file-input'), clear: $('btn-clear'), copy: $('btn-copy'), dl: $('btn-download'),
    changed: $('changed'), error: $('note-error'),
    enc: $('enc'), encText: $('enc-text'), encSelect: $('enc-select'),
    inStats: $('in-stats'), outStats: $('out-stats')
  };
  var state = { from: 'cn', to: 'twp', convert: null, timer: 0, bytes: null, fileName: '' };
  var converters = {};

  /* ── 編碼偵測 ── */
  // Big5 的常用字與全形標點第二個位元組常落在 0x40–0x7E，GB2312 則不會；用這個比例區分 Big5 與 GBK。
  function guessDoubleByte(bytes) {
    var pairs = 0, lowTrail = 0;
    for (var i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] >= 0x81 && bytes[i] <= 0xFE) {
        pairs++;
        if (bytes[i + 1] >= 0x40 && bytes[i + 1] <= 0x7E) lowTrail++;
        i++;
      }
    }
    return pairs && lowTrail / pairs > 0.05 ? 'big5' : 'gbk';
  }

  function decode(bytes, forced) {
    var tryOrder = forced ? [forced] : ['utf-8', guessDoubleByte(bytes)];
    for (var i = 0; i < tryOrder.length; i++) {
      try {
        return { text: new TextDecoder(tryOrder[i], { fatal: true }).decode(bytes), encoding: tryOrder[i], lossy: false };
      } catch (e) { /* 換下一種 */ }
    }
    var enc = tryOrder[tryOrder.length - 1];
    return { text: new TextDecoder(enc).decode(bytes), encoding: enc, lossy: true };
  }

  var ENC_NAME = { 'utf-8': 'UTF-8', big5: 'Big5', gbk: 'GBK' };

  /* ── 統計 ── */
  var segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null;
  function graphemes(text) {
    if (!segmenter) return Array.from(text);
    var out = [];
    for (var it = segmenter.segment(text)[Symbol.iterator](), s = it.next(); !s.done; s = it.next()) out.push(s.value.segment);
    return out;
  }

  function countMatches(text, re) { var m = text.match(re); return m ? m.length : 0; }

  var NUMBER_RE = /\d+(?:[.,]\d+)*/g;

  function stats(text, g) {
    var punctSource = segmenter ? graphemes(text.replace(NUMBER_RE, '')) : Array.from(text.replace(NUMBER_RE, ''));
    var noBreak = g.filter(function (c) { return c !== '\n' && c !== '\r' && c !== '\r\n'; });
    var lines = text ? text.split(/\r\n|\r|\n/) : [];
    return {
      chars: noBreak.length,
      nospace: noBreak.filter(function (c) { return !/^\s+$/.test(c); }).length,
      han: countMatches(text, /\p{Script=Han}/gu),
      words: countMatches(text, /[A-Za-z]+(?:['’][A-Za-z]+)*/g),
      nums: countMatches(text, NUMBER_RE),
      punct: punctSource.filter(function (c) { return /^\p{P}$/u.test(c); }).length,
      lines: lines.length,
      paras: lines.filter(function (l) { return l.trim() !== ''; }).length
    };
  }

  function renderStats(el, s) {
    Array.prototype.forEach.call(el.querySelectorAll('.v'), function (v) { v.textContent = s[v.dataset.k].toLocaleString(); });
  }

  /* ── 變動字數：Myers 演算法求編輯距離 D，LCS = (N+M−D)/2，輸出端變動 = M − LCS ── */
  function changedCount(a, b) {
    var n = a.length, m = b.length, max = Math.min(n + m, MAX_DIFF_STEPS);
    var v = { 1: 0 };
    for (var d = 0; d <= max; d++) {
      for (var k = -d; k <= d; k += 2) {
        var x = (k === -d || (k !== d && v[k - 1] < v[k + 1])) ? v[k + 1] : v[k - 1] + 1;
        var y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[k] = x;
        if (x >= n && y >= m) return m - (n + m - d) / 2;
      }
    }
    return -1;
  }

  /* ── 轉換 ── */
  function getConverter() {
    var key = state.from + '>' + state.to;
    if (!converters[key]) converters[key] = OpenCC.Converter({ from: state.from, to: state.to });
    return converters[key];
  }

  function convertNow() {
    var text = els.input.value;
    var gi = graphemes(text);
    renderStats(els.inStats, stats(text, gi));
    if (!window.OpenCC) return;
    var out = getConverter()(text);
    els.output.value = out;
    var go = graphemes(out);
    renderStats(els.outStats, stats(out, go));
    var c = changedCount(gi, go);
    els.changed.textContent = c < 0 ? '變動很多字' : '變動 ' + c.toLocaleString() + ' 字';
    els.changed.classList.toggle('is-hot', c !== 0);
    els.copy.disabled = els.dl.disabled = !out;
  }

  function schedule() { clearTimeout(state.timer); state.timer = setTimeout(convertNow, DEBOUNCE_MS); }

  /* ── 檔案 ── */
  function loadBytes(forced) {
    var r = decode(state.bytes, forced);
    els.input.value = r.text.replace(/^﻿/, '');
    els.encSelect.value = r.encoding;
    els.encText.textContent = '「' + state.fileName + '」以 ' + ENC_NAME[r.encoding] + ' 讀取' + (r.lossy ? '，部分字元無法辨識' : '') + '。亂碼嗎？';
    els.enc.hidden = false;
    convertNow();
  }

  function openFile(file) {
    Kit.hideNote(els.error);
    if (file.size > 20e6) { Kit.showNote(els.error, '檔案太大（超過 20 MB），請改用較小的文字檔。'); return; }
    file.arrayBuffer().then(function (buf) {
      state.bytes = new Uint8Array(buf); state.fileName = file.name;
      loadBytes(null);
    }).catch(function () { Kit.showNote(els.error, '無法讀取這個檔案。'); });
  }

  /* ── 事件 ── */
  els.modes.addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b || b.disabled) return;
    Array.prototype.forEach.call(els.modes.querySelectorAll('.chip'), function (c) { c.setAttribute('aria-pressed', String(c === b)); });
    state.from = b.dataset.from; state.to = b.dataset.to;
    convertNow();
  });
  els.input.addEventListener('input', schedule);
  els.clear.addEventListener('click', function () { els.input.value = ''; els.enc.hidden = true; state.bytes = null; convertNow(); els.input.focus(); });
  els.file.addEventListener('change', function () { if (els.file.files[0]) openFile(els.file.files[0]); els.file.value = ''; });
  els.encSelect.addEventListener('change', function () { if (state.bytes) loadBytes(els.encSelect.value); });

  ['dragenter', 'dragover'].forEach(function (ev) { els.inBox.addEventListener(ev, function (e) { e.preventDefault(); els.inBox.classList.add('is-over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { els.inBox.addEventListener(ev, function (e) { e.preventDefault(); els.inBox.classList.remove('is-over'); }); });
  els.inBox.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) openFile(f); });
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) { e.preventDefault(); });

  els.copy.addEventListener('click', function () {
    var done = function () { els.copy.textContent = '已複製'; setTimeout(function () { els.copy.textContent = '複製'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(els.output.value).then(done, function () { els.output.select(); document.execCommand('copy'); done(); });
    } else { els.output.select(); document.execCommand('copy'); done(); }
  });
  els.dl.addEventListener('click', function () {
    var name = (state.fileName ? Kit.baseName(state.fileName) : '轉換結果') + '_' + state.to + '.txt';
    Kit.download(new Blob([els.output.value], { type: 'text/plain;charset=utf-8' }), name);
  });

  /* ── 載入引擎 ── */
  var chips = els.modes.querySelectorAll('.chip');
  Array.prototype.forEach.call(chips, function (c) { c.disabled = true; });
  Kit.loadScript(OPENCC_URL).then(function () {
    Array.prototype.forEach.call(chips, function (c) { c.disabled = false; });
    els.output.placeholder = '轉換結果會顯示在這裡';
    convertNow();
  }).catch(function () {
    els.output.placeholder = '';
    Kit.showNote(els.error, '轉換引擎載入失敗，請確認網路連線後重新整理頁面。');
  });

  window.__zh = { convertNow: convertNow, openFile: openFile, stats: stats, graphemes: graphemes, changedCount: changedCount, state: state };
  convertNow();
})();
