/* 生成商店截图（精确 1280×800 PNG）。
 * 用法：node tools/make-store-shots.js [输出目录]（默认 ./dist；本地发布时传入提交素材目录）
 * 四张：① 文章页效果 ② 设置页·站点修正 ③ 弹窗搜索合成图（练习页背景 + 弹窗面板）④ 设置页·自动复制开关与我添加的站点。
 * UI 改动后重跑即可。运行：
 *   NODE_PATH=<全局 node_modules> PLAYWRIGHT_BROWSERS_PATH=<chromium 目录> node tools/make-store-shots.js <输出目录>
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'dist');
const MANUAL_IMG = path.join(ROOT, 'src', 'manual-images');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-store-shots-'));
const W = 1280;
const H = 800;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf',
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

async function resolveExtensionId(ctx, userDataDir) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) {
    try { sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }); } catch (e) { /* 兜底 */ }
  }
  if (sw) return new URL(sw.url()).host;
  for (const rel of ['Default/Secure Preferences', 'Default/Preferences']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(userDataDir, rel), 'utf8'));
      for (const [id, v] of Object.entries((j.extensions && j.extensions.settings) || {})) {
        if (v && typeof v.path === 'string' && path.resolve(v.path).toLowerCase() === path.resolve(ROOT).toLowerCase()) return id;
      }
    } catch (e) { /* 继续 */ }
  }
  return null;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(TMP, 'profile');

  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run']
  });
  const extId = await resolveExtensionId(ctx, profile);
  if (!extId) throw new Error('拿不到扩展 ID');

  // ① 文章页效果（滚到正文链接密集处）
  const art = await ctx.newPage();
  await art.setViewportSize({ width: W, height: H });
  await art.goto(base + '/tests/article.html');
  await art.waitForTimeout(1300);
  await art.locator('h2').first().scrollIntoViewIfNeeded();
  await art.waitForTimeout(400);
  await art.screenshot({ path: path.join(OUT, 'screenshot-1.png') });
  await art.close();

  // 背景：练习页（给合成图用）
  const quiz = await ctx.newPage();
  await quiz.setViewportSize({ width: W, height: H });
  await quiz.goto(base + '/tests/quiz.html');
  await quiz.waitForTimeout(1100);
  await quiz.screenshot({ path: path.join(TMP, 'quiz-bg.png') });
  await quiz.close();

  // ② 设置页：站点修正区块
  const opt = await ctx.newPage();
  await opt.setViewportSize({ width: W, height: H });
  await opt.goto(`chrome-extension://${extId}/src/options.html`);
  await opt.waitForTimeout(1100);
  await opt.locator('.revise h2').scrollIntoViewIfNeeded();
  await opt.waitForTimeout(400);
  await opt.screenshot({ path: path.join(OUT, 'screenshot-2.png') });
  await opt.close();

  // ②b v1.6.0：设置页「点击链接时」自动复制开关 +「我添加的站点」专区
  const opt2 = await ctx.newPage();
  await opt2.setViewportSize({ width: W, height: H });
  await opt2.goto(`chrome-extension://${extId}/src/options.html`);
  await opt2.evaluate(() => new Promise(res => chrome.storage.sync.set({
    'siteLinker.userSites': [{ name: '示例站点', aliases: ['示例'], url: 'https://example.com' }]
  }, res)));
  await opt2.reload();
  await opt2.waitForTimeout(1100);
  await opt2.locator('.prefs h2').scrollIntoViewIfNeeded();
  await opt2.waitForTimeout(400);
  await opt2.screenshot({ path: path.join(OUT, 'screenshot-4.png') });
  await opt2.close();

  // ③ 合成图：练习页背景 + 右下角浮出的弹窗面板（弹窗图本身是 2x，缩放后更清晰）
  const bgB64 = fs.readFileSync(path.join(TMP, 'quiz-bg.png')).toString('base64');
  const popB64 = fs.readFileSync(path.join(MANUAL_IMG, 'popup-search.png')).toString('base64');
  const page = await ctx.newPage();
  await page.setViewportSize({ width: W, height: H });
  await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;width:' + W + 'px;height:' + H + 'px;overflow:hidden}' +
    'body{background:url(data:image/png;base64,' + bgB64 + ') 0 0/1280px 800px no-repeat}' +
    '.popup{position:absolute;top:8px;right:16px;width:320px;display:block;border-radius:10px;' +
    'border:1px solid #cfd6e0;box-shadow:0 12px 36px rgba(15,23,42,.28)}' +
    '</style></head><body><img class="popup" src="data:image/png;base64,' + popB64 + '"></body></html>');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'screenshot-3.png') });
  await page.close();

  await ctx.close();
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

  console.log('商店截图已生成 ->', OUT);
  for (const f of ['screenshot-1.png', 'screenshot-2.png', 'screenshot-3.png', 'screenshot-4.png']) {
    console.log('  ' + f + '  ' + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + 'KB');
  }
})().catch(err => { console.error('生成失败：', err); process.exit(1); });