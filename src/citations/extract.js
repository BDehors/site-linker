/* 站点链接助手 · 信源体检 · 引用提取管线
 *
 * 只消费 adapters.js 的配置，不写任何站点专属分支（清单 C1 验收："新增一站只改
 * adapters.js，不动 extract.js"）。四种采集器由 source.kind 分发：
 *   link      —— <a href> 型（DeepSeek / Kimi / 豆包 / ChatGPT / 未校准三家）
 *   attr      —— URL 挂在自定义属性上（元宝 dt-ext6、Perplexity data-pplx-citation-url）
 *   scriptJson —— 引用不在 DOM 链接里，在 <script type="application/json"> 的 JSON 里（通义千问）
 *   panelItem —— 面板项只有标题+来源名+日期、没有链接（文心一言）→ 天生 named
 *
 * 输出结构（清单 §4.2 第 9 步）：
 *   { ok, failReason, turns: [{ query, citations: [{index,url,title,domain,state,context}] }] }
 *   state ∈ linked（有链接）| named（只有站名/标题、无链接）| claimed（提到来源但什么都没有）
 *
 * 口径纪律（清单 §6）：本文件只负责"识别到什么"，不判断真假、不给结论词，
 * 分级与话术在 audit.js / card.js。
 */
(function (global) {
  'use strict';

  var MAX_URL_LEN = 2048;
  var CONTEXT_CHARS = 50;        // 角标前后各取 50 字，供品牌词比对（清单 §4.2 第 4b 步）
  var DEFAULT_CLICK_GAP_MS = 500; // 点击是"代替用户操作"，节奏要慢（清单 §3.3 坑 2）
  var DEFAULT_PANEL_WAIT_MS = 700;
  var MAX_UNWRAP = 3;            // 中转链接最多解包 3 层，防死循环
  var UNWRAP_PARAMS_DEFAULT = ['url', 'target', 'u', 'redirect_url'];

  // 子域归一表：只为"同一个站别列两行"（清单 §4.2 第 6 步）；
  // 官网判定不用这张表——官方子域按"等于词条域或以 .词条域 结尾"算（见 audit.js）。
  var SUBDOMAIN_MAP = {
    'zhuanlan.zhihu.com': 'zhihu.com',
    'blog.csdn.net': 'csdn.net',
    'download.csdn.net': 'csdn.net',
    'juejin.im': 'juejin.cn'
  };

  // "声称来源但无链接"的文本级探测（清单 §4.3）。误报率高——"根据相关数据"也会命中，
  // 上线前要用 20 个真实页面调参；没调明白之前默认只跑 UI 级（保守，宁少勿多）。
  var TEXT_CLAIMED_RE = /(根据|据)([^，。；！\n]{2,15})(报道|发布|消息|官网|公告|数据)/g;
  var TEXT_CLAIMED_ENABLED = false;

  var GENERATING_RE = /(loading|streaming|typing|generating|in-progress|thinking)/i;

  function qAll(selector, root) {
    try {
      var list = (root || document).querySelectorAll(selector);
      return Array.prototype.slice.call(list);
    } catch (e) {
      return [];   // 选择器写错 / 老浏览器语法不支持：当没命中，绝不抛出
    }
  }

  function qOne(selector, root) {
    var list = qAll(selector, root);
    return list.length ? list[0] : null;
  }

  function textOf(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) : s;
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      if (!(ms > 0)) { resolve(); return; }
      setTimeout(resolve, ms);
    });
  }

  /* ================= §4.2 第 2 步：等回答生成完 ================= */

  /* 页面上还有 loading/streaming/typing/generating 之类的元素，就认为没写完
   * （复用 content.js 那套"按类名判断"的思路，清单 C2）。 */
  function isResponseComplete(doc) {
    var d = doc || document;
    var nodes;
    try {
      nodes = d.querySelectorAll('[class*="loading"],[class*="streaming"],[class*="typing"],[class*="generating"]');
    } catch (e) {
      return true;
    }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.offsetWidth === undefined) continue;        // jsdom / 脱离布局：只看可见性
      var hidden = (el.getAttribute && el.getAttribute('aria-hidden')) === 'true';
      if (!hidden) return false;
    }
    return true;
  }

  /* ================= §4.2 第 5、6 步：URL 清洗与域名归一化 ================= */

  function parseUrl(raw, baseUrl) {
    if (!raw) return null;
    var s = String(raw).trim();
    if (!s || s.length > MAX_URL_LEN) return null;
    if (/^(javascript|data|vbscript|blob):/i.test(s)) return null;   // 防伪协议
    try {
      return new URL(s, baseUrl || (typeof document !== 'undefined' ? document.baseURI : 'https://example.com/'));
    } catch (e) {
      return null;
    }
  }

  /* 删参数：utm_* 一律删，其余按各站 stripParams / 通配前缀处理 */
  function dropParams(u, extra) {
    var doomed = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id'];
    (extra || []).forEach(function (p) { if (doomed.indexOf(p) === -1) doomed.push(p); });
    doomed.forEach(function (p) {
      try { u.searchParams.delete(p); } catch (e) { /* 不支持 URLSearchParams 时忽略 */ }
    });
    // 兜底：URLSearchParams 不可用时，用字符串删 utm_xxx=
    try {
      u.search = u.search.replace(/[?&]utm_[a-z]+=[^&]*/gi, '');
      if (u.search === '?') u.search = '';
    } catch (e) { /* 忽略 */ }
  }

  /* 解中转链接：?url= / ?target= / ?u= 里才是真实出处（Perplexity、部分豆包中转页）。
   * 只做字符串解析，绝不发网络请求（清单 §3.3 坑 3 + §7「明确不做」）。 */
  function unwrapRedirect(u, params) {
    var names = (params && params.length ? params : UNWRAP_PARAMS_DEFAULT);
    var cur = u, depth = 0;
    while (depth < MAX_UNWRAP) {
      var inner = null;
      for (var i = 0; i < names.length; i++) {
        var v = null;
        try { v = cur.searchParams.get(names[i]); } catch (e) { v = null; }
        if (v) { inner = v; break; }
      }
      if (!inner) break;
      var next = parseUrl(inner, cur.href);
      if (!next || next.host === cur.host) break;
      cur = next;
      depth++;
    }
    return cur;
  }

  /**
   * 清洗一个引用 URL：相对转绝对 → 只留 http/https → 解中转包 → 删 utm_* →
   * 截 #:~:text= 文本片段（ChatGPT/defuddle 都要处理这个）。
   * 返回 {url, host, domain, viaRedirect} 或 null（非 http/https 视为无效引用）。
   */
  function cleanCitationUrl(raw, opts) {
    opts = opts || {};
    var u = parseUrl(raw, opts.baseUrl);
    if (!u) return null;
    if (!/^https?:$/.test(u.protocol)) return null;
    var viaRedirect = false;
    var unwrapped = unwrapRedirect(u, opts.unwrapParams);
    if (unwrapped !== u) { viaRedirect = true; u = unwrapped; }
    dropParams(u, opts.stripParams);
    // #:~:text= 媒体片段：截掉，其余 fragment 保留
    try {
      if (u.hash && u.hash.indexOf(':~:text=') === 1) u.hash = '';
    } catch (e) { /* 忽略 */ }
    try { u.hash = u.hash.replace(/#?:~:text=[\s\S]*$/i, ''); } catch (e) { /* 忽略 */ }

    var host = (u.hostname || '').toLowerCase();
    return {
      url: u.href.replace(/#$/, ''),
      host: host,
      domain: normalizeDomain(host),
      viaRedirect: viaRedirect
    };
  }

  /** 去 www + 端口 + 子域归一表，用于"同一个站别列两行" */
  function normalizeDomain(host) {
    var h = (host || '').toLowerCase().replace(/^www\./, '');
    if (SUBDOMAIN_MAP[h]) h = SUBDOMAIN_MAP[h];
    return h;
  }

  /** 去重用的键：归一化域名 + 路径（去掉尾斜杠与 fragment） */
  function dedupeKey(cleaned) {
    if (!cleaned) return '';
    var u = parseUrl(cleaned.url, 'https://example.com/');
    if (!u) return cleaned.domain;
    var path = (u.pathname || '/').replace(/\/+$/, '');
    var query = u.search || '';
    return cleaned.domain + (path === '' ? '/' : path) + query;
  }

  /* ================= §4.2 第 3 步：展开折叠区 ================= */

  /* 按配置点开折叠区（豆包思考框 / ChatGPT 来源钮 / Kimi 角标浮层 / 元宝抽屉）。
   * 每站点最多一轮；done 选择器已命中就整轮跳过；点击间隔 500ms。 */
  function expandAdapter(adapter, opts) {
    var gap = (opts && opts.clickGapMs != null) ? opts.clickGapMs : DEFAULT_CLICK_GAP_MS;
    var exp = adapter && adapter.expand;
    if (!exp || !exp.selector) return Promise.resolve({ clicked: 0, skipped: true });
    if (exp.done && qOne(exp.done)) return Promise.resolve({ clicked: 0, skipped: true });

    var cands = qAll(exp.selector);
    if (exp.textHas && exp.textHas.length) {
      cands = cands.filter(function (el) {
        var t = textOf(el);
        return exp.textHas.every(function (w) { return t.indexOf(w) !== -1; });
      });
    }
    var max = exp.maxClicks || 8;
    cands = cands.slice(0, max);

    var i = 0;
    function step() {
      if (i >= cands.length) return Promise.resolve(null);
      var el = cands[i++];
      // 附近已经有引用链接 → 这条是已展开的，跳过（清单 §3.2 豆包段）
      var scope = el && el.parentElement ? el.parentElement.parentElement : null;
      if (exp.done && scope && qOne(exp.done, scope)) return step();
      try { if (typeof el.click === 'function') el.click(); } catch (e) { /* 点不动就算了 */ }
      return wait(gap).then(step);
    }
    return step().then(function () {
      return { clicked: cands.length, skipped: false };
    });
  }

  /* ================= §4.2 第 4 步：采集 ================= */

  function titleFromEl(el, source) {
    if (source.titleFrom && source.titleFrom.indexOf('attr:') === 0) {
      var attr = source.titleFrom.slice(5);
      var v = el.getAttribute && el.getAttribute(attr);
      if (v) return String(v);
    }
    if (source.titleFrom && source.titleFrom.indexOf('child:') === 0) {
      var child = qOne(source.titleFrom.slice(6), el);
      if (child) return textOf(child);
    }
    return textOf(el);
  }

  function urlFromEl(el, source, baseUrl, adapter) {
    var raw = null;
    if (source.urlFrom && source.urlFrom.indexOf('attr:') === 0) {
      raw = el.getAttribute && el.getAttribute(source.urlFrom.slice(5));
    } else if (source.urlFrom === 'dataUrl' || source.urlFrom === 'href') {
      raw = el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-url'));
    } else {
      raw = (el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-url'))) ||
        (el.href && String(el.href)) || null;
    }
    return cleanCitationUrl(raw, {
      baseUrl: baseUrl,
      stripParams: adapter && adapter.stripParams,
      unwrapParams: adapter && adapter.unwrapParams
    });
  }

  /* kind: 'link' | 'attr' —— 从 DOM 元素上取 URL，state=linked */
  function collectFromElements(adapter, source, scope, baseUrl) {
    var out = [];
    var els = qAll(source.selector, scope);
    els.forEach(function (el) {
      if (!el || !el.getAttribute) return;
      var cleaned = urlFromEl(el, source, baseUrl, adapter);
      if (!cleaned) return;
      var title = truncate(titleFromEl(el, source), 160);
      var cid = null;
      if (source.cidFrom && source.cidFrom.indexOf('attr:') === 0) {
        cid = (el.getAttribute && el.getAttribute(source.cidFrom.slice(5))) || null;
      }
      // 标题来自属性（元宝抽屉的 dt-ext3 就是平台自己署的"来源名"）时，同一个值也填进 siteName：
      // 规则 6"自称与域名不符"要比对的就是这个平台署名，而链接文本（正文里的 <a>）不是署名。
      var siteName = (source.titleFrom && source.titleFrom.indexOf('attr:') === 0) ? title : '';
      // 标题取不到就退回域名（Perplexity 那家的处理思路：找不到标题文本就用域名）
      out.push({
        url: cleaned.url, domain: cleaned.host, baseDomain: cleaned.domain,
        title: title || cleaned.domain, siteName: siteName,
        state: 'linked', viaRedirect: cleaned.viaRedirect,
        cid: cid, sourceKind: source.kind, note: source.note || ''
      });
    });
    return out;
  }

  /* kind: 'scriptJson' —— 解析 <script type="application/json"> 里的 JSON（通义千问） */
  function collectFromScriptJson(adapter, source, scope, baseUrl) {
    var out = [];
    var scripts = qAll(source.selector, scope);
    var fields = source.fields || {};
    scripts.forEach(function (sc) {
      var data = null;
      try { data = JSON.parse(sc.textContent || ''); } catch (e) { return; }
      var list = getPath(data, source.path);
      if (!Array.isArray(list)) list = list ? [list] : [];
      list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var rawUrl = fields.url ? item[fields.url] : null;
        var title = fields.title ? String(item[fields.title] || '') : '';
        var site = fields.site ? String(item[fields.site] || '') : '';
        var time = fields.time ? String(item[fields.time] || '') : '';
        var cleaned = rawUrl ? cleanCitationUrl(String(rawUrl), {
          baseUrl: baseUrl, stripParams: adapter && adapter.stripParams
        }) : null;
        if (cleaned) {
          out.push({
            url: cleaned.url, domain: cleaned.host, baseDomain: cleaned.domain,
            title: truncate(title || cleaned.domain, 160), siteName: site, time: time,
            state: 'linked', viaRedirect: cleaned.viaRedirect, sourceKind: 'scriptJson',
            note: source.note || ''
          });
        } else if (title || site) {
          // JSON 里给了标题/来源名但没给可用链接 → 半来源
          out.push({
            url: null, domain: null, baseDomain: null,
            title: truncate(title, 160), siteName: site, time: time,
            state: 'named', sourceKind: 'scriptJson', note: source.note || ''
          });
        }
      });
    });
    return out;
  }

  /* kind: 'panelItem' —— 面板项无 href（文心一言）→ named（拍板 §8-3 = A：单列一行、不判档） */
  function collectFromPanel(adapter, source, scope) {
    var out = [];
    var containers = qAll(source.container, scope);
    containers.forEach(function (panel) {
      var picked = [];
      qAll(source.item, panel).forEach(function (item) {
        // [class*="item__"] 这类包含式匹配会连内层嵌套的容器一起吃掉；
        // 外层已经收过的，内层不再单独算一条（否则同一条来源在卡上出现两遍）
        var nested = false;
        for (var k = 0; k < picked.length; k++) {
          if (contains(picked[k], item)) { nested = true; break; }
        }
        if (nested) return;
        picked.push(item);
        var title = source.title ? textOf(qOne(source.title, item)) : textOf(item);
        var site = source.site ? textOf(qOne(source.site, item)) : '';
        var date = source.date ? textOf(qOne(source.date, item)) : '';
        if (!title && !site) return;
        out.push({
          url: null, domain: null, baseDomain: null,
          title: truncate(title, 160), siteName: truncate(site, 60), time: date,
          state: 'named', sourceKind: 'panelItem', note: source.note || ''
        });
      });
    });
    return out;
  }

  function getPath(obj, path) {
    if (!path) return obj;
    var segs = String(path).replace(/\[\]$/, '').split('.');
    var cur = obj;
    for (var i = 0; i < segs.length; i++) {
      if (cur == null) return null;
      cur = cur[segs[i]];
    }
    return cur == null ? null : cur;
  }

  /* 无 URL 兜底项：元宝深度思考区只有文档标题（清单 §3.2 元宝段） */
  function collectNamedFallback(adapter, scope) {
    var fb = adapter.namedFallback;
    if (!fb || !fb.container) return [];
    return qAll(fb.container, scope).map(function (el) {
      return {
        url: null, domain: null, baseDomain: null,
        title: truncate(textOf(el), 160), siteName: '', state: 'named',
        sourceKind: 'namedFallback', note: '深度思考区标题，无链接'
      };
    }).filter(function (c) { return c.title; });
  }

  /* 正文角标：记录编号 + 前后 50 字上下文（供 audit.js 规则 6 品牌词比对） */
  function collectMarkers(adapter, scope) {
    var sels = (adapter.citeMarker || []).concat(
      adapter.citeTrigger ? [adapter.citeTrigger.outer] : []);
    var seen = [];
    sels.forEach(function (sel) {
      qAll(sel, scope).forEach(function (el) {
        if (!el || seen.indexOf(el) !== -1) return;
        seen.push(el);
      });
    });
    return seen.map(function (el) {
      var num = (textOf(el).match(/\d{1,3}/) || [])[0] || '';
      var host = el.parentElement;
      var around = textOf(host);
      var pos = num ? around.indexOf(num) : -1;
      var ctx = around;
      if (pos > 0) {
        ctx = around.slice(Math.max(0, pos - CONTEXT_CHARS), pos + CONTEXT_CHARS + 4);
      }
      return { num: num, text: truncate(textOf(el), 20), context: truncate(ctx, CONTEXT_CHARS * 2 + 8) };
    });
  }

  /* 采集一个作用域内的全部来源：sources 数组里每个描述符都跑，事后按 URL 去重
   * （主选命中时备选不会重复计入；主选失效时备选自动顶上——比"短路返回"更抗改版）
   * filterFn 用于区分"轮内采集"与"全页采集"（抽屉 / 全局面板 / script JSON 属后者）。 */
  function collectSources(adapter, scope, baseUrl, filterFn) {
    var raw = [];
    (adapter.sources || []).forEach(function (src) {
      if (filterFn && !filterFn(src)) return;
      if (src.kind === 'link' || src.kind === 'attr') {
        raw = raw.concat(collectFromElements(adapter, src, scope, baseUrl));
      } else if (src.kind === 'scriptJson') {
        raw = raw.concat(collectFromScriptJson(adapter, src, scope, baseUrl));
      } else if (src.kind === 'panelItem') {
        raw = raw.concat(collectFromPanel(adapter, src, scope));
      }
    });
    if (adapter.namedFallback) raw = raw.concat(collectNamedFallback(adapter, scope));
    return dedupeCitations(raw);
  }

  /* §4.2 第 7 步：去重——linked 按归一化 URL；named 按「标题+来源名」 */
  function dedupeCitations(list) {
    var byKey = {};
    var out = [];
    list.forEach(function (c) {
      var key = c.state === 'linked' ? 'L|' + dedupeKey(c) : c.state + '|' + (c.title || '') + '|' + (c.siteName || '');
      if (byKey[key]) return;
      byKey[key] = true;
      out.push(c);
    });
    out.forEach(function (c, i) { c.index = i + 1; });
    return out;
  }

  /* ================= §4.2 第 8 步：轮次配对 ================= */

  function isKind(el, selectors) {
    if (!el || !el.matches || !selectors) return null;
    for (var i = 0; i < selectors.length; i++) {
      try {
        if (el.matches(selectors[i])) return i;
      } catch (e) { /* 忽略非法选择器 */ }
    }
    return null;
  }

  /* 文档顺序收集 user / ai 元素，剔除"外层已收、内层重复"的嵌套命中 */
  function collectRoleEls(adapter, doc) {
    var d = doc || document;
    var r = adapter.rounds || {};
    var user = [], ai = [];
    (r.user || []).forEach(function (sel) {
      qAll(sel, d).forEach(function (el) {
        // 文心式："外层 class 同时含 flowBox 的才是真问题"（清单 §3.2 文心段）
        if (r.userFilterRe && !new RegExp(r.userFilterRe).test(String(el.className || ''))) return;
        if (!dupNested(user, el)) user.push(el);
      });
    });
    (r.ai || []).forEach(function (sel) {
      qAll(sel, d).forEach(function (el) {
        if (r.aiFilterRe && !new RegExp(r.aiFilterRe).test(String(el.className || ''))) return;
        if (!dupNested(ai, el)) ai.push(el);
      });
    });
    return { user: user, ai: ai };
  }

  function dupNested(list, el) {
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === el) return true;
      if (contains(other, el) || contains(el, other)) return true;
    }
    return false;
  }

  function contains(a, b) {
    try { return !!(a && b && a !== b && (a.compareDocumentPosition(b) & 16)); } catch (e) { return false; }
  }

  function docOrderBefore(a, b) {
    try { return !!(a.compareDocumentPosition(b) & 4); } catch (e) { return false; }
  }

  /**
   * 切轮次：用户消息块 → 紧随其后的 AI 消息块。
   * 元宝用 dt-cid ↔ data-conv-id 配对（清单 §4.2 第 8 步），其余按文档顺序 zip；
   * 文心 DOM 逆序，先 reverse 再 zip（reverseRounds）。
   */
  function buildTurns(adapter, doc) {
    var roles = collectRoleEls(adapter, doc);
    var merged = [];
    roles.user.forEach(function (el) { merged.push({ kind: 'user', el: el }); });
    roles.ai.forEach(function (el) { merged.push({ kind: 'ai', el: el }); });
    merged.sort(function (a, b) {
      if (a.el === b.el) return 0;
      return docOrderBefore(a.el, b.el) ? -1 : 1;
    });
    if (adapter.reverseRounds) merged.reverse();

    var turns = [];
    var current = null;
    merged.forEach(function (item) {
      var convId = adapter.rounds && adapter.rounds.convIdAttr
        ? item.el.getAttribute && item.el.getAttribute(adapter.rounds.convIdAttr) : null;
      if (item.kind === 'user') {
        current = {
          query: queryTextOf(adapter, item.el),
          queryEl: item.el, aiEls: [], convId: convId || null
        };
        turns.push(current);
      } else {
        if (!current) {
          current = { query: '', queryEl: null, aiEls: [], convId: convId || null };
          turns.push(current);
        }
        if (convId && !current.convId) current.convId = convId;
        current.aiEls.push(item.el);
      }
    });
    // 一家都没配对出来（页面结构猜错 / 未登录页）→ 退回"整页一轮"，别丢数据
    if (!turns.length) {
      turns = [{ query: '', queryEl: null, aiEls: [], convId: null }];
    }
    return turns;
  }

  function queryTextOf(adapter, el) {
    var r = adapter.rounds || {};
    if (r.userText) {
      for (var i = 0; i < r.userText.length; i++) {
        var inner = qOne(r.userText[i], el);
        if (inner && textOf(inner)) return truncate(textOf(inner), 300);
      }
    }
    return truncate(textOf(el), 300);
  }

  function aiScopeOf(adapter, turn) {
    var r = adapter.rounds || {};
    if (!turn.aiEls.length) return null;
    if (r.aiText) {
      for (var i = 0; i < r.aiText.length; i++) {
        var inner = qOne(r.aiText[i], turn.aiEls[0]);
        if (inner) return inner;
      }
    }
    return turn.aiEls[0];
  }

  /* ================= §4.3 claimed 三态 ================= */

  /* UI 级：有"参考 N 个网页"这类触发文本，但一条来源都没提取到 → claimed。
   * 注意判据是"什么条目都没拿到"，不是"没拿到链接"：文心那种只有标题+来源名的面板
   * 已经作为 named 行列出来了，再补一行 claimed 就是同一件事数两遍（拍板 §8-3 = A）。 */
  function detectUiClaimed(adapter, scopeEl, collected) {
    if (collected && collected.length) return [];
    var hits = [];
    var scopeText = scopeEl ? textOf(scopeEl) : '';
    var re = adapter.claimedText && adapter.claimedText.triggerRe;
    if (re) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(scopeText)) !== null) {
        hits.push({
          url: null, domain: null, baseDomain: null,
          title: truncate(m[0], 80), siteName: '', state: 'claimed',
          sourceKind: 'uiTrigger', note: 'UI 声称有来源'
        });
        if (re.global !== true) break;
      }
    }
    if (!hits.length && adapter.citeTrigger) {
      var trig = qAll(adapter.citeTrigger.outer, scopeEl);
      trig.forEach(function (el) {
        var t = adapter.citeTrigger.inner ? textOf(qOne(adapter.citeTrigger.inner, el)) : textOf(el);
        if (t && new RegExp(adapter.citeTrigger.textRe).test(t)) {
          hits.push({
            url: null, domain: null, baseDomain: null, title: truncate(t, 80),
            siteName: '', state: 'claimed', sourceKind: 'uiTrigger', note: '引用钮存在但面板没读到链接'
          });
        }
      });
    }
    return hits;
  }

  /* 文本级：正文"根据 XX 报道"且同段无 <a>。误报率高，默认关（见文件头 TEXT_CLAIMED_ENABLED） */
  function detectTextClaimed(scopeEl) {
    if (!scopeEl || !TEXT_CLAIMED_ENABLED) return [];
    var out = [];
    var paras = qAll('p, li, div', scopeEl);
    TEXT_CLAIMED_RE.lastIndex = 0;
    paras.forEach(function (p) {
      var t = textOf(p);
      if (!t) return;
      var hasLink = qAll('a[href^="http"]', p).length > 0;
      if (hasLink) return;
      TEXT_CLAIMED_RE.lastIndex = 0;
      var m = TEXT_CLAIMED_RE.exec(t);
      if (m) {
        out.push({
          url: null, domain: null, baseDomain: null, title: truncate(m[0], 80),
          siteName: (m[2] || '').trim(), state: 'claimed', sourceKind: 'textPattern',
          note: '正文提到来源但无链接'
        });
      }
    });
    return out;
  }

  /* ================= 主流程（清单 §4.2） ================= */

  /**
   * @param {object} adapter 来自 SL_CITATION_ADAPTERS 的站点配置
   * @param {object} opts { doc, win, clickGapMs, panelWaitMs, fast }
   * @returns {Promise<{ok:boolean, failReason:?string, turns:Array, platform:string}>}
   */
  function extractCitations(adapter, opts) {
    opts = opts || {};
    var doc = opts.doc || document;
    var gap = opts.fast ? 0 : (opts.clickGapMs != null ? opts.clickGapMs : DEFAULT_CLICK_GAP_MS);
    var panelWait = opts.fast ? 0 : (opts.panelWaitMs != null ? opts.panelWaitMs : DEFAULT_PANEL_WAIT_MS);
    var baseUrl = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || undefined;

    if (!adapter) {
      return Promise.resolve({ ok: false, failReason: 'no-adapter', platform: '', turns: [] });
    }
    // §4.2 第 2 步：流式没结束就什么都不做，交给下次 MutationObserver 触发（清单坑 5）
    if (!isResponseComplete(doc)) {
      return Promise.resolve({ ok: false, failReason: 'streaming', platform: adapter.id, turns: [] });
    }

    var failReason = null;
    var turns = [];
    var expanded = { clicked: 0, skipped: true };

    // 展开点击是"代替用户操作"，每站点最多一次（清单 §4.2 第 3 步）：
    // content.js 第一次跑完会带 skipExpand，之后只读不点，避免每次 DOM 变动都去戳页面。
    var expandStep = opts.skipExpand
      ? Promise.resolve({ clicked: 0, skipped: true })
      : expandAdapter(adapter, { clickGapMs: gap });

    return expandStep
      .then(function (exp) {
        expanded = exp || { clicked: 0, skipped: true };
        turns = buildTurns(adapter, doc);
        // 全页级来源（元宝抽屉 / 全局唯一面板 / 千问 script JSON）整页只采一次，再按轮分派
        var globalCits = collectSources(adapter, doc, baseUrl, function (src) {
          return src.from === 'global';
        });
        assignGlobalToTurns(adapter, turns, globalCits);
        // 串行跑：点击是代替用户操作，别并发点页面（清单 §3.3 坑 2）
        return turns.reduce(function (chain, turn) {
          return chain.then(function () {
            return runTurn(adapter, turn, doc, baseUrl, panelWait);
          });
        }, Promise.resolve());
      })
      .catch(function (err) {
        failReason = 'extract-error';
        if (global.console) global.console.warn('[站点链接助手] 引用提取异常：', err && err.message);
      })
      .then(function () {
        var total = 0;
        turns.forEach(function (t) { total += (t.citations || []).length; });
        var ok = !failReason;
        if (ok && total === 0) {
          // 未校准站点一个都没命中 → 报"可能改版"，绝不静默显示"无来源"（清单 §6 文案纪律）
          ok = adapter.status === 'verified';
          failReason = ok ? 'empty' : 'uncalibrated-no-hit';
        }
        return {
          ok: ok,
          failReason: ok ? null : failReason,
          platform: adapter.id,
          expanded: expanded,
          turns: turns.map(publicTurn)
        };
      });
  }

  /** 全页级来源分派到轮次：元宝按 dt-cid ↔ data-conv-id 配；配不上才整批挂最后一轮 */
  function assignGlobalToTurns(adapter, turns, globalCits) {
    turns.forEach(function (t) { t.globalCits = []; });
    if (!globalCits.length || !turns.length) return;
    var matched = false;
    if (adapter.pairBy === 'cid') {
      turns.forEach(function (turn) {
        if (!turn.convId) return;
        var mine = globalCits.filter(function (c) { return c.cid && c.cid === turn.convId; });
        if (mine.length) { turn.globalCits = mine; matched = true; }
      });
    }
    // 挂错轮次比漏挂更难被发现，所以只在真配不上时才这么退（清单 §4.2 第 8 步的保守解）
    if (!matched) turns[turns.length - 1].globalCits = globalCits;
  }

  /** 单轮：先按轮内作用域采（所有 kind 都试），采不到再退回全页级来源 */
  function runTurn(adapter, turn, doc, baseUrl, panelWait) {
    var scope = aiScopeOf(adapter, turn) || (doc.body || doc.documentElement);
    // 文心式：面板全局唯一，必须"点这一轮的引用钮 → 等面板刷新 → 再读"（CiteSnap yiyan.js 思路）
    var pre = Promise.resolve();
    if (adapter.panelPerTurn && adapter.citeTrigger) {
      var btn = turn.aiEls.length ? qAll(adapter.citeTrigger.outer, turn.aiEls[0])[0] : null;
      if (!btn) btn = qOne(adapter.citeTrigger.outer, doc);
      if (btn && typeof btn.click === 'function') {
        try { btn.click(); } catch (e) { /* 点不动就算了 */ }
        pre = wait(panelWait);
      }
    }
    return pre.then(function () {
      var citations = collectSources(adapter, scope, baseUrl);
      if (adapter.panelPerTurn) {
        var panel = collectSources(adapter, doc, baseUrl, function (src) {
          return src.kind === 'panelItem';
        });
        if (panel.length) citations = panel;   // 这一轮点出来的面板项就是这一轮的来源
      }
      if (!citations.length && turn.globalCits && turn.globalCits.length) {
        citations = turn.globalCits;
      }
      var markers = collectMarkers(adapter, scope);
      var claims = detectUiClaimed(adapter, scope, citations).concat(detectTextClaimed(scope));
      var list = dedupeCitations(citations.concat(claims));
      list.forEach(function (c, i) {
        c.index = i + 1;
        if (!c.context && markers.length) c.context = markers[i % markers.length].context;
      });
      turn.citations = list;
      turn.markers = markers;
    });
  }

  /* 卡片与台账要的形状（清单 §4.2 第 9 步）：不把 DOM 元素引用带出去 */
  function publicTurn(turn) {
    return {
      query: turn.query || '',
      convId: turn.convId || null,
      citations: (turn.citations || []).map(function (c) {
        return {
          index: c.index, url: c.url || null, title: c.title || '',
          domain: c.domain || null, baseDomain: c.baseDomain || null,
          siteName: c.siteName || '', time: c.time || '',
          state: c.state, viaRedirect: !!c.viaRedirect,
          context: c.context || '', sourceKind: c.sourceKind || ''
        };
      }),
      markers: turn.markers || []
    };
  }

  var api = {
    extractCitations: extractCitations,
    isResponseComplete: isResponseComplete,
    cleanCitationUrl: cleanCitationUrl,
    normalizeDomain: normalizeDomain,
    dedupeKey: dedupeKey,
    dedupeCitations: dedupeCitations,
    buildTurns: buildTurns,
    collectMarkers: collectMarkers,
    collectSources: collectSources,
    detectUiClaimed: detectUiClaimed,
    detectTextClaimed: detectTextClaimed,
    expandAdapter: expandAdapter,
    SUBDOMAIN_MAP: SUBDOMAIN_MAP,
    TEXT_CLAIMED_RE: TEXT_CLAIMED_RE,
    setTextClaimed: function (on) { TEXT_CLAIMED_ENABLED = !!on; },
    getTextClaimedEnabled: function () { return TEXT_CLAIMED_ENABLED; }
  };
  global.SL_CITATION_EXTRACT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
