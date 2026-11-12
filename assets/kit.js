/*
 * 工具集共用小函式：window.Kit
 *   Kit.$(id)                     getElementById
 *   Kit.fmtBytes(n) / fmtDur(sec) 格式化
 *   Kit.escapeHtml(s)
 *   Kit.baseName(name) / extOf(name)
 *   Kit.dropzone(labelEl, inputEl, onFiles)   拖放＋點選，onFiles(File[])
 *   Kit.download(blob, filename)              觸發下載
 *   Kit.downloadZip(files, zipName, onProgress)  files=[{name, blob}]，需先載入 JSZip
 *   Kit.progress(barEl, pctEl) -> { set(ratio), busy(), done() }
 *   Kit.showNote(el, msg) / hideNote(el)
 *   Kit.loadScript(url) -> Promise   依需求延遲載入大型函式庫
 */
(function (root) {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1e3) return n + ' B';
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + ' KB';
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + ' MB';
    return (n / 1e9).toFixed(2) + ' GB';
  }

  function fmtDur(sec) {
    if (!Number.isFinite(sec)) return '—';
    var t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function baseName(name) { return String(name).replace(/\.[^./]+$/, ''); }
  function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toLowerCase() : ''; }

  function dropzone(label, input, onFiles) {
    var deliver = function (list) { var files = Array.prototype.slice.call(list || []); if (files.length) onFiles(files); };
    input.addEventListener('change', function () { deliver(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      label.addEventListener(ev, function (e) { e.preventDefault(); if (!label.classList.contains('is-disabled')) label.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      label.addEventListener(ev, function (e) { e.preventDefault(); label.classList.remove('is-over'); });
    });
    label.addEventListener('drop', function (e) { if (!label.classList.contains('is-disabled')) deliver(e.dataTransfer.files); });
    label.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    // 防止拖到頁面其他地方時瀏覽器直接開啟檔案
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function downloadZip(files, zipName, onProgress) {
    if (typeof JSZip === 'undefined') return Promise.reject(new Error('JSZip 尚未載入'));
    var zip = new JSZip(), used = {};
    files.forEach(function (f) {
      var name = f.name, n = 1;
      while (used[name]) { name = baseName(f.name) + ' (' + (++n) + ')' + (extOf(f.name) ? '.' + extOf(f.name) : ''); }
      used[name] = true;
      zip.file(name, f.blob);
    });
    return zip.generateAsync({ type: 'blob', compression: 'STORE' }, function (m) { if (onProgress) onProgress(m.percent / 100); })
      .then(function (blob) { download(blob, zipName); return blob; });
  }

  function progress(bar, pct) {
    var fill = bar.querySelector('i');
    return {
      set: function (r) {
        r = Math.max(0, Math.min(1, r || 0));
        bar.classList.remove('is-indeterminate');
        fill.style.transform = 'scaleX(' + r + ')';
        if (pct) pct.textContent = Math.round(r * 100) + '%';
      },
      busy: function () { bar.classList.add('is-indeterminate'); if (pct) pct.textContent = ''; },
      done: function () { this.set(1); }
    };
  }

  function showNote(el, msg) { el.textContent = msg; el.hidden = false; }
  function hideNote(el) { el.hidden = true; el.textContent = ''; }

  var scriptCache = {};
  function loadScript(url) {
    if (scriptCache[url]) return scriptCache[url];
    scriptCache[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { delete scriptCache[url]; reject(new Error('無法載入程式庫：' + url)); };
      document.head.appendChild(s);
    });
    return scriptCache[url];
  }

  root.Kit = {
    $: $, fmtBytes: fmtBytes, fmtDur: fmtDur, escapeHtml: escapeHtml, baseName: baseName, extOf: extOf,
    dropzone: dropzone, download: download, downloadZip: downloadZip, progress: progress,
    showNote: showNote, hideNote: hideNote, loadScript: loadScript
  };
})(self);
