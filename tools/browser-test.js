/* 浏览器环境端到端测试：用 jsdom 跑【真实的】src/content.js 与 src/background.js。
 * 覆盖：正文链接化、长词优先、误报屏蔽、代码块/已有链接跳过、动态内容（MutationObserver）；
 *       v1.6.0：点击链接自动复制（《》/引号/冒号）、新页面自动粘贴、开关、自添加站点分离与旧键回退；
 *       v1.7.0：点击链接新开浏览器窗口（消息发送/开关/组合键/与复制开关独立/失败回退），
 *               后台智能定位算法（吸附镜像/相邻平铺/翻左兜底/左右副屏降级/URL 校验/边界被拒后重建兜底/update 双保险）；
 *       v1.8.0：iframe 不回贴（真 iframe 里跑 content.js）、srcTop 不回贴、update 被拒仍算成功。
 *       v1.9.0：一句多个引号/书名号全部复制（去重、跳过站点名、回退冒号）、词典新站点链接化、
 *               生效窗口内多次粘贴 / 跨窗口不粘 / 老队列（无 win）仍粘一次。
 *       v2.0.0：信源体检——11 站结构复刻快照的提取与判级、§5.2 九条规则逐条、社区名单优先于词典、
 *               URL 清洗与去重、流式中不提取、未校准站静默、Shadow DOM 卡片与"假"字口径反证、
 *               台账落盘与 CSV 导出、withLists 复用 getDictionary 通道、总开关往返。
 * 运行：NODE_PATH=<受管node工作区>/node_modules node tools/browser-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const contentSrc = fs.readFileSync(path.join(root, 'src/content.js'), 'utf8');
const backgroundSrc = fs.readFileSync(path.join(root, 'src/background.js'), 'utf8');
const dict = JSON.parse(fs.readFileSync(path.join(root, 'src/dictionary.json'), 'utf8'));

/* ---- v2.0.0 信源体检：源码与名单（快照回归用） ---- */
const CITE_DIR = path.join(root, 'src/citations');
const CITE_FILES = ['adapters.js', 'extract.js', 'audit.js', 'card.js', 'ledger.js'];
const CITE_SRCS = CITE_FILES.map(function (f) {
  return fs.readFileSync(path.join(CITE_DIR, f), 'utf8');
});
const LISTS = JSON.parse(fs.readFileSync(path.join(CITE_DIR, 'lists.json'), 'utf8'));
const FIX_DIR = path.join(root, 'tests/citations');

function readFixture(name) {
  return fs.readFileSync(path.join(FIX_DIR, name), 'utf8');
}

/* 把体检五个模块 eval 进一个 jsdom 页面（它们都挂 window.*，内部用 document 全局） */
function citationWindow(html, url) {
  const dom = new JSDOM(html, { url: url, runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.chrome = makeChrome({ sync: {}, local: {} }, [], {});
  CITE_SRCS.forEach(function (s) { w.eval(s); });
  return w;
}

/* 跑一个快照：提取 + 判级，返回 {res, turns, last, summary, tiers} */
async function auditFixture(name, url, extra) {
  const w = citationWindow(readFixture(name), url);
  const adapter = w.SL_CITATION_ADAPTERS.matchAdapter(w.location.hostname);
  const res = await w.SL_CITATION_EXTRACT.extractCitations(
    adapter, Object.assign({ doc: w.document, fast: true }, extra || {}));
  const turns = res.turns || [];
  const last = turns.length ? turns[turns.length - 1] : { query: '', citations: [] };
  const summary = w.SL_CITATION_AUDIT.summarizeTurn(last.citations, {
    dict: dict, lists: LISTS, adapter: adapter, feedbackHosts: new Set()
  });
  return { w: w, adapter: adapter, res: res, turns: turns, last: last, summary: summary };
}

/* 取某轮全部来源的「域名/档位/判据」三元组，断言时一眼能看出差在哪 */
function rows(turn, ctx) {
  return ((turn && turn.citations) || []).map(function (c) {
    const a = ctx.w.SL_CITATION_AUDIT.auditCitation(c, ctx.ctx);
    return {
      domain: c.domain || '(无域名)',
      state: a.state,
      tier: a.tier || '-',
      reason: a.reason,
      title: (c.title || '').slice(0, 12)
    };
  });
}
function tierOf(list, domainPart) {
  const hit = list.filter(function (r) { return String(r.domain).indexOf(domainPart) !== -1; })[0];
  return hit ? hit.tier + '/' + hit.reason : 'MISSING';
}

/* ---- 桩：chrome API + fetch；storage 用内存对象，可在多个窗口间共享 ----
 * opts.failWindow：模拟后台没接住（建窗失败 → content 回退 window.open）
 * opts.fakeWin：模拟后台建窗成功后回传的新窗口 ID（v1.9.0 起随待粘贴队列落盘）
 * opts.myWin：模拟"我在哪个浏览器窗口"的应答（v1.9.0 起粘贴按窗口限定） */
function makeChrome(store, sent, opts) {
  opts = opts || {};
  var fakeWin = opts.fakeWin == null ? 42 : opts.fakeWin;
  function areaGet(area, keys, cb) {
    var out = {};
    (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(store[area], k)) out[k] = store[area][k];
    });
    cb(out);
  }
  function areaSet(area, data, cb) {
    Object.keys(data).forEach(function (k) { store[area][k] = data[k]; });
    if (cb) cb();
  }
  return {
    runtime: {
      getURL: function (p) { return 'chrome-extension://fake/' + p; },
      lastError: null,
      // v1.7.0：content script 经这里把"新开窗口"请求转交后台；sent 数组收集消息供断言
      sendMessage: function (msg, cb) {
        if (sent) sent.push(msg);
        // v2.0.0：体检名单走的就是这条已有通道（withLists），桩要按 URL 分流给真名单
        if (msg && msg.type === 'siteLinker:getDictionary') {
          if (cb) cb(msg.withLists ? { ok: true, dict: dict, lists: LISTS } : { ok: true, dict: dict });
          return;
        }
        // v1.9.0：应答"我在哪个浏览器窗口"（sender.tab.windowId 的替身）
        if (msg && msg.type === 'siteLinker:myWindow') {
          if (cb) cb({ ok: true, win: opts.myWin == null ? null : opts.myWin });
          return;
        }
        // v1.9.0：建窗成功，回传新窗口 ID
        if (msg && msg.type === 'siteLinker:openInWindow' && !opts.failWindow) {
          if (cb) cb({ ok: true, windowId: fakeWin });
          return;
        }
        if (opts.failWindow) {
          this.lastError = { message: 'stub: 后台没接住' };
          if (cb) cb(null);
          return;
        }
        if (cb) cb({ ok: true });
      }
    },
    storage: {
      sync: {
        get: function (k, cb) { areaGet('sync', k, cb); },
        set: function (d, cb) { areaSet('sync', d, cb); }
      },
      local: {
        get: function (k, cb) { areaGet('local', k, cb); },
        set: function (d, cb) { areaSet('local', d, cb); }
      },
      onChanged: { addListener: function () {} }
    }
  };
}

function makePage(html, store, url, sent, opts) {
  var dom = new JSDOM(html, {
    url: url || 'http://localhost/test.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  dom.window.chrome = makeChrome(store, sent, opts);
  dom.window.fetch = function () {
    return Promise.resolve({ json: function () { return Promise.resolve(dict); } });
  };
  return dom;
}

const html = `<!DOCTYPE html><html><body>
<p id="p1">写论文先用中国知网和万方数据查文献，数据到国家统计局的国家数据查，代码在 GitHub 上。</p>
<pre><code>// 这里的知网、GitHub、arXiv 都不应该被链接
const s = ["中国知网", "GitHub"];</code></pre>
<p id="p2">已有链接：<a href="https://www.cnki.net">中国知网官网</a> 不应被改动。</p>
<p id="p3">万方科技是公司名，不应链接；国家统计局和国家数据应该链接。</p>
<div id="dyn"></div>
</body></html>`;

let pass = 0, fail = 0;
function check(desc, cond) {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + desc);
}
const linkTexts = function (scope) {
  return Array.prototype.map.call(
    scope.querySelectorAll('a[data-site-linker]'),
    function (a) { return a.textContent; }
  );
};
function pendingOf(store) { return store.local['siteLinker.pendingPaste']; }
function clickSiteLink(w, id) {
  var a = w.document.querySelector('#' + id + ' a[data-site-linker]');
  if (!a) return null;
  a.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  return a;
}
function focusIn(w, el) {
  el.dispatchEvent(new w.FocusEvent('focusin', { bubbles: true }));
}

(async function () {
  /* ===== 第一部分：链接化（原有用例） ===== */
  var store1 = { sync: {}, local: {} };
  var dom = makePage(html, store1);
  var window = dom.window;

  window.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });

  var all = linkTexts(window.document);
  check('正文 7 处全部链接化', all.length === 7);
  check('长词优先：国家统计局整词命中', all.indexOf('国家统计局') !== -1 && all.indexOf('统计局') === -1);
  check('国家数据命中', all.indexOf('国家数据') !== -1);
  check('误报屏蔽：万方科技未链接、万方数据已链接', all.indexOf('万方数据') !== -1 && all.indexOf('万方') === -1);
  check('GitHub 命中', all.indexOf('GitHub') !== -1);

  var aCnki = window.document.querySelector('#p2 a[href="https://www.cnki.net"]');
  check('已有链接未被改动（无标记、文字原样）', !!aCnki && !aCnki.hasAttribute('data-site-linker') && aCnki.textContent === '中国知网官网');
  check('代码块内零链接', window.document.querySelectorAll('pre a[data-site-linker]').length === 0);

  var created = window.document.querySelector('a[data-site-linker]');
  check('生成的链接带 target=_blank 与 rel', !!created && created.target === '_blank' && created.rel.indexOf('noopener') !== -1);
  check('生成的链接指向 http(s)', /^https?:/.test(created.href));
  check('生成的链接带上句子属性（点击复制用）', !!created.getAttribute('data-sl-sentence'));

  // 动态内容：防抖 350ms + 空闲回调，等 1s
  var p = window.document.createElement('p');
  p.textContent = '动态追加的文本：维普和 DOAJ 也要变成链接。';
  window.document.getElementById('dyn').appendChild(p);
  await new Promise(function (r) { setTimeout(r, 1200); });
  check('动态内容被 MutationObserver 处理（2 处）', linkTexts(window.document.getElementById('dyn')).length === 2);

  /* ===== 第二部分：点击链接自动复制（提取规则） ===== */
  var store2 = { sync: {}, local: {} };
  var dom2 = makePage(`<!DOCTYPE html><html><body>
    <p id="a">他在豆瓣搜索《三体》的读者评论。</p>
    <p id="b">老师在知乎回答了"如何入门机器学习"这个问题。</p>
    <p id="c">中国知网：查找学位论文的好地方。</p>
    <p id="d">中国知网是一个文献数据库。</p>
    <p id="e">按住 Ctrl 点击中国知网：查找文献，也会自动复制。</p>
  </body></html>`, store2);
  var w2 = dom2.window;
  w2.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });

  clickSiteLink(w2, 'a');
  check('《书名号》内容被复制', pendingOf(store2) && pendingOf(store2).text === '三体');
  clickSiteLink(w2, 'b');
  check('引号内容被复制', pendingOf(store2) && pendingOf(store2).text === '如何入门机器学习');
  clickSiteLink(w2, 'c');
  check('站点名后冒号的内容被复制', pendingOf(store2) && pendingOf(store2).text === '查找学位论文的好地方');
  clickSiteLink(w2, 'd');
  check('三种 Patterns 都没有时不复制', !pendingOf(store2) || !pendingOf(store2).text);
  var toast2 = w2.document.querySelector('.site-linker-toast');
  check('无内容可复制时给出提示', !!toast2 && toast2.textContent.indexOf('没有') !== -1);
  // Ctrl+点击（新标签打开）同样复制
  var linkE = w2.document.querySelector('#e a[data-site-linker]');
  linkE.dispatchEvent(new w2.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  check('Ctrl+点击也复制（照常新标签打开）', pendingOf(store2) && pendingOf(store2).text === '查找文献');

  /* ===== 第二部分 C：一句多个引号 / 书名号（v1.9.0） ===== */
  var store20 = { sync: {}, local: {} };
  var dom20 = makePage(`<!DOCTYPE html><html><body>
    <p id="m1">在CNKI（中国知网）高级检索中，检索主题为“数字经济”与“税收”的文献，2015-2025年，发文量最多的作者是（）。</p>
    <p id="m2">在“中国知网”里同时检索“数字经济”与“税收”，再按被引排序。</p>
    <p id="m3">他从豆瓣搜索《三体》和《活着》的书评。</p>
    <p id="m4">在“中国知网”中检索：免费教程。</p>
    <p id="m5">中国知网重复出现“数字经济”与“数字经济”时只复制一个。</p>
  </body></html>`, store20);
  var w20 = dom20.window;
  w20.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });

  clickSiteLink(w20, 'm1');
  check('一句两个引号：全部复制（空格相连）', pendingOf(store20) && pendingOf(store20).text === '数字经济 税收');
  clickSiteLink(w20, 'm2');
  check('引号里含站点名：跳过站点名，其余全复制', pendingOf(store20) && pendingOf(store20).text === '数字经济 税收');
  clickSiteLink(w20, 'm3');
  check('一句两个书名号：全部复制', pendingOf(store20) && pendingOf(store20).text === '三体 活着');
  clickSiteLink(w20, 'm4');
  check('引号只剩站点名：回退到冒号规则', pendingOf(store20) && pendingOf(store20).text === '免费教程');
  clickSiteLink(w20, 'm5');
  check('重复引号去重', pendingOf(store20) && pendingOf(store20).text === '数字经济');

  /* ===== 第二部分 D：v1.9.0 词典新站点 ===== */
  var store19 = { sync: {}, local: {} };
  var dom19 = makePage(`<!DOCTYPE html><html><body>
    <p id="n1">智谱AI（智谱清言）是智谱的对话产品，ChatGLM 也能用。</p>
    <p id="n2">古籍影像可以查中华古籍资源库，民国时期的图书期刊看民国时期文献库。</p>
    <p id="n3">证券从业人员公示在中国证券业协会查询系统，药品数据在国家药品监督管理局数据查询。</p>
    <p id="n4">国外学位论文可以找 MIT Theses。</p>
  </body></html>`, store19);
  var w19 = dom19.window;
  w19.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  var map19 = {};
  Array.prototype.forEach.call(w19.document.querySelectorAll('a[data-site-linker]'), function (a) {
    map19[a.textContent] = a.getAttribute('href');
  });
  var GLM = 'https://chatglm.cn/main/alltoolsdetail?redirect=/main/toolsCenter&lang=zh';
  check('智谱AI / 智谱 / 智谱清言 / ChatGLM 都指向 chatglm.cn',
    ['智谱AI', '智谱', '智谱清言', 'ChatGLM'].every(function (t) { return map19[t] === GLM; }));
  check('古籍 / 中华古籍资源库 → 国图中华古籍资源库',
    map19['古籍'] === 'http://read.nlc.cn/thematDataSearch/toGujiIndex' &&
    map19['中华古籍资源库'] === 'http://read.nlc.cn/thematDataSearch/toGujiIndex');
  check('民国时期文献库 → 国图民国时期文献',
    map19['民国时期文献库'] === 'http://read.nlc.cn/specialResource/minguoindex');
  check('中国证券业协会查询系统 → 证券业协会公示',
    map19['中国证券业协会查询系统'] === 'https://gs.sac.net.cn/pages/registration/new-sac-publicity-org.html');
  check('国家药品监督管理局数据查询 → 药监数据查询（长词优先于官网条目）',
    map19['国家药品监督管理局数据查询'] === 'https://datasearch.nmpa.gov.cn/datasearch/home-index.html');
  check('MIT Theses → dspace.mit.edu', map19['MIT Theses'] === 'https://dspace.mit.edu/home');

  // 开关关闭：不复制
  var store3 = { sync: { 'siteLinker.prefs': { autoCopyPaste: false } }, local: {} };
  var dom3 = makePage('<p id="a">他在豆瓣搜索《三体》的读者评论。</p>', store3);
  var w3 = dom3.window;
  w3.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  clickSiteLink(w3, 'a');
  check('设置里关闭开关后不复制', !pendingOf(store3));

  /* ===== 第二部分 B：点击链接新开浏览器窗口（v1.7.0） ===== */
  var sent9 = [];
  var store9 = { sync: {}, local: {} };
  var dom9 = makePage('<p id="a">他在豆瓣搜索《三体》的读者评论。</p>', store9, 'http://localhost/test.html', sent9);
  var w9 = dom9.window;
  w9.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  clickSiteLink(w9, 'a');
  check('默认点击：向后台发新窗口请求', sent9.length === 1 && sent9[0].type === 'siteLinker:openInWindow' && /douban/.test(sent9[0].url));
  check('消息带上屏幕尺寸（数字）', typeof sent9[0].screen.w === 'number' && typeof sent9[0].screen.h === 'number');
  check('默认点击也照常复制（两个开关独立）', pendingOf(store9) && pendingOf(store9).text === '三体');

  // 开关关闭：不发窗口请求（链接照常按浏览器默认新标签页打开）
  var sent10 = [];
  var store10 = { sync: { 'siteLinker.prefs': { openInNewWindow: false } }, local: {} };
  var dom10 = makePage('<p id="a">他在豆瓣搜索《三体》的读者评论。</p>', store10, 'http://localhost/test.html', sent10);
  var w10 = dom10.window;
  w10.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  clickSiteLink(w10, 'a');
  // v1.9.0 起同窗口点击会先问一句"我在哪个窗口"（粘贴按窗口限定用），按类型过滤
  var winReqs10 = sent10.filter(function (m) { return m.type === 'siteLinker:openInWindow'; });
  check('关闭新窗口开关后不发窗口请求', winReqs10.length === 0);

  // 组合键：不发窗口请求（交给浏览器默认），但复制照常
  var sent11 = [];
  var store11 = { sync: {}, local: {} };
  var dom11 = makePage('<p id="a">他在豆瓣搜索《三体》的读者评论。</p>', store11, 'http://localhost/test.html', sent11);
  var w11 = dom11.window;
  w11.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  var link11 = w11.document.querySelector('#a a[data-site-linker]');
  link11.dispatchEvent(new w11.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  var winReqs11 = sent11.filter(function (m) { return m.type === 'siteLinker:openInWindow'; });
  check('Ctrl+点击不发窗口请求（浏览器默认新标签页）', winReqs11.length === 0);
  check('Ctrl+点击仍照常复制', pendingOf(store11) && pendingOf(store11).text === '三体');

  // 复制关、窗口开：仍然发窗口请求（互相独立）
  var sent12 = [];
  var store12 = { sync: { 'siteLinker.prefs': { autoCopyPaste: false } }, local: {} };
  var dom12 = makePage('<p id="a">他在豆瓣搜索《三体》的读者评论。</p>', store12, 'http://localhost/test.html', sent12);
  var w12 = dom12.window;
  w12.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  clickSiteLink(w12, 'a');
  check('关掉复制开关后仍发窗口请求', sent12.length === 1);
  check('关掉复制开关后不复制', !pendingOf(store12) || !pendingOf(store12).text);

  // 后台没接住（lastError）：回退 window.open，保证链接一定打得开
  var sent13 = [];
  var opened13 = [];
  var store13 = { sync: {}, local: {} };
  var dom13 = makePage('<p id="a">他在豆瓣搜索《三体》的读者评论。</p>', store13, 'http://localhost/test.html', sent13, { failWindow: true });
  var w13 = dom13.window;
  w13.window.open = function (u) { opened13.push(u); return null; };
  w13.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  clickSiteLink(w13, 'a');
  await new Promise(function (r) { setTimeout(r, 50); });
  check('后台无响应时回退 window.open（链接不丢）', opened13.length === 1 && /douban/.test(opened13[0]));

  /* ===== 第三部分：新页面自动粘贴 ===== */
  var store4 = { sync: {}, local: {
    'siteLinker.pendingPaste': { text: '三体', ts: Date.now(), src: 'http://localhost/source.html' }
  } };
  var dom4 = makePage('<!DOCTYPE html><html><body>' +
    '<input id="filled" type="text" value="已有内容"><input id="q" type="search"></body></html>',
    store4, 'http://localhost/target.html');
  var w4 = dom4.window;
  w4.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });

  focusIn(w4, w4.document.getElementById('filled'));
  await new Promise(function (r) { setTimeout(r, 50); });
  check('非空输入框不被自动粘贴', w4.document.getElementById('filled').value === '已有内容');

  focusIn(w4, w4.document.getElementById('q'));
  await new Promise(function (r) { setTimeout(r, 50); });
  check('空输入框被自动粘贴', w4.document.getElementById('q').value === '三体');
  check('粘贴后队列清空（只粘一次）', !pendingOf(store4));

  // 过期（超过 10 分钟）不粘
  var store5 = { sync: {}, local: {
    'siteLinker.pendingPaste': { text: '旧文本', ts: Date.now() - 11 * 60 * 1000, src: 'http://x/' }
  } };
  var dom5 = makePage('<input id="q" type="text">', store5, 'http://localhost/target.html');
  var w5 = dom5.window;
  w5.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  focusIn(w5, w5.document.getElementById('q'));
  await new Promise(function (r) { setTimeout(r, 50); });
  check('超过 10 分钟的待粘贴文本不生效', w5.document.getElementById('q').value === '');

  // 来源页自身不回贴
  var store6 = { sync: {}, local: {
    'siteLinker.pendingPaste': { text: '三体', ts: Date.now(), src: 'http://localhost/test.html' }
  } };
  var dom6 = makePage('<input id="q" type="text">', store6, 'http://localhost/test.html');
  var w6 = dom6.window;
  w6.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  focusIn(w6, w6.document.getElementById('q'));
  await new Promise(function (r) { setTimeout(r, 50); });
  check('不粘回来源页面', w6.document.getElementById('q').value === '');

  /* ===== 第三部分 C：生效窗口内多次粘贴 / 跨窗口不粘（v1.9.0） ===== */
  // 队列记了生效窗口（点击链接新开的那个窗口）：同窗口 → 可粘多次
  var store16 = { sync: {}, local: {
    'siteLinker.pendingPaste': { text: '数字经济 税收', ts: Date.now(), src: 'http://localhost/source.html', win: 42 }
  } };
  var dom16 = makePage('<!DOCTYPE html><html><body><input id="f1" type="search"><input id="f2" type="search"></body></html>',
    store16, 'http://localhost/target.html', null, { myWin: 42 });
  var w16 = dom16.window;
  w16.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  focusIn(w16, w16.document.getElementById('f1'));
  await new Promise(function (r) { setTimeout(r, 50); });
  check('生效窗口里第一次自动粘贴', w16.document.getElementById('f1').value === '数字经济 税收');
  check('粘贴后队列不清（可粘多次）', pendingOf(store16) && pendingOf(store16).text === '数字经济 税收');
  focusIn(w16, w16.document.getElementById('f2'));
  await new Promise(function (r) { setTimeout(r, 50); });
  check('同一窗口里再粘一次', w16.document.getElementById('f2').value === '数字经济 税收');

  // 换到别的窗口（win 对不上）→ 不粘，队列留着给原窗口
  var store17 = { sync: {}, local: {
    'siteLinker.pendingPaste': { text: '数字经济 税收', ts: Date.now(), src: 'http://localhost/source.html', win: 42 }
  } };
  var dom17 = makePage('<input id="q" type="search">', store17, 'http://localhost/other.html', null, { myWin: 43 });
  var w17 = dom17.window;
  w17.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  focusIn(w17, w17.document.getElementById('q'));
  await new Promise(function (r) { setTimeout(r, 50); });
  check('别的窗口不自动粘贴', w17.document.getElementById('q').value === '');
  check('跨窗口不粘时队列保留（原窗口还能粘）', pendingOf(store17) && pendingOf(store17).text === '数字经济 税收');

  // 点击链接走完整链路：后台回传新窗口 ID，随队列落盘
  var store18 = { sync: {}, local: {} };
  var dom18 = makePage('<p id="k">在中国知网检索“数字经济”与“税收”的文献。</p>',
    store18, 'http://localhost/test.html', null, { fakeWin: 77 });
  var w18 = dom18.window;
  w18.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  clickSiteLink(w18, 'k');
  check('点击链接：多引号关键词入队', pendingOf(store18) && pendingOf(store18).text === '数字经济 税收');
  check('队列带上新窗口 ID（只在该窗口生效、可粘多次）', pendingOf(store18) && pendingOf(store18).win === 77);

  /* ===== 第三部分 B：iframe 防回贴（v1.8.0） ===== */
  // iframe 里不粘：pendingPaste.src 记的是顶层 URL，iframe 的 location.href 不同，
  // 旧版只比 location.href，"不回贴来源页"对来源页内嵌的 iframe 会失效。
  // 用真 iframe 跑 content.js（iframe 里 window.top !== window 是天生的，无需打桩）。
  var store14 = { sync: {}, local: {
    'siteLinker.pendingPaste': { text: '三体', ts: Date.now(), src: 'http://localhost/source.html' }
  } };
  var dom14 = makePage('<!DOCTYPE html><html><body><iframe id="f"></iframe></body></html>',
    store14, 'http://localhost/target.html');
  var w14 = dom14.window;
  var fw14 = w14.document.getElementById('f').contentWindow;
  fw14.chrome = makeChrome(store14);
  fw14.fetch = function () {
    return Promise.resolve({ json: function () { return Promise.resolve(dict); } });
  };
  fw14.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  var q14 = fw14.document.createElement('input');
  q14.id = 'q';
  q14.type = 'text';
  fw14.document.body.appendChild(q14);
  check('iframe 里 window.top !== window（测试前提）', fw14.top !== fw14);
  focusIn(fw14, q14);
  await new Promise(function (r) { setTimeout(r, 50); });
  check('iframe 里不自动粘贴（window.top !== window 直接跳过）', q14.value === '');

  // 点击发生在来源页内嵌 iframe：记了 srcTop，来源页顶层也不回贴
  var store15 = { sync: {}, local: {
    'siteLinker.pendingPaste': {
      text: '三体', ts: Date.now(), src: 'http://iframe-source/', srcTop: 'http://localhost/target.html'
    }
  } };
  var dom15 = makePage('<input id="q" type="text">', store15, 'http://localhost/target.html');
  var w15 = dom15.window;
  w15.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  focusIn(w15, w15.document.getElementById('q'));
  await new Promise(function (r) { setTimeout(r, 50); });
  check('点击来自来源页内嵌 iframe 时，来源页顶层不回贴（srcTop）', w15.document.getElementById('q').value === '');

  /* ===== 第四部分：自添加站点独立存储 + 旧键回退 ===== */
  var store7 = { sync: { 'siteLinker.userSites': [{ name: '测试星球', url: 'https://example.com', aliases: [] }] }, local: {} };
  var dom7 = makePage('<p>欢迎来到测试星球。</p>', store7);
  var w7 = dom7.window;
  w7.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  var link7 = w7.document.querySelector('a[data-site-linker]');
  check('自添加站点（新键 userSites）正常链接', !!link7 && link7.href === 'https://example.com/');

  var store8 = { sync: { 'siteLinker.overrides': { edits: {}, custom: [{ name: '旧版星球', url: 'https://legacy.example.com', aliases: [] }] } }, local: {} };
  var dom8 = makePage('<p>欢迎来到旧版星球。</p>', store8);
  var w8 = dom8.window;
  w8.eval(contentSrc);
  await new Promise(function (r) { setTimeout(r, 300); });
  var link8 = w8.document.querySelector('a[data-site-linker]');
  check('旧版 overrides.custom 回退读取（更新不丢数据）', !!link8 && link8.href === 'https://legacy.example.com/');

  /* ===== 第五部分：后台新开窗口 + 智能定位算法（v1.7.0） ===== */
  var bgListener = null;
  var winCalls = [];
  var bgWins = {};

  // 每个用例重建一套 chrome 桩并重新加载 background.js，拿最新注册的消息监听
  function setupBg(bounds) {
    bgWins = bounds || {};
    winCalls = [];
    bgListener = null;
    global.chrome = {
      runtime: {
        getURL: function (p) { return 'chrome-extension://fake/' + p; },
        lastError: null,
        onMessage: { addListener: function (fn) { bgListener = fn; } },
        onInstalled: { addListener: function () {} }
      },
      storage: {
        sync: { get: function (k, cb) { cb({}); }, set: function (d, cb) { if (cb) cb(); } },
        local: { get: function (k, cb) { cb({}); }, set: function (d, cb) { if (cb) cb(); } }
      },
      tabs: {
        get: function (id, cb) { cb({ id: id, windowId: 7 }); },
        create: function (d, cb) { if (cb) cb({}); }
      },
      windows: {
        get: function (id, cb) { cb(bgWins[id] || null); },
        getLastFocused: function (cb) { cb(bgWins[7] || null); },
        create: function (data, cb) { winCalls.push({ m: 'create', data: data }); cb({ id: 99 }); },
        update: function (id, data, cb) { winCalls.push({ m: 'update', id: id, data: data }); cb({ id: id }); }
      }
    };
    global.fetch = function (u) {
      // v2.0.0：background 会为体检名单再 fetch 一次 lists.json，按 URL 分流
      var payload = String(u || '').indexOf('citations/lists.json') !== -1 ? LISTS : dict;
      return Promise.resolve({ json: function () { return Promise.resolve(payload); } });
    };
    eval(backgroundSrc);
  }

  function sendBg(msg, sender) {
    return new Promise(function (resolve) {
      bgListener(msg, sender, function (resp) { resolve(resp); });
    });
  }
  var createOf = function () {
    for (var i = 0; i < winCalls.length; i++) if (winCalls[i].m === 'create') return winCalls[i].data;
    return null;
  };
  var updateOf = function () {
    for (var i = 0; i < winCalls.length; i++) if (winCalls[i].m === 'update') return winCalls[i];
    return null;
  };
  var TAB7 = { tab: { id: 3, windowId: 7 } };

  // ① 左半屏吸附 → 镜像到右半屏
  setupBg({ 7: { id: 7, left: 0, top: 0, width: 960, height: 1080 } });
  var r1 = await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 1920, h: 1080 } }, TAB7);
  var c1 = createOf();
  check('左半屏吸附：新窗口镜像到右半屏', r1.ok === true && c1 && c1.left === 972 && c1.width === 936 && c1.top === 0 && c1.height === 1056);
  check('create 参数：url / focused / normal 齐全', c1 && c1.url === 'https://www.douban.com/' && c1.focused === true && c1.type === 'normal');
  check('create 后补 update 修正位置（macOS 双保险）', !!updateOf() && updateOf().data.left === 972 && updateOf().data.top === 0);

  // ② 右半屏吸附 → 放左半屏
  setupBg({ 7: { id: 7, left: 960, top: 0, width: 960, height: 1040 } });
  await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 1920, h: 1080 } }, TAB7);
  var c2 = createOf();
  check('右半屏吸附：新窗口放左半屏', c2 && c2.left === 12 && c2.width === 936 && c2.height === 1040);

  // ③ 普通窗口 → 紧挨右侧
  setupBg({ 7: { id: 7, left: 100, top: 50, width: 800, height: 600 } });
  await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 1920, h: 1080 } }, TAB7);
  var c3 = createOf();
  check('普通窗口：紧挨当前窗口右侧', c3 && c3.left === 912 && c3.top === 50 && c3.width === 800 && c3.height === 600);

  // ④ 右侧放不下 → 翻到左侧
  setupBg({ 7: { id: 7, left: 1000, top: 0, width: 800, height: 600 } });
  await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 1920, h: 1080 } }, TAB7);
  var c4 = createOf();
  check('右侧放不下：翻到当前窗口左侧', c4 && c4.left === 188);

  // ⑤ 多显示器坐标异常 → 不指定位置，交给系统级联
  setupBg({ 7: { id: 7, left: -1600, top: 0, width: 900, height: 1200 } });
  var r5 = await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 1920, h: 1080 } }, TAB7);
  var c5 = createOf();
  check('多屏坐标异常（左侧副屏）：不指定位置（系统级联），窗口照常创建', r5.ok === true && c5 && !('left' in c5));
  check('多屏降级时不调 update', !updateOf());

  // ⑤b 右侧副屏（left 超出当前屏宽）→ 同样降级，不把窗口扔到主屏
  setupBg({ 7: { id: 7, left: 1920, top: 0, width: 960, height: 1080 } });
  await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 1920, h: 1080 } }, TAB7);
  check('右侧副屏：不指定位置（级联）', !('left' in createOf()));

  // ⑤c 边界被浏览器拒绝（"至少 50% 在可见屏幕内"）→ 无边界重建 + update 移位，窗口不丢
  setupBg({ 7: { id: 7, left: 0, top: 0, width: 960, height: 1080 } });
  var createCount = 0;
  var origCreate = global.chrome.windows.create;
  global.chrome.windows.create = function (data, cb) {
    createCount++;
    var n = createCount;
    // 真实 Chrome 语义：lastError 只在当次回调里有效，且回调是异步的
    setTimeout(function () {
      if (n === 1) {
        global.chrome.runtime.lastError = { message: 'Invalid value for bounds.' };
        cb(undefined);
        global.chrome.runtime.lastError = null;
        return;
      }
      winCalls.push({ m: 'create', data: data });
      cb({ id: 99 });
    }, 0);
  };
  var r5c = await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 1920, h: 1080 } }, TAB7);
  global.chrome.windows.create = origCreate;
  check('边界被拒：改用无边界重建，窗口不丢', r5c.ok === true && createCount === 2);
  check('重建时不带边界（系统级联位置）', !('left' in createOf()));
  check('重建后仍尝试 update 移位', !!updateOf() && updateOf().data.left === 972);

  // ⑥ 拿不到屏幕尺寸 → 同样级联
  setupBg({ 7: { id: 7, left: 0, top: 0, width: 960, height: 1080 } });
  await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 0, h: 0 } }, TAB7);
  check('无屏幕尺寸：不指定位置（级联）', !('left' in createOf()));

  // ⑦ 非 http(s) 拒绝
  setupBg({ 7: { id: 7, left: 0, top: 0, width: 960, height: 1080 } });
  var r7 = await sendBg({ type: 'siteLinker:openInWindow', url: 'javascript:alert(1)', screen: { w: 1920, h: 1080 } }, TAB7);
  check('拒绝非 http(s) 链接', r7.ok === false && !createOf());

  // ⑧ popup 等扩展页面来源（无 sender.tab）→ 最近聚焦窗口兜底
  setupBg({ 7: { id: 7, left: 0, top: 0, width: 960, height: 1080 } });
  var r8 = await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 1920, h: 1080 } }, {});
  check('扩展页面来源：用最近聚焦窗口定位', r8.ok === true && createOf().left === 972);

  // ⑨ getDictionary 兜底通道回归
  setupBg({});
  var r9 = await sendBg({ type: 'siteLinker:getDictionary' }, {});
  check('getDictionary 兜底通道仍正常', r9.ok === true && Array.isArray(r9.dict.categories));

  // ⑨-b v2.0.0：体检名单复用同一条消息通道（不新增消息类型）
  var r9b = await sendBg({ type: 'siteLinker:getDictionary', withLists: true }, {});
  check('withLists：同一条通道把体检名单一起带出来',
    r9b.ok === true && Array.isArray(r9b.dict.categories) &&
    Array.isArray(r9b.lists.media) && r9b.lists.media.length > 200);
  var r9c = await sendBg({ type: 'siteLinker:getDictionary' }, {});
  check('不要名单时载荷不变（老调用方不受影响）', r9c.ok === true && r9c.lists === undefined);

  // ⑩ update 移位被拒（边界仍不合格）：窗口已存在，算成功，不丢窗口
  setupBg({ 7: { id: 7, left: 0, top: 0, width: 960, height: 1080 } });
  var origUpdate = global.chrome.windows.update;
  global.chrome.windows.update = function (id, data, cb) {
    winCalls.push({ m: 'update', id: id, data: data });
    setTimeout(function () {
      global.chrome.runtime.lastError = { message: 'Invalid value for bounds.' };
      cb(undefined);
      global.chrome.runtime.lastError = null;
    }, 0);
  };
  var r10 = await sendBg({ type: 'siteLinker:openInWindow', url: 'https://www.douban.com/', screen: { w: 1920, h: 1080 } }, TAB7);
  global.chrome.windows.update = origUpdate;
  check('update 被拒：窗口已存在，仍报成功（位置留系统默认）', r10.ok === true && !!createOf() && !!updateOf());

  /* ===== 第五部分：v2.0.0 信源体检 · 结构复刻快照回归 =====
   * 快照在 tests/citations/，DOM 形状照抄调研 §3.2（不是真实页面抓取，真快照 S0 校准后替换）。
   * 用例断言的是"提取出的来源集合与判级结果"，不锁具体哈希类名。 */
  console.log('\n--- v2.0.0 信源体检：快照、判级、卡片、台账 ---');
  const AUDIT_CTX = function (w, adapter, feedback) {
    return { dict: dict, lists: LISTS, adapter: adapter, feedbackHosts: feedback || new Set() };
  };

  // —— DeepSeek ——
  var ds = await auditFixture('deepseek-sample.html', 'https://chat.deepseek.com/');
  var dsCtx = AUDIT_CTX(ds.w, ds.adapter);
  var dsRows = rows(ds.last, { w: ds.w, ctx: dsCtx });
  check('DeepSeek：chat.deepseek.com 命中适配器', !!ds.adapter && ds.adapter.id === 'deepseek');
  check('DeepSeek：切成 2 轮（提问块与 .ds-markdown 配对）', ds.turns.length === 2);
  check('DeepSeek：最新一轮提问取自哈希类 .fbb737a4', ds.last.query === '知网有哪些学位论文库？');
  check('DeepSeek：最新一轮提取到 4 条来源', dsRows.length === 4);
  check('DeepSeek：中国知网按词典判高', tierOf(dsRows, 'cnki.net') === 'high/dictionary');
  check('DeepSeek：统计局按 gov.cn 后缀判高', tierOf(dsRows, 'stats.gov.cn') === 'high/gov-edu');
  check('DeepSeek：blog.csdn.net 按社区名单判中', tierOf(dsRows, 'blog.csdn.net') === 'mid/community');
  check('DeepSeek：doubao.com 中转域判待核（不是"低可信"）', tierOf(dsRows, 'doubao.com') === 'pending/platform-link');
  check('DeepSeek：没有来源的那一条就是空的，不硬凑 claimed',
    (ds.turns[0].citations || []).length === 0);
  check('DeepSeek：角标编号与前后 50 字上下文被记录',
    (ds.last.markers || []).length >= 2 && !!ds.last.markers[0].context);
  var dsSummary0 = ds.w.SL_CITATION_AUDIT.summarizeTurn(ds.last.citations, dsCtx);
  check('DeepSeek：汇总行分档计数 2/1/1',
    dsSummary0.high === 2 && dsSummary0.mid === 1 && dsSummary0.pending === 1 && dsSummary0.total === 4);

  var dsStream = await auditFixture('deepseek-streaming.html', 'https://chat.deepseek.com/');
  check('DeepSeek：页面还在流式输出时不做提取（streaming）',
    dsStream.res.ok === false && dsStream.res.failReason === 'streaming');

  var dsCollapsed = await auditFixture('deepseek-collapsed.html', 'https://chat.deepseek.com/');
  check('DeepSeek：只声称"搜索到5个网页"→ 一条 claimed，不显示"无来源"',
    dsCollapsed.res.ok === true && (dsCollapsed.turns[0].citations || []).length === 1 &&
    dsCollapsed.turns[0].citations[0].state === 'claimed');

  // —— Kimi ——
  var km = await auditFixture('kimi-sample.html', 'https://www.kimi.com/');
  var kmCtx = AUDIT_CTX(km.w, km.adapter);
  var kmRows = rows(km.last, { w: km.w, ctx: kmCtx });
  check('Kimi：kimi.com 命中适配器', !!km.adapter && km.adapter.id === 'kimi');
  check('Kimi：浮层 .info-container 的链接算进最后一轮', kmRows.length === 2);
  check('Kimi：同一 URL 重复出现已去重', km.last.citations.length === 2);
  check('Kimi：澎湃新闻按核实名单判高', tierOf(kmRows, 'thepaper.cn') === 'high/cac-media');
  check('Kimi：环球网按官方许可名单判高', tierOf(kmRows, 'huanqiu.com') === 'high/cac-media');
  check('Kimi：正文 .rag-tag 角标计数命中 2 个', (km.last.markers || []).length === 2);
  var kmAi = await auditFixture('kimi-sample.html', 'https://www.kimi.ai/');
  check('Kimi：kimi.ai 国际版同样适配（拍板 §8-4 = A）', !!kmAi.adapter && kmAi.adapter.id === 'kimi');

  // —— 豆包 ——
  var db = await auditFixture('doubao-sample.html', 'https://www.doubao.com/chat/');
  var dbRows = rows(db.last, { w: db.w, ctx: AUDIT_CTX(db.w, db.adapter) });
  check('豆包：思考框引用链接提取 3 条（重复 URL 已去重）', dbRows.length === 3);
  check('豆包：站内链接一律待核', dbRows.filter(function (r) { return r.domain.indexOf('doubao.com') === -1; }).length === 1);
  check('豆包：中国政府网判高', tierOf(dbRows, 'gov.cn') === 'high/gov-edu');
  var dbEmpty = await auditFixture('doubao-no-source.html', 'https://www.doubao.com/chat/');
  // 折叠区"每站点最多一次"：思考框没展开时第一次要点开，第二次必须只读不点
  var dbTwice = await auditFixture('doubao-no-source.html', 'https://www.doubao.com/chat/', { skipExpand: true });
  check('豆包：第一次会点开折叠的思考框（点了 1 次）',
    dbEmpty.res.expanded && dbEmpty.res.expanded.clicked === 1 && dbEmpty.res.expanded.skipped === false);
  check('豆包：带 skipExpand 时不再替用户点页面',
    dbTwice.res.expanded && dbTwice.res.expanded.clicked === 0 && dbTwice.res.expanded.skipped === true);
  check('豆包：无来源时给 1 条 claimed 而不是空卡',
    (dbEmpty.last.citations || []).length === 1 && dbEmpty.last.citations[0].state === 'claimed');

  // —— 元宝：抽屉按 dt-cid 配轮次 ——
  var yb = await auditFixture('yuanbao-sample.html', 'https://yuanbao.tencent.com/');
  var ybCtx = AUDIT_CTX(yb.w, yb.adapter);
  check('元宝：切出 2 轮', yb.turns.length === 2);
  check('元宝：conv-1 分到 2 条、conv-2 分到 1 条（dt-cid 配对）',
    (yb.turns[0].citations || []).length === 2 && (yb.turns[1].citations || []).length === 1);
  check('元宝：抽屉项的来源名当 siteName 用', yb.turns[0].citations[0].siteName === '中国政府网');
  check('元宝：第二轮人民网判高',
    rows(yb.turns[1], { w: yb.w, ctx: ybCtx })[0].tier === 'high');
  check('元宝：知乎条目判中（社区优先于词典）',
    rows(yb.turns[0], { w: yb.w, ctx: ybCtx }).some(function (r) { return r.tier === 'mid'; }));

  // —— 通义千问：引用在 script JSON 里 ——
  var qw = await auditFixture('qianwen-sample.html', 'https://www.qianwen.com/chat');
  var qwCtx = AUDIT_CTX(qw.w, qw.adapter);
  var qwRows = rows(qw.last, { w: qw.w, ctx: qwCtx });
  check('千问：从 script[type=application/json] 解出 4 条', qwRows.length === 4);
  check('千问：norm_url 字段被当成链接', qw.last.citations.filter(function (c) { return c.state === 'linked'; }).length === 3);
  check('千问：新华网判高（词典或名单任一通道）',
    qwRows.some(function (r) { return r.domain.indexOf('news.cn') !== -1 && r.tier === 'high'; }));
  check('千问：知乎判中', tierOf(qwRows, 'zhihu.com') === 'mid/community');
  check('千问：news24 类榜单域判农场待核', tierOf(qwRows, 'top100-news24.com') === 'pending/farm-pattern');
  check('千问：JSON 里没给链接的一条算无链接',
    qwRows.some(function (r) { return r.state === 'claimed'; }));

  // —— 文心一言：面板无 URL + DOM 逆序 ——
  var yy = await auditFixture('yiyan-sample.html', 'https://yiyan.baidu.com/');
  check('文心：reverseRounds 生效，最早一轮排在第一', yy.turns[0].query === '第一轮的问题');
  check('文心：面板 3 项全部算"提到来源但无链接"',
    (yy.turns[0].citations || []).length === 3 &&
    yy.turns[0].citations.every(function (c) { return c.state === 'named'; }));
  check('文心：面板项没链接 → 特殊态，不进三档',
    rows(yy.turns[0], { w: yy.w, ctx: AUDIT_CTX(yy.w, yy.adapter) })
      .every(function (r) { return r.state === 'claimed' && r.tier === '-'; }));
  check('文心：来源名与日期都留着（卡片要显示）',
    yy.turns[0].citations[0].siteName === '中国新闻网' && !!yy.turns[0].citations[0].time);

  // —— Perplexity：属性 URL + 中转解包 ——
  var pp = await auditFixture('perplexity-sample.html', 'https://www.perplexity.ai/');
  var ppRows = rows(pp.last, { w: pp.w, ctx: AUDIT_CTX(pp.w, pp.adapter) });
  check('Perplexity：3 条来源（含两条解包后的不同子域）', ppRows.length === 3);
  check('Perplexity：data-pplx-citation-url 属性直接取到 URL',
    pp.last.citations.some(function (c) { return c.url.indexOf('wikipedia.org') !== -1; }));
  check('Perplexity：/api/redirect?url= 解包成真实域名',
    pp.last.citations.some(function (c) { return c.viaRedirect && c.domain.indexOf('stats.gov.cn') !== -1; }));
  check('Perplexity：解包后的 gov.cn 判高，不因解过包而降', tierOf(ppRows, 'data.stats.gov.cn') === 'high/gov-edu');
  check('Perplexity：维基百科判中（社区优先于词典）', tierOf(ppRows, 'wikipedia.org') === 'mid/community');

  // —— ChatGPT：utm 与 #:~:text= 清洗 + 去重 ——
  var cg = await auditFixture('chatgpt-sample.html', 'https://chatgpt.com/');
  var cgRows = rows(cg.last, { w: cg.w, ctx: AUDIT_CTX(cg.w, cg.adapter) });
  check('ChatGPT：同一条链接的两个片段去掉 utm 与 #:~:text= 后合并成 2 条', cgRows.length === 2);
  check('ChatGPT：URL 里没有 utm_source 残留',
    cg.last.citations.every(function (c) { return c.url.indexOf('utm_') === -1; }));
  check('ChatGPT：URL 里没有媒体片段残留',
    cg.last.citations.every(function (c) { return c.url.indexOf(':~:text=') === -1; }));
  check('ChatGPT：两条都判高', cgRows.filter(function (r) { return r.tier === 'high'; }).length === 2);

  // —— 未校准站点：一个都没命中时报"可能改版"，不静默显示"无来源" ——
  var cg2 = await auditFixture('chatglm-sample.html', 'https://chatglm.cn/');
  check('智谱清言（未校准）：ok=false 且 failReason=uncalibrated-no-hit',
    cg2.res.ok === false && cg2.res.failReason === 'uncalibrated-no-hit');

  // —— 非 AI 对话页：零开销 ——
  check('普通网页（github.com）不匹配任何适配器',
    citationWindow('<html><body>hi</body></html>', 'https://github.com/x')
      .SL_CITATION_ADAPTERS.matchAdapter('github.com') === null);
  check('适配器注册表 11 站、8 已验证 + 3 待校准', (function () {
    var all = citationWindow('<html></html>', 'https://example.com/').SL_CITATION_ADAPTERS.CITATION_ADAPTERS;
    var ids = Object.keys(all);
    return ids.length === 11 &&
      ids.filter(function (k) { return all[k].status === 'verified'; }).length === 8 &&
      ids.filter(function (k) { return all[k].status === 'uncalibrated'; }).length === 3;
  })());
  check('适配器配置自检无问题', (function () {
    var A = citationWindow('<html></html>', 'https://example.com/').SL_CITATION_ADAPTERS;
    return A.validateAdapters(A.CITATION_ADAPTERS).every(function (r) { return r.problems.length === 0; });
  })());

  // —— 判级规则逐条（§5.2 顺序）——
  var W0 = citationWindow('<html></html>', 'https://example.com/');
  var AUD = W0.SL_CITATION_AUDIT;
  function grade(host, siteName, extra) {
    var c = { url: host ? 'https://' + host + '/' : null, domain: host || null,
      state: host ? 'linked' : 'claimed', siteName: siteName || '' };
    if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
    var r = AUD.auditCitation(c, { dict: dict, lists: LISTS, feedbackHosts: new Set() });
    return (r.tier || 'claimed') + '/' + r.reason;
  }
  check('规则 1：没有 URL → 特殊态', grade('', '某站') === 'claimed/no-url');
  check('规则 2：平台自身域优先于 gov 后缀判定', grade('yiyan.baidu.com') === 'pending/platform-link');
  check('规则 3：.gov.cn 判高', grade('www.stats.gov.cn') === 'high/gov-edu');
  check('规则 3：.edu.cn 判高', grade('www.tsinghua.edu.cn') === 'high/gov-edu');
  check('规则 4：官方子域 lawpro.cnki.net 判高（不因不是主页而降档）',
    grade('lawpro.cnki.net') === 'high/dictionary');
  check('规则 5：许可名单内的环球网判高', grade('www.huanqiu.com') === 'high/cac-media');
  check('规则 6：来源名自称知网、域名不对 → 待核',
    grade('cnki-clone-example.com', '中国知网') === 'pending/brand-mismatch');
  check('规则 6 不误伤：自称"中国新闻网"且域名就是它 → 仍判高',
    grade('www.chinanews.com.cn', '中国新闻网').indexOf('high/') === 0);
  check('规则 7：社区子域 zhuanlan.zhihu.com 判中', grade('zhuanlan.zhihu.com') === 'mid/community');
  check('社区名单优先于词典（词典里的知乎不能被判成权威）',
    grade('www.zhihu.com') === 'mid/community');
  check('规则 7：docs. 前缀的产品文档判中', grade('docs.example-tool.com') === 'mid/community');
  check('docs. 前缀不盖过词典（docs.python.org 是 Python 官网，判高）',
    grade('docs.python.org') === 'high/dictionary');
  check('规则 8：农场特征判待核', grade('www.top100-news24.com') === 'pending/farm-pattern');
  check('规则 9：陌生域名判未收录/待核', grade('random-unknown-xyz123.com') === 'pending/unlisted');
  check('用户反馈过的域名升为高（反向积累）', (function () {
    var fb = new Set(['example-farm-news24.com']);
    var r = AUD.auditCitation({ url: 'https://example-farm-news24.com/', domain: 'example-farm-news24.com',
      state: 'linked', siteName: '' }, { dict: dict, lists: LISTS, feedbackHosts: fb });
    return r.tier === 'high' && r.reason === 'user-confirmed';
  })());

  // —— 体检卡：Shadow DOM、文案口径、改版告警 ——
  var cardWin = await auditFixture('deepseek-sample.html', 'https://chat.deepseek.com/');
  var cardSummary = cardWin.w.SL_CITATION_AUDIT.summarizeTurn(
    cardWin.last.citations, AUDIT_CTX(cardWin.w, cardWin.adapter));
  var cardModel = {
    platform: 'deepseek', platformLabel: 'DeepSeek', status: 'ok',
    summary: cardSummary, query: cardWin.last.query
  };
  cardWin.w.SL_CITATION_CARD.renderCard(cardModel, {});
  var hostEl = cardWin.w.document.querySelector('[data-sl-citation-card]');
  check('体检卡：宿主 div 挂在 body 上并带 data-sl-citation-card', !!hostEl);
  check('体检卡：用 open Shadow DOM，样式不外泄', !!hostEl && !!hostEl.shadowRoot &&
    hostEl.shadowRoot.querySelectorAll('style').length === 1);
  check('体检卡：行数与汇总一致', hostEl.shadowRoot.querySelectorAll('.row').length === cardSummary.total);
  check('体检卡：汇总行照清单第 6 节格式', hostEl.shadowRoot.querySelector('.sum').textContent ===
    '本条回答共识别到 4 个来源：官方/权威 2 · 聚合/社区 1 · 未收录/待核 1。');
  check('体检卡：每行有"打开"和"复制"', hostEl.shadowRoot.querySelectorAll('.acts a').length === 4 &&
    hostEl.shadowRoot.querySelectorAll('.acts button').length >= 8);
  var copyText = cardWin.w.SL_CITATION_CARD.buildCopyText(cardModel);
  check('体检卡：复制文本含"不代表是假网站"（未收录必须配这句）',
    copyText.indexOf('不代表是假网站') !== -1);
  check('口径纪律：全文不出现"不可信""谣言""造假"',
    ['不可信', '谣言', '造假', '虚假信息'].every(function (t) { return copyText.indexOf(t) === -1; }));
  check('口径纪律：每一个"假"字都只能在"不代表是假网站"这句里', (function () {
    var n = cardWin.w.SL_CITATION_CARD;
    var all = [copyText, hostEl.shadowRoot.textContent].join('\n');
    return all.split('假').length - 1 === all.split('不代表是假网站').length - 1 &&
      all.indexOf(n.PENDING_LEGEND) !== -1;
  })());
  check('口径纪律：卡片正文里"未收录"出现就配了那句（图例已挂上）',
    hostEl.shadowRoot.querySelectorAll('.legend').length === 1);
  cardWin.w.SL_CITATION_CARD.renderCard({ platform: 'deepseek', platformLabel: 'DeepSeek',
    status: 'fail', summary: cardWin.summary }, {});
  check('体检卡：选择器失效时报"可能已改版"，不说"没有来源"',
    hostEl.shadowRoot.querySelector('.warn').textContent.indexOf('可能页面已改版') !== -1);
  cardWin.w.SL_CITATION_CARD.renderCard({ platform: 'deepseek', platformLabel: 'DeepSeek',
    status: 'ok', summary: { total: 0, high: 0, mid: 0, pending: 0, claimed: 0, items: [] }, query: 'q' }, {});
  check('体检卡：真的没有来源时明说"没有任何可核对的来源"',
    hostEl.shadowRoot.querySelector('.empty').textContent === '本条回答没有给出任何可核对的来源。');

  // —— 台账与开关 ——
  var led = cardWin.w.SL_CITATION_LEDGER;
  led.appendRecord(led.recordFromModel(cardModel));
  var recs = null;
  led.loadLedger(function (r) { recs = r; });
  await new Promise(function (r) { setTimeout(r, 20); });
  led.loadLedger(function (r) { recs = r; });
  await new Promise(function (r) { setTimeout(r, 20); });
  check('台账：记录落 storage.local 且形状对',
    Array.isArray(recs) && recs.length === 1 && recs[0].platform === 'deepseek' &&
    recs[0].sources.length === 4 && recs[0].sources[0].tier);
  var csvText = led.toCsv((function () {
    var out = [];
    for (var i = 0; i < 10; i++) out.push({ ts: Date.now(), platform: 'deepseek', query: 'q' + i,
      sources: [{ domain: 'www.cnki.net', tier: 'high', reason: 'dictionary', url: 'https://www.cnki.net/' }],
      claimedCount: 1 });
    return out;
  })());
  check('台账：10 条能导出 CSV（表头 + 10 行）', csvText.split('\r\n').length === 11 && csvText.indexOf('时间,平台') !== -1);
  check('台账：CSV 带 BOM，Excel 打开不乱码', csvText.charCodeAt(0) === 0xFEFF);
  check('台账：防公式注入（= 开头加前导单引号）', led.toCsv([{ ts: 1, platform: '=1+1', query: '', sources: [], claimedCount: 0 }])
    .search(/"'=1\+1"/) !== -1);
  check('台账：JSON 导出写明无网络请求', led.toJson([]).indexOf('未发起任何网络请求') !== -1);
  var en = null;
  led.isEnabled(function (v) { en = v; });
  check('台账：总开关缺省为开', en === true);
  led.setEnabled(false);
  var en2 = null;
  led.isEnabled(function (v) { en2 = v; });
  await new Promise(function (r) { setTimeout(r, 10); });
  check('台账：关掉总开关后 isEnabled 为 false（回到 v1 行为）', en2 === false);

  // —— content.js 接入：体检卡不会被链接化误伤 ——
  var w2 = await (function () {
    var html2 = '<!DOCTYPE html><html><body><div class="ds-message"><div class="ds-markdown">' +
      '<p>写论文先查中国知网和数据。</p>' +
      '<div class="_04ab7b1_wrap"><a class="_04ab7b1" href="https://www.cnki.net/">中国知网</a>' +
      '<a class="_04ab7b1" href="https://www.stats.gov.cn/">国家统计局</a></div>' +
      '</div></div></body></html>';
    var dom2 = new JSDOM(html2, { url: 'https://chat.deepseek.com/', runScripts: 'dangerously', pretendToBeVisual: true });
    var win2 = dom2.window;
    var store2 = { sync: {}, local: {} };
    win2.chrome = makeChrome(store2, [], {});
    win2.fetch = function (u) {
      var payload = String(u).indexOf('citations/lists.json') !== -1 ? LISTS : dict;
      return Promise.resolve({ json: function () { return Promise.resolve(payload); } });
    };
    CITE_SRCS.forEach(function (s) { win2.eval(s); });
    win2.eval(contentSrc);
    return new Promise(function (resolve) { setTimeout(function () { resolve(win2); }, 3200); });
  })();
  check('content.js 接入：AI 页面上链接化照常工作',
    w2.document.querySelectorAll('a[data-site-linker]').length >= 1);
  var h2 = w2.document.querySelector('[data-sl-citation-card]');
  check('content.js 接入：体检卡在这条回答完成后自动出现', !!h2 && !!h2.shadowRoot);
  check('content.js 接入：卡片文本没有被链接化（Shadow DOM + SKIP_SELECTOR 双保险）',
    !!h2 && h2.shadowRoot.querySelectorAll('a[data-site-linker]').length === 0);
  check('content.js 接入：卡片里能看到分档计数',
    !!h2 && /本条回答共识别到/.test(h2.shadowRoot.textContent));

  // —— content.js 接入：总开关关了就不弹卡 ——
  var w3 = await (function () {
    var store3 = { sync: {}, local: { 'siteLinker.citations.enabled': false } };
    var dom3 = new JSDOM('<div class="ds-message"><div class="ds-markdown"><p>查中国知网</p></div></div>',
      { url: 'https://chat.deepseek.com/', runScripts: 'dangerously', pretendToBeVisual: true });
    var win3 = dom3.window;
    win3.chrome = makeChrome(store3, [], {});
    win3.fetch = function (u) {
      var payload = String(u).indexOf('citations/lists.json') !== -1 ? LISTS : dict;
      return Promise.resolve({ json: function () { return Promise.resolve(payload); } });
    };
    CITE_SRCS.forEach(function (s) { win3.eval(s); });
    win3.eval(contentSrc);
    return new Promise(function (resolve) { setTimeout(function () { resolve(win3); }, 2600); });
  })();
  check('总开关关：不挂体检卡（整条链路不跑）',
    !w3.document.querySelector('[data-sl-citation-card]'));
  check('总开关关：链接化主功能照常', w3.document.querySelectorAll('a[data-site-linker]').length >= 1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('运行出错:', e);
  process.exit(1);
});
