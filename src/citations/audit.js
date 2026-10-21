/* 站点链接助手 · 信源体检 · 域名体检（三档 + 一个特殊态）
 *
 * 判据顺序严格照《信源体检-引用识别调研与施工清单》§5.2，先命中先返回：
 *   1 无 URL                → 特殊态 claimed（拍板 §8-3 = A：单列一行、不进三档）
 *   2 平台自身域 / 中转页    → 低/待核（reason: platform-link）
 *   3 .gov / .gov.cn / .edu / .edu.cn → 高
 *   4 词典精确匹配或官方子域 → 高
 *   5 网信办稿源名单内媒体    → 高
 *   6 品牌词比对异常          → 低/待核（自称与域名不符，建议核对）
 *   7 社区 / 门户名单（含子域）→ 中
 *   8 内容农场特征正则        → 低/待核
 *   9 其余                   → 低/待核（未收录）
 *
 * 口径纪律（清单 §6，施工时逐条对）：本模块只输出**等级与理由键**，
 * 不出现"假""不可信""谣言"这类词；文案拼装在 card.js，且"未收录"必须配
 * "不代表是假网站"。规则 8 的正则只当特征线索，命中的是"待核"而不是"低可信"。
 */
(function (global) {
  'use strict';

  var TIERS = ['high', 'mid', 'pending'];

  // reason 是枚举键，话术在 card.js 里拼（结构化字段只填枚举值）
  var REASONS = {
    NO_URL: 'no-url',
    PLATFORM_LINK: 'platform-link',
    GOV_EDU: 'gov-edu',
    DICTIONARY: 'dictionary',
    CAC_MEDIA: 'cac-media',
    BRAND_MISMATCH: 'brand-mismatch',
    COMMUNITY: 'community',
    FARM_PATTERN: 'farm-pattern',
    UNLISTED: 'unlisted',
    USER_CONFIRMED: 'user-confirmed'
  };

  var GOV_EDU_RE = /(^|\.)gov\.cn$|(^|\.)gov$|(^|\.)edu\.cn$|(^|\.)edu$/;

  /* 品牌词比对要用"有辨识度的专名"：
   * ① 短词（"中国""人民""网"）会被无数站点命中，全丢弃；
   * ② 是别的注册词子串的也丢弃（注册了"中国搜索/中国网"，"中国"就不是品牌词）。
   * 这是 §4.3 "宁少勿多"在规则 6 上的落地：宁可漏判一个假冒站，
   * 也不要把正常来源标成"自称与域名不符"。 */
  var BRAND_STOPWORDS = {
    '数据': 1, '报告': 1, '官网': 1, '新闻': 1, '资讯': 1, '中国': 1, '世界': 1,
    '人民': 1, '网络': 1, '平台': 1, '中心': 1, '科学': 1, '研究': 1, '大学': 1,
    '政府': 1, '部门': 1, '网站': 1, '杂志': 1, '日报': 1, '晚报': 1, '时报': 1,
    '出版社': 1, '图书馆': 1, '数据库': 1, '期刊': 1, '论文': 1, '标准': 1, '专利': 1
  };

  var cache = { dictRef: null, dictIndex: null, listsRef: null, listsIndex: null };

  function hostFromUrl(url) {
    if (!url) return '';
    try {
      return (new URL(url).hostname || '').toLowerCase();
    } catch (e) {
      var m = String(url).match(/^https?:\/\/([^\/?#]+)/i);
      return m ? m[1].split(':')[0].toLowerCase() : '';
    }
  }

  function stripWww(host) {
    return String(host || '').replace(/^www\./, '');
  }

  /* ============ 词典域名索引（清单 C3："从 dict 建索引，启动时建一次缓存"） ============ */

  /**
   * dict 是 content.js 那份**已套用户修正层**的词典（含自定义站点、已删停用条目），
   * 所以用户在设置页改过的网址会直接影响体检结果——这条要写进 README。
   */
  function buildDictIndex(dict) {
    if (cache.dictRef === dict && cache.dictIndex) return cache.dictIndex;
    var byHost = new Map();
    var terms = [];       // [{term, host, name}]
    var all = [];
    (dict && dict.categories ? dict.categories : []).forEach(function (cat) {
      (cat.entries || []).forEach(function (e) {
        var host = stripWww(hostFromUrl(e.url));
        if (!host) return;   // 非 http(s) 或畸形 URL：不进索引（content.js 也是这么过滤的）
        if (!byHost.has(host)) byHost.set(host, { name: e.name, url: e.url, host: host, category: cat.id });
        all.push({ name: e.name, url: e.url, host: host });
        [e.name].concat(e.aliases || []).forEach(function (t) {
          if (!t) return;
          var isAscii = /^[\x00-\x7F]+$/.test(t);
          if (isAscii ? t.length < 4 : t.length < 3) return;   // 太短的当品牌词一定误报
          if (BRAND_STOPWORDS[t]) return;
          terms.push({ term: t, host: host, name: e.name });
        });
      });
    });
    // 是别的注册词子串的，不当品牌词
    var termSet = {};
    terms.forEach(function (t) { termSet[t.term] = true; });
    var brandTerms = terms.filter(function (t) {
      for (var other in termSet) {
        if (other !== t.term && other.indexOf(t.term) !== -1) return false;   // "中国" ⊂ "中国搜索"
      }
      return true;
    });
    var uniq = {};
    brandTerms = brandTerms.filter(function (t) {
      var k = t.term + '|' + t.host;
      if (uniq[k]) return false;
      uniq[k] = true;
      return true;
    });
    cache.dictRef = dict;
    cache.dictIndex = { byHost: byHost, brandTerms: brandTerms, all: all };
    return cache.dictIndex;
  }

  /* 官方子域判定：域名 === 词条域 或 以 "."+词条域 结尾（清单 §5.2 规则 4 / §4.2 末段）。
   * lawpro.cnki.net 是 cnki.net 的官方子域 → 算"高"，不因为"不是主页"而降档。 */
  function findDictEntry(host, index) {
    var h = stripWww(host);
    if (!h) return null;
    var parts = h.split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      var cand = parts.slice(i).join('.');
      var hit = index.byHost.get(cand);
      if (hit) return hit;
    }
    return null;
  }

  /* ============ lists.json 索引 ============ */

  function buildListsIndex(lists) {
    if (cache.listsRef === lists && cache.listsIndex) return cache.listsIndex;
    var media = new Map();
    ((lists && lists.media) || []).forEach(function (m) {
      var h = stripWww(m.domain || '');
      if (h) media.set(h, m);
    });
    var community = new Map();
    ((lists && lists.community) || []).forEach(function (c) {
      var h = stripWww(c.domain || '');
      if (h) community.set(h, c);
      (c.subdomains || []).forEach(function (s) {
        var sh = stripWww(s);
        if (sh) community.set(sh, c);
      });
    });
    var farms = [];
    ((lists && lists.farmPatterns) || []).forEach(function (f) {
      try { farms.push({ re: new RegExp(f.pattern, f.flags || 'i'), why: f.why || '' }); }
      catch (e) { /* 编译不了的正则跳过，smoke-test 会把它揪出来 */ }
    });
    var self = {};
    ((lists && lists.selfDomains) || []).forEach(function (d) { self[stripWww(d)] = true; });
    cache.listsRef = lists;
    cache.listsIndex = { media: media, community: community, farms: farms, self: self };
    return cache.listsIndex;
  }

  function lookupSuffix(host, map) {
    var h = stripWww(host);
    if (!h) return null;
    var parts = h.split('.');
    for (var i = 0; i < parts.length; i++) {
      var cand = parts.slice(i).join('.');
      if (map.has(cand)) return map.get(cand);
    }
    return null;
  }

  function isPlatformDomain(host, listsIndex, adapter) {
    var h = stripWww(host);
    var parts = h.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (listsIndex.self[parts.slice(i).join('.')]) return true;
    }
    // 适配器自带的自身域名（例如某站的新中转域还没进 lists.json 时也能兜住）
    var sd = (adapter && adapter.selfDomains) || [];
    for (var j = 0; j < sd.length; j++) {
      var s = stripWww(sd[j]);
      if (h === s || h.endsWith('.' + s)) return true;
    }
    return false;
  }

  /* 规则 6：品牌词比对。只用「来源名」触发，正文/标题不参与——
   * 标题里提一句"知网怎么用"的 CSDN 文章不该被标成自称与域名不符（宁少勿多）。
   * 来源名是平台自己对这条引用的署名，它和域名打架才是真信号。 */
  function brandMismatch(citation, dictIndex) {
    var label = String(citation.siteName || '').trim();
    if (!label) return null;
    var terms = dictIndex.brandTerms;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      if (label.indexOf(t.term) === -1) continue;
      var host = stripWww(citation.domain || '');
      if (host === t.host || (host && host.endsWith('.' + t.host))) return null; // 本来就是这个域，正常
      return { term: t.term, expectHost: t.host, expectName: t.name, label: label };
    }
    return null;
  }

  /* ============ 主判定（严格按 §5.2 顺序） ============ */

  /**
   * @param {object} citation {url,domain,siteName,state,context,viaRedirect}
   * @param {object} ctx {dict, lists, adapter, feedbackHosts:Set}
   * @returns {{tier:?string, reason:string, matched:object|null, state:string}}
   */
  function auditCitation(citation, ctx) {
    ctx = ctx || {};
    var lists = ctx.lists || {};
    var dictIndex = buildDictIndex(ctx.dict || { categories: [] });
    var listsIndex = buildListsIndex(lists);
    var state = citation && citation.state ? citation.state : (citation && citation.url ? 'linked' : 'named');

    // 规则 1：无 URL → 特殊态，不占三档
    if (!citation || !citation.url || state === 'claimed') {
      return { tier: null, state: 'claimed', reason: REASONS.NO_URL, matched: null };
    }
    var host = stripWww(citation.domain || hostFromUrl(citation.url));

    // 规则 2：平台自身域 / 中转页 → 低/待核（不硬判低：真实出处要点开确认）
    if (isPlatformDomain(host, listsIndex, ctx.adapter)) {
      return { tier: 'pending', state: state, reason: REASONS.PLATFORM_LINK, matched: { kind: 'self', domain: host } };
    }

    // 用户反馈"这是官网"积累过的域名 → 高（清单 §5.4：反向反馈积累，不写进初始词典）
    if (ctx.feedbackHosts && typeof ctx.feedbackHosts.has === 'function' && ctx.feedbackHosts.has(host)) {
      return { tier: 'high', state: state, reason: REASONS.USER_CONFIRMED, matched: { kind: 'feedback', domain: host } };
    }

    // 规则 3：政府 / 教育后缀
    if (GOV_EDU_RE.test(host)) {
      return { tier: 'high', state: state, reason: REASONS.GOV_EDU, matched: { kind: 'gov-edu', domain: host } };
    }

    // 规则 4 / 5：词典与官方名单都算"高"，但有一条**有记录的偏离**：
    // 词典是"站点名 → 官网"的直达表，里面本来就收录了知乎、B 站、微博、豆瓣、
    // 贴吧、百度百科、维基百科、Reddit、GitHub、东方财富这些站（22 条）。
    // 按 §5.2 字面顺序它们会全部被判"官方/权威"——正是 §5.5 说的"压进高又误导"。
    // 所以：域名同时出现在社区名单里时，社区名单赢，判"中"。词典照旧管链接化直达。
    var commHit = lookupSuffix(host, listsIndex.community);
    var dictHit = findDictEntry(host, dictIndex);
    var mediaHit = lookupSuffix(host, listsIndex.media);

    if ((dictHit || mediaHit) && !commHit) {
      if (dictHit) {
        return { tier: 'high', state: state, reason: REASONS.DICTIONARY, matched: { kind: 'dict', name: dictHit.name, domain: dictHit.host } };
      }
      return { tier: 'high', state: state, reason: REASONS.CAC_MEDIA, matched: { kind: 'media', name: mediaHit.name, domain: mediaHit.domain, section: mediaHit.section } };
    }

    // 规则 6：品牌词比对异常（自称与域名不符）
    var mismatch = brandMismatch(citation, dictIndex);
    if (mismatch) {
      return { tier: 'pending', state: state, reason: REASONS.BRAND_MISMATCH, matched: mismatch };
    }

    // 规则 7：社区 / 门户名单（含子域映射）
    if (commHit) {
      return { tier: 'mid', state: state, reason: REASONS.COMMUNITY, matched: { kind: 'community', name: commHit.name, domain: commHit.domain } };
    }
    // docs. / developer. 这类产品文档域（清单 §5.2 规则 7 末尾那条）
    if (/^docs\./i.test(host) || /^developer\./i.test(host) || /^developer\./i.test(citation.domain || '')) {
      return { tier: 'mid', state: state, reason: REASONS.COMMUNITY, matched: { kind: 'product-docs', domain: host } };
    }

    // 规则 8：内容农场特征
    for (var i = 0; i < listsIndex.farms.length; i++) {
      if (listsIndex.farms[i].re.test(host)) {
        return { tier: 'pending', state: state, reason: REASONS.FARM_PATTERN, matched: { kind: 'farm', domain: host, why: listsIndex.farms[i].why } };
      }
    }

    // 规则 9：其余未收录
    return { tier: 'pending', state: state, reason: REASONS.UNLISTED, matched: { kind: 'unlisted', domain: host } };
  }

  /* ============ 汇总（卡片汇总行与台账都吃这个） ============ */

  function summarizeTurn(citations, ctx) {
    var s = { total: 0, high: 0, mid: 0, pending: 0, claimed: 0, items: [] };
    (citations || []).forEach(function (c) {
      var r = auditCitation(c, ctx);
      s.total++;
      if (r.tier === 'high') s.high++;
      else if (r.tier === 'mid') s.mid++;
      else if (r.tier === 'pending') s.pending++;
      if (r.state === 'claimed') s.claimed++;
      s.items.push({ citation: c, audit: r });
    });
    return s;
  }

  var api = {
    TIERS: TIERS,
    REASONS: REASONS,
    auditCitation: auditCitation,
    summarizeTurn: summarizeTurn,
    buildDictIndex: buildDictIndex,
    buildListsIndex: buildListsIndex,
    findDictEntry: findDictEntry,
    hostFromUrl: hostFromUrl,
    stripWww: stripWww,
    clearCache: function () { cache.dictRef = null; cache.dictIndex = null; cache.listsRef = null; cache.listsIndex = null; }
  };
  global.SL_CITATION_AUDIT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
