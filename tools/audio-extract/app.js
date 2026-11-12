/* 抽出音訊：批次輸出 MP3 或 M4A */
(function () {
  'use strict';

  var $ = Kit.$;
  var u = AV.ui();
  var els = { input: $('file-input'), actions: $('actions'), go: $('btn-start'), clear: $('btn-clear'), zip: $('btn-zip'), rows: $('rows') };
  var state = { items: [], busy: false };
  var fmt = AV.chips($('fmt')), kbps = AV.chips($('kbps'));
  var NOTE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  var OK_ICON = '<span class="ok" aria-label="完成"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L19 7"/></svg></span>';

  function outName(item, ext) { return Kit.baseName(item.file.name) + '.' + ext; }

  function render() {
    els.rows.hidden = !state.items.length;
    els.actions.hidden = !state.items.length;
    els.rows.innerHTML = state.items.map(function (it, i) {
      return '<li class="row" id="row-' + i + '">' +
        '<span class="thumb">' + NOTE_ICON + '</span>' +
        '<span><div class="r-name">' + Kit.escapeHtml(it.file.name) + '</div><div class="r-meta">' + rowMeta(it) + '</div></span>' +
        '<span class="r-state">' + rowState(it, i) + '</span></li>';
    }).join('');
    var done = state.items.filter(function (it) { return it.blob; });
    els.zip.hidden = done.length < 2;
  }

  function rowMeta(it) {
    var s = Kit.fmtBytes(it.file.size);
    if (it.info && it.info.duration > 0) s += ' · ' + Kit.fmtDur(it.info.duration);
    if (it.blob) s += ' → <b>' + Kit.fmtBytes(it.blob.size) + '</b>' + (it.copied ? ' · 直接複製音軌' : '');
    if (it.error) s += ' · <span class="r-err">' + Kit.escapeHtml(it.error) + '</span>';
    return s;
  }

  function rowState(it, i) {
    if (it.status === 'work') return '<span class="spin" aria-hidden="true"></span>處理中';
    if (it.blob) return OK_ICON + '<a class="btn btn-sm" href="' + it.url + '" download="' + Kit.escapeHtml(it.outName) + '">下載</a>';
    if (it.error) return '失敗';
    return '等待中';
  }

  function add(files) {
    if (state.busy) return;
    u.clearError();
    files.forEach(function (f) { state.items.push({ file: f, status: 'wait' }); });
    render();
  }

  function clearAll() {
    if (state.busy) return;
    state.items.forEach(function (it) { if (it.url) URL.revokeObjectURL(it.url); });
    state.items = [];
    $('progress').hidden = true;
    u.clearError();
    render();
  }

  function argsFor(it, path) {
    var k = kbps.get() + 'k', base = ['-i', path, '-vn', '-map', '0:a:0'];
    if (fmt.get() === 'mp3') return { args: base.concat(['-c:a', 'libmp3lame', '-b:a', k, '-y', 'out.mp3']), out: 'out.mp3', ext: 'mp3', mime: 'audio/mpeg', copied: false };
    var copy = it.info.audio.codec === 'aac';
    var codec = copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', k];
    return { args: base.concat(codec, ['-movflags', '+faststart', '-y', 'out.m4a']), out: 'out.m4a', ext: 'm4a', mime: 'audio/mp4', copied: copy };
  }

  function processOne(it, i, n) {
    it.status = 'work'; it.error = null; render();
    u.status('處理第 ' + (i + 1) + ' / ' + n + ' 個');
    return FFKit.mount(it.file)
      .then(function (path) {
        return AV.probe(path).then(function (info) {
          it.info = info;
          if (!info.audio && !info.video) throw new Error('無法讀取，可能不是影音檔或檔案已損毀');
          if (!info.audio) throw new Error('這個檔案沒有音訊軌');
          var job = argsFor(it, path);
          return FFKit.run(job.args, info.duration, function (r) { u.prog.set((i + r) / n); })
            .then(function () { return FFKit.read(job.out, job.mime); })
            .then(function (blob) {
              it.blob = blob; it.copied = job.copied; it.outName = outName(it, job.ext);
              it.url = URL.createObjectURL(blob);
            });
        });
      })
      .catch(function (err) { it.error = err && err.message ? err.message : String(err); })
      .then(function () { it.status = 'done'; render(); });
  }

  function setBusy(on) {
    state.busy = on;
    u.busy(on, [els.go, els.clear, els.zip].concat(fmt.buttons, kbps.buttons));
  }

  function go() {
    if (state.busy || !state.items.length) return;
    u.clearError(); setBusy(true);
    state.items.forEach(function (it) { if (it.url) URL.revokeObjectURL(it.url); it.blob = null; it.url = null; it.error = null; it.status = 'wait'; });
    render();
    var n = state.items.length;
    AV.engine(u)
      .then(function () {
        u.prog.set(0);
        return state.items.reduce(function (p, it, i) { return p.then(function () { return processOne(it, i, n); }); }, Promise.resolve());
      })
      .then(function () {
        var ok = state.items.filter(function (it) { return it.blob; }).length;
        u.prog.done();
        u.status('完成：成功 ' + ok + ' 個' + (ok < n ? '，失敗 ' + (n - ok) + ' 個' : ''), ok < n);
      })
      .catch(function (err) { u.status('處理失敗', true); u.error(err); })
      .then(function () { return FFKit.unmount(); })
      .then(function () { setBusy(false); render(); });
  }

  function zipAll() {
    var files = state.items.filter(function (it) { return it.blob; }).map(function (it) { return { name: it.outName, blob: it.blob }; });
    setBusy(true);
    u.status('打包 ZIP 中'); u.prog.set(0);
    Kit.downloadZip(files, '音訊.zip', function (r) { u.prog.set(r); })
      .then(function () { u.status('ZIP 已下載'); })
      .catch(function (err) { u.error(err); })
      .then(function () { setBusy(false); });
  }

  Kit.dropzone(u.els.drop, els.input, add);
  els.go.addEventListener('click', go);
  els.clear.addEventListener('click', clearAll);
  els.zip.addEventListener('click', zipAll);

  window.__tool = { add: add, start: go, state: state };
})();
