/* 站点链接助手 · 信源体检 · S0 现场校准工具（构建期脚本，不随插件发布）
 *
 * 干什么：把插件里那套**真实代码**（adapters.js + extract.js + audit.js）注入浏览器，
 * 在你登录后的真实 AI 对话页上跑一遍，直接告诉你：
 *   ① 每个选择器命中几个元素（主选失效了、该补哪一级备选）；
 *   ② 整条提取管线 + 判级的真实产出，跟页面上肉眼看到的来源对不对得上（清单 C2 验收
 *      要人工标注对照，这一步就是给人对照用的）；
 *   ③ 把回答区 outerHTML 存成 tests/citations/<站>-live.html，快照从此是真的。
 * 因为注入的就是生产源码，这里报"命中 0"就是 adapters.js 真该改了，不会出现
 * "校准工具和插件两套判据"的假结论。
 *
 * 用法 A —— 现场校准（清单 S0 第 1–4 步，需要你登录 + 用眼睛核对）：
 *   env -u PLAYWRIGHT_BROWSERS_PATH NODE_PATH=<受管node工作区>/node_modules \
 *     node tools/calibrate.js https://chat.deepseek.com/
 *   node tools/calibrate.js https://www.kimi.com/ --save kimi
 * 浏览器会停在页面上：你登录、提几个需要联网的问题、等回答出完，回终端按回车才开始测。
 *
 * 用法 B —— 离线自检（不打扰人，用本地结构复刻快照验证工具与管线一致）：
 *   node tools/calibrate.js --file tests/citations/deepseek-sample.html --host chat.deepseek.com
 *
 * ⚠ --save 存的是真实页面：上传或分享前先检查有没有账号名、头像、私有提问，需要就先删。
 */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const CITE_DIR = path.join(ROOT, 'src', 'citations');
const MODULES = ['adapters.js', 'extract.js', 'audit.js', 'card.js'];
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/dictionary.json'), 'utf8'));
const lists = JSON.parse(fs.readFileSync(path.join(CITE_DIR, 'lists.json'), 'utf8'));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  const v = i > -1 ? process.argv[i + 1] : null;
  return v && !v.startsWith('--') ? v : dflt;
}

const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const fileMode = arg('file', null);
const hostMode = arg('host', 'chat.deepseek.com');
const saveName = arg('save', null);

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, () => { rl.close(); resolve(); }));
}

/* 离线自检也要让 hostname 是真的（适配器按 hostname 命中），所以本地起一个静态服务，
 * 再用 --host-resolver-rules 把目标域名指到它。 */
function startServer() {
  const s = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const abs = path.resolve(ROOT, fileMode || 'tests/index.html');
    if (url !== '/' && url !== '/' + path.basename(abs)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

async function injectModules(page) {
  for (const f of MODULES) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(CITE_DIR, f), 'utf8') });
  }
}

async function probe(page) {
  const info = await page.evaluate(() => {
    const A = window.SL_CITATION_ADAPTERS;
    const ad = A.matchAdapter(location.hostname);
    if (!ad) return { host: location.hostname, adapterId: null, selectors: {} };
    const out = { host: location.hostname, adapterId: ad.id, status: ad.status, selectors: {} };
    // 只把"拿去 querySelector 的东西"计入命中表；selfDomains / urlPatterns / notes 不是选择器
    const NOT_SELECTOR = /^(selfDomains|urlPatterns|notes|note|label|id|status|pairBy|path|fields)$/i;
    const count = (sel) => {
      try { return document.querySelectorAll(sel).length; } catch (e) { return '语法错'; }
    };
    const walk = (node, key) => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, key + '[' + i + ']'));
      if (!node || typeof node !== 'object') return;
      Object.keys(node).forEach((k) => {
        if (NOT_SELECTOR.test(k)) return;
        const v = node[k];
        if (typeof v === 'string' && /(selector|container|outer|inner|item|title|site|date)$/i.test(k)) {
          out.selectors[key + '.' + k + ' = ' + v] = count(v);
        } else if (Array.isArray(v) && /user|ai|citeMarker|sources/i.test(k)) {
          v.forEach((one, i) => {
            const sel = typeof one === 'string' ? one : (one && one.selector);
            if (sel) out.selectors[key + '.' + k + '[' + i + '] = ' + sel] = count(sel);
            else if (one) walk(one, key + '.' + k + '[' + i + ']');
          });
        } else if (v && typeof v === 'object') walk(v, key + '.' + k);
      });
    };
    walk(ad, 'adapter');
    return out;
  });

  console.log('\n主机 ' + info.host + ' → 适配器 ' +
    (info.adapterId || '（不匹配：检查 adapters.js 的 urlPatterns）') +
    (info.status ? '  [' + info.status + ']' : ''));
  if (!info.adapterId) return;

  console.log('\n—— 选择器命中表（0 = 该补备选或换包含式匹配）——');
  const zeros = [];
  Object.keys(info.selectors).forEach((k) => {
    const v = info.selectors[k];
    if (v === 0) zeros.push(k);
    console.log('  ' + String(v).padStart(4) + '  ' + k);
  });
  if (zeros.length) console.log('  ⚠ 命中 0 共 ' + zeros.length + ' 条：\n     ' + zeros.join('\n     '));

  // 真跑一遍提取 + 判级（同一份生产代码，不另写判据）
  const result = await page.evaluate((ctx) => {
    const A = window.SL_CITATION_ADAPTERS, E = window.SL_CITATION_EXTRACT, U = window.SL_CITATION_AUDIT;
    const ad = A.matchAdapter(location.hostname);
    if (!ad) return { noAdapter: true };
    return E.extractCitations(ad, {}).then((r) => ({
      ok: r.ok, failReason: r.failReason, platform: r.platform,
      turns: r.turns.map((t) => {
        const sum = U.summarizeTurn(t.citations, {
          dict: ctx.dict, lists: ctx.lists, adapter: ad, feedbackHosts: new Set()
        });
        return {
          query: (t.query || '').slice(0, 46),
          markers: (t.markers || []).length,
          items: sum.items.map((it) => ({
            tier: it.audit.tier || it.audit.state, reason: it.audit.reason,
            domain: it.citation.domain || it.citation.siteName || '(无域名)',
            title: String(it.citation.title || '').slice(0, 32),
            redirect: it.citation.viaRedirect ? '经跳转解包' : ''
          }))
        };
      })
    }));
  }, { dict, lists });

  if (result.noAdapter) return;
  console.log('\n—— 提取管线产出：ok=' + result.ok + '  failReason=' + result.failReason + ' ——');
  result.turns.forEach((t, i) => {
    console.log('  轮 ' + (i + 1) + '「' + t.query + '」 角标 ' + t.markers + ' 个，来源 ' + t.items.length + ' 条');
    t.items.forEach((c) => {
      console.log('    ' + String(c.tier).padEnd(8) + c.reason.padEnd(17) +
        c.domain.padEnd(27) + c.title + '  ' + c.redirect);
    });
  });
  const flat = [].concat.apply([], result.turns.map((t) => t.items));
  const s = { high: 0, mid: 0, pending: 0, claimed: 0 };
  flat.forEach((c) => { if (s[c.tier] != null) s[c.tier]++; });
  console.log('\n  合计：官方/权威 ' + s.high + ' · 聚合/社区 ' + s.mid + ' · 未收录/待核 ' + s.pending +
    ' · 无链接 ' + s.claimed);
  console.log('  ↑ 拿这个数字跟你在页面上看到的来源条数对一遍：对不上就是漏抓（清单 C2 验收的"人工标注对照"）。');

  if (saveName) {
    const html = await page.evaluate((name) => {
      const body = document.body ? document.body.innerHTML : '';
      return '<!DOCTYPE html>\n<!-- 真实页面快照：' + location.hostname + ' · ' +
        new Date().toISOString().slice(0, 10) + ' · 由 tools/calibrate.js --save ' + name + ' 生成 -->\n' +
        '<html lang="zh-CN"><head><meta charset="utf-8"><title>' + name + ' live</title></head>\n<body>\n' +
        body + '\n</body></html>\n';
    }, saveName);
    const out = path.join(ROOT, 'tests', 'citations', saveName + '-live.html');
    fs.writeFileSync(out, html, 'utf8');
    console.log('\n快照已存：' + out + '（' + html.length + ' 字节）');
    console.log('⚠ 真实页面可能带账号名 / 头像 / 私有提问，分享或入库前先打开看一眼、该删的删。');
  }
}

(async () => {
  let server = null;
  let url = target;
  let rules = null;
  if (fileMode) {
    server = await startServer();
    const port = server.address().port;
    rules = 'MAP ' + hostMode + ' 127.0.0.1:' + port;
    url = 'http://' + hostMode + '/';
  } else if (!target) {
    console.log('用法：node tools/calibrate.js <AI 站地址> [--save 站点名]\n' +
      '  或：node tools/calibrate.js --file tests/citations/xx.html --host chat.deepseek.com');
    process.exit(1);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-calibrate-'));
  const args = ['--disable-blink-features=AutomationControlled', '--no-first-run'];
  if (rules) args.push('--host-resolver-rules=' + rules);
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: !!fileMode, channel: 'chromium',
    viewport: { width: 1440, height: 900 }, args
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  if (!fileMode) {
    console.log('\n浏览器已打开 ' + url);
    console.log('请：① 登录 ② 提 3–5 个需要联网的问题（要数据、要政策那种最容易出引用）③ 等回答出完');
    console.log('做完回终端按回车开始测（Ctrl+C 随时放弃）。');
    await ask('按回车继续…');
  }

  await injectModules(page);
  await probe(page);
  await ctx.close();
  if (server) server.close();
})().catch((e) => {
  console.error('跑不动：', e && e.message ? e.message : e);
  console.error('提示：playwright 需 1.58.0 + 本机 chromium-1208，运行前 env -u PLAYWRIGHT_BROWSERS_PATH');
  process.exit(1);
});
