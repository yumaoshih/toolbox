/* 移除照片 EXIF：exifr 列出找到的資訊 → MetaStrip 無損移除 → exifr 再驗證一次 */
(function () {
  'use strict';

  var $ = Kit.$;
  var EXIFR = 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.umd.js';
  var JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  var PARSE_OPTS = { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, jfif: false, ihdr: false, mergeOutput: true, translateValues: true, reviveValues: true };
  var HEIC_LINK = '../heic-convert/';

  var state = { items: [], busy: false };
  var prog = Kit.progress($('bar'), $('status-pct'));

  /* ── 從 exifr 結果整理出要顯示的標籤 ── */
  function fmtDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return String(d);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function describe(meta) {
    if (!meta) return [];
    var tags = [];
    if (Number.isFinite(meta.latitude) && Number.isFinite(meta.longitude)) {
      tags.push({ gps: true, text: 'GPS 位置 ' + meta.latitude.toFixed(5) + ', ' + meta.longitude.toFixed(5) });
    }
    var cam = [meta.Make, meta.Model].filter(Boolean).join(' ');
    if (cam) tags.push({ text: '相機 ' + cam });
    if (meta.LensModel) tags.push({ text: '鏡頭 ' + meta.LensModel });
    var when = meta.DateTimeOriginal || meta.CreateDate || meta.DateTime || meta.ModifyDate;
    if (when) tags.push({ text: '拍攝時間 ' + fmtDate(when) });
    if (meta.Software) tags.push({ text: '軟體 ' + meta.Software });
    var who = meta.Artist || meta.creator || meta.Creator || meta.Byline;
    if (who) tags.push({ text: '作者 ' + (Array.isArray(who) ? who.join('、') : who) });
    if (meta.Copyright || meta.rights) tags.push({ text: '版權資訊' });
    if (meta.ImageDescription || meta.description) tags.push({ text: '描述文字' });
    return tags;
  }

  function hasNonOrientation(meta) {
    return !!meta && Object.keys(meta).some(function (k) { return k !== 'Orientation'; });
  }

  /* ── 列表 ── */
  function tagHtml(t) {
    return '<span class="tag' + (t.gps ? ' is-gps' : '') + '">' + Kit.escapeHtml(t.text) + '</span>';
  }

  function renderRow(it) {
    var tags = it.heic
      ? '<span class="tag">HEIC 請改用 <a class="inline" href="' + HEIC_LINK + '">HEIC 轉 JPG</a>，轉檔時會一併移除這些資訊</span>'
      : it.error ? '<span class="tag is-gps">' + Kit.escapeHtml(it.error) + '</span>'
      : it.result ? '<span class="tag is-done">已清除' + (it.result.removed.length ? '：' + Kit.escapeHtml(it.result.removed.join('、')) : '') + '</span>'
      : it.tags.length ? it.tags.map(tagHtml).join('')
      : it.removable ? '<span class="tag">含其他中繼資料</span>'
      : '<span class="tag is-clean">沒有找到隱藏資訊</span>';
    var meta = Kit.fmtBytes(it.file.size) + (it.result ? ' → <b>' + Kit.fmtBytes(it.result.blob.size) + '</b>' : '');
    var right = it.result ? '<button type="button" class="btn btn-sm" data-dl="' + it.id + '">下載</button>'
      : it.busy ? '<span class="spin" aria-hidden="true"></span>' : '';
    it.el.innerHTML = (it.thumb ? '<img class="thumb" alt="" src="' + it.thumb + '">' : '<span class="thumb">' + Kit.escapeHtml((Kit.extOf(it.file.name) || '?').toUpperCase()) + '</span>') +
      '<span><div class="r-name">' + Kit.escapeHtml(it.file.name) + '</div><div class="r-meta">' + meta + '</div><div class="tags">' + tags + '</div></span>' +
      '<span class="r-state">' + right + '</span>';
  }

  function renderStats() {
    var list = state.items;
    $('st-count').textContent = list.length;
    $('st-gps').textContent = list.filter(function (i) { return i.tags && i.tags.some(function (t) { return t.gps; }); }).length;
    $('st-meta').textContent = list.filter(function (i) { return i.removable; }).length;
    $('summary').hidden = !list.length;
    $('btn-start').disabled = state.busy || !list.some(function (i) { return i.removable && !i.result; });
  }

  /* exifr 不認得 WebP，PNG 也不一定讀得到 eXIf；改把 EXIF 本體（TIFF）直接交給它 */
  function parseMeta(u8, kind) {
    var src = kind === 'jpeg' ? u8 : MetaStrip.exifTiff(u8);
    if (!src) return Promise.resolve(null);
    return exifr.parse(src, PARSE_OPTS).catch(function () { return null; });
  }

  /* ── 讀檔與分析 ── */
  function analyse(it) {
    return it.file.arrayBuffer().then(function (buf) {
      it.bytes = new Uint8Array(buf);
      var kind = MetaStrip.detect(it.bytes);
      if (kind === 'heic') { it.heic = true; return; }
      if (!kind) { it.error = '不支援的格式（支援 JPG、PNG、WebP）'; return; }
      it.thumb = URL.createObjectURL(it.file);
      var probe = MetaStrip.strip(it.bytes);
      it.removable = probe.removed.length > 0;
      return parseMeta(it.bytes, kind).then(function (meta) {
        it.tags = describe(meta);
        if (it.tags.length) it.removable = true;
      });
    }).catch(function (err) { it.error = '讀取失敗：' + err.message; });
  }

  var seq = 0;
  function pickFiles(files) {
    if (state.busy) return;
    reset(); Kit.hideNote($('note-error'));
    $('drop').hidden = true; $('actions').hidden = false; $('rows').hidden = false;
    state.items = files.map(function (f) {
      var li = document.createElement('li'); li.className = 'row';
      $('rows').appendChild(li);
      return { id: ++seq, file: f, el: li, tags: [], busy: true };
    });
    state.items.forEach(renderRow);
    setBusy(true);
    Kit.loadScript(EXIFR).then(function () {
      return Promise.all(state.items.map(function (it) {
        return analyse(it).then(function () { it.busy = false; renderRow(it); });
      }));
    }).catch(function (err) { Kit.showNote($('note-error'), err.message); })
      .then(function () { setBusy(false); renderStats(); });
  }

  function reset() {
    state.items.forEach(function (it) { if (it.thumb) URL.revokeObjectURL(it.thumb); });
    state.items = [];
    $('rows').innerHTML = ''; $('btn-zip').hidden = true; $('progress').hidden = true; $('note-orient').hidden = true;
  }

  /* ── 移除 ── */
  function verify(u8, kind) {
    return parseMeta(u8, kind).then(function (meta) {
      if (hasNonOrientation(meta)) throw new Error('清除後仍偵測到資訊，請回報這張照片');
    });
  }

  var MINI_EXIF_MAX = 40; // 只含方向的最小 EXIF 區塊大小上限（bytes）

  function cleanOne(it) {
    var r = MetaStrip.strip(it.bytes);
    var again = MetaStrip.strip(r.bytes).bytes.length;
    if (r.bytes.length - again > (r.keptOrientation === 1 ? 0 : MINI_EXIF_MAX)) return Promise.reject(new Error('清除後仍有殘留資料，請回報這張照片'));
    var blob = new Blob([r.bytes], { type: it.file.type || 'application/octet-stream' });
    return verify(r.bytes, MetaStrip.detect(r.bytes)).then(function () {
      it.result = { blob: blob, removed: r.removed, keptOrientation: r.keptOrientation };
    });
  }

  function setBusy(b) {
    state.busy = b;
    $('btn-start').disabled = b; $('btn-change').disabled = b; $('btn-zip').disabled = b;
  }

  function run() {
    var todo = state.items.filter(function (i) { return i.removable && !i.result && !i.error; });
    if (state.busy || !todo.length) return;
    Kit.hideNote($('note-error')); setBusy(true); $('progress').hidden = false;
    var i = 0;
    function next() {
      if (i >= todo.length) return Promise.resolve();
      var it = todo[i];
      $('status-label').textContent = '清除第 ' + (i + 1) + ' / ' + todo.length + ' 張';
      prog.set(i / todo.length);
      it.busy = true; renderRow(it);
      return cleanOne(it).catch(function (err) { it.error = err.message; })
        .then(function () { it.busy = false; renderRow(it); i++; return next(); });
    }
    next().then(function () {
      prog.done();
      var done = state.items.filter(function (x) { return x.result; });
      $('status-label').textContent = '完成，已清除 ' + done.length + ' 張';
      $('btn-zip').hidden = done.length < 2;
      $('note-orient').hidden = !done.some(function (x) { return x.result.keptOrientation !== 1; });
      if (done.length === 1 && state.items.length === 1) Kit.download(done[0].result.blob, done[0].file.name);
    }).then(function () { setBusy(false); renderStats(); });
  }

  function zipAll() {
    var files = state.items.filter(function (x) { return x.result; }).map(function (x) { return { name: x.file.name, blob: x.result.blob }; });
    setBusy(true); $('status-label').textContent = '打包 ZIP…';
    Kit.loadScript(JSZIP)
      .then(function () { return Kit.downloadZip(files, '已清除資訊的照片.zip', function (r) { prog.set(r); }); })
      .then(function () { $('status-label').textContent = '已下載 ZIP'; })
      .catch(function (err) { Kit.showNote($('note-error'), '打包失敗：' + err.message); })
      .then(function () { setBusy(false); });
  }

  Kit.dropzone($('drop'), $('file-input'), pickFiles);
  $('btn-change').addEventListener('click', function () { if (!state.busy) $('file-input').click(); });
  $('btn-start').addEventListener('click', run);
  $('btn-zip').addEventListener('click', zipAll);
  $('rows').addEventListener('click', function (e) {
    var b = e.target.closest('[data-dl]'); if (!b) return;
    var it = state.items.filter(function (x) { return x.id === +b.dataset.dl; })[0];
    if (it && it.result) Kit.download(it.result.blob, it.file.name);
  });

  window.__exifStrip = { state: state, pickFiles: pickFiles, run: run };
})();
