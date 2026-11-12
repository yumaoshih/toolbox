/* CSV、Excel 互轉：SheetJS 讀寫，整理（修剪、空白列、去重、搜尋）後匯出 */
(function () {
  'use strict';

  var SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  var PREVIEW_ROWS = 500;
  var MAX_BYTES = 60e6;
  var TEXT_EXT = { csv: 1, tsv: 1, txt: 1 };
  var ENC_NAME = { 'utf-8': 'UTF-8', big5: 'Big5', gbk: 'GBK' };

  var $ = Kit.$;
  var els = {
    drop: $('drop'), input: $('file-input'), dropTitle: $('drop-title'), error: $('note-error'), loading: $('note-loading'),
    panel: $('panel'), name: $('file-name'), meta: $('file-meta'),
    sheetWrap: $('sheet-wrap'), sheet: $('sheet-select'), encWrap: $('enc-wrap'), enc: $('enc-select'),
    header: $('opt-header'), trim: $('opt-trim'), empty: $('opt-empty'), safe: $('opt-safe'),
    dedupeMode: $('dedupe-mode'), dedupeCols: $('dedupe-cols'), search: $('search'), searchCol: $('search-col'),
    summary: $('summary'), tableWrap: $('table-wrap'), table: $('table'), more: $('more'),
    exportBox: $('export'), exportLead: $('export-lead')
  };
  var state = { file: null, bytes: null, isText: false, encoding: 'utf-8', wb: null, aoa: [], dedupe: 'off', dedupeKeys: {}, result: null, timer: 0 };

  /* ── 編碼（與繁簡轉換相同的判斷：Big5 第二位元組常落在 0x40–0x7E） ── */
  function guessDoubleByte(bytes) {
    var pairs = 0, low = 0;
    for (var i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] >= 0x81 && bytes[i] <= 0xFE) { pairs++; if (bytes[i + 1] >= 0x40 && bytes[i + 1] <= 0x7E) low++; i++; }
    }
    return pairs && low / pairs > 0.05 ? 'big5' : 'gbk';
  }
  function decode(bytes, forced) {
    var order = forced ? [forced] : ['utf-8', guessDoubleByte(bytes)];
    for (var i = 0; i < order.length; i++) {
      try { return { text: new TextDecoder(order[i], { fatal: true }).decode(bytes), encoding: order[i] }; } catch (e) { /* 換下一種 */ }
    }
    var enc = order[order.length - 1];
    return { text: new TextDecoder(enc).decode(bytes), encoding: enc };
  }

  /* ── 讀檔 ── */
  function readWorkbook() {
    if (!state.isText) return XLSX.read(state.bytes, { type: 'array' });
    var r = decode(state.bytes, state.encoding === 'auto' ? null : state.encoding);
    state.encoding = r.encoding;
    var text = r.text.replace(/^﻿/, '');
    var firstLine = text.slice(0, text.indexOf('\n') + 1 || 2000);
    var isTsv = Kit.extOf(state.file.name) === 'tsv' || (firstLine.indexOf('\t') !== -1 && firstLine.indexOf(',') === -1);
    var opts = { type: 'string', raw: true };
    if (isTsv) opts.FS = '\t';
    return XLSX.read(text, opts);
  }

  function loadSheet() {
    var ws = state.wb.Sheets[els.sheet.value];
    var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, rawNumbers: true, defval: '', blankrows: true });
    var width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    state.aoa = rows.map(function (r) {
      var out = new Array(width);
      for (var i = 0; i < width; i++) out[i] = r[i] == null ? '' : String(r[i]);
      return out;
    });
    state.dedupeKeys = {};
    compute();
  }

  // 試算表檔頭：ZIP（xlsx、ods）、OLE（xls），或舊系統匯出的 HTML／XML 試算表
  function looksLikeSpreadsheet(bytes) {
    var b = bytes, i = 0;
    if (b[0] === 0x50 && b[1] === 0x4B) return true;
    if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) return true;
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) i = 3;
    while (i < b.length && i < 64 && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0A || b[i] === 0x0D)) i++;
    return b[i] === 0x3C;
  }

  function openFile(file) {
    Kit.hideNote(els.error);
    if (file.size > MAX_BYTES) { Kit.showNote(els.error, '檔案超過 60 MB，瀏覽器可能處理不動，請先拆小一點。'); return; }
    var ext = Kit.extOf(file.name);
    state.file = file; state.isText = !!TEXT_EXT[ext]; state.encoding = 'auto';
    file.arrayBuffer().then(function (buf) {
      state.bytes = new Uint8Array(buf);
      return ready;
    }).then(function () {
      if (!state.isText && !looksLikeSpreadsheet(state.bytes)) throw new Error('bad');
      state.wb = readWorkbook();
      var names = state.wb.SheetNames;
      if (!names.length) throw new Error('empty');
      els.sheet.innerHTML = names.map(function (n) { return '<option>' + Kit.escapeHtml(n) + '</option>'; }).join('');
      els.sheetWrap.hidden = names.length < 2;
      els.encWrap.hidden = !state.isText;
      els.enc.value = state.encoding;
      els.name.textContent = file.name;
      els.dropTitle.textContent = '換一個檔案';
      els.panel.hidden = false;
      loadSheet();
    }).catch(function () {
      state.result = null;
      els.panel.hidden = els.tableWrap.hidden = els.exportBox.hidden = true;
      els.dropTitle.textContent = '拖曳試算表到這裡，或點擊選擇';
      Kit.showNote(els.error, '無法讀取「' + file.name + '」，請確認是 CSV、Excel 或 ODS 檔案。');
    });
  }

  /* ── 整理流程：修剪 → 空白列 → 去重 → 搜尋 ── */
  function headerNames(first, width) {
    var seen = {};
    return Array.from({ length: width }, function (_, i) {
      var base = (first && first[i] && first[i].trim()) || '欄 ' + XLSX.utils.encode_col(i);
      var name = base, n = 1;
      while (seen[name]) name = base + ' (' + (++n) + ')';
      seen[name] = true;
      return name;
    });
  }

  function compute() {
    var rows = state.aoa, width = rows.length ? rows[0].length : 0;
    var useHeader = els.header.checked && rows.length > 0;
    var header = headerNames(useHeader ? rows[0].map(function (c) { return c.trim(); }) : null, width);
    var body = useHeader ? rows.slice(1) : rows.slice();
    var total = body.length;

    if (els.trim.checked) body = body.map(function (r) { return r.map(function (c) { return c.trim(); }); });

    var removedEmpty = 0;
    if (els.empty.checked) {
      body = body.filter(function (r) { var keep = r.some(function (c) { return c.trim() !== ''; }); if (!keep) removedEmpty++; return keep; });
    }

    var removedDup = 0;
    if (state.dedupe !== 'off') {
      var idx = state.dedupe === 'all' ? null : Object.keys(state.dedupeKeys).map(Number).filter(function (i) { return i < width; });
      if (idx === null || idx.length) {
        var seen = new Set();
        body = body.filter(function (r) {
          var key = JSON.stringify(idx === null ? r : idx.map(function (i) { return r[i]; }));
          if (seen.has(key)) { removedDup++; return false; }
          seen.add(key); return true;
        });
      }
    }

    var q = els.search.value.trim().toLowerCase(), col = els.searchCol.value, matched = body.length;
    if (q) {
      body = body.filter(function (r) {
        var cells = col === '' ? r : [r[Number(col)] || ''];
        return cells.some(function (c) { return c.toLowerCase().indexOf(q) !== -1; });
      });
      matched = body.length;
    }

    state.result = { header: header, rows: body, useHeader: useHeader };
    renderControls(header);
    renderSummary(total, width, removedEmpty, removedDup, q ? matched : null);
    renderTable(header, body);
  }

  /* ── 畫面 ── */
  function renderControls(header) {
    var cur = els.searchCol.value;
    var opts = '<option value="">全部欄位</option>' + header.map(function (h, i) { return '<option value="' + i + '">' + Kit.escapeHtml(h) + '</option>'; }).join('');
    if (els.searchCol.dataset.sig !== opts) { els.searchCol.innerHTML = opts; els.searchCol.dataset.sig = opts; els.searchCol.value = cur && Number(cur) < header.length ? cur : ''; }

    els.dedupeCols.hidden = state.dedupe !== 'cols';
    var boxes = header.map(function (h, i) {
      return '<label class="toggle"><input type="checkbox" data-col="' + i + '"' + (state.dedupeKeys[i] ? ' checked' : '') + '>' + Kit.escapeHtml(h) + '</label>';
    }).join('');
    if (els.dedupeCols.dataset.sig !== boxes) { els.dedupeCols.innerHTML = boxes; els.dedupeCols.dataset.sig = boxes; }
  }

  function renderSummary(total, width, removedEmpty, removedDup, matched) {
    var src = state.isText ? ' · ' + ENC_NAME[state.encoding] : '';
    els.meta.textContent = Kit.fmtBytes(state.file.size) + ' · ' + total.toLocaleString() + ' 列 × ' + width + ' 欄' + src;
    var parts = ['原始 <b>' + total.toLocaleString() + '</b> 列'];
    if (removedEmpty) parts.push('<span class="minus">空白列 −' + removedEmpty.toLocaleString() + '</span>');
    if (removedDup) parts.push('<span class="minus">重複 −' + removedDup.toLocaleString() + '</span>');
    if (state.dedupe === 'cols' && !Object.keys(state.dedupeKeys).length) parts.push('請勾選要比對的欄位');
    if (matched !== null) parts.push('搜尋符合 <b>' + matched.toLocaleString() + '</b> 列');
    els.summary.innerHTML = parts.join(' · ');
    var n = state.result.rows.length;
    els.exportLead.innerHTML = '將匯出 <b>' + n.toLocaleString() + '</b> 列' + (state.result.useHeader ? '（另含標題列）' : '');
    els.exportBox.hidden = false;
  }

  function renderTable(header, rows) {
    var thead = els.table.tHead, tbody = els.table.tBodies[0];
    var htr = document.createElement('tr');
    var corner = document.createElement('th'); corner.className = 'rn'; corner.textContent = '#'; htr.appendChild(corner);
    header.forEach(function (h) { var th = document.createElement('th'); th.textContent = h; th.title = h; htr.appendChild(th); });
    thead.replaceChildren(htr);

    var frag = document.createDocumentFragment();
    rows.slice(0, PREVIEW_ROWS).forEach(function (r, i) {
      var tr = document.createElement('tr');
      var rn = document.createElement('td'); rn.className = 'rn'; rn.textContent = i + 1; tr.appendChild(rn);
      r.forEach(function (c) {
        var td = document.createElement('td');
        if (c === '') { td.className = 'empty'; td.textContent = '—'; } else { td.textContent = c; if (c.length > 40) td.title = c; }
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    });
    tbody.replaceChildren(frag);
    els.more.hidden = rows.length <= PREVIEW_ROWS;
    els.more.textContent = '只預覽前 ' + PREVIEW_ROWS + ' 列，共 ' + rows.length.toLocaleString() + ' 列；匯出時會包含全部。';
    els.tableWrap.hidden = false;
  }

  /* ── 匯出 ── */
  var NUMERIC = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
  function guard(c) { return els.safe.checked && /^[=+\-@\t\r]/.test(c) && !NUMERIC.test(c) ? "'" + c : c; }

  function delimited(rows, sep) {
    return rows.map(function (r) {
      return r.map(function (c) {
        c = guard(c);
        return /["\r\n]/.test(c) || c.indexOf(sep) !== -1 ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(sep);
    }).join('\r\n');
  }

  function exportRows() { var r = state.result; return r.useHeader ? [r.header].concat(r.rows) : r.rows; }

  function doExport(fmt) {
    var base = Kit.baseName(state.file.name), r = state.result;
    if (fmt === 'csv') return Kit.download(new Blob(['﻿' + delimited(exportRows(), ',')], { type: 'text/csv;charset=utf-8' }), base + '.csv');
    if (fmt === 'tsv') return Kit.download(new Blob([delimited(exportRows(), '\t')], { type: 'text/tab-separated-values;charset=utf-8' }), base + '.tsv');
    if (fmt === 'json') {
      var objs = r.rows.map(function (row) { var o = {}; r.header.forEach(function (h, i) { o[h] = row[i]; }); return o; });
      return Kit.download(new Blob([JSON.stringify(objs, null, 2)], { type: 'application/json' }), base + '.json');
    }
    var aoa = exportRows().map(function (row, i) {
      return row.map(function (c) { return (r.useHeader && i === 0) || !NUMERIC.test(c) ? c : Number(c); });
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), (els.sheet.value || 'Sheet1').slice(0, 31));
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    Kit.download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), base + '.xlsx');
  }

  /* ── 事件 ── */
  Kit.dropzone(els.drop, els.input, function (files) { openFile(files[0]); });
  els.sheet.addEventListener('change', loadSheet);
  els.enc.addEventListener('change', function () { state.encoding = els.enc.value; state.wb = readWorkbook(); loadSheet(); });
  [els.header, els.trim, els.empty, els.searchCol].forEach(function (el) { el.addEventListener('change', compute); });
  els.search.addEventListener('input', function () { clearTimeout(state.timer); state.timer = setTimeout(compute, 150); });
  els.dedupeMode.addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    Array.prototype.forEach.call(els.dedupeMode.querySelectorAll('.chip'), function (c) { c.setAttribute('aria-pressed', String(c === b)); });
    state.dedupe = b.dataset.mode; compute();
  });
  els.dedupeCols.addEventListener('change', function (e) {
    var i = e.target.dataset.col; if (i == null) return;
    if (e.target.checked) state.dedupeKeys[i] = true; else delete state.dedupeKeys[i];
    compute();
  });
  els.exportBox.addEventListener('click', function (e) {
    var b = e.target.closest('[data-fmt]'); if (!b || !state.result) return;
    try { doExport(b.dataset.fmt); } catch (err) { Kit.showNote(els.error, '匯出失敗：' + err.message); }
  });

  /* ── 載入引擎 ── */
  els.loading.hidden = false;
  var ready = Kit.loadScript(SHEETJS_URL).then(function () { els.loading.hidden = true; }, function (err) {
    els.loading.hidden = true;
    Kit.showNote(els.error, '試算表引擎載入失敗，請確認網路連線後重新整理頁面。');
    throw err;
  });

  window.__sheet = { openFile: openFile, state: state, compute: compute, delimited: delimited, exportRows: exportRows, doExport: doExport };
})();
