/* 站点链接助手 · 设置页：分类开关 + 行为开关（自动复制/粘贴）+ 我添加的站点 + 站点修正 */
(function () {
  'use strict';

  var KEY = 'siteLinker.categories';
  var OV_KEY = 'siteLinker.overrides';
  var USERSITES_KEY = 'siteLinker.userSites';
  var PREFS_KEY = 'siteLinker.prefs';

  var listEl = document.getElementById('list');
  var statusEl = document.getElementById('status');
  var reviseEl = document.getElementById('revise-list');
  var userListEl = document.getElementById('user-list');
  var userCountEl = document.getElementById('us-count');
  var formEl = document.getElementById('form');
  var searchEl = document.getElementById('search');
  var ovCountEl = document.getElementById('ov-count');
  var prefCopyEl = document.getElementById('pref-autocopy');
  var prefNewWinEl = document.getElementById('pref-newwin');
  var fileEl = document.getElementById('file-json');
  var statusTimer = null;

  var dict = null;
  var overrides = { edits: {} };
  var userSites = [];
  var prefs = { autoCopyPaste: true, openInNewWindow: true };

  function show(msg) {
    statusEl.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      if (statusEl.textContent === msg) statusEl.textContent = '';
    }, 2800);
  }

  /* ---------------- 工具 ---------------- */

  function normalizeUrl(v) {
    v = (v || '').trim();
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      var u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return v;
    } catch (e) {
      return null;
    }
  }

  // 分隔符：逗号 / 顿号 / 分号 / 竖线；不按空格分（保留 "Web of Science" 这类带空格的触发词）
  function parseAliases(v) {
    return (v || '')
      .split(/[，,、;；|]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function findDictEntry(name) {
    for (var i = 0; i < dict.categories.length; i++) {
      var es = dict.categories[i].entries;
      for (var j = 0; j < es.length; j++) {
        if (es[j].name === name) return es[j];
      }
    }
    return null;
  }

  function findDictCat(name) {
    for (var i = 0; i < dict.categories.length; i++) {
      var es = dict.categories[i].entries;
      for (var j = 0; j < es.length; j++) {
        if (es[j].name === name) return dict.categories[i].name;
      }
    }
    return '';
  }

  /* 同步存储单键上限 8KB：“我添加的站点”带别名约 70–80 条就会触顶。
   * 超限时把英文 quota 报错翻成一句人话，并说清"没生效、原数据还在"，
   * 免得重度用户看到 "QUOTA_BYTES quota exceeded" 一头雾水。 */
  function saveFailMsg(errMsg) {
    if (/quota/i.test(errMsg || '')) {
      return '保存失败：超出浏览器同步单键 8KB 上限（“我添加的站点”带别名约 70–80 条就会触顶）。' +
        '本次保存没有生效、原数据还在——删掉不常用的站点再存，或按 CONTRIBUTING.md 提进公共词库。';
    }
    return '保存失败：' + (errMsg || '未知错误');
  }

  /* 写盘：词库修正（edits）与自添加站点（userSites）两个键分开存 */
  function persistSites(msg) {
    var data = {};
    data[OV_KEY] = overrides;
    data[USERSITES_KEY] = userSites;
    chrome.storage.sync.set(data, function () {
      if (chrome.runtime.lastError) {
        show(saveFailMsg(chrome.runtime.lastError.message));
        return;
      }
      show(msg || '已保存，已打开页面即时生效');
      renderOvCount();
      renderUserSites();
      renderRevise();
    });
  }

  /* ---------------- 分类开关（原有行为） ---------------- */

  function render(dict, saved) {
    listEl.textContent = '';
    dict.categories.forEach(function (cat) {
      var on = saved[cat.id] !== false;

      var box = document.createElement('div');
      box.className = 'cat';

      var head = document.createElement('label');
      head.className = 'cat-head';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.dataset.cat = cat.id;
      var title = document.createElement('span');
      title.textContent = cat.name;
      var count = document.createElement('span');
      count.className = 'cat-count';
      count.textContent = cat.entries.length + ' 站';
      head.appendChild(cb);
      head.appendChild(title);
      head.appendChild(count);
      box.appendChild(head);

      var desc = document.createElement('p');
      desc.className = 'cat-desc';
      desc.textContent = cat.desc || '';
      box.appendChild(desc);

      var details = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = '查看站点';
      var ul = document.createElement('ul');
      cat.entries.forEach(function (e) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = e.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = e.name + (e.aliases && e.aliases.length ? '（' + e.aliases.join('、') + '）' : '');
        li.appendChild(a);
        ul.appendChild(li);
      });
      details.appendChild(summary);
      details.appendChild(ul);
      box.appendChild(details);

      listEl.appendChild(box);
    });
  }

  function collect() {
    var saved = {};
    var boxes = listEl.querySelectorAll('input[type=checkbox]');
    for (var i = 0; i < boxes.length; i++) saved[boxes[i].dataset.cat] = boxes[i].checked;
    return saved;
  }

  function save() {
    var data = {};
    data[KEY] = collect();
    chrome.storage.sync.set(data, function () {
      if (chrome.runtime.lastError) { show('保存失败：' + chrome.runtime.lastError.message); return; }
      show('已保存');
    });
  }

  function setAll(on) {
    var boxes = listEl.querySelectorAll('input[type=checkbox]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = on;
    save();
  }

  /* ---------------- 行为开关：点击链接自动复制 / 粘贴 / 新窗口 ---------------- */

  function renderPrefs() {
    prefCopyEl.checked = prefs.autoCopyPaste;
    prefNewWinEl.checked = prefs.openInNewWindow;
  }

  function savePrefs() {
    var data = {};
    data[PREFS_KEY] = { autoCopyPaste: prefs.autoCopyPaste, openInNewWindow: prefs.openInNewWindow };
    chrome.storage.sync.set(data, function () {
      if (chrome.runtime.lastError) { show('保存失败：' + chrome.runtime.lastError.message); return; }
      show(
        (prefs.autoCopyPaste ? '自动复制 + 自动粘贴：开' : '自动复制 + 自动粘贴：关') + '；' +
        (prefs.openInNewWindow ? '新窗口打开：开' : '新窗口打开：关（浏览器默认新标签页）')
      );
    });
  }

  /* ---------------- 信源体检（v2.0.0）：总开关 + 台账导出 ---------------- */

  var citeEnabledEl = document.getElementById('cite-enabled');
  var citeStatEl = document.getElementById('cite-stat');
  var citeCountEl = document.getElementById('cite-count');
  var LED = window.SL_CITATION_LEDGER;   // 由 citations/ledger.js 提供（与 content script 同一份实现）

  function renderCitations() {
    if (!LED) {
      if (citeStatEl) citeStatEl.textContent = '台账：体检模块没加载（设置页脚本没更新？重新加载扩展后再看）。';
      return;
    }
    LED.isEnabled(function (on) { if (citeEnabledEl) citeEnabledEl.checked = !!on; });
    LED.loadLedger(function (list) {
      LED.loadFeedbackSet(function (fb) {
        if (citeCountEl) citeCountEl.textContent = list.length ? ('（台账 ' + list.length + ' 条）') : '';
        if (citeStatEl) {
          citeStatEl.textContent = list.length
            ? '台账：本机已记录 ' + list.length + ' 条回答的体检结果（只保留最近 200 条）；“这是官网”反馈 ' + fb.length + ' 个域名。'
            : '台账：还没有记录。在 AI 对话页提过问、体检卡出现过之后，这里才会有内容。';
        }
      });
    });
  }

  if (citeEnabledEl) {
    citeEnabledEl.addEventListener('change', function () {
      if (!LED) return;
      LED.setEnabled(citeEnabledEl.checked, function () {
        show(citeEnabledEl.checked ? '信源体检：开' : '信源体检：关（回到 v1 行为，已打开的页面即时生效）');
      });
    });
  }

  function copyThen(text) {
    try {
      navigator.clipboard.writeText(text).then(function () { show('下载不成，已把内容复制到剪贴板'); },
        function () { show('导出失败：下载与剪贴板都不行'); });
    } catch (e) { show('导出失败'); }
  }

  function exportLedger(kind) {
    if (!LED) { show('体检模块没加载'); return; }
    LED.loadLedger(function (list) {
      if (!list.length) { show('台账还是空的，先去 AI 页问一句'); return; }
      var text = kind === 'csv' ? LED.toCsv(list) : LED.toJson(list);
      var name = '信源体检台账-' + new Date().toISOString().slice(0, 10) + (kind === 'csv' ? '.csv' : '.json');
      var ok = LED.download(name, text, copyThen);
      show(ok ? ('已导出 ' + list.length + ' 条记录：' + name) : '下载被拦，改用剪贴板');
    });
  }

  ['btn-cite-csv', 'btn-cite-json'].forEach(function (id, i) {
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', function () { exportLedger(i === 0 ? 'csv' : 'json'); });
  });
  var btnCiteClear = document.getElementById('btn-cite-clear');
  if (btnCiteClear) btnCiteClear.addEventListener('click', function () {
    if (!LED) return;
    if (!window.confirm('清空台账？导出的文件不受影响。')) return;
    LED.clearLedger(function () { renderCitations(); show('台账已清空'); });
  });
  var btnFbClear = document.getElementById('btn-fb-clear');
  if (btnFbClear) btnFbClear.addEventListener('click', function () {
    if (!LED) return;
    LED.loadFeedbackSet(function (fb) {
      if (!fb.length) { show('还没有“这是官网”的反馈'); return; }
      if (!window.confirm('清除全部 ' + fb.length + ' 个已确认官网的域名？')) return;
      var obj = {};
      obj[LED.FEEDBACK_KEY] = [];
      chrome.storage.local.set(obj, function () { renderCitations(); show('反馈已清除'); });
    });
  });

  /* ---------------- 我添加的站点（与词库分离） ---------------- */

  function renderOvCount() {
    var n = Object.keys(overrides.edits || {}).length;
    ovCountEl.textContent = n ? '（已改 ' + n + ' 条）' : '';
  }

  function renderUserSites() {
    userListEl.textContent = '';
    userCountEl.textContent = userSites.length ? '（' + userSites.length + ' 个）' : '';
    if (!userSites.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有自己添加过站点。点“＋ 新增自定义站点”，或在下方“批量更新与备份”里整表导入——添加的站点只出现在这里和弹窗的“自定义站点”分类里。';
      userListEl.appendChild(empty);
      return;
    }
    userSites.forEach(function (e, i) {
      userListEl.appendChild(buildUserItem(e, i));
    });
  }

  function buildUserItem(e, i) {
    var el = document.createElement('div');
    el.className = 'item';

    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = e.name;
    el.appendChild(nm);

    var tag = document.createElement('span');
    tag.className = 'cat-tag';
    tag.textContent = '自定义';
    el.appendChild(tag);

    var url = document.createElement('span');
    url.className = 'url';
    url.textContent = e.url + (e.aliases && e.aliases.length ? '（' + e.aliases.join('、') + '）' : '');
    url.title = e.url;
    el.appendChild(url);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '编辑';
    btn.addEventListener('click', function () { openForm({ kind: 'custom', index: i }); });
    el.appendChild(btn);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', function () {
      if (!window.confirm('删除自己添加的站点“' + e.name + '”？')) return;
      userSites.splice(i, 1);
      persistSites('已删除');
      closeForm();
    });
    el.appendChild(del);
    return el;
  }

  /* ---------------- 站点修正：列表（只列词库自带条目） ---------------- */

  function renderRevise() {
    var q = (searchEl.value || '').trim().toLowerCase();
    reviseEl.textContent = '';
    var rows = [];
    dict.categories.forEach(function (cat) {
      cat.entries.forEach(function (e) {
        rows.push({ kind: 'dict', name: e.name, aliases: e.aliases || [], url: e.url, cat: cat.name });
      });
    });

    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (q) {
        var hay = (r.name + ' ' + r.aliases.join(' ') + ' ' + r.url + ' ' + r.cat).toLowerCase();
        if (hay.indexOf(q) === -1) continue;
      }
      if (shown >= 150) {
        var more = document.createElement('p');
        more.className = 'empty';
        more.textContent = '结果过多，仅显示前 150 条——请输入关键词缩小范围。';
        reviseEl.appendChild(more);
        break;
      }
      reviseEl.appendChild(buildItem(r));
      shown++;
    }
    if (!shown) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = q ? '没有匹配的词库条目。（自己添加的站点在上方“我添加的站点”里）' : '';
      if (q) reviseEl.appendChild(empty);
    }
  }

  function buildItem(r) {
    var ed = (r.kind === 'dict' && overrides.edits[r.name]) || {};
    var el = document.createElement('div');
    el.className = 'item';

    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = r.name;
    el.appendChild(nm);

    var tag = document.createElement('span');
    tag.className = 'cat-tag';
    tag.textContent = r.cat;
    el.appendChild(tag);

    var url = document.createElement('span');
    url.className = 'url';
    var shownUrl = ed.url || r.url;
    url.textContent = shownUrl;
    url.title = shownUrl;
    el.appendChild(url);

    if (ed.off) {
      var bOff = document.createElement('span');
      bOff.className = 'badge off';
      bOff.textContent = '已停用';
      el.appendChild(bOff);
    }
    if (ed.url || (ed.aliases && ed.aliases.length)) {
      var bEd = document.createElement('span');
      bEd.className = 'badge edited';
      bEd.textContent = '已修正';
      el.appendChild(bEd);
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '编辑';
    btn.addEventListener('click', function () {
      openForm({ kind: 'dict', name: r.name });
    });
    el.appendChild(btn);
    return el;
  }

  /* ---------------- 编辑表单 ---------------- */

  function closeForm() {
    formEl.hidden = true;
    formEl.textContent = '';
  }

  function openForm(target) {
    var isNew = target.kind === 'new';
    var isCustom = target.kind === 'custom';
    var name = isNew ? '' : (isCustom ? (userSites[target.index] || {}).name : target.name);
    var entry = isCustom ? (userSites[target.index] || {}) : findDictEntry(name);
    var ed = overrides.edits[name] || {};

    formEl.textContent = '';
    formEl.hidden = false;

    var h = document.createElement('h3');
    h.textContent = isNew ? '新增自定义站点' : '编辑：' + name;
    formEl.appendChild(h);

    var l1 = document.createElement('label');
    l1.textContent = '名称（页面里出现这个词就会变成链接）';
    var i1 = document.createElement('input');
    i1.type = 'text';
    i1.id = 'f-name';
    i1.value = name;
    if (!isNew && !isCustom) i1.readOnly = true;
    formEl.appendChild(l1);
    formEl.appendChild(i1);

    var l2 = document.createElement('label');
    l2.textContent = '网址（http:// 或 https://，不写协议会自动补 https）';
    var i2 = document.createElement('input');
    i2.type = 'text';
    i2.id = 'f-url';
    i2.value = isCustom ? (entry.url || '') : (ed.url || (entry && entry.url) || '');
    formEl.appendChild(l2);
    formEl.appendChild(i2);

    var l3 = document.createElement('label');
    l3.textContent = isCustom
      ? '触发词（其他叫法，用逗号或顿号分隔，可留空）'
      : '补充触发词（在词库原有基础上追加，用逗号或顿号分隔，可留空）';
    var i3 = document.createElement('input');
    i3.type = 'text';
    i3.id = 'f-aliases';
    i3.value = isCustom ? (entry.aliases || []).join('、') : (ed.aliases || []).join('、');
    formEl.appendChild(l3);
    formEl.appendChild(i3);

    if (!isNew && !isCustom && entry && (entry.aliases || []).length) {
      var baseHint = document.createElement('p');
      baseHint.className = 'hint';
      baseHint.textContent = '词库自带触发词：' + entry.aliases.join('、');
      formEl.appendChild(baseHint);
    }

    if (!isNew && !isCustom && entry) {
      var wrap = document.createElement('label');
      wrap.className = 'chk';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'f-off';
      cb.checked = !!ed.off;
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode('停用这个站点（不再自动链接）'));
      formEl.appendChild(wrap);
    }

    if (isCustom || isNew) {
      var customHint = document.createElement('p');
      customHint.className = 'hint';
      customHint.textContent = '自己添加的站点存放在“我添加的站点”里，与词库分开；弹窗的“自定义站点”分类可整体开关。';
      formEl.appendChild(customHint);
    }

    var row = document.createElement('div');
    row.className = 'row2';

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', function () { saveForm(target, entry); });
    row.appendChild(saveBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', closeForm);
    row.appendChild(cancelBtn);

    if (!isNew && !isCustom && entry) {
      var resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.textContent = '恢复词库默认';
      resetBtn.addEventListener('click', function () {
        delete overrides.edits[name];
        persistSites('已恢复默认');
        closeForm();
      });
      row.appendChild(resetBtn);
    }

    if (isCustom) {
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger';
      delBtn.textContent = '删除此站点';
      delBtn.addEventListener('click', function () {
        userSites.splice(target.index, 1);
        persistSites('已删除');
        closeForm();
      });
      row.appendChild(delBtn);
    }

    formEl.appendChild(row);
    i2.focus();
  }

  function saveForm(target, entry) {
    var name = (document.getElementById('f-name').value || '').trim();
    var url = normalizeUrl(document.getElementById('f-url').value);
    var aliases = parseAliases(document.getElementById('f-aliases').value);

    if (!name) { show('请填写名称'); return; }
    if (!url) { show('网址无效：请填写完整网址（可用 http/https 开头）'); return; }

    if (target.kind === 'new' || target.kind === 'custom') {
      // 重名防护：自添加站点不能与词库条目同名——否则匹配时自定义会盖住词库条目，
      // 弹窗搜索也会列出两条；编辑时还不能撞上另一条自添加站点
      if (findDictEntry(name)) {
        show('词库里已有同名条目“' + name + '”，请在下方“站点修正”里搜索并编辑它');
        return;
      }
      var dup = userSites.findIndex(function (c) { return c.name === name; });
      if (dup >= 0 && !(target.kind === 'custom' && dup === target.index)) {
        show('“我添加的站点”里已有同名条目，换个名字，或直接编辑那一条');
        return;
      }
      var item = { name: name, aliases: aliases, url: url };
      if (target.kind === 'new') userSites.push(item);
      else userSites[target.index] = item;
      persistSites('已保存');
      closeForm();
      return;
    }

    // 词典条目：只存与词库不同的部分
    var edNew = {};
    if (entry && url !== entry.url) edNew.url = url;
    var base = (entry && entry.aliases) || [];
    var extra = aliases.filter(function (t) { return t && t !== name && base.indexOf(t) === -1; });
    if (extra.length) edNew.aliases = extra;
    var offEl = document.getElementById('f-off');
    if (offEl && offEl.checked) edNew.off = true;
    if (Object.keys(edNew).length) overrides.edits[name] = edNew;
    else delete overrides.edits[name];
    persistSites('已保存');
    closeForm();
  }

  /* ---------------- 批量导入 / 导出 ---------------- */

  function parseBulk(text) {
    var rows = [];
    var bad = 0;
    String(text || '').split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var f = line.split('\t').map(function (s) { return s.trim(); });
      if (f.length >= 3) {
        var url = normalizeUrl(f[2]);
        if (!f[0] || !url) { bad++; return; }
        rows.push({ name: f[0], prompts: parseAliases(f[1]), url: url });
      } else if (f.length === 2) {
        var url2 = normalizeUrl(f[1]);
        if (!f[0] || !url2) { bad++; return; }
        rows.push({ name: f[0], prompts: [], url: url2 });
      } else {
        bad++;
      }
    });
    return { rows: rows, bad: bad };
  }

  function applyBulk() {
    var parsed = parseBulk(document.getElementById('bulk-text').value);
    if (!parsed.rows.length) {
      show('没有解析到有效行：请从 Excel / 表格里整块复制（列之间是制表符）');
      return;
    }
    var fixed = 0, added = 0, unchanged = 0;
    parsed.rows.forEach(function (r) {
      var entry = findDictEntry(r.name);
      if (entry) {
        var ed = overrides.edits[r.name] || {};
        var changed = false;
        if (r.url !== entry.url) { ed.url = r.url; changed = true; }
        else if (ed.url) { delete ed.url; changed = true; } // 导入的网址与词库一致 = 恢复默认（此前会保留旧自定义值还计"一致"）
        var base = entry.aliases || [];
        var news = r.prompts.filter(function (t) { return t && t !== r.name && base.indexOf(t) === -1; });
        if (news.length) {
          var cur = ed.aliases || [];
          ed.aliases = cur.concat(news.filter(function (t) { return cur.indexOf(t) === -1; }));
          changed = true;
        }
        if (changed) {
          // 修正被清空时（如只改过网址、这次导回默认）删掉空壳，别留 {}
          if (Object.keys(ed).length) overrides.edits[r.name] = ed;
          else delete overrides.edits[r.name];
          fixed++;
        } else unchanged++;
      } else {
        var i = userSites.findIndex(function (c) { return c.name === r.name; });
        var item = {
          name: r.name,
          aliases: r.prompts.filter(function (t) { return t !== r.name; }),
          url: r.url
        };
        if (i >= 0) userSites[i] = item;
        else userSites.push(item);
        added++;
      }
    });
    // 什么都没变就不写盘：避免拿页面内存覆盖外部（另一个标签页/页面）对存储的修改
    if (fixed || added) {
      persistSites(
        '导入完成：修正 ' + fixed + ' 条、新增 ' + added + ' 条' +
        (unchanged ? '、与词库一致 ' + unchanged + ' 条' : '') +
        (parsed.bad ? '、跳过 ' + parsed.bad + ' 行' : '')
      );
    } else {
      show(
        '导入完成：修正 ' + fixed + ' 条、新增 ' + added + ' 条' +
        (unchanged ? '、与词库一致 ' + unchanged + ' 条' : '') +
        (parsed.bad ? '、跳过 ' + parsed.bad + ' 行' : '') + '（无变化，未写盘）'
      );
    }
  }

  /* 导出：同时写 userSites（新键）与 custom（旧键镜像，方便旧版本导入） */
  function exportJson() {
    var payload = {
      edits: overrides.edits,
      userSites: userSites,
      custom: userSites
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'site-linker-corrections.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    show('已导出修正文件');
  }

  /* 导入：新格式优先读 userSites，旧格式读 custom */
  function importJson(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      show('JSON 解析失败');
      return;
    }
    if (!data || typeof data !== 'object') { show('JSON 格式不对'); return; }
    var nEdits = 0, nCustom = 0, nDup = 0;
    if (data.edits && typeof data.edits === 'object') {
      Object.keys(data.edits).forEach(function (k) {
        var ed = data.edits[k];
        if (!ed || typeof ed !== 'object') return;
        var clean = {};
        var u = normalizeUrl(ed.url);
        if (u) clean.url = u;
        if (Array.isArray(ed.aliases) && ed.aliases.length) clean.aliases = ed.aliases.map(String);
        if (ed.off) clean.off = true;
        if (Object.keys(clean).length) { overrides.edits[k] = clean; nEdits++; }
      });
    }
    var incoming = Array.isArray(data.userSites) ? data.userSites
      : (Array.isArray(data.custom) ? data.custom : []);
    incoming.forEach(function (c) {
      var u = c && normalizeUrl(c.url);
      if (!c || !c.name || !u) return;
      // 与词库同名的自添加站点会互相盖住、搜索列两条，跳过并计数告知
      if (findDictEntry(c.name)) { nDup++; return; }
      var item = { name: String(c.name), aliases: Array.isArray(c.aliases) ? c.aliases.map(String) : [], url: u };
      var i = userSites.findIndex(function (x) { return x.name === item.name; });
      if (i >= 0) userSites[i] = item;
      else userSites.push(item);
      nCustom++;
    });
    if (nEdits || nCustom) {
      persistSites('导入完成：修正 ' + nEdits + ' 条、自添加站点 ' + nCustom + ' 个' +
        (nDup ? '、跳过与词库同名 ' + nDup + ' 个' : ''));
    } else {
      show('导入完成：没有可导入的内容' + (nDup ? '（跳过与词库同名 ' + nDup + ' 个）' : '') + '（无变化，未写盘）');
    }
  }

  /* ---------------- 绑定与启动 ---------------- */

  listEl.addEventListener('change', function (e) {
    if (e.target && e.target.type === 'checkbox') save();
  });
  document.getElementById('btn-all').addEventListener('click', function () { setAll(true); });
  document.getElementById('btn-none').addEventListener('click', function () { setAll(false); });
  document.getElementById('btn-reset').addEventListener('click', function () { setAll(true); });

  prefCopyEl.addEventListener('change', function () {
    prefs.autoCopyPaste = prefCopyEl.checked;
    savePrefs();
  });

  prefNewWinEl.addEventListener('change', function () {
    prefs.openInNewWindow = prefNewWinEl.checked;
    savePrefs();
  });

  searchEl.addEventListener('input', renderRevise);
  document.getElementById('btn-add').addEventListener('click', function () { openForm({ kind: 'new' }); });
  document.getElementById('btn-import-text').addEventListener('click', applyBulk);
  document.getElementById('btn-export').addEventListener('click', exportJson);
  document.getElementById('btn-import-json').addEventListener('click', function () { fileEl.click(); });
  document.getElementById('btn-clear').addEventListener('click', function () {
    if (!window.confirm('确定清空全部修正与自添加站点吗？建议先导出备份。')) return;
    overrides = { edits: {} };
    userSites = [];
    persistSites('已清空全部修正');
    closeForm();
  });
  document.getElementById('manual-link').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/manual.html') });
  });
  fileEl.addEventListener('change', function () {
    var f = fileEl.files && fileEl.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () { importJson(String(fr.result || '')); fileEl.value = ''; };
    fr.readAsText(f);
  });

  fetch(chrome.runtime.getURL('src/dictionary.json'))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      dict = d;
      document.getElementById('dict-version').textContent = d.version || '-';
      document.getElementById('dict-updated').textContent = d.updated || '-';
      chrome.storage.sync.get([KEY, OV_KEY, USERSITES_KEY, PREFS_KEY], function (data) {
        data = data || {};
        var ovRaw = data[OV_KEY] || {};
        overrides = { edits: ovRaw.edits || {} };
        // 自添加站点：新键优先；旧版在 overrides.custom 里，读到时顺手归置到新键
        var us = data[USERSITES_KEY];
        var legacy = Array.isArray(ovRaw.custom) ? ovRaw.custom : null;
        if (Array.isArray(us)) {
          userSites = us;
          if (legacy && legacy.length) {
            legacy.forEach(function (e) {
              if (!e || !e.name || !e.url) return;
              if (userSites.some(function (x) { return x.name === e.name; })) return;
              userSites.push({ name: e.name, url: e.url, aliases: Array.isArray(e.aliases) ? e.aliases.slice() : [] });
            });
          }
        } else {
          userSites = (legacy || []).filter(function (e) { return e && e.name && e.url; });
        }
        userSites = userSites.filter(function (e) { return e && e.name && e.url; });
        prefs = {
          autoCopyPaste: (data[PREFS_KEY] || {}).autoCopyPaste !== false,
          openInNewWindow: (data[PREFS_KEY] || {}).openInNewWindow !== false
        };
        render(d, (data && data[KEY]) || {});
        renderPrefs();
        renderCitations();
        renderOvCount();
        renderUserSites();
        renderRevise();
      });
    })
    .catch(function () { show('词典加载失败'); });
})();
