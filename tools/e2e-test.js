/* 真实浏览器端到端测试（Playwright + 解压加载扩展 + 本地 http 服务）。
 * 断言三个测试页面的链接化结果、修正层、弹窗搜索、设置页，v1.6.0 的
 * “点击链接自动复制 + 新页面自动粘贴”（含设置页开关联动、自添加站点新旧存储键），
 * v1.7.0 的“点击链接新开浏览器窗口 + 智能定位”（CDP 校验确为独立窗口、
 * 关闭开关后恢复同窗口新标签页），v1.8.0 的“编辑重名防护 + 批量导入恢复默认”，
 * v1.9.0 的“一句多个引号全部复制 + 生效窗口内多次粘贴 / 跨窗口不粘”，
 * 并把页面截图存到系统临时目录（SL_E2E_SHOTS 可覆盖）。
 * v2.0.0 信源体检：用 --host-resolver-rules 把 AI 站域名指到本地测试服务，在真实扩展加载下
 * 验证体检卡挂载耗时、卡片未被链接化、未校准站点静默、台账落 storage.local、设置页开关往返。
 *
 * 运行：NODE_PATH=<全局 node_modules> PLAYWRIGHT_BROWSERS_PATH=<chromium 所在目录> node tools/e2e-test.js
 * 依赖：playwright（全局或局部安装均可）。扩展以 --load-extension 方式加载真实 src/。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SL_E2E_SHOTS || path.join(os.tmpdir(), 'sl-visual');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name); }
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* v2.0.0 信源体检：把这几个 AI 站域名指到本地测试服务，
 * 这样能在真实 Chromium 里跑"扩展加载 → content script → 适配器命中 → 体检卡"整条链路，
 * 而不用登录真站（真站需账号，快照抓取归 S0 现场校准）。 */
const AI_HOSTS = ['chat.deepseek.com', 'www.doubao.com', 'yiyan.baidu.com', 'chatglm.cn'];

function chromeArgs(port) {
  const rules = AI_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(',');
  return [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run',
    '--no-default-browser-check', '--disable-sync', '--host-resolver-rules=' + rules];
}

async function launchWithExtension(port) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-e2e-profile-'));
  const args = chromeArgs(port);
  // channel:'chromium' = 完整浏览器（新版无头模式），支持 --load-extension；
  // 默认的 headless shell 不加载扩展。
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: true, channel: 'chromium', args });
  return { ctx, userDataDir };
}

// 从用户数据目录里找解压扩展的 ID（兜底手段：service worker 可能尚未启动）
function readExtensionIdFromProfile(userDataDir) {
  for (const rel of ['Default/Secure Preferences', 'Default/Preferences']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(userDataDir, rel), 'utf8'));
      const st = (j.extensions && j.extensions.settings) || {};
      for (const [id, v] of Object.entries(st)) {
        if (v && typeof v.path === 'string' && path.resolve(v.path).toLowerCase() === path.resolve(ROOT).toLowerCase()) return id;
      }
    } catch (e) { /* 文件不存在或格式不同，继续 */ }
  }
  return null;
}

async function resolveExtensionId(ctx, userDataDir) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) {
    try { sw = await ctx.waitForEvent('serviceworker', { timeout: 6000 }); } catch (e) { /* 没等到就换兜底 */ }
  }
  if (sw) return new URL(sw.url()).host;
  return readExtensionIdFromProfile(userDataDir);
}

// 取页面所在浏览器窗口的 ID（CDP）：两个页面 ID 相同 = 同一窗口（标签页），不同 = 独立窗口
async function windowIdOf(ctx, page) {
  try {
    const cdp = await ctx.newCDPSession(page);
    const info = await cdp.send('Target.getTargetInfo');
    const w = await cdp.send('Browser.getWindowForTarget', { targetId: info.targetInfo.targetId });
    return w.windowId;
  } catch (e) {
    return null;
  }
}

(async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;

  let { ctx, userDataDir } = await launchWithExtension(server.address().port);
  let page = await ctx.newPage();
  await page.goto(base + '/tests/quiz.html');
  await page.waitForTimeout(1500);

  let linkTexts = await page.$$eval('a[data-site-linker]', as => as.map(a => a.textContent));
  if (linkTexts.length === 0) {
    // 个别环境新无头模式不加载扩展，换有头模式再试一次
    console.log('  （无头模式未生效，改用有头模式重试）');
    await ctx.close();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-e2e-profile-'));
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false, channel: 'chromium', args: chromeArgs(server.address().port)
    });
    page = await ctx.newPage();
    await page.goto(base + '/tests/quiz.html');
    await page.waitForTimeout(2000);
    linkTexts = await page.$$eval('a[data-site-linker]', as => as.map(a => a.textContent));
  }

  console.log('quiz.html（模拟练习）');
  const quizExpect = ['国家统计局', '国家数据', '北京市统计局', '中国知网', '万方数据', '维普',
    'Web of Science', 'Scopus', '谷歌学术', 'OpenAlex', 'arXiv', 'bioRxiv', 'medRxiv',
    'PubMed', 'PubMed Central', 'DOAJ', 'PubScholar', 'Zotero', 'Overleaf', 'GitHub',
    'Kaggle', 'Hugging Face', '国家图书馆', 'NSTL', 'CALIS', '国家标准全文公开', '国家法律法规数据库',
    'CNKI', '中华古籍资源库', '民国时期文献库', '中国证券业协会查询系统', '国家药品监督管理局数据查询'];
  const quizMissing = quizExpect.filter(t => linkTexts.indexOf(t) === -1);
  check('32 个期望站点全部成链' + (quizMissing.length ? `，缺：${quizMissing.join('、')}` : ''), quizMissing.length === 0);
  check('误报屏蔽：万方科技未被链接', linkTexts.indexOf('万方科技') === -1);
  check('长词优先：无独立“统计局”链接', linkTexts.filter(t => t === '统计局').length === 0);
  check('代码块内零链接', await page.$$eval('pre a[data-site-linker]', as => as.length) === 0);
  const oldLink = await page.$eval('a[href="https://www.cnki.net"]:not([data-site-linker])',
    a => ({ t: a.textContent, marked: a.hasAttribute('data-site-linker') }));
  check('已有链接未被改动', oldLink.t === '中国知网官网' && !oldLink.marked);
  await page.screenshot({ path: path.join(SHOTS, 'page-quiz.png'), fullPage: true });

  console.log('article.html（文章阅读）');
  await page.goto(base + '/tests/article.html');
  await page.waitForTimeout(1500);
  linkTexts = await page.$$eval('a[data-site-linker]', as => as.map(a => a.textContent));
  const artExpect = ['PubMed', 'bioRxiv', 'medRxiv', 'JAMA', 'The Lancet', 'Nature', '人民日报',
    '中国知网', '万方数据', 'DOAJ', 'PubScholar', '国家哲学社会科学文献中心',
    '国家统计局', '国家数据', 'Our World in Data', 'World Bank Open Data', '世界卫生组织', '新英格兰医学杂志'];
  const artMissing = artExpect.filter(t => linkTexts.indexOf(t) === -1);
  check('18 个正文站点全部成链' + (artMissing.length ? `，缺：${artMissing.join('、')}` : ''), artMissing.length === 0);
  check('BibTeX 代码块内零链接（对照保留）', await page.$$eval('pre a[data-site-linker]', as => as.length) === 0);
  const nejm = await page.$eval('a[href="https://www.nejm.org"]:not([data-site-linker])', a => a.textContent);
  check('手写的 NEJM 链接未被改动', nejm === 'NEJM');
  check('参考资料 7 条出处均为链接', await page.$$eval('ol.refs a[href]', as => as.length) >= 7);
  const before = await page.$$eval('#more a[data-site-linker]', as => as.length);
  await page.click('#load-more');
  await page.waitForTimeout(1000);
  const dyn = await page.$$eval('#more a[data-site-linker]', as => as.map(a => a.textContent));
  check(`动态加载前 0 链接（实际 ${before}）`, before === 0);
  check('动态加载后被处理（Science / Web of Science / arXiv）' +
    (dyn.length ? `，实际：${dyn.join('、')}` : ''),
    ['Science', 'Web of Science', 'arXiv'].every(t => dyn.indexOf(t) !== -1));
  await page.screenshot({ path: path.join(SHOTS, 'page-article.png'), fullPage: true });

  console.log('index.html（套件首页）');
  await page.goto(base + '/tests/index.html');
  await page.waitForTimeout(800);
  check('三个场景卡片各就各位', await page.$$eval('.cards .card', as => as.length) === 3);
  await page.screenshot({ path: path.join(SHOTS, 'page-index.png'), fullPage: true });

  // —— 新功能：工具栏弹窗（分类速控）+ 站点修正层 ——
  const extId = await resolveExtensionId(ctx, userDataDir);
  check('能取得扩展 ID（用于打开弹窗 / 设置页）', !!extId);

  // 首次安装会自动打开《使用指南》（含截图）
  let guide = null;
  const g0 = Date.now();
  while (Date.now() - g0 < 6000) {
    guide = ctx.pages().find(p => p.url().indexOf('/src/manual.html') !== -1);
    if (guide) break;
    await page.waitForTimeout(300);
  }
  check('首次安装自动打开《使用指南》', !!guide);
  if (guide) {
    await guide.waitForTimeout(1000);
    const gi = await guide.$$eval('img', xs => xs.map(i => ({ s: i.getAttribute('src'), w: i.naturalWidth })));
    check('指南 7 张截图全部加载成功', gi.length === 7 && gi.every(i => i.w > 0));
  }

  if (extId) {
    console.log('popup.html（弹窗：分类速控）');
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);
    await popup.waitForTimeout(500);
    check('弹窗渲染出 6 个分类开关', await popup.$$eval('.cat input[type=checkbox]', xs => xs.length) === 6);

    const work = await ctx.newPage();
    await work.goto(base + '/tests/quiz.html');
    await work.waitForTimeout(1300);
    await popup.click('.cat input[data-cat="gov"]');
    await work.waitForTimeout(900);
    let texts = await work.$$eval('a[data-site-linker]', as => as.map(a => a.textContent));
    check('弹窗关“政府与数据”后：国家统计局不再链接（无需刷新）', texts.indexOf('国家统计局') === -1);
    check('其他分类不受影响：中国知网仍在', texts.indexOf('中国知网') !== -1);
    await popup.click('.cat input[data-cat="gov"]');
    await work.waitForTimeout(900);
    texts = await work.$$eval('a[data-site-linker]', as => as.map(a => a.textContent));
    check('恢复“政府与数据”后：国家统计局重新链接', texts.indexOf('国家统计局') !== -1);

    console.log('修正层（改网址 / 停用 / 自添加站点：新键 + 旧键回退）');
    // 先按旧版格式写入（模拟老用户更新前的存储）：content.js 应从 overrides.custom 回退读取
    await popup.evaluate(() => new Promise(res => chrome.storage.sync.set({
      'siteLinker.overrides': {
        edits: { '中国知网': { url: 'https://example.com/cnki-fixed' }, '万方数据': { off: true } },
        custom: [{ name: 'DeepSeek', aliases: ['深度求索'], url: 'https://www.deepseek.com/' }]
      }
    }, res)));
    await work.waitForTimeout(1000);
    const fixed = await work.$eval('a[data-site-linker][href="https://example.com/cnki-fixed"]', a => a.textContent).catch(() => null);
    check('改网址生效：中国知网 → 自定义网址', fixed === '中国知网');
    texts = await work.$$eval('a[data-site-linker]', as => as.map(a => a.textContent));
    check('停用生效：万方数据不再链接', texts.indexOf('万方数据') === -1);
    await work.evaluate(() => {
      const p = document.createElement('p');
      p.className = 'dyn-check';
      p.textContent = '顺便看看 DeepSeek 和 深度求索 的新模型。';
      document.body.appendChild(p);
    });
    await work.waitForTimeout(1000);
    let custom = await work.$$eval('p.dyn-check a[data-site-linker]', as => as.map(a => [a.textContent, a.href]));
    check('旧版 overrides.custom 回退读取（老用户更新后不丢数据）',
      custom.length === 2 && custom.every(x => x[1].indexOf('deepseek.com') !== -1));

    // 再按新版格式写入：自添加站点独立键 siteLinker.userSites（与词库修正分离）
    await popup.evaluate(() => new Promise(res => chrome.storage.sync.set({
      'siteLinker.overrides': {
        edits: { '中国知网': { url: 'https://example.com/cnki-fixed' }, '万方数据': { off: true } }
      },
      'siteLinker.userSites': [{ name: 'DeepSeek', aliases: ['深度求索'], url: 'https://www.deepseek.com/' }]
    }, res)));
    await work.waitForTimeout(1000);
    custom = await work.$$eval('p.dyn-check a[data-site-linker]', as => as.map(a => [a.textContent, a.href]));
    check('新版 userSites 独立键生效（DeepSeek / 深度求索 → deepseek.com）',
      custom.length === 2 && custom.every(x => x[1].indexOf('deepseek.com') !== -1));

    console.log('点击链接自动复制 + 新窗口自动粘贴（可粘多次）');
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
    const ac = await ctx.newPage();
    await ac.goto(base + '/tests/article.html');
    await ac.waitForTimeout(1500);
    // 注意：内容页的 page world 里没有 chrome API，storage 操作一律借道扩展页面
    await popup.evaluate(() => new Promise(res => chrome.storage.local.set({ 'siteLinker.pendingPaste': null }, res)));
    await ac.click('#autocopy-demo a[data-site-linker][href*="douban"]');
    await ac.waitForTimeout(600);
    const pend = await popup.evaluate(() => new Promise(res =>
      chrome.storage.local.get('siteLinker.pendingPaste', d => res(d['siteLinker.pendingPaste'] || null))));
    check('点击链接：句中《》内容进入待粘贴队列', !!pend && pend.text === '三体');
    check('队列记下新开的浏览器窗口（只在该窗口生效）', !!pend && typeof pend.win === 'number');
    let clip = '';
    try { clip = await ac.evaluate(() => navigator.clipboard.readText()); } catch (e) { /* 无剪贴板权限时跳过 */ }
    check('同时写入系统剪贴板', clip === '三体');
    check('复制后有提示浮层', !!(await ac.$('.site-linker-toast').catch(() => null)));

    // v1.9.0：自动粘贴限定在“点击链接时新打开的那个浏览器窗口”，且可以粘多次
    let winPage = null;
    for (const pg of ctx.pages()) {
      if (pg.url().indexOf('douban.com') !== -1) winPage = pg;
    }
    check('点击后确实新开了一个浏览器窗口', !!winPage);
    if (winPage) {
      // 把这个窗口里的页面导航到本地测试页（窗口 ID 不变），模拟“在新窗口里干活”
      await winPage.goto(base + '/tests/quiz.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await winPage.waitForTimeout(1300);
      await winPage.evaluate(() => {
        const i = document.createElement('input');
        i.id = 'sl-paste-1'; i.type = 'search';
        document.body.appendChild(i); i.focus();
      });
      await winPage.waitForTimeout(400);
      const p1 = await winPage.$eval('#sl-paste-1', el => el.value).catch(() => '');
      check('新窗口里第一次自动粘贴', p1 === '三体');
      // 再粘一次：高级检索有多个检索框时，粘完删掉不要的词再粘下一个
      await winPage.evaluate(() => {
        const i = document.createElement('input');
        i.id = 'sl-paste-2'; i.type = 'search';
        document.body.appendChild(i); i.focus();
      });
      await winPage.waitForTimeout(400);
      const p2 = await winPage.$eval('#sl-paste-2', el => el.value).catch(() => '');
      check('同一窗口里可以再粘一次（不清队列）', p2 === '三体');
      const pendAfter = await popup.evaluate(() => new Promise(res =>
        chrome.storage.local.get('siteLinker.pendingPaste', d => res(d['siteLinker.pendingPaste'] || null))));
      check('粘过多次后队列仍在（10 分钟内有效）', !!pendAfter && pendAfter.text === '三体');
    }

    // v1.9.0：一句多个引号——点练习页第 11 题里的知网链接，两个检索词一起入队
    await popup.evaluate(() => new Promise(res => chrome.storage.local.set({ 'siteLinker.pendingPaste': null }, res)));
    await work.goto(base + '/tests/quiz.html');
    await work.waitForTimeout(1300);
    // 第 11 题题面里 CNKI 和“中国知网”都是链接，点第一个（CNKI）
    await work.locator('#q11 a[data-site-linker][href*="cnki"]').first().click();
    await work.waitForTimeout(600);
    const pendMulti = await popup.evaluate(() => new Promise(res =>
      chrome.storage.local.get('siteLinker.pendingPaste', d => res(d['siteLinker.pendingPaste'] || null))));
    check('一句两个引号：点击后“数字经济 税收”一起入队', !!pendMulti && pendMulti.text === '数字经济 税收');
    for (const pg of ctx.pages()) {
      if (pg.url().indexOf('cnki.net') !== -1) await pg.close().catch(() => {}); // 关掉点击打开的外网站
    }

    // 跨窗口不粘：work 与点击打开的新窗口不是同一个；先导航到与来源页不同的 URL，
    // 排除“来源页不回贴”的干扰，专门验证窗口限定
    await work.goto(base + '/demo.html');
    await work.waitForTimeout(1300);
    await work.evaluate(() => {
      const i = document.createElement('input');
      i.id = 'sl-paste-cross'; i.type = 'search';
      document.body.appendChild(i); i.focus();
    });
    await work.waitForTimeout(400);
    const crossed = await work.$eval('#sl-paste-cross', el => el.value).catch(() => '');
    check('换到别的窗口不自动粘贴（队列留着给原窗口）', crossed === '');
    if (winPage) await winPage.close().catch(() => {});
    await ac.close();

    console.log('popup 搜索（直达官网）');
    await popup.reload();
    await popup.waitForTimeout(600);
    await popup.fill('#q', 'steam');
    await popup.waitForTimeout(400);
    let qHits = await popup.$$eval('#results .res .nm', xs => xs.map(x => x.textContent));
    check('搜索 steam 命中 Steam', qHits.indexOf('Steam') !== -1);
    await popup.fill('#q', 'deepseek');
    await popup.waitForTimeout(400);
    qHits = await popup.$$eval('#results .res .nm', xs => xs.map(x => x.textContent));
    check('搜索命中自定义站点（DeepSeek，来自修正层）', qHits.indexOf('DeepSeek') !== -1);
    await popup.fill('#q', '这个词不存在xyz');
    await popup.waitForTimeout(400);
    const emptyText = await popup.$eval('#results .res-empty', el => el.textContent).catch(() => '');
    check('无结果时给出“没有找到”提示', emptyText.indexOf('没有找到') !== -1);

    // 点击结果 → 新标签打开（目标用本机测试服务，避免外网不可达干扰）
    await popup.evaluate((u) => new Promise(res => chrome.storage.sync.set({
      'siteLinker.overrides': { edits: {}, custom: [] },
      'siteLinker.userSites': [{ name: '本地测试站', url: u }]
    }, res)), base + '/tests/index.html');
    await popup.reload();
    await popup.waitForTimeout(600);
    await popup.fill('#q', '本地测试站');
    await popup.waitForTimeout(400);
    const [opened] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 6000 }),
      popup.click('#results .res')
    ]);
    await opened.waitForTimeout(800);
    check('点击搜索结果以新标签打开（' + opened.url().slice(0, 52) + '…）', opened.url() === base + '/tests/index.html');
    await opened.close().catch(() => {});
    await popup.close().catch(() => {});

    // 还原修正（弹窗已自行关闭，另起一页操作存储）
    const cleanup = await ctx.newPage();
    await cleanup.goto(`chrome-extension://${extId}/src/popup.html`);
    await cleanup.evaluate(() => new Promise(res => chrome.storage.sync.set({
      'siteLinker.overrides': { edits: {}, custom: [] },
      'siteLinker.userSites': []
    }, res)));
    await cleanup.close();
    await work.waitForTimeout(400);

    console.log('options.html（设置页）');
    // 预置一个自添加站点，验证“我添加的站点”专区与词库分离展示（storage 操作借道扩展页面）
    const pre = await ctx.newPage();
    await pre.goto(`chrome-extension://${extId}/src/popup.html`);
    await pre.evaluate(() => new Promise(res => chrome.storage.sync.set({
      'siteLinker.userSites': [{ name: 'DeepSeek', aliases: ['深度求索'], url: 'https://www.deepseek.com/' }]
    }, res)));
    await pre.close();
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/src/options.html`);
    await opt.waitForTimeout(700);
    check('设置页：分类列表 6 项', await opt.$$eval('#list .cat', xs => xs.length) === 6);
    check('设置页：修正列表已渲染', await opt.$$eval('#revise-list .item', xs => xs.length) >= 100);
    await opt.fill('#search', 'CNKI');
    await opt.waitForTimeout(300);
    const hits = await opt.$$eval('#revise-list .item .nm', xs => xs.map(x => x.textContent));
    check('设置页：搜索 CNKI 命中 CNKI / CNKI AI / 中国知网',
      ['CNKI', 'CNKI AI', '中国知网'].every(t => hits.indexOf(t) !== -1));
    check('设置页：修正列表不含自添加站点（DeepSeek 只在专属专区）',
      hits.indexOf('DeepSeek') === -1);
    check('设置页：自动复制开关存在且默认勾选', await opt.$eval('#pref-autocopy', el => el.checked));
    check('设置页：新窗口开关存在且默认勾选', await opt.$eval('#pref-newwin', el => el.checked));
    check('设置页：“我添加的站点”专区渲染出 DeepSeek',
      await opt.$$eval('#user-list .item .nm', xs => xs.map(x => x.textContent).indexOf('DeepSeek') !== -1));

    // 设置页开关联动：关掉 → 点击链接不再复制；再打开 → 恢复
    await work.goto(base + '/tests/article.html');
    await work.waitForTimeout(1300);
    await opt.click('#pref-autocopy');
    await opt.waitForTimeout(300);
    await opt.evaluate(() => new Promise(res => chrome.storage.local.set({ 'siteLinker.pendingPaste': null }, res)));
    await work.click('#autocopy-demo a[data-site-linker][href*="douban"]');
    await work.waitForTimeout(400);
    let pend2 = await opt.evaluate(() => new Promise(res =>
      chrome.storage.local.get('siteLinker.pendingPaste', d => res(d['siteLinker.pendingPaste'] || null))));
    check('设置页关闭开关后：点击链接不再复制', !pend2);
    await opt.click('#pref-autocopy');
    await opt.waitForTimeout(300);
    await opt.evaluate(() => new Promise(res => chrome.storage.local.set({ 'siteLinker.pendingPaste': null }, res)));
    await work.click('#autocopy-demo a[data-site-linker][href*="douban"]');
    await work.waitForTimeout(400);
    pend2 = await opt.evaluate(() => new Promise(res =>
      chrome.storage.local.get('siteLinker.pendingPaste', d => res(d['siteLinker.pendingPaste'] || null))));
    check('重新开启开关后：恢复自动复制', !!pend2 && pend2.text === '三体');
    for (const pg of ctx.pages()) {
      if (pg.url().indexOf('douban.com') !== -1) await pg.close().catch(() => {});
    }
    await opt.screenshot({ path: path.join(SHOTS, 'page-options.png'), fullPage: true });

    console.log('编辑重名防护 + 批量导入恢复默认（v1.8.0）');
    // ① 把自添加站点改名成词库已有名称 → 拒绝，不出同名双条目
    await opt.click('#user-list .item button'); // DeepSeek 的“编辑”
    await opt.waitForTimeout(300);
    await opt.fill('#f-name', '中国知网');
    await opt.click('.form .row2 button'); // “保存”
    await opt.waitForTimeout(300);
    const dupMsg = await opt.$eval('#status', el => el.textContent).catch(() => '');
    check('自添加站点不能改名成词库已有名称', dupMsg.indexOf('同名') !== -1);
    const usAfter = await opt.evaluate(() => new Promise(res =>
      chrome.storage.sync.get('siteLinker.userSites', d => res(d['siteLinker.userSites'] || []))));
    check('重名被拒后自添加站点原样保留', usAfter.length === 1 && usAfter[0].name === 'DeepSeek');

    // ② 批量导入词库默认网址 = 恢复默认（此前保留旧自定义值还计“与词库一致”）
    // 注意：直接改存储后必须 reload 设置页——否则页面内存里的 overrides 是旧的，
    // 导入时看不到刚设置的网址修正（还会在结尾写盘时把旧内存覆盖回去）
    await opt.evaluate(() => new Promise(res => chrome.storage.sync.set({
      'siteLinker.overrides': { edits: { '中国知网': { url: 'https://example.com/cnki-fixed' } } }
    }, res)));
    await opt.reload();
    await opt.waitForTimeout(800);
    await opt.evaluate(() => { document.querySelector('details.bulk').open = true; });
    await work.goto(base + '/tests/article.html');
    await work.waitForTimeout(1300);
    const fixedHref = await work.$eval('a[data-site-linker][href*="cnki-fixed"]', a => a.href).catch(() => null);
    check('预置：中国知网网址已被改写到 example.com', !!fixedHref);
    await opt.fill('#bulk-text', '中国知网\thttps://www.cnki.net');
    await opt.click('#btn-import-text');
    // 导入完成的提示要等 storage.sync.set 回调才显示，轮询等它出现
    let importMsg = '';
    for (let i = 0; i < 30; i++) {
      await opt.waitForTimeout(100);
      importMsg = await opt.$eval('#status', el => el.textContent).catch(() => '');
      if (importMsg.indexOf('导入完成') !== -1) break;
    }
    check('导入默认网址：计为修正并恢复默认', importMsg.indexOf('修正 1 条') !== -1);
    const editsAfter = await opt.evaluate(() => new Promise(res =>
      chrome.storage.sync.get('siteLinker.overrides', d => res((d['siteLinker.overrides'] || {}).edits || {}))));
    check('恢复默认：中国知网的网址修正被清除', !editsAfter['中国知网']);
    await work.goto(base + '/tests/article.html');
    await work.waitForTimeout(1300);
    const backHref = await work.$eval('a[data-site-linker][href="https://www.cnki.net"]', a => a.href).catch(() => null);
    check('页面链接回到词库默认网址', !!backHref);

    console.log('新开浏览器窗口 + 智能定位（v1.7.0）');
    // 目标页用本地服务：把豆瓣的网址改写到本地 index.html，避免外网不可达干扰
    await opt.evaluate((u) => new Promise(res => chrome.storage.sync.set({
      'siteLinker.overrides': { edits: { '豆瓣': { url: u } } },
      'siteLinker.userSites': []
    }, res)), base + '/tests/index.html');
    await work.goto(base + '/tests/article.html');
    await work.waitForTimeout(1300);

    // 默认（开关开）：点击链接 → 新开浏览器窗口，CDP 校验确为独立窗口
    const [nwWin] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 8000 }),
      work.click('#autocopy-demo a[data-site-linker]')
    ]);
    await nwWin.waitForTimeout(600);
    check('点击链接打开目标页（' + nwWin.url().slice(0, 52) + '…）',
      nwWin.url() === base + '/tests/index.html');
    const winSrc = await windowIdOf(ctx, work);
    const winNew = await windowIdOf(ctx, nwWin);
    check('新页面是独立浏览器窗口（与来源页 windowId 不同）', winSrc !== null && winNew !== null && winSrc !== winNew);
    await nwWin.close().catch(() => {});

    // 关掉开关：点击 → 浏览器默认新标签页，与来源页同窗口
    await opt.click('#pref-newwin');
    await opt.waitForTimeout(300);
    const [nwTab] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 8000 }),
      work.click('#autocopy-demo a[data-site-linker]')
    ]);
    await nwTab.waitForTimeout(600);
    check('关闭开关后：点击仍打开目标页', nwTab.url() === base + '/tests/index.html');
    const winTab = await windowIdOf(ctx, nwTab);
    check('关闭开关后：恢复为同一窗口的新标签页（windowId 相同）', winSrc !== null && winTab === winSrc);
    await nwTab.close().catch(() => {});

    // 还原：开关恢复默认，清掉本节的网址改写
    await opt.click('#pref-newwin');
    await opt.evaluate(() => new Promise(res => chrome.storage.sync.set({
      'siteLinker.overrides': { edits: {}, custom: [] },
      'siteLinker.userSites': []
    }, res)));

    await work.close(); await opt.close();
  }

  /* ===== v2.0.0 信源体检：真实浏览器里的端到端（本地指站，不需要账号登录） ===== */
  console.log('\n信源体检（真实 Chromium · DeepSeek / 豆包 / 文心 + 未校准对照）');
  const citePort = server.address().port;
  const citeCases = [
    { host: 'chat.deepseek.com', file: 'deepseek-sample.html', rows: 4, high: true, legend: true },
    { host: 'www.doubao.com', file: 'doubao-sample.html', rows: 3, high: true, legend: true },
    { host: 'yiyan.baidu.com', file: 'yiyan-sample.html', rows: 3, high: false, legend: false }
  ];
  for (const c of citeCases) {
    const p = await ctx.newPage();
    await p.goto(`http://${c.host}:${citePort}/tests/citations/${c.file}`, { waitUntil: 'domcontentloaded' });
    // 轮询而不是 waitForSelector：卡片要等"链接化跑完 → 防抖 → 体检 → 渲染"，
    // 实测 ~1.3–3 秒出现，轮询能把出现时刻测准，失败时也好判断是"没出现"还是"出现得慢"
    let mounted = null;
    const t0 = Date.now();
    for (let i = 0; i < 80 && !mounted; i++) {
      mounted = await p.evaluate(() => {
        const h = document.querySelector('[data-sl-citation-card]');
        return h && h.shadowRoot ? true : null;
      }).catch(() => null);
      if (!mounted) await p.waitForTimeout(250);
    }
    check(`${c.host}：体检卡自动挂载（扩展真加载、适配器真命中，用时 ` + (Date.now() - t0) + 'ms）',
      mounted === true);
    const info = await p.evaluate(() => {
      const h = document.querySelector('[data-sl-citation-card]');
      if (!h || !h.shadowRoot) return null;
      const sr = h.shadowRoot;
      const txt = (sel) => { const n = sr.querySelector(sel); return n ? n.textContent : ''; };
      return {
        rows: sr.querySelectorAll('.row').length,
        sum: txt('.sum'), warn: txt('.warn'), legend: txt('.legend'),
        leaked: sr.querySelectorAll('a[data-site-linker]').length,
        tags: Array.from(sr.querySelectorAll('.tag')).map((t) => t.textContent),
        opens: sr.querySelectorAll('.acts a').length,
        pageLinks: document.querySelectorAll('a[data-site-linker]').length
      };
    });
    check(`${c.host}：来源行数与快照一致`, !!info && info.rows === c.rows);
    check(`${c.host}：卡片在 shadow root 里，没被链接化误伤`, !!info && info.leaked === 0);
    check(`${c.host}：档位标签只用清单 §6 的四种说法`,
      !!info && info.tags.length === c.rows &&
      info.tags.every((t) => ['官方/权威', '聚合/社区', '未收录/待核', '无链接'].indexOf(t) !== -1));
    if (c.high) {
      check(`${c.host}：汇总行按 §6 格式`,
        /本条回答共识别到 \d+ 个来源：官方\/权威 \d+ · 聚合\/社区 \d+ · 未收录\/待核 \d+/.test(info.sum));
      check(`${c.host}：主功能没被带下水（正站点名照常链接化）`, info.pageLinks >= 1);
    } else {
      check(`${c.host}：无 URL 的半来源单独计数，写"没给链接"而不是"没有来源"`,
        info.sum.indexOf('处提到来源但没给链接，无法核对') !== -1 &&
        info.sum.indexOf('没有给出任何可核对的来源') === -1);
    }
    if (c.legend) {
      check(`${c.host}：出现"未收录/待核"就配了"不代表是假网站"`,
        info.legend.indexOf('不代表是假网站') !== -1);
    }
    await p.screenshot({ path: path.join(SHOTS, 'citation-' + c.host + '.png') }).catch(() => {});
    await p.close();
  }

  // 未校准站点：既不弹卡，也不报"可能改版"（校准没做完之前不制造噪音）
  const pUncal = await ctx.newPage();
  await pUncal.goto(`http://chatglm.cn:${citePort}/tests/citations/chatglm-sample.html`,
    { waitUntil: 'domcontentloaded' });
  await pUncal.waitForTimeout(5000);
  check('未校准站点（chatglm.cn）：不弹体检卡（校准没做完就不制造噪音）',
    !(await pUncal.$('[data-sl-citation-card]')));
  const uncalLinks = await pUncal.$$eval('a[data-site-linker]', (as) => as.map((a) => a.textContent));
  check('未校准页面上主功能照常（"中国知网"照样被链接化，体检只是静默）',
    uncalLinks.indexOf('中国知网') !== -1);
  await pUncal.close();

  // 设置页：信源体检开关（清单「回退」第 2 条要求一键回到 v1）与台账状态
  if (extId) {
    const optC = await ctx.newPage();
    await optC.goto(`chrome-extension://${extId}/src/options.html`);
    await optC.waitForTimeout(800);
    check('设置页出现“信源体检”分区与总开关', !!(await optC.$('#cite-enabled')));
    const statTxt = await optC.textContent('#cite-stat');
    check('设置页读得到台账条数（导出功能的数据源对得上）',
      /台账/.test(statTxt || '') && /记录|没有记录|还没有/.test(statTxt || ''));
    await optC.click('#cite-enabled');
    await optC.waitForTimeout(400);
    const offVal = await optC.evaluate(() => new Promise((r) =>
      chrome.storage.local.get('siteLinker.citations.enabled',
        (d) => r(d['siteLinker.citations.enabled']))));
    check('取消勾选 → siteLinker.citations.enabled 落盘为 false', offVal === false);

    // 关掉之后新开的 AI 页面不该有卡
    const pOff = await ctx.newPage();
    await pOff.goto(`http://chat.deepseek.com:${citePort}/tests/citations/deepseek-sample.html`,
      { waitUntil: 'domcontentloaded' });
    await pOff.waitForTimeout(5000);
    check('开关关掉后：AI 页面不再弹体检卡（回到 v1 行为）',
      !(await pOff.$('[data-sl-citation-card]')));
    check('开关关掉后：链接化主功能照常',
      (await pOff.$$eval('a[data-site-linker]', (as) => as.map((a) => a.textContent)))
        .indexOf('中国知网') !== -1);
    await pOff.close();

    await optC.click('#cite-enabled');
    await optC.waitForTimeout(400);
    const onVal = await optC.evaluate(() => new Promise((r) =>
      chrome.storage.local.get('siteLinker.citations.enabled',
        (d) => r(d['siteLinker.citations.enabled']))));
    check('重新勾选 → 开关回到开', onVal === true);
    await optC.close();
  }

  // 台账真的落盘：读 storage.local 要在扩展自己的页面里读（页面上下文的 chrome 没有 storage 权限）
  const pLed = await ctx.newPage();
  await pLed.goto(`http://chat.deepseek.com:${citePort}/tests/citations/deepseek-sample.html`,
    { waitUntil: 'domcontentloaded' });
  await pLed.waitForTimeout(5000);   // 体检 + 台账写入都在这个窗口里完成（实测 <3s）
  await pLed.close();
  let ledCheck = { n: 0, platform: '', sources: 0, claimed: 0, platforms: [], tiers: [] };
  if (extId) {
    const pStore = await ctx.newPage();
    await pStore.goto(`chrome-extension://${extId}/src/options.html`);
    ledCheck = await pStore.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get('siteLinker.auditLog', (d) => {
        const list = (d && d['siteLinker.auditLog']) || [];
        const r = list[list.length - 1];
        resolve({
          n: list.length,
          platform: r && r.platform,
          sources: r && r.sources ? r.sources.length : 0,
          claimed: r ? r.claimedCount : 0,
          platforms: Array.from(new Set(list.map((x) => x.platform))),
          tiers: r && r.sources ? Array.from(new Set(r.sources.map((s) => s.tier))) : []
        });
      });
    }));
    await pStore.close();
    check('台账落 storage.local：记了平台与来源条数',
      ledCheck.n >= 1 && ledCheck.platform === 'deepseek' && ledCheck.sources >= 1);
    check('台账里每条都带等级枚举值（结构化字段只填枚举，说明写在表外）',
      ledCheck.tiers.length > 0 && ledCheck.tiers.every((t) => ['high', 'mid', 'pending', 'claimed'].indexOf(t) !== -1));
    check('未校准站点不写台账（chatglm 不在记录里）',
      ledCheck.platforms.indexOf('chatglm') === -1);
  } else {
    check('台账检查跳过（没拿到扩展 ID）', false);
  }

  await ctx.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed ｜ 截图目录：${SHOTS}`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('运行出错：', err); process.exit(1); });