/* 生成使用指南截图（src/manual-images/*）。UI 改动后重跑一次即可。
 * 运行：NODE_PATH=<全局 node_modules> PLAYWRIGHT_BROWSERS_PATH=<chromium 目录> node tools/make-manual-shots.js
 * 依赖：playwright（与 e2e-test.js 相同）。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'manual-images');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, url === '/' ? 'index.html' : url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-shots-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true, channel: 'chromium', deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run']
  });

  let extId = null;
  const [sw] = ctx.serviceWorkers();
  if (sw) extId = new URL(sw.url()).host;
  if (!extId) {
    try { const w = await ctx.waitForEvent('serviceworker', { timeout: 8000 }); extId = new URL(w.url()).host; } catch (e) { /* 兜底下面再试 */ }
  }
  if (!extId) {
    for (const rel of ['Default/Secure Preferences', 'Default/Preferences']) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(userDataDir, rel), 'utf8'));
        for (const [id, v] of Object.entries((j.extensions && j.extensions.settings) || {})) {
          if (v && typeof v.path === 'string' && path.resolve(v.path).toLowerCase() === path.resolve(ROOT).toLowerCase()) extId = id;
        }
      } catch (e) { /* 继续 */ }
    }
  }
  if (!extId) throw new Error('拿不到扩展 ID');

  // 1) 弹窗默认
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 320, height: 520 });
  await popup.goto(`chrome-extension://${extId}/src/popup.html`);
  await popup.waitForTimeout(700);
  await popup.screenshot({ path: path.join(OUT, 'popup.png') });

  // 2) 弹窗搜索
  await popup.fill('#q', '知网');
  await popup.waitForTimeout(600);
  await popup.screenshot({ path: path.join(OUT, 'popup-search.png') });
  await popup.close();

  // 3) 网页效果（文章页，裁掉测试套件顶栏，JPEG 控体积）
  const art = await ctx.newPage();
  await art.setViewportSize({ width: 900, height: 680 });
  await art.goto(base + '/tests/article.html');
  await art.waitForTimeout(1300);
  await art.locator('h2').first().scrollIntoViewIfNeeded();
  await art.waitForTimeout(500);
  await art.screenshot({ path: path.join(OUT, 'page-links.jpg'), type: 'jpeg', quality: 85,
    clip: { x: 0, y: 44, width: 900, height: 620 } });
  await art.close();

  // 4) 设置页：站点修正区块
  const opt = await ctx.newPage();
  await opt.setViewportSize({ width: 900, height: 760 });
  await opt.goto(`chrome-extension://${extId}/src/options.html`);
  await opt.waitForTimeout(1100);
  await opt.locator('.revise h2').scrollIntoViewIfNeeded();
  await opt.waitForTimeout(400);
  await opt.screenshot({ path: path.join(OUT, 'options.jpg'), type: 'jpeg', quality: 85 });

  // 5) 编辑面板展开
  await opt.locator('#revise-list .item button').first().click();
  await opt.waitForTimeout(500);
  await opt.locator('.form').scrollIntoViewIfNeeded();
  await opt.waitForTimeout(400);
  await opt.screenshot({ path: path.join(OUT, 'options-edit.jpg'), type: 'jpeg', quality: 85 });
  await opt.close();

  // 6) v1.6.0：设置页「点击链接时」开关卡片
  const opt2 = await ctx.newPage();
  await opt2.setViewportSize({ width: 900, height: 760 });
  await opt2.goto(`chrome-extension://${extId}/src/options.html`);
  await opt2.waitForTimeout(1100);
  await opt2.locator('.prefs h2').scrollIntoViewIfNeeded();
  await opt2.waitForTimeout(400);
  await opt2.screenshot({ path: path.join(OUT, 'options-prefs.jpg'), type: 'jpeg', quality: 85 });

  // 7) v1.6.0：设置页「我添加的站点」专区（预置一个自添加站点）
  await opt2.evaluate(() => new Promise(res => chrome.storage.sync.set({
    'siteLinker.userSites': [{ name: '示例站点', aliases: ['示例'], url: 'https://example.com' }]
  }, res)));
  await opt2.reload();
  await opt2.waitForTimeout(1100);
  await opt2.locator('.user-sites h2').scrollIntoViewIfNeeded();
  await opt2.waitForTimeout(400);
  await opt2.screenshot({ path: path.join(OUT, 'user-sites.jpg'), type: 'jpeg', quality: 85 });
  await opt2.close();

  await ctx.close();
  server.close();

  console.log('截图已生成 ->', OUT);
  for (const f of fs.readdirSync(OUT)) {
    console.log('  ' + f + '  ' + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + 'KB');
  }
})().catch(err => { console.error('生成失败：', err); process.exit(1); });