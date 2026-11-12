/* HEIC 轉 JPG／PNG：heic2any（libheif 的 WebAssembly 版）逐張解碼，一個 HEIC 內含多張時全部輸出。 */
(function () {
  'use strict';

  var $ = Kit.$;
  var HEIC2ANY = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
  var JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  var MIME = { jpg: 'image/jpeg', png: 'image/png' };

  function chipGroup(el, onChange) {
    var get = function () { var b = el.querySelector('[aria-pressed="true"]'); return b ? b.dataset.v : null; };
    el.addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b || b.disabled) return;
      el.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c === b)); });
      if (onChange) onChange(get());
    });
    return { get: get, setDisabled: function (d) { el.querySelectorAll('.chip').forEach(function (c) { c.disabled = d; }); } };
  }

  var state = { files: [], results: [], busy: false };
  var prog = Kit.progress($('bar'), $('status-pct'));
  var fmt = chipGroup($('fmt'), function (v) { $('quality-row').hidden = v === 'png'; });

  function isHeic(f) { return /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/i.test(f.type); }

  function pickFiles(files) {
    if (state.busy) return;
    clearResults(); Kit.hideNote($('note-error'));
    var skipped = files.filter(function (f) { return !isHeic(f); }).map(function (f) { return f.name; });
    state.files = files.filter(isHeic);
    if (skipped.length) Kit.showNote($('note-error'), '已略過非 HEIC 檔案：' + skipped.join('、'));
    if (!state.files.length) return;
    var total = state.files.reduce(function (a, f) { return a + f.size; }, 0);
    $('picked-name').textContent = state.files.length === 1 ? state.files[0].name : state.files.length + ' 張照片';
    $('picked-meta').textContent = Kit.fmtBytes(total);
    $('picked').hidden = false; $('drop').hidden = true; $('btn-start').disabled = false;
    Kit.loadScript(HEIC2ANY).catch(function () {}); // 先在背景載入轉檔程式（約 1.3 MB）
  }

  function clearResults() {
    state.results.forEach(function (r) { URL.revokeObjectURL(r.url); });
    state.results = [];
    $('rows').innerHTML = ''; $('rows').hidden = true; $('btn-zip').hidden = true; $('progress').hidden = true;
  }

  function addRow(r) {
    var li = document.createElement('li'); li.className = 'row';
    li.innerHTML = '<img class="thumb zoomable" title="點擊放大" alt="" src="' + r.url + '">' +
      '<span><div class="r-name">' + Kit.escapeHtml(r.name) + '</div><div class="r-meta">' + Kit.fmtBytes(r.inSize) + ' → <b>' + Kit.fmtBytes(r.blob.size) + '</b>' + (r.dims ? ' · ' + r.dims : '') + '</div></span>' +
      '<span class="r-state"><button type="button" class="btn btn-sm">下載</button></span>';
    li.querySelector('button').addEventListener('click', function () { Kit.download(r.blob, r.name); });
    $('rows').appendChild(li);
    var img = li.querySelector('img');
    img.addEventListener('click', function () {
      Kit.viewer.open({ title: r.name, cap: (r.dims ? r.dims + ' · ' : '') + Kit.fmtBytes(r.blob.size), url: r.url, onDownload: function () { Kit.download(r.blob, r.name); } });
    });
    img.addEventListener('load', function () { r.dims = img.naturalWidth + '×' + img.naturalHeight; li.querySelector('.r-meta').insertAdjacentText('beforeend', ' · ' + r.dims); }, { once: true });
  }

  function addFailRow(file, msg) {
    var li = document.createElement('li'); li.className = 'row';
    li.innerHTML = '<span class="thumb">!</span><span><div class="r-name">' + Kit.escapeHtml(file.name) + '</div><div class="r-meta"><span class="warn">' + Kit.escapeHtml(msg) + '</span></div></span><span></span>';
    $('rows').appendChild(li);
  }

  function friendly(err) {
    var m = err && (err.message || err.toString && err.toString()) || '';
    if (/ERR_USER|not supported|format/i.test(m)) return '這不是有效的 HEIC 檔，或格式不支援';
    return '轉檔失敗' + (m ? '：' + m : '');
  }

  function convertOne(file, type, quality) {
    return heic2any({ blob: file, toType: MIME[type], quality: quality, multiple: true }).then(function (out) {
      var list = Array.isArray(out) ? out : [out], base = Kit.baseName(file.name);
      return list.map(function (blob, i) {
        var name = base + (list.length > 1 ? '_' + (i + 1) : '') + '.' + type;
        return { blob: blob, name: name, url: URL.createObjectURL(blob), inSize: list.length > 1 ? file.size / list.length : file.size };
      });
    });
  }

  function setBusy(b) {
    state.busy = b;
    ['btn-start', 'btn-change', 'btn-zip', 'quality'].forEach(function (id) { $(id).disabled = b; });
    fmt.setDisabled(b);
  }

  function run() {
    if (state.busy || !state.files.length) return;
    clearResults(); Kit.hideNote($('note-error')); setBusy(true);
    $('progress').hidden = false; $('rows').hidden = false;
    var files = state.files.slice(), type = fmt.get(), q = +$('quality').value / 100, i = 0, fails = 0;
    $('status-label').textContent = '載入轉檔程式…'; prog.busy();
    function next() {
      if (i >= files.length) return Promise.resolve();
      var f = files[i];
      $('status-label').textContent = '轉換第 ' + (i + 1) + ' / ' + files.length + ' 張';
      prog.set(i / files.length);
      return convertOne(f, type, q).then(function (rs) { rs.forEach(function (r) { state.results.push(r); addRow(r); }); },
        function (err) { fails++; addFailRow(f, friendly(err)); })
        .then(function () { i++; return next(); });
    }
    Kit.loadScript(HEIC2ANY).then(next).then(function () {
      prog.done();
      $('status-label').textContent = '完成 ' + state.results.length + ' 張' + (fails ? '，' + fails + ' 張失敗' : '');
      $('btn-zip').hidden = state.results.length < 2;
      if (state.results.length === 1) Kit.download(state.results[0].blob, state.results[0].name);
    }).catch(function (err) {
      $('status-label').textContent = '轉檔失敗';
      Kit.showNote($('note-error'), err.message);
    }).then(function () { setBusy(false); });
  }

  function zipAll() {
    setBusy(true); $('status-label').textContent = '打包 ZIP…';
    Kit.loadScript(JSZIP)
      .then(function () { return Kit.downloadZip(state.results, 'HEIC轉檔.zip', function (r) { prog.set(r); }); })
      .then(function () { $('status-label').textContent = '已下載 ZIP'; })
      .catch(function (err) { Kit.showNote($('note-error'), '打包失敗：' + err.message); })
      .then(function () { setBusy(false); });
  }

  Kit.dropzone($('drop'), $('file-input'), pickFiles);
  $('btn-change').addEventListener('click', function () { if (!state.busy) $('file-input').click(); });
  $('btn-start').addEventListener('click', run);
  $('btn-zip').addEventListener('click', zipAll);
  $('quality').addEventListener('input', function () { $('quality-val').textContent = $('quality').value; });

  window.__heic = { state: state, pickFiles: pickFiles, run: run };
})();
