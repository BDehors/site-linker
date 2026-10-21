# 隐私政策 / Privacy Policy

**站点链接助手（Site Linker）**

最后更新 / Last updated：2026-10-19

## 中文

本扩展**不收集、不存储、不传输任何用户数据**。

- 所有站点词典与文本匹配均在本地浏览器内完成，扩展不发起任何网络请求（无远程代码、无统计、无追踪）。
- 扩展的本地存储只有你自己的设置：分类开关，以及你主动填写的"站点修正"（改网址 / 补充触发词 / 自定义站点）。它们保存在你自己的浏览器账号中（`chrome.storage.sync`），用于跨设备同步，开发者无法读取。
- **信源体检（v2.0.0）与台账均在本地完成，无任何网络请求。**在 AI 对话页识别引用来源、判断域名档位，全部在你浏览器里就地计算；词典与媒体名单是随扩展一起打包的静态文件，不联网获取。体检记录（`chrome.storage.local` 的 `siteLinker.auditLog`，只保留最近 200 条）与"这是官网"反馈（`siteLinker.citationFeedback`）**只存在你这台设备上**，不进入 `sync`、不同步、不上传，你可以随时在设置页导出或清空。插件不读取浏览历史、不抓取网页内容、不调用任何 AI 接口。
- 扩展只请求 `storage` 一项权限，用于保存上述设置与本地台账。

## English

This extension **does not collect, store, or transmit any user data**.

- All dictionary matching happens locally in your browser. The extension makes no network requests (no remote code, no analytics, no tracking).
- The only local storage used is your own settings: category toggles and any site corrections you make (edited URLs, extra trigger words, custom sites). They are kept in your browser account (`chrome.storage.sync`) for cross-device sync. The developer cannot read them.
- **Source check (v2.0.0) and its ledger run entirely on-device, with no network requests.** Detecting citations on AI chat pages and grading their domains happens locally; the dictionary and the media lists ship as static files inside the extension and are never fetched online. Audit records (`siteLinker.auditLog` in `chrome.storage.local`, last 200 entries) and your "this is the official site" feedback stay **on this device only** — they are not synced and never uploaded, and you can export or clear them from the options page at any time. The extension does not read browsing history, scrape page content, or call any AI API.
- The extension requests a single permission, `storage`, to save those settings and the local ledger.
