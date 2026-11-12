/* 批次改尺寸與浮水印：createImageBitmap（套用 EXIF 方向）→ canvas 縮放 → 文字浮水印 → 編碼輸出 */
(function () {
  'use strict';

  var $ = Kit.$;
  var JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  var MAX_SIDE = 16384;
  var MIME = { jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
  var EXT_OF_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  var FONT = '600 {px}px "Geist", "PingFang TC", "Noto Sans TC", system-ui, sans-serif';

  function chipGroup(el, onChange) {
    var get = function () { var b = el.querySelector('[aria-pressed="true"]'); return b ? b.dataset.v : null; };
    var set = function (v) { el.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c.dataset.v === v)); }); };
    el.addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b || b.disabled) return;
      set(b.dataset.v); if (onChange) onChange(get());
    });
    return { get: get, set: set, setDisabled: function (d) { el.querySelectorAll('.chip').forEach(function (c) { c.disabled = d; }); } };
  }

  var state = { files: [], results: [], busy: false, previewBmp: null, previewIdx: 0, previewQueued: false };
  var prog = Kit.progress($('bar'), $('status-pct'));
  var ui = {
    mode: chipGroup($('mode'), onModeChange),
    fmt: chipGroup($('fmt'), onFmtChange),
    pos: chipGroup($('wm-pos'), schedulePreview),
    swatch: chipGroup($('wm-swatch'), function (v) { if (v !== 'auto') $('wm-color').value = v; schedulePreview(); })
  };

  /* ── 讀設定 ── */
  function readOpts() {
    var size = parseFloat($('size').value);
    var mode = ui.mode.get();
    var valid = Number.isFinite(size) && size > 0 && (mode === 'percent' ? size <= 400 : size <= MAX_SIDE);
    $('size-wrap').classList.toggle('is-invalid', !valid);
    return {
      valid: valid, mode: mode, size: size, fmt: ui.fmt.get(), quality: +$('quality').value / 100,
      wm: $('wm-on').checked && $('wm-text').value.trim() ? {
        text: $('wm-text').value.trim(), pos: ui.pos.get(), size: +$('wm-size').value / 100,
        alpha: +$('wm-alpha').value / 100, color: ui.swatch.get() === 'auto' ? 'auto' : $('wm-color').value
      } : null
    };
  }

  function targetSize(w, h, o) {
    var s;
    if (o.mode === 'percent') s = o.size / 100;
    else if (o.mode === 'width') s = o.size / w;
    else if (o.mode === 'height') s = o.size / h;
    else s = o.size / Math.max(w, h);
    if (o.mode !== 'percent') s = Math.min(1, s);   // 指定像素時不放大小圖，避免變糊又變大
    var tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
    var cap = Math.min(1, MAX_SIDE / Math.max(tw, th));
    return { w: Math.max(1, Math.round(tw * cap)), h: Math.max(1, Math.round(th * cap)) };
  }

  function outMime(file, o) {
    if (o.fmt !== 'same') return MIME[o.fmt];
    return EXT_OF_MIME[file.type] ? file.type : 'image/png';
  }

  /* ── 繪製 ── */
  function isLight(hex) {
    var n = parseInt(hex.slice(1), 16);
    return ((n >> 16 & 255) * 0.299 + (n >> 8 & 255) * 0.587 + (n & 255) * 0.114) > 150;
  }

  /** 字級以圖片面積的平方根為基準，寬扁或細長的圖也不會變得太小 */
  function wmFontPx(w, h, wm) { return Math.max(12, Math.round(Math.sqrt(w * h) * wm.size)); }

  function drawWatermark(ctx, w, h, wm) {
    var px = wmFontPx(w, h, wm);
    var fill = wm.color === 'auto' ? '#ffffff' : wm.color;
    var outline = isLight(fill) ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
    ctx.save();
    ctx.font = FONT.replace('{px}', px);
    ctx.globalAlpha = wm.alpha;
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, px * 0.12); ctx.strokeStyle = outline; ctx.fillStyle = fill;
    var text = function (t, x, y) { ctx.strokeText(t, x, y); ctx.fillText(t, x, y); };
    ctx.textBaseline = 'middle';
    var tw = ctx.measureText(wm.text).width, m = px * 0.9;
    if (wm.pos === 'tile') {
      ctx.translate(w / 2, h / 2); ctx.rotate(-Math.PI / 6); ctx.textAlign = 'center';
      var stepX = tw + px * 3, stepY = px * 4, R = Math.hypot(w, h) / 2 + stepX;
      for (var y = -R, row = 0; y <= R; y += stepY, row++) {
        for (var x = -R + (row % 2) * stepX / 2; x <= R; x += stepX) text(wm.text, x, y);
      }
    } else {
      var right = wm.pos === 'tr' || wm.pos === 'br', bottom = wm.pos === 'bl' || wm.pos === 'br';
      ctx.textAlign = wm.pos === 'c' ? 'center' : (right ? 'right' : 'left');
      var x0 = wm.pos === 'c' ? w / 2 : (right ? w - m : m);
      var y0 = wm.pos === 'c' ? h / 2 : (bottom ? h - m - px / 2 : m + px / 2);
      text(wm.text, x0, y0);
    }
    ctx.restore();
  }

  /** 把 bitmap 依設定畫到 canvas，回傳 canvas */
  function render(bmp, o, mime, canvas) {
    var t = targetSize(bmp.width, bmp.height, o);
    var c = canvas || document.createElement('canvas');
    c.width = t.w; c.height = t.h;
    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, t.w, t.h);
    if (mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, t.w, t.h); }
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, t.w, t.h);
    if (o.wm) drawWatermark(ctx, t.w, t.h, o.wm);
    return c;
  }

  function decode(file) {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
      var isHeic = /hei[cf]$/i.test(Kit.extOf(file.name)) || /hei[cf]/i.test(file.type);
      throw new Error(isHeic ? 'HEIC 格式瀏覽器無法直接讀取，請先用「HEIC 轉 JPG」轉檔' : '無法讀取這張圖片');
    });
  }

  /* ── 預覽 ── */
  function schedulePreview() {
    if (state.previewQueued) return;
    state.previewQueued = true;
    requestAnimationFrame(function () { state.previewQueued = false; drawPreview(); });
  }
  function drawPreview() {
    var o = readOpts(), bmp = state.previewBmp;
    if (!bmp || !o.valid) return;
    var mime = outMime(state.files[state.previewIdx], o);
    render(bmp, o, mime, $('preview'));
    var t = targetSize(bmp.width, bmp.height, o);
    $('preview-cap').textContent = bmp.width + '×' + bmp.height + ' → ' + t.w + '×' + t.h + ' · ' + EXT_OF_MIME[mime].toUpperCase();
  }

  function showPreview(idx) {
    var n = state.files.length;
    state.previewIdx = (idx + n) % n;
    var file = state.files[state.previewIdx];
    $('preview-idx').textContent = (state.previewIdx + 1) + ' / ' + n;
    $('preview-nav').hidden = n < 2;
    return decode(file).then(function (bmp) {
      if (state.files[state.previewIdx] !== file) { bmp.close(); return; }
      if (state.previewBmp) state.previewBmp.close();
      state.previewBmp = bmp;
      $('live').hidden = false;
      drawPreview();
    }).catch(function (err) { Kit.showNote($('note-error'), file.name + '：' + err.message); });
  }

  /* ── 全尺寸檢視（共用 Kit.viewer） ── */
  function openViewer(v) { Kit.viewer.open(v); }
  function zoomPreview() {
    if (!state.previewBmp) return;
    $('preview').toBlob(function (b) {
      if (!b) return;
      openViewer({ title: '預覽：' + state.files[state.previewIdx].name, cap: $('preview-cap').textContent, url: URL.createObjectURL(b), ownUrl: true });
    }, 'image/png');
  }

  /* ── 選檔 ── */
  function pickFiles(files) {
    if (state.busy) return;
    clearResults(); Kit.hideNote($('note-error'));
    state.files = files.filter(function (f) { return /^image\//.test(f.type) || /hei[cf]$/i.test(Kit.extOf(f.name)); });
    if (!state.files.length) return Kit.showNote($('note-error'), '沒有可處理的圖片檔。');
    var total = state.files.reduce(function (a, f) { return a + f.size; }, 0);
    $('picked-name').textContent = state.files.length === 1 ? state.files[0].name : state.files.length + ' 張圖片';
    $('picked-meta').textContent = Kit.fmtBytes(total);
    $('picked').hidden = false; $('drop').hidden = true;
    $('btn-start').disabled = false;
    showPreview(0);
  }

  function clearResults() {
    state.results.forEach(function (r) { URL.revokeObjectURL(r.url); });
    state.results = [];
    $('rows').innerHTML = ''; $('rows').hidden = true; $('btn-zip').hidden = true; $('progress').hidden = true;
  }

  /* ── 處理 ── */
  function encode(canvas, mime, q) {
    return new Promise(function (res, rej) {
      canvas.toBlob(function (b) { b ? res(b) : rej(new Error('編碼失敗')); }, mime, mime === 'image/png' ? undefined : q);
    });
  }

  function addRow(r) {
    var li = document.createElement('li');
    li.className = 'row';
    var saved = r.inSize > 0 ? Math.round((1 - r.blob.size / r.inSize) * 100) : 0;
    var cls = saved >= 0 ? 'good' : 'warn';
    li.innerHTML = '<img class="thumb" alt="點擊放大" title="點擊放大" src="' + r.url + '">' +
      '<span><div class="r-name">' + Kit.escapeHtml(r.name) + '</div>' +
      '<div class="r-meta">' + r.from + ' → <b>' + r.to + '</b> · ' + Kit.fmtBytes(r.inSize) + ' → <b>' + Kit.fmtBytes(r.blob.size) + '</b> ' +
      '<span class="' + cls + '">' + (saved >= 0 ? '−' + saved : '+' + (-saved)) + '%</span></div></span>' +
      '<span class="r-state"><button type="button" class="btn btn-sm">下載</button></span>';
    li.querySelector('button').addEventListener('click', function () { Kit.download(r.blob, r.name); });
    li.querySelector('.thumb').addEventListener('click', function () {
      openViewer({ title: r.name, cap: r.to + ' · ' + Kit.fmtBytes(r.blob.size), url: r.url, onDownload: function () { Kit.download(r.blob, r.name); } });
    });
    $('rows').appendChild(li);
  }

  function addFailRow(file, msg) {
    var li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = '<span class="thumb">!</span><span><div class="r-name">' + Kit.escapeHtml(file.name) + '</div>' +
      '<div class="r-meta"><span class="warn">' + Kit.escapeHtml(msg) + '</span></div></span><span></span>';
    $('rows').appendChild(li);
  }

  function processOne(file, o) {
    return decode(file).then(function (bmp) {
      var mime = outMime(file, o), c = render(bmp, o, mime);
      var from = bmp.width + '×' + bmp.height, to = c.width + '×' + c.height;
      bmp.close();
      return encode(c, mime, o.quality).then(function (blob) {
        c.width = c.height = 0;
        return { blob: blob, url: URL.createObjectURL(blob), name: Kit.baseName(file.name) + '.' + EXT_OF_MIME[mime], from: from, to: to, inSize: file.size };
      });
    });
  }

  function setBusy(b) {
    state.busy = b;
    ['btn-start', 'btn-change', 'btn-zip', 'size', 'quality', 'wm-on', 'wm-text', 'wm-size', 'wm-alpha', 'wm-color'].forEach(function (id) { $(id).disabled = b; });
    Object.keys(ui).forEach(function (k) { ui[k].setDisabled(b); });
  }

  function run() {
    var o = readOpts();
    if (state.busy || !state.files.length) return;
    if (!o.valid) return Kit.showNote($('note-error'), '請輸入有效的尺寸數值。');
    clearResults(); Kit.hideNote($('note-error')); setBusy(true);
    $('progress').hidden = false; $('rows').hidden = false;
    var files = state.files.slice(), i = 0, fails = 0;
    function next() {
      if (i >= files.length) return Promise.resolve();
      var f = files[i];
      $('status-label').textContent = '處理第 ' + (i + 1) + ' / ' + files.length + ' 張';
      prog.set(i / files.length);
      return processOne(f, o).then(function (r) { state.results.push(r); addRow(r); }, function (err) { fails++; addFailRow(f, err.message); })
        .then(function () { i++; return next(); });
    }
    next().then(function () {
      prog.done();
      $('status-label').textContent = '完成 ' + state.results.length + ' 張' + (fails ? '，' + fails + ' 張失敗' : '');
      $('btn-zip').hidden = state.results.length < 2;
      if (state.results.length === 1 && files.length === 1) Kit.download(state.results[0].blob, state.results[0].name);
    }).then(function () { setBusy(false); });
  }

  function zipAll() {
    setBusy(true); $('status-label').textContent = '打包 ZIP…';
    Kit.loadScript(JSZIP)
      .then(function () { return Kit.downloadZip(state.results, '處理後圖片.zip', function (r) { prog.set(r); }); })
      .then(function () { $('status-label').textContent = '已下載 ZIP'; })
      .catch(function (err) { Kit.showNote($('note-error'), '打包失敗：' + err.message); })
      .then(function () { setBusy(false); });
  }

  /* ── 事件 ── */
  function onModeChange(m) {
    var isPct = m === 'percent';
    $('size-unit').textContent = isPct ? '%' : 'px';
    $('size').value = isPct ? 50 : 1600;
    schedulePreview();
  }
  function onFmtChange(f) { $('quality-row').hidden = f === 'png'; schedulePreview(); }

  Kit.dropzone($('drop'), $('file-input'), pickFiles);
  $('btn-change').addEventListener('click', function () { if (!state.busy) $('file-input').click(); });
  $('btn-start').addEventListener('click', run);
  $('btn-zip').addEventListener('click', zipAll);
  $('size').addEventListener('input', schedulePreview);
  $('quality').addEventListener('input', function () { $('quality-val').textContent = $('quality').value; });
  $('wm-on').addEventListener('change', function () { $('wm-opts').hidden = !$('wm-on').checked; schedulePreview(); });
  $('wm-text').addEventListener('input', schedulePreview);
  $('wm-size').addEventListener('input', function () { $('wm-size-val').textContent = $('wm-size').value + '%'; schedulePreview(); });
  $('wm-alpha').addEventListener('input', function () { $('wm-alpha-val').textContent = $('wm-alpha').value + '%'; schedulePreview(); });
  $('wm-color').addEventListener('input', function () { ui.swatch.set($('wm-color').value); schedulePreview(); });
  $('prev').addEventListener('click', function () { showPreview(state.previewIdx - 1); });
  $('next').addEventListener('click', function () { showPreview(state.previewIdx + 1); });
  $('stage').addEventListener('click', zoomPreview);
  $('btn-zoom').addEventListener('click', zoomPreview);

  window.__imageResize = { state: state, pickFiles: pickFiles, run: run, readOpts: readOpts };
})();
