/* 词典冒烟测试：复刻 content.js 的匹配器构建逻辑，验证词典行为。
 * 运行：node tools/smoke-test.js（DOM 行为见 browser-test.js）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'dictionary.json'), 'utf8'));

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function isAscii(s) { return /^[\x00-\x7F]+$/.test(s); }
function termPattern(term) {
  const esc = escapeRegExp(term);
  if (/^[A-Za-z0-9 .&+'\-]+$/.test(term)) return '\\b' + esc + '\\b';
  return esc;
}

function build(dict, enabled) {
  const csTerms = [], ciTerms = [];
  const mapCS = new Map(), mapCI = new Map();
  dict.categories.forEach(cat => {
    if (!enabled[cat.id]) return;
    cat.entries.forEach(e => {
      if (!/^https?:\/\//.test(e.url || '')) return;
      const entry = { name: e.name, url: e.url };
      [e.name].concat(e.aliases || []).forEach(t => {
        if (!t) return;
        if (isAscii(t)) {
          if (!mapCS.has(t)) mapCS.set(t, entry);
          csTerms.push(t);
          if (!e.cs) {
            const low = t.toLowerCase();
            if (low !== t) { if (!mapCI.has(low)) mapCI.set(low, entry); ciTerms.push(low); }
          }
        } else {
          if (!mapCS.has(t)) mapCS.set(t, entry);
          csTerms.push(t);
        }
      });
    });
  });
  csTerms.sort((a, b) => b.length - a.length);
  ciTerms.sort((a, b) => b.length - a.length);
  return {
    reCS: csTerms.length ? new RegExp(csTerms.map(t => '(' + termPattern(t) + ')').join('|'), 'g') : null,
    reCI: ciTerms.length ? new RegExp(ciTerms.map(t => '(' + termPattern(t) + ')').join('|'), 'gi') : null,
    mapCS, mapCI,
    exclusions: dict.exclusions || []
  };
}

function findMatches(state, text) {
  const found = [];
  const collect = (re, map, lower) => {
    if (!re) return;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const key = lower ? m[0].toLowerCase() : m[0];
      const entry = map.get(key);
      if (entry) found.push({ start: m.index, end: m.index + m[0].length, text: m[0], entry });
    }
  };
  collect(state.reCS, state.mapCS, false);
  collect(state.reCI, state.mapCI, true);
  if (found.length < 2) return found;
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  found.forEach(f => { if (f.start >= lastEnd) { out.push(f); lastEnd = f.end; } });
  return out;
}

function inExclusion(state, text, start, end) {
  for (const ex of state.exclusions) {
    let idx = text.indexOf(ex);
    while (idx !== -1) {
      if (start < idx + ex.length && idx < end) return true;
      idx = text.indexOf(ex, idx + 1);
    }
  }
  return false;
}

function linkify(state, text) {
  return findMatches(state, text)
    .filter(m => !inExclusion(state, text, m.start, m.end))
    .map(m => m.text + '->' + m.entry.url);
}

const all = {};
dict.categories.forEach(c => { all[c.id] = true; });
const state = build(dict, all);

let pass = 0, fail = 0;
function check(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + desc);
  if (!ok) console.log('   expected: ' + JSON.stringify(expected) + '\n   actual:   ' + JSON.stringify(actual));
}

check('中文基本匹配', linkify(state, '写论文先用中国知网和万方数据查文献'),
  ['中国知网->https://www.cnki.net', '万方数据->https://www.wanfangdata.com.cn']);
check('长词优先', linkify(state, '国家统计局发布数据，各统计局都要报'),
  ['国家统计局->https://www.stats.gov.cn', '统计局->https://www.stats.gov.cn']);
check('误报屏蔽', linkify(state, '万方科技是公司，万方数据是网站'),
  ['万方数据->https://www.wanfangdata.com.cn']);
check('英文大小写都认', linkify(state, '在 GitHub 和 github 上都能找到'),
  ['GitHub->https://github.com', 'github->https://github.com']);
check('小写常用词不误报', linkify(state, 'data science is fun'), []);
check('期刊名大写才链', linkify(state, 'published in Science last year'),
  ['Science->https://www.science.org/journal/science']);
check('consensus 小写不链', linkify(state, 'they reached a consensus'), []);
check('WHO 大写才链', linkify(state, 'WHO says; who are you'),
  ['WHO->https://www.who.int']);
check('PubMed 大小写', linkify(state, 'PubMed 和 pubmed'),
  ['PubMed->https://pubmed.ncbi.nlm.nih.gov', 'pubmed->https://pubmed.ncbi.nlm.nih.gov']);
check('分类可关', (() => {
  const off = Object.assign({}, all, { research: false });
  return linkify(build(dict, off), '中国知网和国家统计局');
})(), ['国家统计局->https://www.stats.gov.cn']);

check('上海市政府', linkify(state, '查找上海市政府户籍证明'),
  ['上海市政府->https://www.shanghai.gov.cn']);
check('上海政府简称', linkify(state, '上海政府网站'),
  ['上海政府->https://www.shanghai.gov.cn']);
check('全国标准信息公共服务平台', linkify(state, '全国标准信息公共服务平台可找到强制性标准'),
  ['全国标准信息公共服务平台->http://std.samr.gov.cn']);
check('NCBI', linkify(state, 'NCBI 和 ncbi 的图书章节'),
  ['NCBI->https://www.ncbi.nlm.nih.gov', 'ncbi->https://www.ncbi.nlm.nih.gov']);
check('文心一言 + 文心雕龙屏蔽', linkify(state, '文心一言的生图；文心雕龙是古籍'),
  ['文心一言->https://wenxin.baidu.com', '古籍->http://read.nlc.cn/thematDataSearch/toGujiIndex']);
check('T&F 与无空格写法', linkify(state, 'T&F 检索；Taylor&Francis 高级检索'),
  ['T&F->https://www.tandfonline.com', 'Taylor&Francis->https://www.tandfonline.com']);
check('千问', linkify(state, '千问网页版的功能入口'),
  ['千问->https://www.qianwen.com']);
check('智慧高教', linkify(state, '智慧高教平台的课程评价'),
  ['智慧高教->https://higher.smartedu.cn']);
check('国际组织实习任职平台', linkify(state, '在国际组织实习任职平台查岗位'),
  ['国际组织实习任职平台->https://gj.ncss.cn']);
check('国家社科基金数据库', linkify(state, '国家社科基金数据库的项目查询'),
  ['国家社科基金数据库->https://www.nopss.gov.cn']);
check('法律智库', linkify(state, '用法律智库 AI+ 研究案例'),
  ['法律智库->https://lawpro.cnki.net']);
check('CNKI 与 CNKI AI 分指两址（长词优先）', linkify(state, 'CNKI 官网和 CNKI AI 助手'),
  ['CNKI->https://www.cnki.net/', 'CNKI AI->https://ai.cnki.net/chat/home']);
check('知网别名仍走中国知网', linkify(state, '知网和 CNKI 是一家的'),
  ['知网->https://www.cnki.net', 'CNKI->https://www.cnki.net/']);
check('新修网址抽查', [
  linkify(state, '学堂在线选课'),
  linkify(state, '四川省统计局的数据'),
  linkify(state, 'CADAL 数字图书馆'),
  linkify(state, 'RePEc 找经济学论文'),
  linkify(state, 'ChinaXiv 预印本'),
], [
  ['学堂在线->https://www.xuetangx.com'],
  ['四川省统计局->https://tjj.sc.gov.cn'],
  ['CADAL->https://cadal.edu.cn'],
  ['RePEc->https://ideas.repec.org'],
  ['ChinaXiv->https://www.chinaxiv.org/home.htm'],
]);
check('抖音指数别名', linkify(state, '抖音指数看趋势'),
  ['抖音指数->https://trendinsight.oceanengine.com']);
check('企业微信优先于微信', linkify(state, '用企业微信开会，微信聊天'),
  ['企业微信->https://work.weixin.qq.com', '微信->https://weixin.qq.com']);
check('抖音 vs 抖音指数（长词优先）', linkify(state, '抖音指数和抖音'),
  ['抖音指数->https://trendinsight.oceanengine.com', '抖音->https://www.douyin.com']);
check('Steam 只认大写（小写 steam=蒸汽不链）', linkify(state, 'Steam 平台很火，steam is hot'),
  ['Steam->https://store.steampowered.com']);
check('主要电商命中', linkify(state, '淘宝、京东商城和拼多多'),
  ['淘宝->https://www.taobao.com', '京东商城->https://www.jd.com', '拼多多->https://www.pinduoduo.com']);
check('豆瓣酱不误报', linkify(state, '这瓶豆瓣酱，上豆瓣看评分'),
  ['豆瓣->https://www.douban.com']);
check('去哪儿网 vs 日常问句', linkify(state, '你打算去哪儿？去去哪儿网订票'),
  ['去哪儿网->https://www.qunar.com']);
check('京东大鼓不误报', linkify(state, '京东大鼓是曲艺，京东商城是网站'),
  ['京东商城->https://www.jd.com']);
check('国外站点（含括号名）', linkify(state, 'Google、YouTube、X（Twitter）和 Amazon'),
  ['Google->https://www.google.com', 'YouTube->https://www.youtube.com', 'X（Twitter）->https://x.com', 'Amazon->https://www.amazon.com']);
check('国家政府门户', linkify(state, '美国国会通过法案，白宫回应，欧盟表态'),
  ['美国国会->https://www.congress.gov', '白宫->https://www.whitehouse.gov', '欧盟->https://european-union.europa.eu']);
check('财经站点', linkify(state, '东方财富网和同花顺，再看 TradingView 与 Yahoo Finance'),
  ['东方财富网->https://www.eastmoney.com', '同花顺->https://www.10jqka.com.cn',
   'TradingView->https://www.tradingview.com', 'Yahoo Finance->https://finance.yahoo.com']);

check('v1.9.0 新站点：智谱', linkify(state, '智谱清言是智谱AI的产品，ChatGLM 也能用'),
  ['智谱清言->https://chatglm.cn/main/alltoolsdetail?redirect=/main/toolsCenter&lang=zh',
   '智谱AI->https://chatglm.cn/main/alltoolsdetail?redirect=/main/toolsCenter&lang=zh',
   'ChatGLM->https://chatglm.cn/main/alltoolsdetail?redirect=/main/toolsCenter&lang=zh']);
check('v1.9.0 新站点：国图资源库', linkify(state, '古籍影像上中华古籍资源库查，民国报刊看民国时期文献库'),
  ['古籍->http://read.nlc.cn/thematDataSearch/toGujiIndex',
   '中华古籍资源库->http://read.nlc.cn/thematDataSearch/toGujiIndex',
   '民国时期文献库->http://read.nlc.cn/specialResource/minguoindex']);
check('v1.9.0 新站点：证券 / 药监 / MIT', linkify(state, '证券公示查中国证券业协会查询系统，药品数据在国家药品监督管理局数据查询，学位论文找 MIT Theses'),
  ['中国证券业协会查询系统->https://gs.sac.net.cn/pages/registration/new-sac-publicity-org.html',
   '国家药品监督管理局数据查询->https://datasearch.nmpa.gov.cn/datasearch/home-index.html',
   'MIT Theses->https://dspace.mit.edu/home']);
check('v1.9.0 新站点：药监局长词优先', linkify(state, '国家药品监督管理局数据查询和药监局数据查询'),
  ['国家药品监督管理局数据查询->https://datasearch.nmpa.gov.cn/datasearch/home-index.html',
   '药监局数据查询->https://datasearch.nmpa.gov.cn/datasearch/home-index.html']);

const total = dict.categories.reduce((n, c) => n + c.entries.length, 0);

/* ================= v2.0.0 信源体检：lists.json 结构校验 + 词典域名反查 ================= */
/* 本套件的 check(desc, actual, expected) 是三参数全等比较，布尔判据统一走 bcheck */
function bcheck(desc, cond) { check(desc, !!cond, true); }

const lists = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'citations', 'lists.json'), 'utf8'));
const AUD = require('../src/citations/audit.js');
const DOMAIN_OK = /^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$/;
const badDomain = (d) => !d || !DOMAIN_OK.test(String(d).toLowerCase()) || /[\/\s@:%]/.test(d);
const dupOf = (arr) => {
  const seen = new Set(), dup = [];
  arr.forEach((x) => { if (seen.has(x)) dup.push(x); else seen.add(x); });
  return dup;
};
const farmOf = (host) => lists.farmPatterns.some((f) => new RegExp(f.pattern, f.flags || 'i').test(host));

bcheck('lists.json 带 version 与 updated', !!lists.version && !!lists.updated);
bcheck('lists.json meta 记录了名单版本、来源与复核日期',
  !!lists.meta.mediaListVersion && !!lists.meta.mediaListSource && !!lists.meta.reviewedAt);
bcheck('media[] 非空且超过 200 条（官方许可名单 194 家打底）', lists.media.length > 200);
bcheck('media[] 域名全部可解析', lists.media.every((m) => !badDomain(m.domain)));
bcheck('media[] 无重复域名', dupOf(lists.media.map((m) => m.domain)).length === 0);
bcheck('media[] 每条都标了来源层（central-license 带许可证号 / verified-list 带核实证据）',
  lists.media.every((m) => m.section === 'central-license' ? !!m.license : !!m.evidence));
bcheck('community[] 域名与子域全部可解析',
  lists.community.every((c) => !badDomain(c.domain) && (c.subdomains || []).every((s) => !badDomain(s))));
bcheck('community[] 无重复', dupOf(lists.community.map((c) => c.domain)).length === 0);
bcheck('farmPatterns 正则全部可编译',
  lists.farmPatterns.every((f) => { try { new RegExp(f.pattern, f.flags || 'i'); return true; } catch (e) { return false; } }));
bcheck('farmPatterns 每条都带 why 说明（卡片要给用户看理由）',
  lists.farmPatterns.every((f) => !!f.why));
bcheck('selfDomains 覆盖清单 §5.2 规则 2 点名的 14 个平台/中转域',
  ['deepseek.com', 'doubao.com', 'kimi.com', 'kimi.ai', 'moonshot.cn', 'yuanbao.tencent.com',
    'chatglm.cn', 'qianwen.com', 'tongyi.aliyun.com', 'yiyan.baidu.com', 'perplexity.ai',
    'link.perplexity.ai', 'chatgpt.com', 'metaso.cn', 'xinghuo.xfyun.cn']
    .every((d) => lists.selfDomains.indexOf(d) !== -1));
bcheck('selfDomains 不收裸大众域（baidu.com/tencent.com/qq.com 会把百度知道、腾讯文档一起误伤）',
  ['baidu.com', 'tencent.com', 'qq.com', 'aliyun.com', 'openai.com', '163.com', 'sohu.com']
    .every((d) => lists.selfDomains.indexOf(d) === -1));
bcheck('农场正则不误伤正常站（反向对照：人民网/CSDN/环球网/GitHub/维基）',
  ['www.people.com.cn', 'blog.csdn.net', 'www.huanqiu.com', 'github.com', 'en.wikipedia.org',
    'www.thepaper.cn', 'lawpro.cnki.net'].every((d) => !farmOf(d)));
bcheck('农场正则能抓到批量站样本（正向对照，按 §5.4 的"通用词+数字/连字符"风格）',
  ['top100-news24.com', 'daily24.cn', 'best-tips999.com', 'paihang2026.com']
    .every((d) => farmOf(d)));

/* 词典 325 站全部能反查出域名索引（清单 C3 验收） */
const dictIndex = AUD.buildDictIndex(dict);
const noHost = [];
dict.categories.forEach((c) => c.entries.forEach((e) => {
  const h = AUD.hostFromUrl(e.url).replace(/^www\./, '');
  if (!h) noHost.push(c.id + '/' + e.name + ' ' + e.url);
}));
bcheck('词典 325 条全部建出域名索引', dictIndex.all.length === total && noHost.length === 0);
bcheck('每条词典域名都能被自己反查命中（官方子域判定不跑偏）',
  dictIndex.all.every((e) => {
    const hit = AUD.findDictEntry(e.host, dictIndex);
    return !!hit && hit.host === e.host;
  }));
bcheck('词典里单独收录的子域按精确匹配优先（lawpro.cnki.net 自己就是词条"知网法律"）',
  AUD.findDictEntry('lawpro.cnki.net', dictIndex).name === '知网法律');
bcheck('没单独收录的官方子域也能反查到主词条（kns.cnki.net → 中国知网）',
  AUD.findDictEntry('kns.cnki.net', dictIndex).host === 'cnki.net');
bcheck('品牌词表非空且不含两字裸词（防误伤）',
  dictIndex.brandTerms.length > 100 &&
  dictIndex.brandTerms.every((t) => /^[\x00-\x7F]+$/.test(t.term) ? t.term.length >= 4 : t.term.length >= 3));
bcheck('品牌词表剔除了子串关系（"中国"不能当品牌词）',
  !dictIndex.brandTerms.some((t) => t.term === '中国' || t.term === '人民'));
bcheck('词典改网址后体检跟着变（用户修正层作用于体检，不只是链接化）', (function () {
  const moved = JSON.parse(JSON.stringify(dict));
  let found = false;
  // 词典里 cnki.net 挂了两个词条（中国知网 / CNKI），两个都要改，否则老域名照样反查命中
  moved.categories.forEach((c) => c.entries.forEach((e) => {
    if (/cnki\.net/.test(e.url || '')) { e.url = 'https://cnki.mirror-example.org/'; found = true; }
  }));
  if (!found) return false;
  AUD.clearCache();
  const opt = { dict: moved, lists, feedbackHosts: new Set() };
  const rNew = AUD.auditCitation(
    { url: 'https://cnki.mirror-example.org/', domain: 'cnki.mirror-example.org', state: 'linked', siteName: '' }, opt);
  const rOld = AUD.auditCitation(
    { url: 'https://www.cnki.net/', domain: 'www.cnki.net', state: 'linked', siteName: '' }, opt);
  AUD.clearCache();
  return rNew.tier === 'high' && rNew.reason === 'dictionary' && rOld.reason !== 'dictionary';
})());

console.log('\n分类统计: ' + dict.categories.map(c => c.name + ' ' + c.entries.length).join(' | '));
console.log('词典条目总数: ' + total);
console.log('名单条数: media ' + lists.media.length + '（许可 ' + lists.meta.counts.mediaCentral +
  ' + 核实 ' + lists.meta.counts.mediaVerified + '） | community ' + lists.community.length +
  ' | 农场特征 ' + lists.farmPatterns.length + ' | 平台域 ' + lists.selfDomains.length);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
