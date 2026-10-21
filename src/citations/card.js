/* 站点链接助手 · 信源体检 · 体检卡（Shadow DOM 浮层）
 *
 * 用 Shadow DOM 的两个理由（清单 C4）：
 *  ① 样式不污染页面、也不被页面样式污染（AI 站的 CSS 重置很凶，普通 div 会被打成一片白）；
 *  ② content.js 的 TreeWalker 不进 shadow root，卡片文字不会被"链接化"误伤。
 *     （再加一道保险：content.js 的 SKIP_SELECTOR 里补了 [data-sl-citation-card]。）
 *
 * 文案是清单第 6 节的原文，不得自行发挥：
 *  - 不写"假"、不写"不可信"、不写"谣言"——只写等级和理由；
 *  - "未收录"必须配"不代表是假网站"；
 *  - 选择器失效时报"可能改版"，绝不静默显示"无来源"（那会误伤）。
 *
 * 任何异常都 try/catch 吞掉：体检卡是附加物，绝不能把链接化主功能带下水。
 */
(function (global) {
  'use strict';

  var HOST_ATTR = 'data-sl-citation-card';
  var MAX_TITLE_CHARS = 40;      // 每行标题截 40 字（清单 §6 每行格式）
  var RENDER_BUDGET_MS = 200;    // 方案第 5 节的渲染性能红线，超了就在控制台记一笔

  var TIER_LABEL = {
    high: '官方/权威',
    mid: '聚合/社区',
    pending: '未收录/待核'
  };

  /* 档位"为什么"——清单 §6 原文逐字搬过来，改动要过口径纪律 */
  var TIER_WHY = {
    high: '域名在本插件的权威站点词典（325 站）内，或属于政府、教育、官方媒体域名。',
    mid: '门户、社区或百科，内容多为网友或编辑整理。看观点可以，当证据要谨慎。',
    pending: '不在词典和官方名单里。不代表是假网站，只代表插件没法替你确认——建议点开看一眼。',
    claimed: '回答里提到了来源，但没有给链接，无法核对。'
  };

  /* 命中规则的不同，话术要跟着变（都是"只给等级和理由"，不评价真假） */
  var REASON_WHY = {
    'platform-link': '这条是平台自己的中转链接，真实出处要点开确认，插件替你判不了。',
    'brand-mismatch': '来源名写着「{term}」，域名却不是它（{expectHost}）——自称与域名不符，建议核对。',
    'farm-pattern': '域名带有批量站点的常见特征（{why}），先当待核处理；不代表是假网站。',
    'user-confirmed': '你之前点过"这是官网"，插件记住了这个域名。'
  };

  function whyFor(audit, citation) {
    var base = audit.state === 'claimed' ? TIER_WHY.claimed : (TIER_WHY[audit.tier] || TIER_WHY.pending);
    var extra = REASON_WHY[audit.reason];
    var text = extra
      ? base + ' ' + String(extra)
        .replace('{term}', (audit.matched && audit.matched.term) || '')
        .replace('{expectHost}', (audit.matched && audit.matched.expectHost) || '')
        .replace('{why}', (audit.matched && audit.matched.why) || '')
      : base;
    // 解包过平台跳转链接的要说明白：等级是按解包后的真实域名判的（Perplexity 这类）
    if (citation && citation.viaRedirect) text = '这条经平台跳转链接解包后再判。' + text;
    return text;
  }

  function css() {
    return [
      ':host{all:initial}',
      '.card{position:fixed;right:16px;bottom:88px;z-index:2147483646;width:340px;max-width:calc(100vw - 32px);',
      'font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#101828;',
      'background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 10px 30px rgba(16,24,40,.18);',
      'overflow:hidden;}',
      '.card.mini{width:250px}',
      '.hd{display:flex;align-items:center;gap:8px;padding:9px 11px;background:#f8fafc;border-bottom:1px solid #eef1f5;cursor:pointer;}',
      '.hd b{font-size:13px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.hd .x{border:0;background:none;font-size:15px;line-height:1;color:#98a2b3;cursor:pointer;padding:0 2px;}',
      '.hd .x:hover{color:#344054}',
      '.sum{padding:8px 11px;color:#475469;border-bottom:1px dashed #eef1f5;}',
      '.rows{max-height:44vh;overflow:auto;padding:2px 0;}',
      '.row{padding:6px 11px;border-bottom:1px solid #f6f7f9;}',
      '.row:last-child{border-bottom:0}',
      '.l1{display:flex;align-items:center;gap:6px;}',
      '.tag{flex:0 0 auto;font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid transparent;}',
      '.t-high{background:#ecfdf3;border-color:#c9f5d9;color:#087443}',
      '.t-mid{background:#fff7e6;border-color:#ffe4b3;color:#8a5a00}',
      '.t-pending{background:#f2f4f7;border-color:#e4e7ec;color:#475469}',
      '.t-claimed{background:#fef2f2;border-color:#fecaca;color:#a02a2a}',
      '.dom{flex:1 1 auto;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ttl{color:#475469;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.why{display:none;margin-top:3px;color:#667085;background:#f8fafc;border-radius:6px;padding:5px 7px;}',
      '.row.open .why{display:block}',
      '.acts{display:flex;gap:4px;margin-left:auto;}',
      '.acts a,.acts button{font-size:11px;color:#175cd3;text-decoration:none;cursor:pointer;',
      'border:0;background:none;padding:0 3px;white-space:nowrap;}',
      '.acts a:hover,.acts button:hover{text-decoration:underline}',
      '.ft{display:flex;gap:10px;padding:8px 11px;background:#f8fafc;border-top:1px solid #eef1f5;align-items:center;}',
      '.ft button{font:inherit;font-size:12px;color:#364152;background:#fff;border:1px solid #d0d5dd;',
      'border-radius:7px;padding:4px 8px;cursor:pointer;}',
      '.ft button:hover{background:#f2f4f7}',
      '.tip{padding:9px 11px;color:#667085;}',
      '.warn{padding:9px 11px;color:#8a5a00;background:#fffbeb;}',
      '.empty{padding:9px 11px;color:#475469;}',
      '.legend{padding:7px 11px;color:#667085;background:#fcfcfd;border-top:1px dashed #eef1f5;font-size:12px;}'
    ].join('');
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function tierClass(audit) {
    if (audit.state === 'claimed') return 't-claimed';
    return audit.tier === 'high' ? 't-high' : audit.tier === 'mid' ? 't-mid' : 't-pending';
  }

  function tierText(audit) {
    if (audit.state === 'claimed') return '无链接';
    return TIER_LABEL[audit.tier] || '未收录/待核';
  }

  /* 口径纪律（清单 §6）：全插件唯一允许出现"假"字的地方就是这句
   * "不代表是假网站"，而且"未收录"出现在几处，这句就要配几处。 */
  var PENDING_LEGEND = '「未收录/待核」不代表是假网站，只代表插件没法替你确认——建议点开看一眼。';
  var FOOTER = '等级只说明插件认不认得这个域名，不评价内容对错——最终判断在人。';

  /** 汇总行文案（清单 §6） */
  function summaryLine(s) {
    var line = '本条回答共识别到 ' + s.total + ' 个来源：官方/权威 ' + s.high +
      ' · 聚合/社区 ' + s.mid + ' · 未收录/待核 ' + s.pending;
    if (s.claimed) line += '；另有 ' + s.claimed + ' 处提到来源但没给链接，无法核对。';
    else line += '。';
    return line;
  }

  /** 复制用的纯文本体检结果 */
  function buildCopyText(platformLabel, s) {
    var out = ['【信源体检 · ' + platformLabel + '】'];
    out.push(summaryLine(s));
    s.items.forEach(function (it, i) {
      var c = it.citation, a = it.audit;
      out.push((i + 1) + '. [' + tierText(a) + '] ' + (c.domain || c.siteName || '（无域名）') +
        (c.title ? ' — ' + c.title : '') + (c.url ? '  ' + c.url : '  （没有可点链接）'));
    });
    if (s.pending > 0) out.push(PENDING_LEGEND);
    out.push(FOOTER);
    return out.join('\n');
  }

  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
        return;
      }
    } catch (e) { /* 走兜底 */ }
    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('style', 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;');
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (e) { /* 复制不了就算了，不打扰用户 */ }
  }

  var current = null;   // {host, shadow, card, platform}

  function ensureShadow() {
    var host = document.querySelector('[' + HOST_ATTR + ']');
    if (!host) {
      host = document.createElement('div');
      host.setAttribute(HOST_ATTR, '1');
      (document.body || document.documentElement).appendChild(host);
    }
    var shadow = host.shadowRoot;
    if (!shadow) shadow = host.attachShadow({ mode: 'open' });
    shadow.textContent = '';
    var style = el('style');
    style.textContent = css();
    shadow.appendChild(style);
    return { host: host, shadow: shadow };
  }

  function rowOf(it, idx, handlers) {
    var c = it.citation, a = it.audit;
    var row = el('div', 'row');
    var l1 = el('div', 'l1');
    l1.appendChild(el('span', 'tag ' + tierClass(a), tierText(a)));
    var dom = el('span', 'dom', c.domain || (c.state === 'claimed' ? '（没有可点链接）' : (c.siteName || '（无域名）')));
    dom.title = whyFor(a, c);
    l1.appendChild(dom);

    var acts = el('div', 'acts');
    if (c.url) {
      var open = el('a', null, '打开');
      open.href = c.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      acts.appendChild(open);
      var cp = el('button', null, '复制');
      cp.addEventListener('click', function () { copyToClipboard(c.url); });
      acts.appendChild(cp);
    }
    var more = el('button', null, '为什么');
    more.addEventListener('click', function () { row.classList.toggle('open'); });
    acts.appendChild(more);
    l1.appendChild(acts);
    row.appendChild(l1);

    if (c.title) row.appendChild(el('div', 'ttl', c.title.slice(0, MAX_TITLE_CHARS) + (c.title.length > MAX_TITLE_CHARS ? '…' : '')));
    var why = el('div', 'why', whyFor(a, c));
    row.appendChild(why);
    row.dataset.idx = String(idx);
    if (handlers) handlers.forEach(function (h) { h(row); });
    return row;
  }

  /**
   * 渲染体检卡。
   * @param {object} model {platformLabel, summary(summarizeTurn 的结果), status:'ok'|'fail', failReason}
   * @param {object} handlers {onFeedback(domain), onLedger(model)}
   */
  function renderCard(model, handlers) {
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    try {
      if (!model || !model.summary) return null;
      var made = ensureShadow();
      var card = el('div', 'card');

      var hd = el('div', 'hd');
      hd.appendChild(el('b', null, '信源体检 · 本条回答'));
      var x = el('span', 'x', '×');
      x.title = '收起（下一次回答出现时会再弹出来）';
      x.addEventListener('click', function (e) { e.stopPropagation(); hideCard(); });
      hd.appendChild(x);
      hd.addEventListener('click', function () { card.classList.toggle('mini'); });
      card.appendChild(hd);

      var s = model.summary;
      if (model.status === 'fail') {
        // 改版告警：不能静默说"没有来源"（清单 §6）
        card.appendChild(el('div', 'warn', '没识别到引用区域，可能页面已改版——结果可在设置里反馈。'));
      } else if (!s.total) {
        card.appendChild(el('div', 'empty', '本条回答没有给出任何可核对的来源。'));
      } else {
        card.appendChild(el('div', 'sum', summaryLine(s)));
        var rows = el('div', 'rows');
        s.items.forEach(function (it, i) { rows.appendChild(rowOf(it, i, handlers && handlers.rowHandlers)); });
        card.appendChild(rows);
        // "未收录"出现在几处，"不代表是假网站"就要配几处（清单 §6 口径纪律）
        if (s.pending > 0) card.appendChild(el('div', 'legend', PENDING_LEGEND));
      }

      var ft = el('div', 'ft');
      var copyBtn = el('button', null, '复制体检结果');
      copyBtn.addEventListener('click', function () { copyToClipboard(buildCopyText(model.platformLabel, s)); });
      ft.appendChild(copyBtn);
      var fbBtn = el('button', null, '这是官网（反馈误报）');
      fbBtn.title = '把本条里被判"未收录/待核"的域名记为你确认过的官网，下次直接算高';
      fbBtn.addEventListener('click', function () {
        if (handlers && typeof handlers.onFeedback === 'function') handlers.onFeedback(s.items);
      });
      ft.appendChild(fbBtn);
      card.appendChild(ft);

      made.shadow.appendChild(card);
      current = { host: made.host, shadow: made.shadow, card: card, platform: model.platform };

      var spent = ((global.performance && performance.now) ? performance.now() : Date.now()) - t0;
      if (spent > RENDER_BUDGET_MS && global.console) {
        global.console.warn('[站点链接助手] 体检卡渲染 ' + Math.round(spent) + 'ms，超出 200ms 预算');
      }
      return current;
    } catch (e) {
      if (global.console) global.console.warn('[站点链接助手] 体检卡渲染失败（已忽略，不影响链接化）：', e && e.message);
      return null;
    }
  }

  function hideCard() {
    try {
      if (current && current.host && current.host.parentNode) current.host.parentNode.removeChild(current.host);
    } catch (e) { /* 忽略 */ }
    current = null;
  }

  function hasCard() {
    return !!(current && current.host && current.host.parentNode);
  }

  function buildCopyTextExport(model) {
    return buildCopyText(model.platformLabel, model.summary);
  }

  var api = {
    HOST_ATTR: HOST_ATTR,
    TIER_LABEL: TIER_LABEL,
    TIER_WHY: TIER_WHY,
    PENDING_LEGEND: PENDING_LEGEND,
    FOOTER: FOOTER,
    renderCard: renderCard,
    hideCard: hideCard,
    hasCard: hasCard,
    summaryLine: summaryLine,
    buildCopyText: buildCopyTextExport,
    whyFor: whyFor,
    copyToClipboard: copyToClipboard
  };
  global.SL_CITATION_CARD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
