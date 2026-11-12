/* 影片轉 GIF／WebP 動圖 */
(function () {
  'use strict';

  var $ = Kit.$;
  var MAX_LEN = 30;
  var u = AV.ui();
  var els = {
    input: $('file-input'), card: $('file-card'), name: $('file-name'), meta: $('file-meta'), change: $('btn-change'),
    video: $('src-video'), settings: $('settings'), hint: $('range-hint'), here: $('btn-here'),
    start: $('start'), len: $('len'), actions: $('actions'), go: $('btn-start'), est: $('est'),
    result: $('result'), img: $('r-img'), rMeta: $('r-meta'), rDownload: $('r-download')
  };
  var state = { file: null, info: null, path: null, busy: false, srcUrl: null, outUrl: null, lastBlob: null };
  var width = AV.chips($('width'), refresh), fps = AV.chips($('fps'), refresh), fmt = AV.chips($('fmt'), refresh);

  function num(el, fallback) { var v = parseFloat(el.value); return Number.isFinite(v) ? v : fallback; }

  /** 讀取並修正開始時間與長度，回傳 {start, len} */
  function range() {
    var dur = state.info ? state.info.duration : 0;
    var start = Math.max(0, Math.min(num(els.start, 0), Math.max(0, dur - 0.1)));
    var len = Math.max(0.5, Math.min(num(els.len, 5), MAX_LEN, dur - start));
    return { start: Math.round(start * 100) / 100, len: Math.round(len * 100) / 100 };
  }

  function outSize() {
    var v = state.info.video, w = +width.get();
    if (!w || w >= v.width) return { w: v.width, h: v.height };
    return { w: w, h: Math.round(v.height * w / v.width) };
  }

  function refresh() {
    if (!state.info) return;
    var r = range(), s = outSize(), v = state.info.video;
    width.buttons.forEach(function (b) { var w = +b.dataset.v; b.disabled = w > 0 && w >= v.width; });
    if (width.buttons.some(function (b) { return b.disabled && b.getAttribute('aria-pressed') === 'true'; })) width.set('0');
    els.est.textContent = '輸出 ' + s.w + '×' + s.h + ' · ' + r.len + ' 秒 · 約 ' + Math.round(r.len * +fps.get()) + ' 張畫格';
  }
  [els.start, els.len].forEach(function (el) {
    el.addEventListener('input', refresh);
    el.addEventListener('change', function () { var r = range(); els.start.value = r.start; els.len.value = r.len; refresh(); });
  });
  els.here.addEventListener('click', function () { els.start.value = Math.round(els.video.currentTime * 10) / 10; els.start.dispatchEvent(new Event('change')); });

  function buildArgs(r) {
    var w = +width.get(), scale = w && w < state.info.video.width ? ',scale=' + w + ':-1:flags=lanczos' : '';
    var base = ['-ss', String(r.start), '-t', String(r.len), '-i', state.path];
    if (fmt.get() === 'webp') {
      return base.concat(['-vf', 'fps=' + fps.get() + scale, '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', '75', '-loop', '0', '-an', '-y', 'out.webp']);
    }
    var graph = 'fps=' + fps.get() + scale + ',split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
    return base.concat(['-vf', graph, '-loop', '0', '-an', '-y', 'out.gif']);
  }

  function setBusy(on) {
    state.busy = on;
    u.busy(on, [els.go, els.change, els.here, els.start, els.len].concat(width.buttons, fps.buttons, fmt.buttons));
    if (!on) refresh();
  }

  function clearOut() {
    els.result.hidden = true;
    if (state.outUrl) { URL.revokeObjectURL(state.outUrl); state.outUrl = null; }
  }

  function pick(files) {
    var file = files[0];
    if (!file || state.busy) return;
    u.clearError(); clearOut();
    if (state.srcUrl) URL.revokeObjectURL(state.srcUrl);
    state.file = file; state.info = null;
    state.srcUrl = URL.createObjectURL(file);
    els.video.src = state.srcUrl;
    els.card.hidden = false; els.settings.hidden = true; els.actions.hidden = true;
    els.name.textContent = file.name;
    els.meta.textContent = Kit.fmtBytes(file.size) + ' · 讀取中…';
    els.start.value = 0; els.len.value = 5;
    setBusy(true);
    AV.engine(u)
      .then(function () { u.status('讀取影片資訊'); u.prog.busy(); return FFKit.mount(file); })
      .then(function (p) { state.path = p; return AV.probe(p); })
      .then(function (info) {
        if (state.file !== file) return;
        if (!info.video || !(info.duration > 0)) throw new Error('找不到影片軌，這個檔案可能不是影片，或格式不受支援。');
        state.info = info;
        els.meta.textContent = Kit.fmtBytes(file.size) + ' · ' + Kit.fmtDur(info.duration) + ' · ' + info.video.width + '×' + info.video.height;
        els.hint.textContent = '影片長 ' + Kit.fmtDur(info.duration);
        els.settings.hidden = false; els.actions.hidden = false;
        $('progress').hidden = true;
      })
      .catch(function (err) { els.card.hidden = true; state.file = null; $('progress').hidden = true; u.error(err); })
      .then(function () { setBusy(false); });
  }

  function go() {
    if (!state.info || state.busy) return;
    var r = range(), isWebp = fmt.get() === 'webp', out = isWebp ? 'out.webp' : 'out.gif';
    els.start.value = r.start; els.len.value = r.len;
    u.clearError(); clearOut(); setBusy(true);
    els.video.pause();
    var t0 = Date.now();
    u.status('產生' + (isWebp ? ' WebP' : ' GIF') + ' 中'); u.prog.set(0);
    FFKit.run(buildArgs(r), r.len, function (x) { u.prog.set(x); })
      .then(function () { return FFKit.read(out, isWebp ? 'image/webp' : 'image/gif'); })
      .then(function (blob) { show(blob, r, isWebp, (Date.now() - t0) / 1000); u.prog.done(); u.status('完成'); })
      .catch(function (err) { u.status('產生失敗', true); u.error(err); })
      .then(function () { setBusy(false); });
  }

  function show(blob, r, isWebp, secs) {
    var s = outSize(), name = Kit.baseName(state.file.name) + '_' + r.start + 's' + (isWebp ? '.webp' : '.gif');
    state.lastBlob = blob;
    state.outUrl = URL.createObjectURL(blob);
    els.img.src = state.outUrl;
    els.rMeta.textContent = s.w + '×' + s.h + ' · ' + r.len + ' 秒 · ' + Kit.fmtBytes(blob.size) + ' · 耗時 ' + secs.toFixed(1) + ' 秒';
    els.rDownload.href = state.outUrl; els.rDownload.download = name;
    els.rDownload.textContent = '下載 ' + (isWebp ? 'WebP' : 'GIF');
    els.result.hidden = false;
  }

  Kit.dropzone(u.els.drop, els.input, pick);
  els.change.addEventListener('click', function () { if (!state.busy) els.input.click(); });
  els.go.addEventListener('click', go);

  window.__tool = { pick: pick, start: go, state: state };
})();
