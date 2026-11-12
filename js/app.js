/* 工具集：讀取 tools.json，依分類與搜尋顯示卡牌；狀態同步到網址 (?q=&cat=) */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = { search: $('search'), cats: $('cats'), grid: $('grid'), empty: $('empty'), emptyQ: $('empty-q'), clear: $('btn-clear'), total: $('total-count') };
  var tpl = $('card-tpl');
  var data = { categories: [], tools: [] };
  var state = { q: '', cat: 'all' };

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function norm(s) { return String(s).toLowerCase().replace(/\s+/g, ''); }

  /* 高亮：把符合的字串包成 <mark>，其餘字元跳脫 */
  function highlight(text, q) {
    if (!q) return escapeHtml(text);
    var lower = text.toLowerCase(), ql = q.toLowerCase(), out = '', i = 0, idx;
    while ((idx = lower.indexOf(ql, i)) !== -1) {
      out += escapeHtml(text.slice(i, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>';
      i = idx + q.length;
    }
    return out + escapeHtml(text.slice(i));
  }

  function catName(id) {
    var c = data.categories.filter(function (c) { return c.id === id; })[0];
    return c ? c.name : '';
  }

  function matches(tool, q) {
    if (!q) return true;
    var hay = [tool.name, tool.desc, catName(tool.category)].concat(tool.tags || []).map(norm).join(' ');
    return hay.indexOf(norm(q)) !== -1;
  }

  function visibleTools() {
    return data.tools.filter(function (t) {
      return (state.cat === 'all' || t.category === state.cat) && matches(t, state.q);
    });
  }

  /* ── 分類列 ── */
  function renderCats() {
    var counts = {};
    data.tools.forEach(function (t) { if (matches(t, state.q)) counts[t.category] = (counts[t.category] || 0) + 1; });
    var all = Object.keys(counts).reduce(function (a, k) { return a + counts[k]; }, 0);
    var items = [{ id: 'all', name: '全部', n: all }].concat(data.categories.map(function (c) { return { id: c.id, name: c.name, n: counts[c.id] || 0 }; }));
    els.cats.innerHTML = items.map(function (c) {
      return '<button type="button" class="chip" role="tab" data-cat="' + c.id + '" aria-selected="' + (state.cat === c.id) + '">' +
        escapeHtml(c.name) + '<span class="n">' + c.n + '</span></button>';
    }).join('');
  }

  /* ── 卡牌 ── */
  function renderGrid() {
    var list = visibleTools();
    els.grid.innerHTML = '';
    list.forEach(function (t, i) {
      var node = tpl.content.firstElementChild.cloneNode(true);
      node.style.animationDelay = Math.min(i, 12) * 25 + 'ms';
      var a = node.querySelector('.card-link');
      a.href = t.url; a.setAttribute('aria-label', t.name + '：' + t.desc);
      node.querySelector('.card-icon').textContent = t.icon || '🔧';
      node.querySelector('.card-name').innerHTML = highlight(t.name, state.q);
      node.querySelector('.card-cat').textContent = catName(t.category);
      node.querySelector('.card-desc').innerHTML = highlight(t.desc, state.q);
      node.querySelector('.card-tags').innerHTML = (t.tags || []).map(function (tag) { return '<span>' + highlight(tag, state.q) + '</span>'; }).join('');
      els.grid.appendChild(node);
    });
    els.empty.hidden = list.length > 0;
    els.emptyQ.textContent = state.q;
    els.total.textContent = list.length + ' / ' + data.tools.length + ' 個工具';
  }

  function render() { renderCats(); renderGrid(); }

  /* ── URL 狀態 ── */
  function readUrl() {
    var p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    state.cat = p.get('cat') || 'all';
    if (state.cat !== 'all' && !data.categories.some(function (c) { return c.id === state.cat; })) state.cat = 'all';
    els.search.value = state.q;
  }
  function writeUrl() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.cat !== 'all') p.set('cat', state.cat);
    var qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  /* ── 互動 ── */
  els.search.addEventListener('input', function () { state.q = els.search.value.trim(); writeUrl(); render(); });
  els.cats.addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    state.cat = b.dataset.cat; writeUrl(); render();
  });
  els.clear.addEventListener('click', function () { els.search.value = ''; state.q = ''; state.cat = 'all'; writeUrl(); render(); els.search.focus(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== els.search && !e.metaKey && !e.ctrlKey) { e.preventDefault(); els.search.focus(); }
    if (e.key === 'Escape' && document.activeElement === els.search) { els.search.value = ''; state.q = ''; writeUrl(); render(); }
  });
  window.addEventListener('popstate', function () { readUrl(); render(); });

  /* ── 載入 ── */
  fetch('tools.json', { cache: 'no-cache' }).then(function (r) {
    if (!r.ok) throw new Error('tools.json 讀取失敗（' + r.status + '）');
    return r.json();
  }).then(function (json) {
    if (!json || !Array.isArray(json.tools) || !Array.isArray(json.categories)) throw new Error('tools.json 格式不正確');
    data = json;
    readUrl(); render();
  }).catch(function (err) {
    els.grid.innerHTML = '';
    els.empty.hidden = false;
    els.empty.querySelector('p').textContent = '無法載入工具清單：' + err.message;
    els.clear.hidden = true;
  });
})();
