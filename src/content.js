/* 站点链接助手 · content script
 * 把网页文本中的站点名称转成可点击链接。
 * 思路参考 Auto Linkify（MIT，见 NOTICE.md）：TreeWalker + MutationObserver + 安全建节点。
 *
 * v1.7.0 新增：
 *  - 点击生成的链接默认新开一个浏览器窗口（而非新标签页），窗口位置智能避让：
 *    当前窗口半屏吸附在左就放右半屏、吸附在右就放左半屏，普通窗口则紧挨着放；
 *  - 总开关在设置页：siteLinker.prefs.openInNewWindow（默认开），与 autoCopyPaste 并列；
 *  - content script 没有 chrome.windows 权限：点击后经消息通道交给后台创建，
 *    屏幕尺寸由页面侧 window.screen 读得随消息带去（service worker 里拿不到）。
 *
 * v1.6.0 新增：
 *  - 点击生成的链接时，从所在句子提取《书名号》/ 引号 / 站点名后冒号的内容，复制并写入待粘贴队列；
 *  - 在新页面的空输入框上聚焦时自动粘贴（一次性，10 分钟内有效，不回贴来源页）；
 *  - 总开关在设置页：siteLinker.prefs.autoCopyPaste（默认开）。
 *  - 自添加站点独立存放（siteLinker.userSites），与词库修正（siteLinker.overrides）分离；
 *    旧版 overrides.custom 由 background.js 在更新时迁移，这里仍做读取回退兜底。
 *
 * v1.9.0 变更：
 *  - 一句多个引号 / 书名号全部复制：检索主题为“数字经济”与“税收”的文献，点链接复制到的是
 *    “数字经济 税收”（按出现顺序空格相连，去重、跳过与站点名相同的片段）；
 *    书名号优先于引号的规则不变，同类一个都取不到才回退到冒号规则。
 *  - 自动粘贴改为“窗口内可粘多次”：待粘贴队列记下点击链接时打开的那个浏览器窗口
 *    （不开新窗口时记当前窗口），只有那个窗口里聚焦空输入框才粘，且可以粘多次——
 *    高级检索有几个检索框就粘几次，粘过的地方有内容不会重复粘；
 *    换窗口不粘、不粘回来源页、iframe 里不粘、10 分钟有效，都不变。
 */
(function () {
  'use strict';

  var MARK_ATTR = 'data-site-linker';
  var SENTENCE_ATTR = 'data-sl-sentence';
  var STORAGE_KEY = 'siteLinker.categories';
  var OVERRIDE_KEY = 'siteLinker.overrides';
  var USERSITES_KEY = 'siteLinker.userSites';
  var PREFS_KEY = 'siteLinker.prefs';
  var PENDING_KEY = 'siteLinker.pendingPaste';   // 存 storage.local：待自动粘贴的文本
  var PASTE_TTL_MS = 10 * 60 * 1000;             // 待粘贴队列有效期 10 分钟
  var DEBOUNCE_MS = 350;

  // 安全跳过区：代码块、表单控件、已有链接、可编辑区、媒体容器
  // v2.0.0：末位补信源体检卡宿主 [data-sl-citation-card]——TreeWalker 本来就不进 shadow root，
  // 这里再加一道保险，防的是哪天卡片宿主被换成 light DOM 时卡片文字自己把自己链接化（清单 C4）。
  var SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'textarea', 'select', 'option',
    'button', 'input', 'datalist', 'output', 'code', 'pre', 'kbd', 'samp', 'var',
    'svg', 'math', 'canvas', 'audio', 'video', 'iframe', 'object', 'embed', 'applet',
    'a', '[' + MARK_ATTR + ']', '[contenteditable=""]', '[contenteditable="true"]',
    '[data-sl-citation-card]'
  ].join(',');

  var DICT = null;
  var state = {
    mapCS: new Map(),   // 精确文本 -> 词条（大小写敏感）
    mapCI: new Map(),   // 小写文本 -> 词条（大小写不敏感）
    reCS: null,
    reCI: null,
    exclusions: []
  };
  var prefs = { autoCopyPaste: true, openInNewWindow: true };

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isAscii(s) {
    return /^[\x00-\x7F]+$/.test(s);
  }

  // 英文/数字术语加词边界；含中文的术语直接匹配（中文没有词边界）
  function termPattern(term) {
    var esc = escapeRegExp(term);
    if (/^[A-Za-z0-9 .&+'\-]+$/.test(term)) {
      return '\\b' + esc + '\\b';
    }
    return esc;
  }

  function buildMatchers(dict, enabledCats) {
    var csTerms = [];
    var ciTerms = [];
    state.mapCS = new Map();
    state.mapCI = new Map();
    state.exclusions = dict.exclusions || [];

    dict.categories.forEach(function (cat) {
      if (!enabledCats[cat.id]) return;
      cat.entries.forEach(function (e) {
        if (!/^https?:\/\//.test(e.url || '')) return; // 只允许 http/https，防伪协议
        var entry = { name: e.name, url: e.url };
        var terms = [e.name].concat(e.aliases || []);
        terms.forEach(function (t) {
          if (!t) return;
          if (isAscii(t)) {
            if (!state.mapCS.has(t)) state.mapCS.set(t, entry);
            csTerms.push(t);
            if (!e.cs) { // cs 词条（Nature/Science 等）不生成小写变体，避免常用词误报
              var low = t.toLowerCase();
              if (low !== t) {
                if (!state.mapCI.has(low)) state.mapCI.set(low, entry);
                ciTerms.push(low);
              }
            }
          } else {
            if (!state.mapCS.has(t)) state.mapCS.set(t, entry);
            csTerms.push(t);
          }
        });
      });
    });

    // 长词优先：按长度降序，正则交替时先命中长词
    csTerms.sort(function (a, b) { return b.length - a.length; });
    ciTerms.sort(function (a, b) { return b.length - a.length; });

    state.reCS = csTerms.length
      ? new RegExp(csTerms.map(function (t) { return '(' + termPattern(t) + ')'; }).join('|'), 'g')
      : null;
    state.reCI = ciTerms.length
      ? new RegExp(ciTerms.map(function (t) { return '(' + termPattern(t) + ')'; }).join('|'), 'gi')
      : null;
  }

  function findMatches(text) {
    var found = [];
    function collect(re, map, lower) {
      if (!re) return;
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        var key = lower ? m[0].toLowerCase() : m[0];
        var entry = map.get(key);
        if (entry) found.push({ start: m.index, end: m.index + m[0].length, text: m[0], entry: entry });
      }
    }
    collect(state.reCS, state.mapCS, false);
    collect(state.reCI, state.mapCI, true);
    if (found.length < 2) return found;
    // 同位置取更长者，并去掉重叠区间
    found.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var out = [];
    var lastEnd = -1;
    found.forEach(function (f) {
      if (f.start >= lastEnd) { out.push(f); lastEnd = f.end; }
    });
    return out;
  }

  // 误报屏蔽：匹配落在屏蔽词组内则跳过（如"万方"命中"万方科技"）
  function inExclusion(text, start, end) {
    if (!state.exclusions.length) return false;
    for (var i = 0; i < state.exclusions.length; i++) {
      var ex = state.exclusions[i];
      var idx = text.indexOf(ex);
      while (idx !== -1) {
        if (start < idx + ex.length && idx < end) return true;
        idx = text.indexOf(ex, idx + 1);
      }
    }
    return false;
  }

  function linkifyNode(node) {
    var text = node.nodeValue;
    if (!text) return;
    var matches = findMatches(text);
    if (!matches.length) return;
    var frag = document.createDocumentFragment();
    var last = 0;
    var changed = false;
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (inExclusion(text, m.start, m.end)) continue;
      if (m.start > last) frag.appendChild(document.createTextNode(text.slice(last, m.start)));
      var a = document.createElement('a');
      a.href = m.entry.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'site-linker-link';
      a.setAttribute(MARK_ATTR, '1');
      a.setAttribute(SENTENCE_ATTR, sentenceAt(text, m.start)); // 点击时用来提取要复制的内容
      a.title = m.entry.name + ' → ' + m.entry.url;
      a.textContent = m.text;
      frag.appendChild(a);
      last = m.end;
      changed = true;
    }
    if (!changed) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function collectTextNodes(root) {
    var nodes = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        try {
          if (p.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        } catch (err) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function processRoot(root) {
    if (!state.reCS && !state.reCI) return;
    var nodes = collectTextNodes(root);
    for (var i = 0; i < nodes.length; i++) linkifyNode(nodes[i]);
  }

  /* ---- 动态页面：MutationObserver + 防抖 ---- */
  var timer = null;
  function scheduleProcess() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      var run = function () {
        processRoot(document.body || document.documentElement);
        // v2.0.0 信源体检：链接化之后再接着跑体检，两件事互不影响（清单 C6）
        scheduleCitationAudit();
      };
      if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 1000 });
      else run();
    }, DEBOUNCE_MS);
  }

  // 识别自身造成的变更，避免自我触发
  function isOwnMutation(muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'characterData') return false;
      if (m.type !== 'childList') continue;
      for (var j = 0; j < m.addedNodes.length; j++) {
        var n = m.addedNodes[j];
        if (n.nodeType === 1 && !n.hasAttribute(MARK_ATTR)) return false;
      }
      for (var k = 0; k < m.removedNodes.length; k++) {
        if (m.removedNodes[k].nodeType !== 3) return false;
      }
    }
    return true;
  }

  var observer = new MutationObserver(function (muts) {
    if (isOwnMutation(muts)) return;
    scheduleProcess();
  });

  // 撤销本插件生成的全部链接（分类开关变化时用）
  function unwrapAll() {
    var links = document.querySelectorAll('a[' + MARK_ATTR + ']');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var t = document.createTextNode(a.textContent);
      a.parentNode.replaceChild(t, a);
    }
  }

  function enabledCategories(dict, saved) {
    var enabled = {};
    dict.categories.forEach(function (c) { enabled[c.id] = saved[c.id] !== false; });
    return enabled;
  }

  function loadDictionary() {
    return fetch(chrome.runtime.getURL('src/dictionary.json'))
      .then(function (r) { return r.json(); })
      .catch(function () {
        // 兜底：问后台 service worker 要（个别页面里 content script 直接 fetch 会失败）
        return new Promise(function (resolve) {
          try {
            chrome.runtime.sendMessage({ type: 'siteLinker:getDictionary' }, function (resp) {
              if (chrome.runtime.lastError || !resp || !resp.ok) resolve(null);
              else resolve(resp.dict);
            });
          } catch (e) {
            resolve(null);
          }
        });
      });
  }

  function getSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(STORAGE_KEY, function (data) {
          resolve((data && data[STORAGE_KEY]) || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  function getOverrides() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(OVERRIDE_KEY, function (data) {
          resolve((data && data[OVERRIDE_KEY]) || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  function getPrefs() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(PREFS_KEY, function (data) {
          var p = (data && data[PREFS_KEY]) || {};
          resolve({
            autoCopyPaste: p.autoCopyPaste !== false,   // 缺省开
            openInNewWindow: p.openInNewWindow !== false // 缺省开
          });
        });
      } catch (e) {
        resolve({ autoCopyPaste: true, openInNewWindow: true });
      }
    });
  }

  function getUserSites() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get([USERSITES_KEY, OVERRIDE_KEY], function (data) {
          var list = data && data[USERSITES_KEY];
          if (!Array.isArray(list)) {
            // 旧版回退：自定义站点曾放在 overrides.custom 里（background.js 更新时已迁移）
            list = (data && data[OVERRIDE_KEY] && data[OVERRIDE_KEY].custom) || [];
          }
          resolve(list);
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  /* 用户修正层：改网址 / 补触发词 / 停用条目 / 自添加站点。
   * 自添加站点（userSites）单独一个键存放，与词库修正分离；匹配时仍排最前：
   * 同名术语“先入先得”，保证用户修正优先于词库命中。 */
  function applyOverrides(dict, ov, userSites) {
    ov = ov || {};
    var edits = ov.edits || {};
    var out = { version: dict.version, updated: dict.updated, exclusions: dict.exclusions, categories: [] };
    dict.categories.forEach(function (cat) {
      var entries = [];
      cat.entries.forEach(function (e) {
        var ed = edits[e.name];
        if (ed && ed.off) return;
        var copy = { name: e.name, url: e.url, aliases: (e.aliases || []).slice(), cs: e.cs };
        if (ed) {
          if (ed.url) copy.url = ed.url;
          if (ed.aliases && ed.aliases.length) copy.aliases = copy.aliases.concat(ed.aliases);
        }
        entries.push(copy);
      });
      out.categories.push({ id: cat.id, name: cat.name, desc: cat.desc, entries: entries });
    });
    var custom = [];
    (userSites || ov.custom || []).forEach(function (e) {
      if (e && e.name && e.url) custom.push({ name: e.name, url: e.url, aliases: (e.aliases || []).slice(), cs: e.cs });
    });
    out.categories.unshift({ id: 'custom', name: '自定义站点', desc: '你自己添加的站点（与词库分开存放）', entries: custom });
    return out;
  }

  var DICT_BASE = null;

  function rebuild(saved, ov, userSites) {
    DICT = applyOverrides(DICT_BASE, ov, userSites);
    buildMatchers(DICT, enabledCategories(DICT, saved));
  }

  function start(dict, saved, ov, userSites) {
    DICT_BASE = dict;
    rebuild(saved, ov, userSites);
    processRoot(document.body || document.documentElement);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  /* ================= 点击链接：自动复制 + 新页面自动粘贴 ================= */

  /* 断句：按中英文句末标点与换行切分，返回覆盖 start 的那一句 */
  function sentenceAt(text, start) {
    if (!text) return '';
    var re = /[^。！？；!?;\n\r]+/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0].trim()) continue;
      if (start >= m.index && start < m.index + m[0].length) return m[0];
    }
    return text;
  }

  /* 从句子里挑“要复制的关键词”，规则（按优先级）：
   * ① 《书名号》里的内容；② 各种引号 "…" “…” ‘…’ 「…」 『…』 里的内容；
   * ③ 站点名之后第一个冒号（：:）之后、到第一个逗号/句号为止的内容。
   * ①② 同句出现多个时全部收集，按出现顺序用空格连起来（v1.9.0：检索主题为“数字经济”
   * 与“税收”的文献，两个词都要），去重、跳过与站点名相同的片段；同类一个都取不到才往后掉。
   * 都取不到就返回空串——此时只打开链接，不复制。
   * 注意：故意不支持英文直单引号 '…'——会把 don't / he's 这类缩写切坏，所以文档里也别宣称支持它。 */
  var BOOK_RE = /《([^《》\n]{1,80})》/g;
  var QUOTE_RE = /["“『‘「]([^"“”‘’『』「」\n]{1,80})["”’』」]/g;
  var MAX_QUOTE_TERMS = 8;    // 同一句最多收集多少个引号 / 书名号片段
  var MAX_QUOTE_CHARS = 120;  // 连起来的总长度上限，超出就丢尾部（搜索框粘太长没意义）
  var COLON_CUT_RE = /[\n\r，,。！？；;!?]/;
  // 冒号后只取到这些“没信息量”的词，视为没取到
  var COLON_JUNK = { '官网': 1, '首页': 1, '搜索': 1, '入口': 1, '链接': 1, '查看': 1, '一下': 1 };

  function cleanKeyword(s) {
    return (s || '')
      .replace(/^[\s"'“”‘’『』「」《》]+/, '')
      .replace(/[\s"'“”‘’『』「」《》，。！？；：、,.;:!?]+$/, '')
      .trim();
  }

  /* 用一条全局正则收集句子里所有片段内容（调用前复位 lastIndex，可反复用） */
  function collectSegments(re, sentence) {
    var out = [];
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(sentence)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push(m[1]);
    }
    return out;
  }

  /* 一组片段 → 干净、去重、去掉站点名本身的关键词数组（超量丢尾部） */
  function keywordsFrom(segments, siteText) {
    var kws = [];
    for (var i = 0; i < segments.length && kws.length < MAX_QUOTE_TERMS; i++) {
      var k = cleanKeyword(segments[i]);
      if (!k || k === siteText) continue;
      if (kws.indexOf(k) !== -1) continue;
      kws.push(k);
    }
    while (kws.length > 1 && kws.join(' ').length > MAX_QUOTE_CHARS) kws.pop();
    return kws;
  }

  function extractKeyword(sentence, siteText) {
    if (!sentence) return '';
    // ① 书名号、② 引号：同类有多个全复制；书名号优先，一个都取不到才看下一类
    var groups = [collectSegments(BOOK_RE, sentence), collectSegments(QUOTE_RE, sentence)];
    for (var g = 0; g < groups.length; g++) {
      var kws = keywordsFrom(groups[g], siteText);
      if (kws.length) return kws.join(' ');
    }
    // 冒号后：只认站点名之后的冒号（“站点：内容”），内容取到第一个逗号/句号
    var idx = sentence.indexOf(siteText);
    var from = idx === -1 ? 0 : idx + siteText.length;
    var ci = sentence.slice(from).search(/[：:]/);
    if (ci !== -1) {
      var rest = sentence.slice(from + ci + 1);
      var cut = rest.search(COLON_CUT_RE);
      if (cut !== -1) rest = rest.slice(0, cut);
      var k3 = cleanKeyword(rest);
      if (k3 && k3 !== siteText && !COLON_JUNK[k3]) return k3;
    }
    return '';
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('style', 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;');
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { /* 老页面忽略 */ }
      ta.remove();
      return ok;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(fallback); // http 页面等场景走兜底
        return;
      }
    } catch (err) { /* 继续走兜底 */ }
    fallback();
  }

  /* 组一条待粘贴记录：text 要粘的文本；win 生效窗口（null = 不限定窗口，粘一次即清）。
   * srcTop：点击发生在内嵌 iframe 里时，记下顶层页面地址（跨源 iframe 拿不到就留空），
   * 配合 onPasteFocus 的“不回贴来源页”判断用。 */
  function makePaste(text) {
    var srcTop = null;
    try { srcTop = window.top.location.href; } catch (e) { /* 跨源 iframe 里取不到顶层地址 */ }
    return { text: text, ts: Date.now(), src: location.href, srcTop: srcTop, win: null };
  }

  function writePending(p) {
    try {
      var data = {};
      data[PENDING_KEY] = p;
      chrome.storage.local.set(data);
    } catch (e) { /* 无 local 存储时只靠剪贴板 */ }
  }

  function clearPendingPaste() {
    try {
      var data = {};
      data[PENDING_KEY] = null;
      chrome.storage.local.set(data);
    } catch (e) { /* 忽略 */ }
  }

  /* 问后台“我在哪个浏览器窗口”：content script 拿不到 chrome.windows / chrome.tabs，
   * 只能经消息通道问，后台从 sender.tab.windowId 回答。拿不到返回 null。 */
  function myWindowId(cb) {
    try {
      chrome.runtime.sendMessage({ type: 'siteLinker:myWindow' }, function (resp) {
        if (chrome.runtime.lastError || !resp || resp.win == null) cb(null);
        else cb(resp.win);
      });
    } catch (e) { cb(null); }
  }

  /* 不开新窗口的点击（组合键 / “新窗口打开”开关关着）：队列限定在当前窗口，同样可粘多次 */
  function commitPaste(p) {
    myWindowId(function (win) {
      p.win = win;
      writePending(p);
    });
  }

  function showToast(msg) {
    try {
      var old = document.querySelector('.site-linker-toast');
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var d = document.createElement('div');
      d.className = 'site-linker-toast';
      d.textContent = msg;
      d.setAttribute('style',
        'position:fixed;right:16px;bottom:22px;z-index:2147483647;max-width:72vw;' +
        'background:#101828;color:#fff;font:13px/1.55 "Segoe UI","Microsoft YaHei",sans-serif;' +
        'padding:9px 14px;border-radius:8px;box-shadow:0 6px 20px rgba(16,24,40,.28);');
      (document.body || document.documentElement).appendChild(d);
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2800);
    } catch (e) { /* 忽略 */ }
  }

  /* 交给后台新开浏览器窗口：content script 没有 chrome.windows 权限，
   * 只能发消息；屏幕尺寸从页面侧读（service worker 里拿不到 screen）。
   * paste：这次点击要入队的待粘贴记录（没复制到内容时为 null）——窗口建好后，
   * 把队列限定在这个新窗口里（v1.9.0：只有它里面粘，且可粘多次）。
   * 后台没接住时退回 window.open，保证链接一定能打开。 */
  function requestWindow(url, paste) {
    var screen = { w: 0, h: 0 };
    try {
      screen = { w: window.screen.availWidth || 0, h: window.screen.availHeight || 0 };
    } catch (err) { /* 拿不到就传 0，后台会降级为系统默认级联 */ }
    function fallback() {
      // 后台没接住 / 建窗失败：按老规则落队列（不限窗口、粘一次即清），再退回 window.open
      if (paste) { paste.win = null; writePending(paste); }
      try { window.open(url, '_blank', 'noopener'); } catch (e) { /* 忽略 */ }
    }
    try {
      chrome.runtime.sendMessage(
        { type: 'siteLinker:openInWindow', url: url, screen: screen },
        function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok) { fallback(); return; }
          if (paste) {
            paste.win = resp.windowId == null ? null : resp.windowId;
            writePending(paste);
          }
        }
      );
    } catch (err) {
      fallback();
    }
  }

  function onLinkClick(e) {
    if (e.button !== 0) return; // 只响应左键（中键/右键不触发）
    var a = e.target && e.target.closest ? e.target.closest('a[' + MARK_ATTR + ']') : null;
    if (!a) return;

    /* ① 自动复制（v1.6.0）：与打开方式无关，任何点击（含组合键）都照常 */
    var paste = null;
    if (prefs.autoCopyPaste) {
      var sentence = a.getAttribute(SENTENCE_ATTR) || '';
      if (!sentence) {
        var host = a.parentElement;
        sentence = host ? (host.textContent || '') : '';
      }
      var kw = extractKeyword(sentence, a.textContent || '');
      if (kw) {
        copyText(kw);
        paste = makePaste(kw);
        showToast('已复制“' + kw + '”——打开后点输入框自动粘贴（可粘多次）');
      } else {
        // 这次点击没有可复制的内容：清掉上一次的待粘贴队列，避免粘到不相干的页面
        clearPendingPaste();
        showToast('这句里没有引号 / 《书名号》/ 冒号后的内容，已直接打开官网');
      }
    }

    /* ② 新开浏览器窗口（v1.7.0）：只拦"光秃秃的左键点击"；
     *    组合键（Ctrl/⌘/Shift/Alt）和中键一律交给浏览器默认行为（新标签页）。 */
    var combo = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
    if (prefs.openInNewWindow && !combo) {
      e.preventDefault(); // 不让浏览器按 target=_blank 开新标签页
      requestWindow(a.href, paste);
      return;
    }
    // 新标签页（浏览器默认 / 组合键 / 开关关着）：队列落在当前窗口
    if (paste) commitPaste(paste);
  }

  /* ---- 自动粘贴：新页面里聚焦到空输入框时，把队列里的文本粘进去 ---- */

  var PASTE_SKIP_SELECTOR = [
    'input[type=checkbox]', 'input[type=radio]', 'input[type=button]', 'input[type=submit]',
    'input[type=reset]', 'input[type=file]', 'input[type=color]', 'input[type=range]',
    'input[type=hidden]', 'input[type=password]', 'input[readonly]', 'input[disabled]',
    'textarea[readonly]', 'textarea[disabled]'
  ].join(',');

  function pasteTarget(el) {
    if (!el || el.nodeType !== 1) return null;
    try {
      if (el.closest(PASTE_SKIP_SELECTOR)) return null;
    } catch (err) { return null; }
    if (el.isContentEditable) return el;
    if (el.tagName === 'TEXTAREA') return el;
    if (el.tagName === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['text', 'search', 'url', 'tel', 'email', 'number'].indexOf(t) !== -1) return el;
    }
    return null;
  }

  function fieldEmpty(el) {
    if (el.isContentEditable) return !(el.textContent || '').trim();
    return !(el.value || '');
  }

  function insertText(el, text) {
    if (document.activeElement !== el) el.focus();
    if (!el.isContentEditable) {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch (err) { /* 忽略 */ }
    }
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (err) { /* 走手动兜底 */ }
    if (ok) return;
    if (el.isContentEditable) {
      var sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount) {
        var r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(document.createTextNode(text));
      } else {
        el.textContent = text;
      }
    } else {
      var s = el.selectionStart == null ? el.value.length : el.selectionStart;
      var e2 = el.selectionEnd == null ? s : el.selectionEnd;
      el.value = el.value.slice(0, s) + text + el.value.slice(e2);
      try { el.setSelectionRange(s + text.length, s + text.length); } catch (err2) { /* 忽略 */ }
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (err3) { /* 忽略 */ }
    }
  }

  // 插入过程中 focus() 可能再触发 focusin——用标志挡住，避免重复粘贴
  var pasting = false;

  function doPaste(el, p) {
    if (!fieldEmpty(el)) return;               // 异步期间用户可能已经输入
    pasting = true;
    try { insertText(el, p.text); } finally { pasting = false; }
    // 队列记了生效窗口（v1.9.0）：这个窗口里可粘多次，不清队列（10 分钟 TTL 照旧）；
    // 没记窗口的老队列（旧版本 / 后台没响应）：维持“只粘一次”
    if (!p.win) clearPendingPaste();
    showToast('已自动粘贴“' + p.text + '”');
  }

  function onPasteFocus(e) {
    if (pasting) return;
    // 只粘顶层页面：iframe 的 location.href 与 pendingPaste.src（顶层地址）不同，
    // “不回贴来源页”的判断会失效，来源页内嵌的 iframe 会被误粘
    if (window.top !== window) return;
    var el = pasteTarget(e.target);
    if (!el || !fieldEmpty(el)) return; // 只粘进空输入框，不打扰已有内容
    var store = chrome.storage && chrome.storage.local;
    if (!store) return;
    store.get(PENDING_KEY, function (data) {
      var p = data && data[PENDING_KEY];
      if (!p || !p.text) return;
      if (Date.now() - (p.ts || 0) > PASTE_TTL_MS) { clearPendingPaste(); return; }
      if (p.src && p.src === location.href) return; // 不回贴到来源页
      // 点击发生在来源页内嵌 iframe 时，来源页顶层本身也不回贴
      if (p.srcTop && p.srcTop === location.href) return;
      if (p.win) {
        // 队列记了生效窗口：只有那个浏览器窗口里才粘（v1.9.0 起可粘多次）
        myWindowId(function (myWin) {
          if (myWin === null || myWin !== p.win) return; // 别的窗口不粘
          doPaste(el, p);
        });
        return;
      }
      doPaste(el, p);
    });
  }

  document.addEventListener('click', onLinkClick, true);
  document.addEventListener('focusin', onPasteFocus, true);

  /* ================= v2.0.0 信源体检（src/citations/*） =================
   * 只在 AI 对话页跑：hostname 不匹配 adapters.js 的任何 urlPatterns，整条链路
   * 连 lists.json 都不去取，普通网页零开销（清单 C6）。
   * 体检这一路的任何异常都在 try/catch 里吞掉——它是附加物，
   * 绝不能把"站点链接化"这个主功能带下水（清单「回退」第 3 条）。 */
  var CIT = {
    adapter: null, lists: null, enabled: true, feedback: new Set(),
    busy: false, pending: false, lastSig: '', booted: false, timer: null,
    expanded: false   // 折叠区每站点只点一次（清单 §4.2 第 3 步），之后只读不点
  };

  function citMods() {
    var W = window;
    return (W.SL_CITATION_ADAPTERS && W.SL_CITATION_EXTRACT && W.SL_CITATION_AUDIT &&
      W.SL_CITATION_CARD && W.SL_CITATION_LEDGER) ? W : null;
  }

  /* 名单文件走已有的 siteLinker:getDictionary 通道带出来（不新增消息类型、不新增权限，
   * 清单 §4.1 / C7）。这里故意不做"先直接 fetch 扩展资源"的尝试：MV3 下 content script
   * 直接 fetch 自家资源必失败，浏览器控制台会多出一条 ERR_FAILED 噪音——词典那条是历史行为，
   * 新增的名单不再添一条。 */
  function loadCitationLists() {
    if (CIT.lists) return Promise.resolve(CIT.lists);
    return new Promise(function (resolve) {
      function done(lists) {
        CIT.lists = lists || { media: [], community: [], farmPatterns: [], selfDomains: [] };
        resolve(CIT.lists);
      }
      try {
        chrome.runtime.sendMessage({ type: 'siteLinker:getDictionary', withLists: true }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok) { done(null); return; }
          done(resp.lists);
        });
      } catch (e) { done(null); }
    });
  }

  function bootCitations() {
    try {
      if (CIT.booted) return;
      var W = citMods();
      if (!W) return;                                   // 模块没加载（老 manifest / 单页测试）：当没这功能
      if (window.top !== window) return;                // 体检卡只挂顶层，iframe 里不重复挂
      var adapter = W.SL_CITATION_ADAPTERS.matchAdapter(location.hostname);
      if (!adapter) return;                             // 非 AI 对话页：到此为止
      CIT.adapter = adapter;
      CIT.booted = true;
      W.SL_CITATION_LEDGER.isEnabled(function (on) {
        CIT.enabled = on !== false;
        if (!CIT.enabled) { CIT.adapter = null; return; }   // 总开关关了：回到 v1 行为
        W.SL_CITATION_LEDGER.feedbackHostSet(function (s) { CIT.feedback = s || new Set(); });
        loadCitationLists().then(function () { scheduleCitationAudit(1200); });
      });
    } catch (e) {
      CIT.adapter = null;
      if (global_console()) global_console().warn('[站点链接助手] 信源体检启动失败（已忽略）：', e && e.message);
    }
  }

  function global_console() { try { return console; } catch (e) { return null; } }

  function scheduleCitationAudit(delay) {
    if (!CIT.adapter || !CIT.enabled) return;
    if (CIT.timer) clearTimeout(CIT.timer);
    CIT.timer = setTimeout(runCitationAudit, delay || 900);
  }

  function runCitationAudit() {
    var W = citMods();
    if (!W || !CIT.adapter || !CIT.enabled) return;
    if (!DICT) return;               // 词典没到位就别判级——规则 4 要查词典域名索引
    if (CIT.busy) { CIT.pending = true; return; }
    if (!W.SL_CITATION_EXTRACT.isResponseComplete(document)) { scheduleCitationAudit(2000); return; }
    CIT.busy = true;
    try {
      W.SL_CITATION_EXTRACT.extractCitations(CIT.adapter, { skipExpand: CIT.expanded })
        .then(function (res) {
          CIT.expanded = true;   // 点过一次就不再替用户点，避免每次 DOM 变动都去戳页面
          renderCitationAudit(W, res);
        })
        .catch(function (err) {
          if (global_console()) global_console().warn('[站点链接助手] 体检异常（已忽略，不影响链接化）：', err && err.message);
        })
        .then(function () {
          CIT.busy = false;
          if (CIT.pending) { CIT.pending = false; scheduleCitationAudit(600); }
        });
    } catch (e) {
      CIT.busy = false;
      if (global_console()) global_console().warn('[站点链接助手] 体检异常（已忽略）：', e && e.message);
    }
  }

  function renderCitationAudit(W, res) {
    var turns = (res && res.turns) || [];
    var last = turns.length ? turns[turns.length - 1] : null;
    var ctx = { dict: DICT, lists: CIT.lists, adapter: CIT.adapter, feedbackHosts: CIT.feedback };
    var summary = W.SL_CITATION_AUDIT.summarizeTurn(last ? last.citations : [], ctx);
    var model = {
      platform: res.platform, platformLabel: CIT.adapter.label,
      status: res.ok ? 'ok' : 'fail', failReason: res.failReason,
      summary: summary, query: last ? last.query : '', turns: turns
    };
    // 一条空对话页（没有提问也没有来源）什么都不弹——避免"本条回答没有来源"的假告警
    if (res.ok && !summary.total && !model.query) return;
    // 只有"已校准站点什么都没抓到"才报改版。未校准站点（智谱清言/秘塔/星火）、流式中、
    // 提取异常一律不弹卡——校准没做完的站点天天弹"可能改版"，等于把插件自己变成噪音源。
    if (!res.ok && res.failReason !== 'empty') return;

    var sig = [res.platform, summary.total, summary.high, summary.mid, summary.pending,
      summary.claimed, (model.query || '').slice(0, 60)].join('|');
    if (res.ok && sig === CIT.lastSig) return;   // 同一轮重复触发：不重复弹卡、不重复记台账
    if (res.ok) CIT.lastSig = sig;

    W.SL_CITATION_CARD.renderCard(model, {
      onFeedback: function (items) {
        try {
          (items || []).forEach(function (it) {
            var d = it && it.citation && it.citation.domain;
            if (!d) return;
            if (it.audit.tier !== 'pending') return;
            W.SL_CITATION_LEDGER.addFeedback(d, { name: it.citation.title, url: it.citation.url });
            CIT.feedback.add(String(d).toLowerCase());
          });
          scheduleCitationAudit(400);   // 反馈完重算一遍：那条域名现在该显示"官方/权威"
        } catch (e) { /* 反馈失败不影响看卡 */ }
      }
    });

    if (res.ok) {
      try { W.SL_CITATION_LEDGER.appendRecord(W.SL_CITATION_LEDGER.recordFromModel(model)); }
      catch (e) { /* 台账写不进去就算了 */ }
    }
  }

  loadDictionary().then(function (dict) {
    if (!dict) {
      console.warn('[站点链接助手] 词典加载失败，插件未生效。请到 edge://extensions 点"重新加载"后刷新页面。');
      return;
    }
    Promise.all([getSettings(), getOverrides(), getUserSites(), getPrefs()]).then(function (r) {
      prefs = r[3];
      start(dict, r[0], r[1], r[2]);
      bootCitations();     // v2.0.0：链接化跑起来之后，再决定要不要跑体检（非 AI 站直接返回）
    });
  });

  // 开关 / 修正变化：撤销旧链接 -> 按新数据重建（已打开页面即时生效）
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (!DICT_BASE) return;
      // v2.0.0：体检总开关落在 storage.local。关掉 = 立刻回到 v1 行为（清单「回退」第 2 条），
      // 重新打开 = 当场接回体检链路，不用刷新页面。
      if (area === 'local' && changes['siteLinker.citations.enabled']) {
        var on = changes['siteLinker.citations.enabled'].newValue !== false;
        CIT.enabled = on;
        if (!on) {
          CIT.adapter = null;
          CIT.booted = false;
          try { if (window.SL_CITATION_CARD) window.SL_CITATION_CARD.hideCard(); } catch (e) { /* 忽略 */ }
        } else {
          bootCitations();
        }
        return;
      }
      if (area !== 'sync') return;
      if (changes[STORAGE_KEY] || changes[OVERRIDE_KEY] || changes[USERSITES_KEY]) {
        unwrapAll();
        Promise.all([getSettings(), getOverrides(), getUserSites()]).then(function (r) {
          rebuild(r[0], r[1], r[2]);
          processRoot(document.body || document.documentElement);
        });
      }
      if (changes[PREFS_KEY]) {
        var pv = changes[PREFS_KEY].newValue || {};
        prefs = {
          autoCopyPaste: pv.autoCopyPaste !== false,
          openInNewWindow: pv.openInNewWindow !== false
        };
      }
    });
  } catch (e) { /* 无 storage 权限时忽略 */ }
})();
