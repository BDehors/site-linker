/* 站点链接助手 · 信源体检 · 台账与反馈（全本地，无任何网络请求）
 *
 * 三个键（清单 C5）：
 *   siteLinker.auditLog          (storage.local) 体检台账，记录每次回答的来源构成
 *   siteLinker.citationFeedback  (storage.local) 用户点"这是官网"积累下来的域名
 *   siteLinker.citations.enabled (storage.local) 总开关，缺省=开；关掉即回到 v1 行为（清单「回退」第 2 条）
 *
 * 记录形状：{ts, platform, query, sources:[{domain,tier,url}], claimedCount}
 * 隐私口径（写进 PRIVACY.md）：台账与反馈全部留在本机 storage.local，
 * 插件不发任何网络请求，也不读浏览历史。
 */
(function (global) {
  'use strict';

  var LEDGER_KEY = 'siteLinker.auditLog';
  var FEEDBACK_KEY = 'siteLinker.citationFeedback';
  var ENABLE_KEY = 'siteLinker.citations.enabled';
  var MAX_RECORDS = 200;          // 只留最近 200 条，避免 storage.local 无限膨胀
  var MAX_SOURCES_PER_RECORD = 40;

  function store() {
    try {
      return (global.chrome && global.chrome.storage && global.chrome.storage.local) || null;
    } catch (e) {
      return null;
    }
  }

  function get(keys, cb) {
    var s = store();
    if (!s) { cb({}); return; }
    try {
      s.get(keys, function (data) { cb(data || {}); });
    } catch (e) { cb({}); }
  }

  function set(obj, cb) {
    var s = store();
    if (!s) { if (cb) cb(false); return; }
    try {
      s.set(obj, function () {
        try { if (global.chrome.runtime.lastError) { /* 存储写失败就算了，不影响浏览 */ } } catch (e) { /* 忽略 */ }
        if (cb) cb(true);
      });
    } catch (e) { if (cb) cb(false); }
  }

  /** 总开关：没写过就算"开"（清单 C5：默认开） */
  function isEnabled(cb) {
    get(ENABLE_KEY, function (data) {
      var v = data && data[ENABLE_KEY];
      cb(v === undefined || v === null ? true : v !== false);
    });
  }

  function setEnabled(on, cb) {
    var d = {};
    d[ENABLE_KEY] = !!on;
    set(d, cb);
  }

  /* ============ 台账 ============ */

  function recordFromModel(model) {
    var s = model.summary;
    var sources = [];
    (s.items || []).forEach(function (it) {
      if (sources.length >= MAX_SOURCES_PER_RECORD) return;
      var c = it.citation, a = it.audit;
      sources.push({
        domain: c.domain || (c.state === 'claimed' ? '' : (c.siteName || '')),
        tier: a.tier || 'claimed',
        reason: a.reason || '',
        url: c.url || ''
      });
    });
    return {
      ts: Date.now(),
      platform: model.platform || '',
      query: (model.query || '').slice(0, 200),
      sources: sources,
      claimedCount: s.claimed || 0
    };
  }

  function appendRecord(rec, cb) {
    get(LEDGER_KEY, function (data) {
      var list = Array.isArray(data && data[LEDGER_KEY]) ? data[LEDGER_KEY] : [];
      list.push(rec);
      if (list.length > MAX_RECORDS) list = list.slice(list.length - MAX_RECORDS);
      var d = {};
      d[LEDGER_KEY] = list;
      set(d, cb);
    });
  }

  function loadLedger(cb) {
    get(LEDGER_KEY, function (data) { cb(Array.isArray(data && data[LEDGER_KEY]) ? data[LEDGER_KEY] : []); });
  }

  function clearLedger(cb) {
    var d = {};
    d[LEDGER_KEY] = [];
    set(d, cb);
  }

  /* ============ 反馈（"这是官网"） ============ */

  function loadFeedbackSet(cb) {
    get(FEEDBACK_KEY, function (data) {
      var list = Array.isArray(data && data[FEEDBACK_KEY]) ? data[FEEDBACK_KEY] : [];
      cb(list);
    });
  }

  /** 返回 Set，供 audit.js 的 ctx.feedbackHosts 用 */
  function feedbackHostSet(cb) {
    loadFeedbackSet(function (list) {
      var s = new Set();
      list.forEach(function (f) { if (f && f.domain) s.add(String(f.domain).toLowerCase()); });
      cb(s);
    });
  }

  function addFeedback(domain, meta) {
    var d = String(domain || '').toLowerCase();
    if (!d) return;
    loadFeedbackSet(function (list) {
      if (list.some(function (f) { return f && String(f.domain).toLowerCase() === d; })) return;
      list.push({
        domain: d,
        name: (meta && meta.name) || '',
        url: (meta && meta.url) || '',
        ts: Date.now()
      });
      var obj = {};
      obj[FEEDBACK_KEY] = list;
      set(obj);
    });
  }

  function removeFeedback(domain, cb) {
    loadFeedbackSet(function (list) {
      var d = String(domain || '').toLowerCase();
      var out = list.filter(function (f) { return f && String(f.domain).toLowerCase() !== d; });
      var obj = {};
      obj[FEEDBACK_KEY] = out;
      set(obj, function () { if (cb) cb(out); });
    });
  }

  /* ============ 导出（清单 C5 验收：10 条记录能导出即可） ============ */

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    // 防公式注入：以 = + - @ 开头的单元格加前导单引号
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCsv(list) {
    var lines = ['时间,平台,提问,域名,等级,判据,链接,无链接处数'];
    (list || []).forEach(function (r) {
      var t = new Date(r.ts || 0);
      var ts = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) +
        ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
      (r.sources || []).forEach(function (s) {
        lines.push([ts, r.platform, (r.query || '').replace(/[\r\n]+/g, ' '),
          s.domain, s.tier, s.reason, s.url, r.claimedCount].map(csvCell).join(','));
      });
      if (!(r.sources || []).length) {
        lines.push([ts, r.platform, (r.query || '').replace(/[\r\n]+/g, ' '), '', '', 'no-source', '', r.claimedCount]
          .map(csvCell).join(','));
      }
    });
    return '\ufeff' + lines.join('\r\n');   // BOM：让 Excel 认 UTF-8
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function toJson(list) {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      extension: '站点链接助手 信源体检台账',
      note: '全部来自本机 storage.local，插件未发起任何网络请求',
      records: list || []
    }, null, 2);
  }

  /** 触发下载：扩展页里 a[download] + blob 免权限；失败退回剪贴板 */
  function download(filename, text, onFallbackCopy) {
    try {
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) {
      if (onFallbackCopy) onFallbackCopy(text);
      return false;
    }
  }

  var api = {
    LEDGER_KEY: LEDGER_KEY,
    FEEDBACK_KEY: FEEDBACK_KEY,
    ENABLE_KEY: ENABLE_KEY,
    MAX_RECORDS: MAX_RECORDS,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    recordFromModel: recordFromModel,
    appendRecord: appendRecord,
    loadLedger: loadLedger,
    clearLedger: clearLedger,
    loadFeedbackSet: loadFeedbackSet,
    feedbackHostSet: feedbackHostSet,
    addFeedback: addFeedback,
    removeFeedback: removeFeedback,
    toCsv: toCsv,
    toJson: toJson,
    download: download
  };
  global.SL_CITATION_LEDGER = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
