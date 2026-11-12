/*
 * 影音工具共用：window.AV（依賴 Kit、FFKit）
 *   AV.probe(path) -> {duration, video:{codec,width,height,fps}|null, audio:{codec}|null}
 *   AV.engine(ui) -> Promise   載入 ffmpeg 並在進度列顯示
 *   AV.even(n)                 取最接近的偶數（x264 需要）
 *   AV.fitShortSide(w,h,target) -> {w,h}  短邊縮到 target（不放大），寬高為偶數
 *   AV.ui() -> 取得頁面共通元素並提供 status/error/busy 操作
 */
(function (root) {
  'use strict';

  function parseProbe(text) {
    var out = { duration: NaN, video: null, audio: null };
    var d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
    if (d) out.duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
    var v = /Stream #\d+:\d+[^\n]*?: Video: (\w+)[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*/.exec(text);
    if (v) {
      var fps = /([\d.]+) fps/.exec(v[0]);
      out.video = { codec: v[1], width: +v[2], height: +v[3], fps: fps ? parseFloat(fps[1]) : NaN };
      var rot = /rotation of (-?[\d.]+)/.exec(text);
      if (rot && Math.abs(Math.round(parseFloat(rot[1]))) % 180 === 90) {
        var w = out.video.width; out.video.width = out.video.height; out.video.height = w;
      }
    }
    var a = /Stream #\d+:\d+[^\n]*?: Audio: (\w+)/.exec(text);
    if (a) out.audio = { codec: a[1] };
    return out;
  }

  function probe(path) {
    var ff = FFKit.instance, lines = [];
    var h = function (e) { lines.push(e.message); };
    ff.on('log', h);
    // 只給 -i 不給輸出，ffmpeg 會印出串流資訊後以非 0 結束，屬正常
    return ff.exec(['-hide_banner', '-i', path]).catch(function () {}).then(function () {
      ff.off('log', h);
      return parseProbe(lines.join('\n'));
    });
  }

  function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

  function fitShortSide(w, h, target) {
    var short = Math.min(w, h);
    if (!target || short <= target) return { w: even(w), h: even(h) };
    var f = target / short;
    return { w: even(w * f), h: even(h * f) };
  }

  function ui() {
    var $ = Kit.$;
    var els = {
      drop: $('drop'), error: $('note-error'), progress: $('progress'),
      label: $('status-label'), bar: $('bar'), pct: $('status-pct')
    };
    var prog = Kit.progress(els.bar, els.pct);
    return {
      els: els, prog: prog,
      status: function (text, isError) {
        els.progress.hidden = false;
        els.label.textContent = text;
        els.label.classList.toggle('is-error', !!isError);
      },
      error: function (err) {
        var msg = typeof err === 'string' ? err : (err && err.message) || String(err);
        if (err && err.log) msg += '\n\n' + err.log;
        Kit.showNote(els.error, msg);
      },
      clearError: function () { Kit.hideNote(els.error); },
      busy: function (on, controls) {
        els.drop.classList.toggle('is-disabled', on);
        (controls || []).forEach(function (c) { c.disabled = on; });
      }
    };
  }

  function engine(u) {
    if (FFKit.instance) return Promise.resolve(FFKit.instance);
    u.status('載入處理引擎（約 32 MB，只需一次）');
    u.prog.busy();
    return FFKit.load(function (r) { u.prog.set(r); });
  }

  /** 綁定一組 chip（aria-pressed），回傳 { get(), set(v), disable(fn) } */
  function chips(container, onChange) {
    var btns = Array.prototype.slice.call(container.querySelectorAll('.chip'));
    var api = {
      get: function () { var b = btns.filter(function (x) { return x.getAttribute('aria-pressed') === 'true'; })[0]; return b ? b.dataset.v : null; },
      set: function (v) { btns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === String(v))); }); },
      buttons: btns
    };
    container.addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b || b.disabled) return;
      api.set(b.dataset.v); if (onChange) onChange(b.dataset.v);
    });
    return api;
  }

  root.AV = { probe: probe, parseProbe: parseProbe, even: even, fitShortSide: fitShortSide, ui: ui, engine: engine, chips: chips };
})(self);
