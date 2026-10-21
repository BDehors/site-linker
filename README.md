# 站点链接助手（Site Linker）

把网页正文中出现的**站点名称**自动变成可点击链接的 Edge / Chrome 扩展。
读到"中国知网""国家统计局""arXiv""Steam"这类名字时，直接点进去，不用先复制再去搜索。

纯本地运行，不收集任何数据；词典按 6 类组织，可分类开关，**默认全开**。

## 功能

- **全谱系词典**：科研文献、政府与数据、专利标准与版权、国外常用、工具与软件、生活与娱乐，共 6 类 325 站。
- **分类开关**：设置页勾选类别即存 `chrome.storage.sync`，默认全开；可以只留学术类。设置改动即时生效，已渲染的链接自动重排。
- **工具栏弹窗**：点浏览器工具栏上的图标弹出速控面板——输入站点名可直接搜索打开官网，也可开关 6 类站点；已打开的页面即时生效，不用刷新。
- **点击链接自动复制 + 自动粘贴**：点击网页里生成的站点链接时，自动复制该句中的《书名号》、引号里的内容（同一句有多个会全部复制，空格相连），或站点名后冒号之后的内容；官网在新窗口打开后，在那个窗口里点一下搜索框即自动粘贴（可粘多次，换窗口不粘）。设置页「点击链接时」可开关（默认开）。
- **新窗口打开 + 智能避让定位**：点击链接默认直接新开一个浏览器窗口（而不是新标签页）：当前窗口左半屏吸附就放右半屏、右半屏吸附就放左半屏，普通窗口紧挨着当前窗口放，多显示器等拿不准坐标的场景自动降级为系统级联。中键点击、Ctrl / ⌘ + 点击仍按浏览器默认开新标签页。设置页「点击链接时」可开关（默认开），与上面的复制开关互相独立。
- **自添加站点独立存放**：自己加的站点收在设置页「我添加的站点」专区，与词库分类、「站点修正」完全分开——久了也不会分不清哪些是自己加的；弹窗的"自定义站点"分类用来整体开关。
- **使用指南**：首次安装自动打开一页上手说明（含界面截图）；之后可从弹窗或设置页底部再次打开。
- **站点可自定义**：网址不准确、想补充触发词、要停用或新增站点，在设置页的"站点修正"里直接改——修改保存在你自己的浏览器里（跟随账号同步），**插件更新不会覆盖、不会丢失**（旧版自定义站点会自动迁移到新存储键）；还支持从表格批量粘贴更新、JSON 导入导出。
- **动态页面支持**：MutationObserver + 防抖，SPA / 无限滚动 / 异步加载的内容也能处理。
- **安全与克制**：不碰代码块（`code`/`pre`）、表单控件、已有链接、可编辑区；只用 DOM API 建节点，不用 `innerHTML` 拼接；只允许 `http/https` 协议。
- **长词优先 + 误报屏蔽**：同一位置优先命中更长的词（"国家统计局"优先于"统计局"）；"万方科技""豆瓣酱"这类词命中时自动跳过。

- **信源体检（v2.0.0，AI 对话页）**：在 DeepSeek / Kimi / 豆包 / 元宝 / 千问 / 文心 / Perplexity / ChatGPT 的对话页上，回答下方会出现一张体检卡，列出这条回答引用了哪些来源、每个域名的档位与理由。**只输出等级和理由，不判断内容真假**——详见下方「信源体检」一节。

## 安装（开发模式）

1. 打开 `edge://extensions`，打开左下角"开发人员模式"。
2. 点"加载解压缩的扩展"，选择本仓库目录。
3. 打开任意网页即可看到效果。点工具栏上的扩展图标会弹出速控面板（分类开关）；"扩展选项"里可以改网址、加站点。测试用两个入口：`demo.html`（基础对照页，含"不应被链接"的对照区块）；`tests/index.html`（真实场景测试套件：练习题、带引用与出处的文章、PDF / Word 样例），装好后先开套件首页按验收清单过一遍。

> 两个已知坑：① **file:// 页面默认不生效**——Edge/Chrome 不在本地文件页里跑内容脚本，要么在扩展详情页打开"允许访问文件 URL"，要么用本地服务开（在仓库根目录跑 `python -m http.server 8000`，然后访问 `http://localhost:8000/tests/`）；② 更新过词典/代码后，要去 `edge://extensions` 点扩展卡片的**"重新加载"**，再刷新网页。

## 信源体检（v2.0.0）

AI 回答后面挂的那串引用链接，到底该不该信？插件能替你做的只有**认域名**这一件事：把来源分成三档，说清为什么这么分，剩下的判断留给人。

| 档位 | 什么意思 | 判据 |
|------|----------|------|
| **官方/权威** | 一手来源 | 在 325 站权威词典内（含官方子域，如 `lawpro.cnki.net` 算 `cnki.net`）、在网信办许可名单内，或是 `.gov` / `.gov.cn` / `.edu` / `.edu.cn` |
| **聚合/社区** | 网友或编辑整理，看观点可以，当证据要谨慎 | 知乎 / CSDN / 掘金 / B 站 / 小红书 / 豆瓣 / 贴吧 / 知道 / 微博、门户站、百度百科与维基百科、Reddit 等社区名单，以及 `docs.` / `developer.` 产品文档域 |
| **未收录/待核** | 插件认不得，**不代表是假网站** | 平台自己的中转链接、来源名与域名对不上（自称"中国知网"却指向别的域）、内容农场式域名特征、其余陌生站 |
| （特殊态） | 提到来源但没给链接 | 单独一行标出来，不占三档，提示"无法核对" |

九条判据按顺序先命中先返回，实现在 `src/citations/audit.js`；改档位口径只改这一处。

**名单从哪来**：`src/citations/lists.json` 的 `media[]` 主体取自国家网信办《国家网信办许可信息（2026 年 7 月 20 日）· 中央互联网新闻信息服务单位》附件——194 家单位，每条自带服务名称、服务地址与许可证编号（PDF 存档在 `tools/media-license-central-20260720.pdf`）。另 44 家是许可名单外的常见媒体，用"候选域名 → 真实 HTTPS 取标题 → 真实 Chromium 渲染读自名"三轮实测、**标题里出现该媒体专名才算核实**补进来的（证据见 `tools/media-verify-20261019*.json`）。没通过核实的候选域名一律不收录——过程中有八处看着像其实挂错了的（`cfn.cn` 是银行网、`sxnews.cn` 是绍兴网、`clnews.com.cn` 是长乐新闻网、`audit.gov.cn` 是审计署…）全部被标题判据挡在门外。名单一年一更，`lists.json` 的 `meta` 里记了版本与复核日期。

**一处有记录的判据偏离**：词典是"站点名 → 官网"的直达表，里面收了知乎、B 站、微博、豆瓣、维基百科、Reddit、GitHub 这些站。如果"在词典里"就等于"权威"，体检卡会把一堆 UGC 标成官方/权威——所以**域名同时出现在社区名单里时，社区名单赢，判"中"**。词典照旧管链接化，两边互不影响。

**支持到哪一步**：八站的引用区选择器有开源实现作事实依据；智谱清言、秘塔 AI 搜索、讯飞星火三家只有定性描述、没有验证过的选择器，已进注册表但标着"待校准"——**校准前它们不弹卡、不写台账**，不会拿猜的选择器去误导你。

**隐私**：识别、判级、台账全部在本机，插件不为此发任何一次网络请求，也不读浏览历史、不抓网页内容、不调 AI 接口。台账存在 `chrome.storage.local`（只留最近 200 条），设置页可导出 CSV / JSON 或清空。设置页「信源体检」里的总开关关掉，插件行为立刻回到 v1。

**页面改版了怎么办**：AI 站大量用构建哈希类名（DeepSeek 的 `_04ab7b1`、文心的 `container__MWtKSa6G`），改版即失效。所以每个选择器都留了两到三级备选，全部失效时体检卡会明说"没识别到引用区域，可能页面已改版"，而不是假装"这条回答没有来源"。校准时跑这个（注入的就是插件自己的代码，报"命中 0"就是 `adapters.js` 真该改）：

```
node tools/calibrate.js https://chat.deepseek.com/            # 打开浏览器，登录后提几个联网问题
node tools/calibrate.js https://www.kimi.com/ --save kimi     # 顺便把真实快照存进 tests/citations/
```

它会打出一张选择器命中表 + 提取管线的真实产出 + 判级结果，拿它跟你在页面上肉眼看到的来源条数对一遍，对不上就是漏抓。改的时候只动 `src/citations/adapters.js` 里对应站点的数组，逻辑一行不用改。

## 测试套件（tests/）

`tests/` 里是一套原创的、模拟真实使用场景的测试页：

| 页面 | 场景 | 看什么 |
|------|------|--------|
| `tests/quiz.html` | 面对题目 | 题面与参考答案里的站点名应全部变成链接；对照区（公司名、代码块、已有链接）保持原样 |
| `tests/article.html` | 阅读文章 | 正文站点名变链接；"参考资料"各条可直接点击；点"加载更多资料"后新内容同样被处理 |
| `tests/samples/` | 文档样例 | 同一篇文章的 PDF 与 Word：出处做进了文档本身，点击即可跳转 |

**关于 PDF / Word 的一个技术事实**：浏览器内置的 PDF 查看器与 Office 预览器不运行扩展脚本（任何内容脚本类扩展都进不去）。因此样例文档采用"把链接做进文档"的方式——PDF 里是链接注释、Word 里是超链接字段——在浏览器或阅读器里打开同样可以点击核查。想体验"自动变链接"的效果，请用网页版对照着看。

样例文件由 `tools/make-samples.py` 从 `tests/article.html` 自动生成（需要 Python 的 lxml / python-docx / PyMuPDF 与本机 Edge），改完文章重新跑一次即可。

## 词典怎么加站点

编辑 `src/dictionary.json`，往对应分类的 `entries` 里加一条：

```json
{ "name": "站点全称", "aliases": ["简称", "English Name"], "url": "https://example.com" }
```

- `aliases` 是用户可能敲的名字，中英文都可以。
- 名称为纯英文且是常用词（如 `science`、`sage`）时，加 `"cs": true`，只做大小写敏感匹配，防止误报。
- 名称为纯英文时自动生成小写变体（`GitHub` 也能命中 `github`）。
- 误报屏蔽词加在文件末尾的 `exclusions` 数组里。

详细格式与提 PR 流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 改网址 / 加站点（不用等发版）

词库难免有疏漏。三种办法，按你的身份挑：

1. **自己用**：设置页 →「站点修正」→ 搜到条目直接改网址、补触发词、停用；自己添加的站点在「我添加的站点」专区里增删改（与词库分开存放，一目了然）；也可以从 Excel 复制「名称、提示词、网址」三列整块粘贴导入。修改保存在你自己的浏览器里（`chrome.storage.sync`），插件更新不会覆盖、不会丢失——1.6.0 起自添加站点改用独立键 `siteLinker.userSites`，旧数据在更新时自动迁移。
2. **分享给别人**：在「站点修正」里导出 JSON，对方导入即可（新旧格式都能导入）。
3. **让所有人受益**：按 [CONTRIBUTING.md](CONTRIBUTING.md) 给 `dictionary.json` 提 PR。

## 目录结构

```
├── manifest.json          # MV3 清单
├── src/
│   ├── dictionary.json    # 分类词典（核心资产）
│   ├── content.js         # 文本扫描 + 链接化 + 动态页面监听（体检在这里挂接）
│   ├── citations/         # 信源体检（v2.0.0）
│   │   ├── adapters.js    #   11 站选择器配置（改版只改这里，逻辑不动）
│   │   ├── extract.js     #   提取管线：展开→采集→清洗→归一化→去重→配对→三态
│   │   ├── audit.js       #   九条判据 → 三档 + 特殊态
│   │   ├── lists.json     #   媒体名单 / 社区名单 / 农场特征 / 平台自身域
│   │   ├── card.js        #   体检卡（Shadow DOM 浮层）
│   │   └── ledger.js      #   台账与"这是官网"反馈（全本地）
│   ├── background.js      # 后台 service worker（词典兜底通道 + 名单同通道带出 + 建窗）
│   ├── popup.html/css/js  # 工具栏弹窗（分类速控）
│   └── options.html/css/js# 设置页（分类开关 + 站点修正 + 信源体检开关与台账导出）
├── icons/                 # 16/48/128 包内图标 + 300×300 商店 logo + 440×280 宣传图
├── demo.html              # 基础对照测试页（截图用演示页）
├── tests/                 # 真实场景测试套件（原创示例）
│   ├── index.html         # 套件首页：三个场景 + 验收清单
│   ├── quiz.html          # 场景 01：模拟练习（面对题目）
│   ├── article.html       # 场景 02：文章阅读（引用、出处、动态加载）
│   ├── citations/         # 信源体检快照（11 站结构复刻 + 校准后存的真快照）
│   └── samples/           # 场景 03：文章导出的 PDF / Word 样例
├── tools/                 # 开发脚本：图标生成、词典冒烟、jsdom/真实浏览器测试、
│                          #   打包（显式文件清单）、样例文档生成；
│                          #   信源体检相关：calibrate.js（现场校准）、
│                          #   build-lists.py（从官方 PDF 生成 lists.json）、
│                          #   fetch-media-domains*.py + render-verify.js（媒体域名核实）、
│                          #   make-citation-fixtures.py（生成结构复刻快照）
├── CHANGELOG.md           # 更新记录
├── NOTICE.md              # 第三方致谢
├── PRIVACY.md             # 隐私政策（兼作商店隐私政策 URL）
├── CONTRIBUTING.md        # 词典贡献指南
└── LICENSE                # MIT
```

## 致谢

- **weiningwei 的 [Auto Linkify](https://greasyfork.org/scripts/587142)**（MIT）：本插件 content script 的骨架——TreeWalker 扫文本节点、MutationObserver 防抖、跳过区集合、安全建节点——直接借鉴了它的做法。它是 MIT 许可，本项目同为 MIT，互相兼容；本插件与它的区别是把"URL 正则匹配"换成了"站点名词典匹配"并加了分类开关。
- **信源体检的三处参考**：[CiteSnap](https://github.com/jeffersonme168/CiteSnap)、[ai-chat-exporter](https://github.com/shixiaogaoya/ai-chat-exporter) 与 GreasyFork 上的 DeepSeek / Kimi 引用收集脚本。**注意：前两个仓库经 GitHub API 核验根目录都没有 LICENSE 文件（`license` 字段为空），调研阶段记的"MIT"没有依据**；GreasyFork 两脚本本次网络不可达，日期与许可均未复核。因此本项目的体检代码全部自行编写，从这些项目得到的只是"某个网站的引用挂在哪个类名/属性上"这类 DOM 事实与实现思路。逐条说明见 [NOTICE.md](NOTICE.md)。
- **判级名单的事实来源**：国家网信办《国家网信办许可信息（2026 年 7 月 20 日）》与《2025 版互联网新闻信息稿源单位名单》（政府公开文件，PDF 存档在 `tools/`）。

## 许可

MIT，见 [LICENSE](LICENSE)。

---

# Site Linker (English)

A browser extension that automatically turns **site names** in web page text into clickable links. When it sees "CNKI", "National Bureau of Statistics", "arXiv" or "Steam", it links straight to the site — no copy-paste-search loop.

Runs entirely locally, collects nothing. Dictionary organized into 6 categories, each toggleable, **all enabled by default**.

## Features

- **325 sites across 6 categories**: research literature, government & data, patents/standards & copyright, global favourites, tools & software, life & entertainment.
- **Category toggles** stored in `chrome.storage.sync`; changes apply instantly, already-rendered links are rebuilt.
- **Toolbar popup**: click the toolbar icon to search a site by name and open its official page directly, or toggle the 6 categories; open pages update without a reload.
- **Click-to-copy + auto-paste**: clicking a generated site link copies the 《title》, quoted text (all of them when a sentence has several, space-joined), or post-colon content of that sentence to the clipboard; when the official site opens in the new window, clicking its search box pastes it automatically — repeatedly, and only inside that window. Toggle it in the options page ("点击链接时"), on by default.
- **New window + smart placement**: clicking a link opens a new browser window (not a tab) by default, placed to avoid overlap — mirror to the opposite half when the current window is snapped to a half-screen, tile next to it otherwise, with graceful fallback to the system cascade on multi-monitor setups. Middle-click / Ctrl / ⌘ + click still open a plain new tab. Toggle in the options page ("点击链接时"), on by default, independent of the copy toggle.
- **User-added sites kept separate**: your own sites live in a dedicated "我添加的站点" section of the options page, stored under their own key and clearly separated from the dictionary categories and corrections; the popup's "自定义站点" category toggles them all at once.
- **User guide**: opens automatically on first install (with UI screenshots); reopen it anytime from the popup or the options page.
- **User-editable sites**: fix a URL, add trigger words, disable or add sites in the options page ("站点修正"). Your corrections are stored in your browser profile and survive extension updates (legacy custom sites are migrated automatically to the new `siteLinker.userSites` key); bulk paste from a spreadsheet and JSON import/export are supported (both formats accepted).
- **Dynamic pages**: MutationObserver + debounce handles SPAs and infinite scroll.
- **Safe by design**: skips code blocks, form controls, existing links and editable regions; builds nodes with DOM APIs only (never `innerHTML`); `http/https` only.
- **Longest-match first + exclusion list**: "国家统计局" wins over "统计局"; company names like "万方科技" are excluded.
- **Source check (v2.0.0, on AI chat pages)**: under each answer on DeepSeek / Kimi / Doubao / Tencent Yuanbao / Qianwen / ERNIE / Perplexity / ChatGPT, a card lists the cited domains and grades each one — *official/authoritative*, *aggregator/community*, or *unlisted / needs a look* — together with the reason for that grade. Sources that are mentioned without any link are shown separately instead of being graded. **It reports grades and reasons only; it never judges whether content is true.** Grading uses a bundled dictionary, the CAC licensed-media list and domain-suffix rules — no scraping, no AI calls, no network requests at all. The audit ledger stays in `chrome.storage.local` (last 200 answers), can be exported or cleared from the options page, and the master toggle there returns the extension to its v1 behaviour.

## Install (dev mode)

1. Go to `edge://extensions`, enable **Developer mode**.
2. Click **Load unpacked**, select this repo.
3. Open any page. The toolbar icon opens a quick popup; the options page hosts the site-corrections panel. For testing, use `demo.html` (basic control page with "must-not-link" blocks) or `tests/index.html` — a test suite of realistic scenarios (a quiz page, an article with citations and sources, and PDF / Word samples).

> Two known gotchas: ① **file:// pages are not processed by default** — either enable "Allow access to file URLs" on the extension's details page, or serve locally (`python -m http.server 8000`, then open `http://localhost:8000/tests/`); ② after updating the dictionary or code, click **Reload** on the extension card in `edge://extensions`, then refresh the page.

Note on documents: built-in browser PDF viewers and Office previewers do not run extension scripts. The sample PDF / Word files therefore carry their own links (PDF link annotations / Word hyperlink fields), which stay clickable in any viewer. See `tests/index.html` for details.

## License

MIT — see [LICENSE](LICENSE). Skeleton of the content script adapted from [Auto Linkify](https://greasyfork.org/scripts/587142) by weiningwei (MIT).