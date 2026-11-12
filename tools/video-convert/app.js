/* 影片轉 MP4／壓縮 */
(function () {
  'use strict';

  var $ = Kit.$;
  var CRF = { high: 18, balanced: 23, small: 28 };
  var LONG_SEC = 300;
  var u = AV.ui();
  var els = {
    input: $('file-input'), card: $('file-card'), name: $('file-name'), meta: $('file-meta'), change: $('btn-change'),
    settings: $('settings'), remuxRow: $('remux-row'), remux: $('remux'), long: $('note-long'),
    actions: $('actions'), start: $('btn-start'),
    result: $('result'), before: $('r-before'), after: $('r-after'), diff: $('r-diff'), time: $('r-time'),
    rName: $('r-name'), rDownload: $('r-download'), rVideo: $('r-video')
  };
  var state = { file: null, info: null, path: null, busy: false, url: null };
  var q = AV.chips($('q'), refresh), res = AV.chips($('res'), refresh), audio = AV.chips($('audio'), refresh);

  function codecLabel(info) {
    var v = info.video, a = info.audio;
    return [v ? v.width + '×' + v.height : null, v ? v.codec : null, a ? a.codec : '無音訊'].filter(Boolean).join(' · ');
  }

  /** 來源編碼本身可直接放進 MP4（與目前選項無關） */
  function remuxCompatible() {
    var i = state.info;
    if (!i || !i.video || i.video.codec !== 'h264') return false;
    return audio.get() === 'drop' || !i.audio || i.audio.codec === 'aac';
  }

  function canRemux() { return remuxCompatible() && q.get() === 'high' && res.get() === '0'; }

  function useRemux() { return canRemux() && els.remux.checked; }

  function refresh() {
    var i = state.info;
    if (!i) return;
    var short = i.video ? Math.min(i.video.width, i.video.height) : 0;
    res.buttons.forEach(function (b) {
      var t = +b.dataset.v;
      b.disabled = t > 0 && short > 0 && short <= t;
      b.title = b.disabled ? '來源已小於或等於 ' + t + 'p' : '';
    });
    if (res.buttons.some(function (b) { return b.disabled && b.getAttribute('aria-pressed') === 'true'; })) res.set('0');
    els.remuxRow.hidden = !canRemux();
    var slow = i.duration > LONG_SEC && !useRemux();
    els.long.hidden = !slow;
    if (slow) {
      els.long.textContent = '這支影片長 ' + Kit.fmtDur(i.duration) + '，重新編碼在瀏覽器裡較慢，可能需要數分鐘到十幾分鐘。' +
        (remuxCompatible() ? '只要換格式的話，選「高畫質＋原始」可以秒轉。' : '');
    }
    els.start.textContent = useRemux() ? '開始轉檔（快速）' : '開始轉檔';
  }
  els.remux.addEventListener('change', refresh);

  function buildArgs() {
    var i = state.info, args = ['-i', state.path, '-map', '0:v:0', '-map', '0:a:0?'];
    var dropAudio = audio.get() === 'drop';
    if (useRemux()) {
      args.push('-c', 'copy');
    } else {
      var size = AV.fitShortSide(i.video.width, i.video.height, +res.get());
      args.push('-vf', 'scale=' + size.w + ':' + size.h, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', String(CRF[q.get()]), '-pix_fmt', 'yuv420p');
      if (!dropAudio && i.audio) args.push.apply(args, i.audio.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']);
    }
    if (dropAudio) args.push('-an');
    args.push('-movflags', '+faststart', '-y', 'out.mp4');
    return args;
  }

  function outName() {
    var f = state.file;
    return Kit.baseName(f.name) + (Kit.extOf(f.name) === 'mp4' ? '_converted' : '') + '.mp4';
  }

  function setBusy(on) {
    state.busy = on;
    u.busy(on, [els.start, els.change, els.remux].concat(q.buttons, res.buttons, audio.buttons));
    if (!on) refresh();
  }

  function resetResult() {
    els.result.hidden = true;
    if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
    els.rVideo.removeAttribute('src');
  }

  function pick(files) {
    var file = files[0];
    if (!file || state.busy) return;
    u.clearError(); resetResult();
    state.file = file; state.info = null;
    els.card.hidden = false; els.settings.hidden = true; els.actions.hidden = true; els.long.hidden = true;
    els.name.textContent = file.name;
    els.meta.textContent = Kit.fmtBytes(file.size) + ' · 讀取中…';
    setBusy(true);
    AV.engine(u)
      .then(function () { u.status('讀取影片資訊'); u.prog.busy(); return FFKit.mount(file); })
      .then(function (p) { state.path = p; return AV.probe(p); })
      .then(function (info) {
        if (state.file !== file) return;
        if (!info.video) throw new Error('找不到影片軌，這個檔案可能不是影片，或格式不受支援。');
        state.info = info;
        els.meta.textContent = Kit.fmtBytes(file.size) + ' · ' + Kit.fmtDur(info.duration) + ' · ' + codecLabel(info);
        els.settings.hidden = false; els.actions.hidden = false;
        $('progress').hidden = true;
      })
      .catch(function (err) {
        els.card.hidden = true; state.file = null;
        $('progress').hidden = true;
        u.error(err);
      })
      .then(function () { setBusy(false); });
  }

  function start() {
    if (!state.info || state.busy) return;
    u.clearError(); resetResult();
    setBusy(true);
    var t0 = Date.now(), remux = useRemux();
    u.status(remux ? '換容器中' : '轉檔中（重新編碼）');
    u.prog.set(0);
    FFKit.run(buildArgs(), state.info.duration, function (r) { u.prog.set(r); })
      .then(function () { return FFKit.read('out.mp4', 'video/mp4'); })
      .then(function (blob) { showResult(blob, (Date.now() - t0) / 1000); u.prog.done(); u.status('完成'); })
      .catch(function (err) { u.status('轉檔失敗', true); u.error(err); })
      .then(function () { setBusy(false); });
  }

  function showResult(blob, secs) {
    var before = state.file.size, after = blob.size, pct = Math.round((after - before) / before * 100);
    state.url = URL.createObjectURL(blob);
    els.before.textContent = Kit.fmtBytes(before);
    els.after.textContent = Kit.fmtBytes(after);
    els.diff.textContent = (pct > 0 ? '+' : '') + pct + '%';
    els.diff.className = 'v ' + (pct <= 0 ? 'is-down' : 'is-up');
    els.time.textContent = secs < 60 ? secs.toFixed(1) + ' 秒' : Kit.fmtDur(secs);
    els.rName.textContent = outName();
    els.rDownload.href = state.url; els.rDownload.download = outName();
    els.rVideo.src = state.url;
    els.result.hidden = false;
    state.lastBlob = blob;
  }

  Kit.dropzone(u.els.drop, els.input, pick);
  els.change.addEventListener('click', function () { if (!state.busy) els.input.click(); });
  els.start.addEventListener('click', start);

  window.__tool = { pick: pick, start: start, state: state };
})();
