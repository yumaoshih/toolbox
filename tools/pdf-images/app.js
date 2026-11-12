/* PDF 與圖片互轉：pdf.js 渲染頁面成圖片；pdf-lib 把圖片合成 PDF。 */
(function () {
  'use strict';

  var $ = Kit.$;
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var PDFLIB = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  var JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  var MAX_PIXELS = 40e6;          // 單頁畫布上限，避免瀏覽器記憶體爆掉
  var A4 = [595.28, 841.89];      // pt
  var PX_TO_PT = 0.75;            // 以 96 DPI 換算原尺寸
  var JPG_QUALITY = 0.92;

  /* ── 共用：單選 chip 群組 ── */
  function chipGroup(el, onChange) {
    var get = function () { var b = el.querySelector('[aria-pressed="true"]'); return b ? b.dataset.v : null; };
    el.addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b || b.disabled) return;
      el.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c === b)); });
      if (onChange) onChange(get());
    });
    return { get: get, setDisabled: function (d) { el.querySelectorAll('.chip').forEach(function (c) { c.disabled = d; }); } };
  }

  function errMsg(err) { return err && err.message ? err.message : String(err); }

  /* ── 模式切換 ── */
  var tabs = [$('tab-p2i'), $('tab-i2p')];
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (o) {
        var on = o === t;
        o.setAttribute('aria-selected', String(on));
        $(o.getAttribute('aria-controls')).hidden = !on;
      });
    });
  });

  /* ════════ PDF 轉圖片 ════════ */
  var P = {
    file: null, doc: null, results: [], busy: false,
    dpi: chipGroup($('p-dpi')), fmt: chipGroup($('p-fmt')),
    prog: Kit.progress($('p-bar'), $('p-pct'))
  };

  function loadPdfJs() {
    return Kit.loadScript(PDFJS).then(function () { pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; });
  }

  /** "1-3, 5" -> [1,2,3,5]；空字串 -> 全部 */
  function parseRange(text, total) {
    var t = text.replace(/\s+/g, '');
    if (!t) return Array.from({ length: total }, function (_, i) { return i + 1; });
    var pages = [], seen = {};
    t.split(/[,，、]/).forEach(function (part) {
      if (!part) return;
      var m = /^(\d+)(?:[-–~](\d+))?$/.exec(part);
      if (!m) throw new Error('頁碼格式看不懂：「' + part + '」，請用像 1-3, 5 的寫法');
      var a = +m[1], b = m[2] ? +m[2] : a;
      if (a < 1 || b < a || b > total) throw new Error('頁碼「' + part + '」超出範圍（這份 PDF 共 ' + total + ' 頁）');
      for (var p = a; p <= b; p++) if (!seen[p]) { seen[p] = 1; pages.push(p); }
    });
    if (!pages.length) throw new Error('沒有選到任何頁面');
    return pages;
  }

  function resetP2I() {
    P.results.forEach(function (r) { URL.revokeObjectURL(r.url); });
    P.results = [];
    $('p-thumbs').innerHTML = ''; $('p-thumbs').hidden = true;
    $('p-zip').hidden = true; $('p-progress').hidden = true;
    Kit.hideNote($('p-error'));
  }

  function pickPdf(files) {
    if (P.busy) return;
    var file = files[0];
    resetP2I();
    if (!/pdf$/i.test(file.type) && Kit.extOf(file.name) !== 'pdf') return Kit.showNote($('p-error'), '請選擇 PDF 檔案。');
    P.file = file; P.doc = null; $('p-start').disabled = true;
    $('p-name').textContent = file.name; $('p-meta').textContent = Kit.fmtBytes(file.size) + ' · 讀取中…';
    $('p-file').hidden = false; $('p-drop').hidden = true;
    loadPdfJs().then(function () { return file.arrayBuffer(); })
      .then(function (buf) { return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise; })
      .then(function (doc) {
        if (P.file !== file) return doc.destroy();
        P.doc = doc;
        $('p-meta').textContent = Kit.fmtBytes(file.size) + ' · ' + doc.numPages + ' 頁';
        $('p-start').disabled = false;
      })
      .catch(function (err) {
        if (P.file !== file) return;
        $('p-meta').textContent = Kit.fmtBytes(file.size);
        var msg = err && err.name === 'PasswordException'
          ? '這份 PDF 有密碼保護，請先用原本的軟體解除密碼後再轉換。'
          : '無法讀取這份 PDF：' + errMsg(err);
        Kit.showNote($('p-error'), msg);
      });
  }

  function renderPage(pageNo, dpi, fmt) {
    return P.doc.getPage(pageNo).then(function (page) {
      var scale = dpi / 72;
      var vp = page.getViewport({ scale: scale });
      var area = vp.width * vp.height;
      if (area > MAX_PIXELS) { scale *= Math.sqrt(MAX_PIXELS / area); vp = page.getViewport({ scale: scale }); }
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) {
            var w = canvas.width, h = canvas.height;
            canvas.width = canvas.height = 0; page.cleanup();
            blob ? resolve({ blob: blob, w: w, h: h }) : reject(new Error('第 ' + pageNo + ' 頁輸出失敗'));
          }, fmt === 'png' ? 'image/png' : 'image/jpeg', JPG_QUALITY);
        });
      });
    });
  }

  function addThumb(r) {
    var li = document.createElement('li');
    li.className = 'thumb-card';
    li.innerHTML = '<div class="pic"><img alt="第 ' + r.page + ' 頁" src="' + r.url + '"></div>' +
      '<div class="cap"><span>P' + r.page + ' · ' + Kit.escapeHtml(Kit.fmtBytes(r.blob.size)) + '</span>' +
      '<button type="button" class="btn">下載</button></div>';
    li.querySelector('button').addEventListener('click', function () { Kit.download(r.blob, r.name); });
    $('p-thumbs').appendChild(li);
  }

  function setBusyP(b) {
    P.busy = b;
    ['p-start', 'p-change', 'p-range', 'p-zip'].forEach(function (id) { $(id).disabled = b; });
    P.dpi.setDisabled(b); P.fmt.setDisabled(b);
  }

  function runP2I() {
    if (!P.doc || P.busy) return;
    var pages;
    try { pages = parseRange($('p-range').value, P.doc.numPages); }
    catch (e) { return Kit.showNote($('p-error'), e.message); }
    resetP2I(); setBusyP(true);
    var dpi = +P.dpi.get(), fmt = P.fmt.get(), base = Kit.baseName(P.file.name);
    var pad = String(P.doc.numPages).length;
    $('p-progress').hidden = false; $('p-thumbs').hidden = false;
    var i = 0;
    function next() {
      if (i >= pages.length) return Promise.resolve();
      var pageNo = pages[i];
      $('p-label').textContent = '轉換第 ' + pageNo + ' 頁（' + (i + 1) + ' / ' + pages.length + '）';
      P.prog.set(i / pages.length);
      return renderPage(pageNo, dpi, fmt).then(function (out) {
        var r = { page: pageNo, blob: out.blob, url: URL.createObjectURL(out.blob), name: base + '_p' + String(pageNo).padStart(pad, '0') + '.' + fmt };
        P.results.push(r); addThumb(r); i++;
        return next();
      });
    }
    next().then(function () {
      P.prog.done(); $('p-label').textContent = '完成，共 ' + pages.length + ' 張圖片';
      $('p-zip').hidden = pages.length < 2;
    }).catch(function (err) {
      $('p-label').textContent = '轉換失敗';
      Kit.showNote($('p-error'), '轉換時發生錯誤：' + errMsg(err));
    }).then(function () { setBusyP(false); });
  }

  function zipP2I() {
    setBusyP(true);
    $('p-label').textContent = '打包 ZIP…';
    Kit.loadScript(JSZIP)
      .then(function () { return Kit.downloadZip(P.results, Kit.baseName(P.file.name) + '_圖片.zip', function (r) { P.prog.set(r); }); })
      .then(function () { $('p-label').textContent = '已下載 ZIP'; })
      .catch(function (err) { Kit.showNote($('p-error'), '打包失敗：' + errMsg(err)); })
      .then(function () { setBusyP(false); });
  }

  Kit.dropzone($('p-drop'), $('p-input'), pickPdf);
  $('p-change').addEventListener('click', function () { if (!P.busy) $('p-input').click(); });
  $('p-start').addEventListener('click', runP2I);
  $('p-zip').addEventListener('click', zipP2I);
  $('p-range').addEventListener('input', function () { Kit.hideNote($('p-error')); });

  /* ════════ 圖片轉 PDF ════════ */
  var I = {
    items: [], seq: 0, busy: false, dragId: null,
    size: chipGroup($('i-size')), margin: chipGroup($('i-margin')),
    prog: Kit.progress($('i-bar'), $('i-pct'))
  };
  var ACCEPT = /^image\/(jpeg|png|webp)$/;

  function addImages(files) {
    if (I.busy) return;
    Kit.hideNote($('i-error')); $('i-done').hidden = true;
    var skipped = [];
    files.forEach(function (f) {
      if (!ACCEPT.test(f.type)) { skipped.push(f.name); return; }
      I.items.push({ id: ++I.seq, file: f, url: URL.createObjectURL(f) });
    });
    if (skipped.length) Kit.showNote($('i-error'), '已略過不支援的檔案：' + skipped.join('、') + '（支援 JPG、PNG、WebP；HEIC 請先用「HEIC 轉 JPG」）');
    renderRows();
  }

  var ICON_UP = '<svg viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
  var ICON_DOWN = '<svg viewBox="0 0 24 24"><path d="M12 5v14m6-6-6 6-6-6"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function renderRows() {
    var ol = $('i-rows');
    ol.innerHTML = '';
    I.items.forEach(function (it, i) {
      var li = document.createElement('li');
      li.className = 'row'; li.draggable = true; li.dataset.id = it.id;
      li.innerHTML = '<span class="handle" title="拖曳調整順序">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<img class="thumb" alt="" src="' + it.url + '">' +
        '<span><div class="r-name">' + Kit.escapeHtml(it.file.name) + '</div><div class="r-meta">' + Kit.fmtBytes(it.file.size) + '</div></span>' +
        '<span class="tools">' +
        '<button type="button" class="icon-btn" data-act="up" aria-label="上移"' + (i === 0 ? ' disabled' : '') + '>' + ICON_UP + '</button>' +
        '<button type="button" class="icon-btn" data-act="down" aria-label="下移"' + (i === I.items.length - 1 ? ' disabled' : '') + '>' + ICON_DOWN + '</button>' +
        '<button type="button" class="icon-btn" data-act="del" aria-label="移除">' + ICON_X + '</button></span>';
      ol.appendChild(li);
    });
    ol.hidden = !I.items.length;
    $('i-start').disabled = !I.items.length || I.busy;
    $('i-clear').hidden = !I.items.length;
  }

  function indexOfId(id) { return I.items.findIndex(function (it) { return it.id === id; }); }
  function move(from, to) {
    if (to < 0 || to >= I.items.length || from === to) return;
    var copy = I.items.slice(), it = copy.splice(from, 1)[0];
    copy.splice(to, 0, it); I.items = copy; renderRows();
  }

  $('i-rows').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b || I.busy) return;
    var idx = indexOfId(+b.closest('.row').dataset.id);
    if (b.dataset.act === 'up') move(idx, idx - 1);
    else if (b.dataset.act === 'down') move(idx, idx + 1);
    else { URL.revokeObjectURL(I.items[idx].url); I.items = I.items.filter(function (_, i) { return i !== idx; }); renderRows(); }
  });
  $('i-rows').addEventListener('dragstart', function (e) {
    var row = e.target.closest('.row'); if (!row || I.busy) return e.preventDefault();
    I.dragId = +row.dataset.id; row.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.dataset.id);
  });
  $('i-rows').addEventListener('dragover', function (e) {
    if (I.dragId == null) return;
    e.preventDefault(); e.stopPropagation();
    var row = e.target.closest('.row');
    document.querySelectorAll('#i-rows .is-drop-target').forEach(function (r) { r.classList.remove('is-drop-target'); });
    if (row) row.classList.add('is-drop-target');
  });
  $('i-rows').addEventListener('drop', function (e) {
    if (I.dragId == null) return;
    e.preventDefault(); e.stopPropagation();
    var row = e.target.closest('.row');
    if (row) move(indexOfId(I.dragId), indexOfId(+row.dataset.id));
  });
  $('i-rows').addEventListener('dragend', function () { I.dragId = null; renderRows(); });

  $('i-clear').addEventListener('click', function () {
    if (I.busy) return;
    I.items.forEach(function (it) { URL.revokeObjectURL(it.url); });
    I.items = []; renderRows(); $('i-done').hidden = true; Kit.hideNote($('i-error'));
  });

  /** 讀 JPEG 的 EXIF Orientation（找不到回傳 1） */
  function jpegOrientation(buf) {
    var v = new DataView(buf), off = 2;
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return 1;
    while (off + 4 <= v.byteLength) {
      var marker = v.getUint16(off), len = v.getUint16(off + 2);
      if (marker === 0xFFDA || (marker & 0xFF00) !== 0xFF00) break;
      if (marker === 0xFFE1 && len >= 16 && v.getUint32(off + 4) === 0x45786966) {
        var t = off + 10, le = v.getUint16(t) === 0x4949;
        var ifd = t + v.getUint32(t + 4, le), n = v.getUint16(ifd, le);
        for (var i = 0; i < n; i++) {
          var e = ifd + 2 + i * 12;
          if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
        }
        return 1;
      }
      off += 2 + len;
    }
    return 1;
  }

  /** 回傳可嵌入 PDF 的 {bytes, kind:'jpg'|'png', w, h}，必要時經 canvas 轉正 */
  function prepareImage(file) {
    return file.arrayBuffer().then(function (buf) {
      var isJpg = file.type === 'image/jpeg', isPng = file.type === 'image/png';
      if (isJpg && jpegOrientation(buf) === 1) return { bytes: buf, kind: 'jpg' };
      if (isPng) return { bytes: buf, kind: 'png' };
      return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
        var c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(bmp, 0, 0); bmp.close();
        return new Promise(function (res, rej) {
          c.toBlob(function (b) { c.width = c.height = 0; b ? res(b) : rej(new Error(file.name + ' 轉換失敗')); }, 'image/jpeg', JPG_QUALITY);
        }).then(function (b) { return b.arrayBuffer(); }).then(function (bytes) { return { bytes: bytes, kind: 'jpg' }; });
      });
    });
  }

  function pageLayout(imgW, imgH, sizeMode, margin) {
    var pw, ph;
    if (sizeMode === 'a4') { var land = imgW > imgH; pw = land ? A4[1] : A4[0]; ph = land ? A4[0] : A4[1]; }
    else { pw = imgW * PX_TO_PT + margin * 2; ph = imgH * PX_TO_PT + margin * 2; }
    var boxW = pw - margin * 2, boxH = ph - margin * 2;
    var s = Math.min(boxW / imgW, boxH / imgH);
    if (sizeMode === 'fit') s = PX_TO_PT;
    var w = imgW * s, h = imgH * s;
    return { pw: pw, ph: ph, x: (pw - w) / 2, y: (ph - h) / 2, w: w, h: h };
  }

  function setBusyI(b) {
    I.busy = b;
    $('i-start').disabled = b || !I.items.length; $('i-clear').disabled = b;
    $('i-drop').classList.toggle('is-disabled', b);
    I.size.setDisabled(b); I.margin.setDisabled(b);
    document.querySelectorAll('#i-rows .icon-btn').forEach(function (x) { x.disabled = b; });
    if (!b) renderRows();
  }

  function runI2P() {
    if (I.busy || !I.items.length) return;
    Kit.hideNote($('i-error')); $('i-done').hidden = true;
    setBusyI(true); $('i-progress').hidden = false;
    var items = I.items.slice(), sizeMode = I.size.get(), margin = +I.margin.get(), doc;
    Kit.loadScript(PDFLIB).then(function () { return PDFLib.PDFDocument.create(); }).then(function (d) {
      doc = d;
      var i = 0;
      function next() {
        if (i >= items.length) return Promise.resolve();
        var it = items[i];
        $('i-label').textContent = '加入第 ' + (i + 1) + ' / ' + items.length + ' 張：' + it.file.name;
        I.prog.set(i / items.length);
        return prepareImage(it.file).then(function (img) {
          return img.kind === 'png' ? doc.embedPng(img.bytes) : doc.embedJpg(img.bytes);
        }).then(function (emb) {
          var L = pageLayout(emb.width, emb.height, sizeMode, margin);
          doc.addPage([L.pw, L.ph]).drawImage(emb, { x: L.x, y: L.y, width: L.w, height: L.h });
          i++; return next();
        }, function (err) { throw new Error(it.file.name + '：' + errMsg(err)); });
      }
      return next();
    }).then(function () {
      $('i-label').textContent = '寫出 PDF…';
      return doc.save();
    }).then(function (bytes) {
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var name = (items.length === 1 ? Kit.baseName(items[0].file.name) : '合併圖片') + '.pdf';
      Kit.download(blob, name);
      I.prog.done(); $('i-label').textContent = '完成';
      Kit.showNote($('i-done'), '已下載「' + name + '」：' + items.length + ' 頁，' + Kit.fmtBytes(blob.size) + '。');
      $('i-done').hidden = false;
    }).catch(function (err) {
      $('i-label').textContent = '產生失敗';
      Kit.showNote($('i-error'), '產生 PDF 時發生錯誤：' + errMsg(err));
    }).then(function () { setBusyI(false); });
  }

  Kit.dropzone($('i-drop'), $('i-input'), addImages);
  $('i-start').addEventListener('click', runI2P);

  window.__pdfImages = { P: P, I: I, pickPdf: pickPdf, addImages: addImages, runP2I: runP2I, runI2P: runI2P, parseRange: parseRange };
})();
