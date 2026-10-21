/* 站点链接助手 · 后台 service worker
 * 给 content script 兜底提供词典：个别页面里直接 fetch 扩展资源会失败。
 * v1.7.0 起：代 content script 新开浏览器窗口（chrome.windows.create），
 * 并按"当前窗口位置 + 屏幕尺寸"智能避让定位。windows API 无需声明权限。
 * v1.9.0 起：应答 content script 的"我在哪个浏览器窗口"询问（取 sender.tab.windowId），
 * 供自动粘贴按窗口限定用（只有点击链接时打开的那个窗口里粘，可粘多次）。
 * 更新时把旧版自定义站点迁移到独立存储键（用户无感）。
 * 不访问网络、不存数据。
 */
var OV_KEY = 'siteLinker.overrides';
var USERSITES_KEY = 'siteLinker.userSites';

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'siteLinker:getDictionary') {
    /* v2.0.0：信源体检的名单文件走同一条已有通道带出来（msg.withLists），
     * 不新增消息类型、不新增权限（清单 §4.1 / C7）。lists 取不到时只回 null，
     * 词典照常返回——体检降级不影响链接化。 */
    var wantLists = !!(msg && msg.withLists);
    var p = fetch(chrome.runtime.getURL('src/dictionary.json')).then(function (r) { return r.json(); });
    var q = wantLists
      ? fetch(chrome.runtime.getURL('src/citations/lists.json')).then(function (r) { return r.json(); }).catch(function () { return null; })
      : Promise.resolve(null);
    Promise.all([p, q]).then(function (rr) {
      var resp = { ok: true, dict: rr[0] };
      if (wantLists) resp.lists = rr[1];
      sendResponse(resp);
    }).catch(function (err) { sendResponse({ ok: false, error: String(err) }); });
    return true; // 异步返回，保持消息通道打开
  }
  if (msg && msg.type === 'siteLinker:myWindow') {
    // v1.9.0：content script 判断“我在不在点击链接时打开的那个窗口”用。
    // 它自己拿不到 chrome.windows / chrome.tabs，这里从 sender.tab.windowId 答。
    var wid = sender && sender.tab ? sender.tab.windowId : null;
    sendResponse({ ok: true, win: wid == null ? null : wid });
    return; // 同步返回
  }
  if (msg && msg.type === 'siteLinker:openInWindow') {
    openInWindow(msg, sender, sendResponse);
    return true; // 异步链路（取窗口边界 -> 创建 -> 补位置），保持通道打开
  }
});

/* ================= 新开浏览器窗口 + 智能避让定位 ================= */

/* 只允许 http(s)，与词典过滤一致，防伪协议 */
function safeUrl(u) {
  return /^https?:\/\//i.test(u || '') ? u : null;
}

/* 找到"发起点击的那个"浏览器窗口：
 * content script 消息带 sender.tab（有 windowId 直接用，没有就 tabs.get 补）；
 * popup / 设置页等扩展页面消息没有 sender.tab，退回最近聚焦的窗口。
 * 每个回调都读一次 chrome.runtime.lastError——不读的话，失败时 SW 控制台会刷
 * "Unchecked lastError" 警告噪音（功能本身有兜底，不影响使用）。 */
function getSenderWindow(sender, cb) {
  var tab = sender && sender.tab;
  if (tab && tab.windowId != null) {
    chrome.windows.get(tab.windowId, function (w) {
      if (chrome.runtime.lastError) { cb(null); return; } // 窗口已关等：按拿不到处理
      cb(w || null);
    });
    return;
  }
  if (tab && tab.id != null) {
    chrome.tabs.get(tab.id, function (t) {
      if (chrome.runtime.lastError || !t || t.windowId == null) {
        chrome.windows.getLastFocused(function (w2) {
          if (chrome.runtime.lastError) { cb(null); return; }
          cb(w2 || null);
        });
        return;
      }
      chrome.windows.get(t.windowId, function (w) {
        if (chrome.runtime.lastError) { cb(null); return; }
        cb(w || null);
      });
    });
    return;
  }
  chrome.windows.getLastFocused(function (w) {
    if (chrome.runtime.lastError) { cb(null); return; }
    cb(w || null);
  });
}

/* 位置算法（三级，逐级降级）：
 * ① 半屏吸附 → 镜像：当前窗口贴左半屏，新窗口放右半屏，反之放左半屏；
 * ② 普通窗口 → 相邻平铺：紧挨当前窗口右侧放，放不下翻到左侧；
 * ③ 拿不准（无屏幕尺寸 / 窗口不在当前屏上）→ 返回 {}，不传 left/top，
 *    让浏览器按系统默认级联偏移，避免把窗口扔到看不见的地方。
 * 返回 { left, top, width, height } 或 {}。 */
var WIN_GAP = 12; // 新窗口与屏幕边缘 / 当前窗口的间距（px）

function computeBesideBounds(win, screen) {
  if (!win || !screen || !screen.w || !screen.h) return {};
  var left = win.left, top = win.top, width = win.width, height = win.height;
  if (typeof left !== 'number' || typeof width !== 'number') return {};
  var sw = screen.w, sh = screen.h;
  // 窗口坐标是全局坐标系（副屏在主屏左侧时 left 为负、右侧时 left ≥ 当前屏宽）；
  // 与当前屏尺寸对不上说明是多显示器等复杂场景，放弃精确布局
  if (left >= sw || left + width <= 0) return {};

  var half = Math.floor(sw / 2);
  var newW = Math.min(Math.max(width, 640), sw - WIN_GAP * 2);
  var newH = Math.min(Math.max(height, 480), sh - WIN_GAP * 2);
  var newTop = (typeof top === 'number') ? Math.max(0, top) : 0;

  // ① 半屏吸附（宽度接近半屏且贴边）→ 镜像到另一半
  var snappedLeft = width >= sw * 0.45 && left <= WIN_GAP * 2;
  var snappedRight = width >= sw * 0.45 && left + width >= sw - WIN_GAP * 2;
  if (snappedLeft || snappedRight) {
    return {
      left: snappedLeft ? half + WIN_GAP : WIN_GAP,
      top: newTop,
      width: half - WIN_GAP * 2,
      height: newH
    };
  }

  // ② 普通窗口 → 右侧相邻，放不下翻左侧，两边都放不下让浏览器级联
  var newLeft = left + width + WIN_GAP;
  if (newLeft + newW > sw - WIN_GAP) {
    newLeft = left - newW - WIN_GAP;
    if (newLeft < WIN_GAP) return {};
  }
  return { left: newLeft, top: newTop, width: newW, height: newH };
}

/* 建窗 + 定位，两级兜底：
 * ① 先按算好的边界建窗——成功的话补一次 update（macOS 上 create 的 left/top
 *    可能被窗口管理器忽略，update 双保险）；
 * ② 边界被浏览器拒绝时（Chromium 要求窗口至少 50% 在可见屏幕内：多屏 /
 *    小屏 / 极端 DPI 等场景可能触发），不带边界重建——系统默认级联位置，
 *    绝不会失败——再试一次 update 移位；update 失败也无所谓，窗口已经建出来了。
 * 任何一步真失败（无边界重建都失败）才向 content script 报错走回退。 */
function createPositionedWindow(url, bounds, done) {
  var hasBounds = !!(bounds && bounds.left != null);

  function place(id) {
    if (!hasBounds) { done(true, id); return; }
    chrome.windows.update(id, {
      left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height
    }, function () {
      // 读一次 lastError：边界仍被拒时消掉 SW 控制台的 "Unchecked lastError" 警告；
      // 窗口已经建出来了，留在系统默认位置即可，不算失败
      if (chrome.runtime.lastError) { /* 位置没挪成，接受默认位置 */ }
      done(true, id);
    });
  }

  if (hasBounds) {
    chrome.windows.create({
      url: url, focused: true, type: 'normal',
      left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height
    }, function (created) {
      if (!chrome.runtime.lastError && created) { place(created.id); return; }
      // ② 边界被拒：无边界重建 + update 移位
      chrome.windows.create({ url: url, focused: true, type: 'normal' }, function (created2) {
        if (chrome.runtime.lastError || !created2) { done(false); return; }
        place(created2.id);
      });
    });
    return;
  }

  chrome.windows.create({ url: url, focused: true, type: 'normal' }, function (created) {
    if (chrome.runtime.lastError || !created) { done(false); return; }
    done(true, created.id);
  });
}

function openInWindow(msg, sender, sendResponse) {
  var url = safeUrl(msg && msg.url);
  if (!url) { sendResponse({ ok: false, error: 'bad-url' }); return; }
  getSenderWindow(sender, function (win) {
    var bounds = computeBesideBounds(win, msg && msg.screen);
    createPositionedWindow(url, bounds, function (ok, windowId) {
      sendResponse(ok ? { ok: true, windowId: windowId } : { ok: false, error: 'create-failed' });
    });
  });
}

/* v1.6.0 起，用户自己添加的站点独立存放在 siteLinker.userSites，
 * 与词库修正（siteLinker.overrides.edits）分离。旧版放在 overrides.custom 里，
 * 这里在扩展更新时一次性搬过来——chrome.storage 本身随更新保留，数据不会丢。
 * 幂等：已迁移过（userSites 键已存在且旧键无 custom）时不动作。 */
function migrateUserSites() {
  try {
    chrome.storage.sync.get([OV_KEY, USERSITES_KEY], function (data) {
      var ov = (data && data[OV_KEY]) || {};
      var legacy = Array.isArray(ov.custom) ? ov.custom : [];
      var hasNew = !!(data && Object.prototype.hasOwnProperty.call(data, USERSITES_KEY));
      var current = (data && Array.isArray(data[USERSITES_KEY])) ? data[USERSITES_KEY] : [];
      if (!legacy.length) {
        if (!hasNew) {
          var init = {};
          init[USERSITES_KEY] = [];
          chrome.storage.sync.set(init);
        }
        return;
      }
      var byName = {};
      var merged = [];
      current.concat(legacy).forEach(function (e) {
        if (!e || !e.name || !e.url) return;
        if (byName[e.name]) return; // 新旧都有同名条目时，保留新键里的
        byName[e.name] = true;
        merged.push({ name: e.name, url: e.url, aliases: Array.isArray(e.aliases) ? e.aliases.slice() : [] });
      });
      var payload = {};
      payload[USERSITES_KEY] = merged;
      payload[OV_KEY] = { edits: ov.edits || {} };
      chrome.storage.sync.set(payload, function () {
        if (chrome.runtime.lastError) {
          console.warn('[站点链接助手] 自定义站点迁移失败：', chrome.runtime.lastError.message);
        }
      });
    });
  } catch (e) { /* 老浏览器无此 API 时忽略，读取处有旧键回退 */ }
}

// 首次安装：打开一页使用指南（首次启动引导）；更新：迁移旧版自定义站点
chrome.runtime.onInstalled.addListener(function (details) {
  if (details && details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/manual.html') });
  }
  if (details && details.reason === 'update') {
    migrateUserSites();
  }
});
