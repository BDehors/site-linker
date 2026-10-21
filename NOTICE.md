# 第三方致谢

## Auto Linkify（MIT License）

- 作者：weiningwei
- 地址：https://greasyfork.org/scripts/587142
- 参考内容：content script 的实现思路——TreeWalker 扫文本节点、MutationObserver 防抖、跳过区集合、安全建节点
- 许可：MIT License

本项目同为 MIT，与上游许可兼容。完整许可文本见仓库 `LICENSE`。

## 信源体检（v2.0.0）参考的三个来源

**先说清边界：本项目的信源体检代码全部由本项目自行编写，没有复制下列任何项目的源代码。**
从它们那里得到的只有两类东西：① 对第三方 AI 网站 DOM 结构的**事实性观察**（哪个类名下挂着引用链接、
URL 放在哪个属性上）——DOM 结构是那些网站客观长成的样子，不是这些项目的创作；② 实现**思路**
（折叠区要先点开、逐轮点击全局面板、解析 `<script>` 里的 JSON、按 convId 配对轮次）。

### CiteSnap（AI 搜索引用提取器）

- 地址：https://github.com/jeffersonme168/CiteSnap （首次提交 2026-06-25）
- 参考内容：豆包 / DeepSeek / 腾讯元宝 / 通义千问 / 文心一言 / Perplexity / ChatGPT 七站引用区
  DOM 特征的事实记录，以及"逐轮点击引用钮再读全局面板"的处理思路
- 许可：**2026-10-19 经 GitHub API 核验，该仓库 `license` 字段为空、根目录无 LICENSE 文件**
  （根目录只有 README / PRIVACY / STORE / manifest / background / content / popup / shared / icons）。
  调研阶段曾把它记作"MIT"，该说法没有依据，以本次核验为准。
  按"未声明许可 = 保留所有权利"处理：只参考事实与思路，未使用其任何代码

### ai-chat-exporter

- 地址：https://github.com/shixiaogaoya/ai-chat-exporter （最后提交 2025-12-18）
- 参考内容：Kimi / DeepSeek 等站消息容器与回答容器类名的事实记录
- 许可：**2026-10-19 经 GitHub API 核验，该仓库 `license` 字段为空、根目录无 LICENSE 文件**
  （根目录只有 README.md / main.js / common.js / platforms）。同上，只参考事实与思路

### GreasyFork 用户脚本两则

- 《DeepSeek Chat Citation Collector》https://greasyfork.org/scripts/527421
- 《Kimi citations collector》https://greasyfork.org/scripts/528194
- 参考内容：DeepSeek 正文角标 `span.ds-markdown-cite`、Kimi 角标 `.rag-tag` 与来源浮层
  `.info-container .title a` 这几处 DOM 事实
- 许可与时效：**2026-10-19 本机无法访问 greasyfork.org（连接超时），两页的发布日期与许可条款均未能复核**；
  调研文档本身也标注了"日期未标注，需复核"。因此这两条只作为选择器线索使用，
  实际是否命中以 `tools/calibrate.js` 现场校准结果为准

### 名单与判据资料

- 国家网信办《国家网信办许可信息（2026年7月20日）· 中央互联网新闻信息服务单位》：
  https://www.cac.gov.cn/2026-07/22/c_1786465601042567.htm —— `src/citations/lists.json` 的
  `media[]` 主体（194 家单位、224 个服务地址）逐条取自该官方 PDF，属政府公开文件
- 国家网信办《2025 版互联网新闻信息稿源单位名单》：
  https://www.cac.gov.cn/2025-08/14/c_1756886951643180.htm —— 单位名口径来源（该 PDF 不含域名）
- generative.qa《State of GEO 2026》：https://generative.qa/state-of-geo-2026/ ——
  "社区 / 百科是 AI 引用主力"的实测依据，用于说明为什么必须有"聚合/社区"这一档
