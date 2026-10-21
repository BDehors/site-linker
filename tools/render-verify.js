/* 信源体检 · 第三轮核实：真实 Chromium 渲染后读自名（构建期脚本，不随插件发布）
 *
 * 为什么要第三轮：前两轮是纯 HTTP 抓 HTML，环球网 / 海外网 / 法治网 / 金羊网 /
 * 东方网 这些站首页是 JS 渲染的，静态 HTML 里没有站点自名，于是"标题未含专名"——
 * 这是**抓取能力的局限**，不是"这些站不在名单里"。用真实浏览器渲染一次就能判。
 *
 * 判据不变：渲染后的 document.title / meta[og:site_name] / 正文里出现该媒体专名
 * 才算核实；命不中的照样进 unresolved，绝不写进 lists.json。
 *
 * 运行（环境照项目记忆：playwright 1.58.0 + chromium-1208，必须剥掉 PLAYWRIGHT_BROWSERS_PATH）：
 *   env -u PLAYWRIGHT_BROWSERS_PATH NODE_PATH=<受管node工作区>/node_modules node tools/render-verify.js
 * 输出：tools/media-verify-20261019-round3.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HERE = __dirname;
const OUT = path.join(HERE, 'media-verify-20261019-round3.json');

/* 只跑"前两轮拿不到证据、但域名本身返回过 200 或只是被反爬/TLS 挡住"的条目。
 * 域名 DNS 直接解析失败的（getaddrinfo failed）不在这里试——那说明候选域名压根不存在。 */
const TARGETS = [
  { name: '法治网', domain: 'www.legaldaily.com.cn', tokens: ['法治网', '法治日报'] },
  { name: '环球网', domain: 'www.huanqiu.com', tokens: ['环球网'] },
  { name: '海外网', domain: 'www.haiwainet.cn', tokens: ['海外网', '人民日报海外版'] },
  { name: '中国妇女网', domain: 'www.women.org.cn', tokens: ['中国妇女网'] },
  { name: '中国税务报', domain: 'www.ctaxnews.net.cn', tokens: ['中国税务报', '中国税网'] },
  { name: '金羊网', domain: 'www.ycwb.com', tokens: ['金羊网', '羊城晚报'] },
  { name: '天山网', domain: 'www.ts.cn', tokens: ['天山网'] },
  { name: '东方网', domain: 'www.eastday.com', tokens: ['东方网'] },
  { name: '中国环境网', domain: 'www.cenews.com.cn', tokens: ['中国环境网', '中国环境报'] },
  { name: '中国知识产权资讯网', domain: 'www.iprnews.com', tokens: ['中国知识产权报', '知识产权资讯网'] },
  { name: '中国消费者网', domain: 'www.ccn.com.cn', tokens: ['中国消费者报', '中国消费网'] },
  { name: '中国建设新闻网', domain: 'www.chinajsb.cn', tokens: ['中国建设报', '中国建设新闻网'] },
  { name: '广西新闻网', domain: 'www.gxnews.com.cn', tokens: ['广西新闻网', '广西日报'] },
  { name: '宁夏新闻网', domain: 'www.nxnews.net', tokens: ['宁夏新闻网'] },
  { name: '西部网', domain: 'www.cnwest.com', tokens: ['西部网'] },
  { name: '中国江西网', domain: 'www.jxnews.com.cn', tokens: ['中国江西网', '大江网'] },
  { name: '半月谈网', domain: 'www.banyuetan.org', tokens: ['半月谈'] },
  { name: '中国教育新闻网', domain: 'www.jyb.cn', tokens: ['中国教育报', '中国教育新闻网'] },
  { name: '民主与法制网', domain: 'www.mzyfz.com', tokens: ['民主与法制'] },
  { name: '上游新闻', domain: 'cqcb.com', tokens: ['上游新闻'] },
  { name: '中国气象新闻网', domain: 'www.nmc.cn', tokens: ['中国气象新闻网', '中国气象报'] },
  { name: '中国煤炭报', domain: 'www.ccn.com', tokens: ['中国煤炭报'] },
  { name: '理论网', domain: 'www.theory.cn', tokens: ['理论网'] },
  { name: '人民邮电报', domain: 'www.ptpress.com.cn', tokens: ['人民邮电报'] }
];

async function probe(browser, t) {
  const page = await browser.newPage();
  const rec = { name: t.name, domain: t.domain, ok: false, evidence: '', note: '' };
  try {
    await page.goto('https://' + t.domain + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);   // 给 JS 一点渲染时间
    const info = await page.evaluate(() => ({
      title: document.title || '',
      og: (document.querySelector('meta[property="og:site_name"]') || {}).content || '',
      body: (document.body ? document.body.innerText : '').slice(0, 20000),
      url: location.href
    }));
    const hay = (info.title + ' ' + info.og + ' ' + info.body).toLowerCase();
    const hit = t.tokens.find((x) => hay.indexOf(x.toLowerCase()) !== -1);
    if (hit) {
      rec.ok = true;
      rec.evidence = 'title=' + info.title.slice(0, 90) + ' | og=' + info.og.slice(0, 40) +
        ' | 命中「' + hit + '」 | 落地 ' + info.url;
    } else {
      rec.note = '渲染后仍无专名；title=' + info.title.slice(0, 80) + ' | 落地 ' + info.url;
    }
  } catch (e) {
    rec.note = String(e && e.message ? e.message : e).slice(0, 120);
  } finally {
    await page.close();
  }
  return rec;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const promoted = [], unresolved = [];
  for (const t of TARGETS) {
    const r = await probe(browser, t);
    (r.ok ? promoted : unresolved).push(r);
    console.log((r.ok ? 'UP  ' : 'NO  ') + t.name.padEnd(12) + ' ' + (r.evidence || r.note).slice(0, 100));
  }
  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify({
    round: 3,
    method: '真实 Chromium（headless）渲染后读 document.title / og:site_name / 可见正文，含专名才算核实',
    promotedCount: promoted.length,
    unresolvedCount: unresolved.length,
    promoted, unresolved
  }, null, 1), 'utf8');
  console.log('\n第三轮转正 ' + promoted.length + ' / 仍未核实 ' + unresolved.length + ' -> ' + OUT);
})().catch((e) => { console.error('跑不动：', e && e.message); process.exit(1); });
