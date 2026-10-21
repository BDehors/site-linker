/* 站点链接助手 · 工具栏弹窗：分类速控 + 站点搜索（直达官网） */
(function () {
  'use strict';

  var KEY = 'siteLinker.categories';
  var OV_KEY = 'siteLinker.overrides';
  var USERSITES_KEY = 'siteLinker.userSites';

  var listEl = document.getElementById('list');
  var statusEl = document.getElementById('status');
  var ovEl = document.getElementById('ov-info');
  var qEl = document.getElementById('q');
  var resEl = document.getElementById('results');
  var statusTimer = null;
  var searchable = [];

  function say(msg) {
    statusEl.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      if (statusEl.textContent === msg) statusEl.textContent = '';
    }, 2200);
  }

  function save(saved) {
    var data = {};
    data[KEY] = saved;
    chrome.storage.sync.set(data, function () {
      if (chrome.runtime.lastError) { say('保存失败'); return; }
      say('已保存，页面即时生效');
    });
  }

  function collect() {
    var out = {};
    var boxes = listEl.querySelectorAll('input[type=checkbox]');
    for (var i = 0; i < boxes.length; i++) out[boxes[i].dataset.cat] = boxes[i].checked;
    return out;
  }

  function setAll(on) {
    var boxes = listEl.querySelectorAll('input[type=checkbox]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = on;
    save(collect());
  }

  function render(dict, saved, userSites, ov) {
    var edits = (ov && ov.edits) || {};
    listEl.textContent = '';
    var cats = dict.categories.slice();
    if (userSites.length) cats.push({ id: 'custom', name: '自定义站点', entries: userSites });

    cats.forEach(function (cat) {
      var live = 0;
      cat.entries.forEach(function (e) {
        var ed = edits[e.name] || {};
        if (!ed.off) live++;
      });
      var row = document.createElement('label');
      row.className = 'cat';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = saved[cat.id] !== false;
      cb.dataset.cat = cat.id;
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = cat.name;
      var ct = document.createElement('span');
      ct.className = 'ct';
      ct.textContent = live + ' 站';
      row.appendChild(cb);
      row.appendChild(nm);
      row.appendChild(ct);
      listEl.appendChild(row);
    });
  }

  /* ---------------- 搜索（只搜已收录站点） ---------------- */

  function hostOf(u) {
    try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  // 词库条目 + 用户修正（改过的网址/补的触发词生效；停用的不出现；自添加站点可搜）
  function buildSearchable(dict, ov, userSites) {
    var edits = (ov && ov.edits) || {};
    var list = [];
    dict.categories.forEach(function (cat) {
      cat.entries.forEach(function (e) {
        var ed = edits[e.name] || {};
        if (ed.off) return;
        list.push({
          name: e.name,
          aliases: (e.aliases || []).concat(ed.aliases || []),
          url: ed.url || e.url
        });
      });
    });
    (userSites || []).forEach(function (e) {
      if (e && e.name && e.url) {
        list.push({ name: e.name, aliases: (e.aliases || []).slice(), url: e.url });
      }
    });
    return list;
  }

  function doSearch(qRaw) {
    var q = (qRaw || '').trim().toLowerCase();
    document.body.classList.toggle('searching', !!q);
    resEl.textContent = '';
    if (!q) { resEl.hidden = true; return; }

    var found = [];
    searchable.forEach(function (e) {
      var fields = [e.name].concat(e.aliases).concat([hostOf(e.url), e.url]);
      var score = 0;
      for (var i = 0; i < fields.length; i++) {
        var f = (fields[i] || '').toLowerCase();
        if (!f) continue;
        if (f === q) { score = Math.max(score, 3); }
        else if (f.indexOf(q) === 0) { score = Math.max(score, 2); }
        else if (f.indexOf(q) !== -1) { score = Math.max(score, 1); }
      }
      if (score) found.push({ e: e, s: score });
    });
    found.sort(function (a, b) { return b.s - a.s; });

    resEl.hidden = false;
    if (!found.length) {
      var empty = document.createElement('div');
      empty.className = 'res-empty';
      empty.textContent = '没有找到“' + q + '”。目前只收录已知站点；可在「完整设置」里自己添加。';
      resEl.appendChild(empty);
      return;
    }
    found.slice(0, 12).forEach(function (x) {
      var row = document.createElement('div');
      row.className = 'res';
      row.dataset.url = x.e.url;
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = x.e.name;
      var u = document.createElement('span');
      u.className = 'u';
      u.textContent = hostOf(x.e.url) || x.e.url;
      row.appendChild(nm);
      row.appendChild(u);
      row.addEventListener('click', function () { openUrl(x.e.url); });
      resEl.appendChild(row);
    });
  }

  function openUrl(url) {
    // 先建标签，回调里再关弹窗——直接 window.close() 会抢在建标签之前把请求丢掉
    chrome.tabs.create({ url: url }, function () { window.close(); });
  }

  /* ---------------- 启动 ---------------- */

  fetch(chrome.runtime.getURL('src/dictionary.json'))
    .then(function (r) { return r.json(); })
    .then(function (dict) {
      document.getElementById('dict-ver').textContent = 'v' + chrome.runtime.getManifest().version;
      chrome.storage.sync.get([KEY, OV_KEY, USERSITES_KEY], function (data) {
        data = data || {};
        var saved = data[KEY] || {};
        var ov = data[OV_KEY] || {};
        // 自添加站点：新键优先，旧版 overrides.custom 回退（更新时已由后台迁移）
        var userSites = data[USERSITES_KEY];
        if (!Array.isArray(userSites)) userSites = ov.custom || [];
        var nEdits = Object.keys(ov.edits || {}).length;
        var nCustom = userSites.length;
        if (nEdits || nCustom) {
          ovEl.hidden = false;
          ovEl.textContent = '已应用你的修正：' + nEdits + ' 处修改、' + nCustom + ' 个自添加站点。';
        }
        searchable = buildSearchable(dict, ov, userSites);
        render(dict, saved, userSites, ov);
      });
    })
    .catch(function () { say('词典加载失败'); });

  listEl.addEventListener('change', function (e) {
    if (e.target && e.target.type === 'checkbox') save(collect());
  });
  document.getElementById('btn-all').addEventListener('click', function () { setAll(true); });
  document.getElementById('btn-none').addEventListener('click', function () { setAll(false); });
  document.getElementById('open-options').addEventListener('click', function () {
    chrome.runtime.openOptionsPage(function () { window.close(); });
  });
  document.getElementById('open-manual').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/manual.html') }, function () { window.close(); });
  });
  qEl.addEventListener('input', function () { doSearch(qEl.value); });
  qEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var first = resEl.querySelector('.res');
      if (first && first.dataset.url) openUrl(first.dataset.url);
    }
  });
})();