/* 站点链接助手 · 信源体检 · 站点适配器注册表（纯数据，不含逻辑）
 *
 * 这一份是"选择器即配置"：extract.js 只消费本表，不写任何站点专属分支。
 * 某站改版 → 只改这里对应站的数组，逻辑一行不动（清单 §7「回退」第 1 条）。
 *
 * 选择器出处与时点（清单 §1 资料时效 + §3.2）：
 *  - CiteSnap（MIT，jeffersonme168/CiteSnap，首次提交 2026-06-25）7 站适配器源码；
 *  - ai-chat-exporter（MIT，shixiaogaoya，最后提交 2025-12-18）消息容器选择器；
 *  - GreasyFork 527421《DeepSeek Chat Citation Collector》/ 528194《Kimi citations collector》
 *    —— 两页均未标注发布日期，时点存疑，按"事实线索"用，命中与否以现场为准。
 *
 * ⚠ 哈希类名（DeepSeek `_04ab7b1`、文心 `container__MWtKSa6G` 等）是前端构建产物，
 *   每次发版可能变。凡是哈希，一律写成 [class*="xxx"] 包含式匹配 + 至少两级备选
 *   （清单 §3.3 坑 1）。备选顺序：主选 → 结构备选 → 兜底，extract.js 全跑再按 URL 去重，
 *   主选命中时备选不会重复计入，主选失效时备选自动顶上。
 *
 * status 字段：
 *  - 'verified'    ：选择器来自上述开源源码，可信但有时点性；
 *  - 'uncalibrated'：只有定性描述、没有公开验证过的选择器（智谱清言 / 秘塔 / 讯飞星火），
 *                    下面是宽泛兜底，命中情况必须由 S0 现场校准后回填。
 */
(function (global) {
  'use strict';

  var CITATION_ADAPTERS = {

    /* ============ P0 · 方案原定必做 ============ */

    /* DeepSeek：正文角标 + 回答下方引用卡片列表 */
    deepseek: {
      id: 'deepseek',
      label: 'DeepSeek',
      status: 'verified',
      urlPatterns: ['chat.deepseek.com'],
      selfDomains: ['deepseek.com'],
      rounds: {
        container: '.ds-message',
        // 用户消息：CiteSnap 记的是哈希类 d29f3d7d，文本在 .fbb737a4；包含式匹配 + 结构兜底
        user: ['[class*="d29f3d7d"]', '[class*="user-message"]', '[class*="message-container-user"]'],
        userText: ['.fbb737a4', '[class*="fbb737a4"]'],
        ai: ['.ds-markdown'],
        aiText: ['.ds-markdown']
      },
      citeMarker: ['span.ds-markdown-cite', '[class*="ds-markdown-cite"]', 'sup[class*="cite"]'],
      sources: [
        { kind: 'link', selector: 'a[class*="_04ab7b1"]', titleFrom: 'text', note: '主选：CiteSnap 2026-06 引用卡片' },
        { kind: 'link', selector: '.f2021e64 a[href^="http"]', titleFrom: 'text', note: '备选 1：引用容器内全部链接' },
        { kind: 'link', selector: '[class*="_02fb570"] a[href^="http"]', titleFrom: 'text', note: '备选 2：再兜底' }
      ],
      expand: null,
      claimedText: {
        // DeepSeek 联网时会出"搜索到 N 个网页"摘要；有摘要却没提到链接 → claimed
        triggerRe: /(搜索到|检索到)\s*(\d+)\s*[个篇]\s*(网页|资料|结果)/g
      },
      notes: '⚠ _04ab7b1 / f2021e64 / _02fb570 全是构建哈希，CiteSnap README 自己警告过改版即失效。'
    },

    /* Kimi：正文 .rag-tag 角标，点开后才弹来源浮层；kimi.com 已是主域 */
    kimi: {
      id: 'kimi',
      label: 'Kimi',
      status: 'verified',
      // 拍板 §8-4 = A：kimi.com 与 kimi.ai 都收（moonshot.cn 整域 302 跳到 .com，落到 .com 后自然命中）
      urlPatterns: ['kimi.com', 'kimi.ai', 'kimi.moonshot.cn'],
      selfDomains: ['kimi.com', 'kimi.ai', 'moonshot.cn'],
      rounds: {
        container: '[class*="message-item"], .markdown-container',
        user: ['[class*="message-container-user"]', '[class*="user-message"]', '[data-testid*="user"]'],
        userText: null,
        ai: ['.markdown-container', '.markdown-body'],
        aiText: ['.markdown-body', '.markdown-container']
      },
      citeMarker: [
        '.markdown-container:not(.researchItem-text) .rag-tag',
        '.rag-tag',
        '[class*="citation-trigger"]'
      ],
      sources: [
        { kind: 'link', selector: '.info-container .title a[href^="http"]', titleFrom: 'text', from: 'global', note: '主选：角标点开的来源浮层（GreasyFork 528194）——浮层挂在 body 上，不在气泡内' },
        { kind: 'link', selector: '.info-container a[href^="http"]', titleFrom: 'text', from: 'global', note: '备选 1：浮层内全部链接' },
        // CiteSnap 的 kimi.js 是占位实现，只有这类宽泛兜底——清单 §3.2 明确"以 GreasyFork 脚本为准"
        { kind: 'link', selector: '[class*="reference"] a[href^="http"]', titleFrom: 'text', note: '备选 2：CiteSnap 宽泛兜底（轮内采集）' }
      ],
      // 角标必须点一下才出浮层（清单 §3.3 坑 2）；浮层已在则跳过，不重复点
      expand: {
        selector: '.markdown-container:not(.researchItem-text) .rag-tag, .rag-tag',
        textHas: [],
        done: '.info-container a[href^="http"]',
        maxClicks: 12
      },
      claimedText: { triggerRe: /(参考资料|来源)\s*[：:]/g },
      notes: '2026-09 起 chat 需登录（stack.liuhuo.org 实测），e2e 只能测结构复刻快照，真页需人登录。'
    },

    /* 豆包：思考框默认折叠，要点开才出引用链接；部分引用是站内中转页 */
    doubao: {
      id: 'doubao',
      label: '豆包',
      status: 'verified',
      urlPatterns: ['www.doubao.com', 'doubao.com'],
      selfDomains: ['doubao.com'],
      rounds: {
        container: '[data-message-id]',
        user: ['div[class*="bg-g-send-msg-bubble-bg"]'],
        userText: ['div[class*="bg-g-send-msg-bubble-bg"]'],
        ai: ['[class*="markdow"], [class*="message-content"]'],
        aiText: ['[class*="markdow"]', '[class*="message-content"]']
      },
      citeMarker: ['[class*="reference-index"]', 'sup[class*="cite"]', '[class*="cite-num"]'],
      sources: [
        { kind: 'link', selector: 'a[data-thinking-box-tool-call="true"]', titleFrom: 'text', urlFrom: 'href', note: '主选：CiteSnap 2026-06 思考框引用链接' },
        { kind: 'link', selector: 'a[data-tool-call-item-id]', titleFrom: 'text', urlFrom: 'href', note: '备选：属性名不同的一代实现' }
      ],
      // 思考框折叠时要点开：文本同时含"搜索/关键词/资料"三词的可点元素；附近已有引用链接则跳过
      expand: {
        selector: 'div[class*="cursor-pointer"]',
        textHas: ['搜索', '关键词', '资料'],
        done: 'a[data-thinking-box-tool-call="true"], a[data-tool-call-item-id]',
        maxClicks: 8
      },
      searchKeyword: { selector: 'div[class*="text-dbx-neutral-400"]' },
      claimedText: { triggerRe: /参考\s*(\d+)\s*篇\s*(资料|网页|文献)/g },
      notes: 'CiteSnap 显式过滤 doubao.com 自身链接 —— 豆包有站内中转页。命中 selfDomains 走 audit 规则 2 标"待核"，不硬判低（清单 §3.2 豆包段 + §5.2 规则 2）。'
    },

    /* ============ P0+ · 选择器现成、增量小（清单 §2.4） ============ */

    /* 腾讯元宝：引用在右侧抽屉，属性带 URL/来源名/轮次 convId */
    yuanbao: {
      id: 'yuanbao',
      label: '腾讯元宝',
      status: 'verified',
      urlPatterns: ['yuanbao.tencent.com'],
      selfDomains: ['yuanbao.tencent.com'],
      rounds: {
        // 轮次靠 data-conv-id ↔ 抽屉项的 dt-cid 配对（清单 §4.2 第 8 步）
        container: '.agent-chat__list__item',
        user: ['.agent-chat__list__item--human'],
        userText: ['.agent-chat__list__item--human'],
        ai: ['.agent-chat__list__item--ai'],
        aiText: ['.hyc-common-markdown', '.agent-chat__list__item--ai'],
        convIdAttr: 'data-conv-id'
      },
      citeMarker: ['[class*="__cite"]', 'sup[class*="ref"]'],
      sources: [
        {
          kind: 'attr',
          selector: '.agent-dialogue-references__item',
          urlFrom: 'attr:dt-ext6',
          titleFrom: 'attr:dt-ext3',
          cidFrom: 'attr:dt-cid',
          from: 'global',
          note: '主选：右侧抽屉（dt-ext6=URL、dt-ext3=来源名、dt-cid=轮次）——浮在正文之外，全页只采一次再按 cid 配轮次'
        },
        { kind: 'attr', selector: '.hyc-common-markdown__ref_card', urlFrom: 'attr:data-url', titleFrom: 'text', note: '备选：正文内引用卡（轮内采集）' },
        { kind: 'link', selector: '.agent-dialogue-references__item a[href^="http"]', titleFrom: 'text', from: 'global', note: '备选：抽屉项里的链接形态' }
      ],
      // 抽屉项靠 dt-cid 对回轮次（清单 §4.2 第 8 步）
      pairBy: 'cid',
      // 抽屉没打开时点工具栏引用钮
      expand: {
        selector: '[data-toolbar-type="citation"]',
        textHas: [],
        done: '.agent-dialogue-references__item',
        maxClicks: 1
      },
      // 兜底：深度思考区只有文档标题、没有 URL → named（清单 §3.2 元宝段）
      namedFallback: { container: '.hyc-component-deepsearch-cot__think__content__item__doc', title: 'text' },
      claimedText: { triggerRe: /参考\s*(\d+)\s*[篇个]\s*(资料|网页|文献)/g },
      notes: '引用不落在气泡里而在抽屉，属于"附录式 + 属性携带"，必须配对轮次否则整页来源会挂到第一条提问上。'
    },

    /* 通义千问：引用不在 DOM 链接里，在 <script type="application/json"> 的 JSON 里（清单 §3.2：最特别的一家） */
    qianwen: {
      id: 'qianwen',
      label: '通义千问',
      status: 'verified',
      urlPatterns: ['www.qianwen.com', 'qianwen.com', 'tongyi.aliyun.com', 'www.tongyi.com'],
      selfDomains: ['qianwen.com', 'tongyi.aliyun.com', 'tongyi.com'],
      rounds: {
        container: '.chat-round',
        questionAttr: 'data-chat',        // 值形如 "{reqId}-question"
        user: ['.chat-question-wrap', '[class*="chat-question-card"]'],
        userText: ['.chat-question-wrap', '[class*="chat-question-card"]'],
        ai: ['.chat-answer-container', '.markdown', '[class*="answer"]'],
        aiText: null
      },
      citeMarker: ['[class*="cite-index"]', 'sup[class*="ref"]'],
      sources: [
        {
          kind: 'scriptJson',
          selector: 'script[type="application/json"]',
          path: 'data.originalData.content.list',
          fields: { title: 'title', url: 'norm_url', site: 'author', time: 'publishTime' },
          from: 'global',
          note: '主选：解析 script 标签里的 JSON，不解析 DOM 链接（CiteSnap 2026-06）；' +
            'script 标签可能落在轮次容器外，故按全页采一次再退挂到最后一轮'
        }
      ],
      expand: null,
      claimedText: { triggerRe: /参考\s*(\d+)\s*[篇个]\s*(资料|网页|文献)/g },
      notes: 'www.tongyi.com 未在调研里验证过，只是同产品新域名线索；S0 若发现不命中，从 urlPatterns 删掉即可，不影响其它站。'
    },

    /* 文心一言：引用面板只有标题 + 来源名 + 日期，没有可点链接（无 URL 式） */
    yiyan: {
      id: 'yiyan',
      label: '文心一言',
      status: 'verified',
      urlPatterns: ['yiyan.baidu.com', 'www.yiyan.baidu.com'],
      selfDomains: ['yiyan.baidu.com'],
      rounds: {
        container: '[class*="flowBox"], [class*="chatFlow"] > div',
        user: ['[class*="questionBox"]'],
        userFilterRe: 'flowBox',          // 外层 class 同时含 flowBox 才是真问题
        userText: ['[class*="questionBox"]'],
        ai: ['[class*="answerBox"]'],
        aiText: ['[class*="answerBox"]']
      },
      // 引用钮：container__M 里有 titleText 且文本形如"参考N个网页"，且不再嵌套 container__M
      citeTrigger: {
        outer: '[class*="container__M"]',
        inner: '[class*="titleText"]',
        textRe: /参考\s*(\d+)\s*个\s*网页/
      },
      sources: [
        {
          kind: 'panelItem',
          container: '[class*="sourceContainer"]',
          item: '[class*="item__"]',
          title: '[class*="titleInfo"]',
          site: '[class*="siteText"]',
          date: '[class*="date"]',
          from: 'global',
          note: '面板全局唯一、无 href —— 必须逐轮点击该轮引用钮→等面板刷新→再读（CiteSnap yiyan.js extractAsync 思路）'
        }
      ],
      // 逐轮点击 + 等待，不能用一次性展开
      panelPerTurn: true,
      // DOM 逆序：最新对话在最上，配对前要先 reverse（清单 §3.2 文心段 + §4.2 第 8 步）
      reverseRounds: true,
      expand: null,
      claimedText: { triggerRe: /参考\s*(\d+)\s*个\s*网页/g },
      notes: '这家天生 named：面板项没有 URL，拍板 §8-3 = A —— 单列一行、不进三档、提示"无链接可点"，不拿来源名去词典硬判。'
    },

    /* Perplexity：URL 直接挂在属性上，最干净的一家 */
    perplexity: {
      id: 'perplexity',
      label: 'Perplexity',
      status: 'verified',
      urlPatterns: ['www.perplexity.ai', 'perplexity.ai'],
      selfDomains: ['perplexity.ai', 'link.perplexity.ai'],
      rounds: {
        // 轮次靠 .prose 的公共祖先切分
        container: '[data-testid="ppl-answer"], .prose',
        splitByCommonAncestor: '.prose',
        user: ['[data-testid="user-message"]', '[class*="user-message"]'],
        userText: null,
        ai: ['.prose'],
        aiText: ['.prose']
      },
      citeMarker: ['a[href*="link.perplexity.ai"]', 'button[class*="citation"]', '[class*="citation"] > span'],
      sources: [
        { kind: 'attr', selector: '[data-pplx-citation-url]', urlFrom: 'attr:data-pplx-citation-url', titleFrom: 'text', note: '主选：URL 挂属性（CiteSnap 2026-06）' },
        { kind: 'link', selector: 'a[href*="/api/redirect?url="]', titleFrom: 'text', note: '备选：跳转包装链接，需要解包' },
        { kind: 'link', selector: 'a[href^="https://link.perplexity.ai"]', titleFrom: 'text', note: '备选：短链跳转，需要解包' }
      ],
      // 中转链接解包出真实 URL（清单 §4.2 第 5 步；只解析字符串，不发网络请求）
      unwrapParams: ['url', 'target', 'u'],
      expand: null,
      claimedText: { triggerRe: /Sources|来源/g },
      notes: '解包后的域名若仍是 perplexity 自家，继续走 audit 规则 2 标待核。'
    },

    /* ChatGPT：内联小圆角标签 + 可点开的来源面板，URL 带 utm_source=chatgpt */
    chatgpt: {
      id: 'chatgpt',
      label: 'ChatGPT',
      status: 'verified',
      urlPatterns: ['chatgpt.com', 'chat.openai.com'],
      selfDomains: ['chatgpt.com'],
      rounds: {
        container: 'section[data-testid^="conversation-turn-"]',
        roleAttr: 'data-message-author-role',   // user | assistant
        user: ['[data-message-author-role="user"]'],
        userText: null,
        ai: ['[data-message-author-role="assistant"]'],
        aiText: ['[data-message-author-role="assistant"] .markdown']
      },
      citeMarker: ['sup a[href*="utm_source=chatgpt"]', 'a[data-search-result-index]'],
      sources: [
        { kind: 'link', selector: 'a[href*="utm_source=chatgpt"]', titleFrom: 'text', note: '主选：内联引用标签（只显示域名）' },
        { kind: 'link', selector: 'button[class*="footnote"] ~ * a[href*="utm_source=chatgpt"]', titleFrom: 'text', note: '备选：点开来源面板后' },
        { kind: 'link', selector: 'a[class*="flex-col"][class*="rounded-xl"][href^="http"]', titleFrom: 'text', note: '备选：面板卡片（class 含 flex-col/rounded-xl/py-2.5）' }
      ],
      expand: {
        selector: 'button[class*="footnote"]',
        textHas: [],
        done: 'a[class*="flex-col"][class*="rounded-xl"][href^="http"]',
        maxClicks: 4
      },
      // URL 清洗：删 utm_* 参数、截掉 #:~:text= 文本片段（defuddle 同样处理这个坑）
      stripParams: ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'],
      stripHashText: true,
      claimedText: { triggerRe: /Search(ed)?\s+(\d+)\s+(pages|sources)/gi },
      notes: '官方页改版频繁，class 名（footnote/flex-col/rounded-xl）都是 Tailwind 工具类，相对稳。'
    },

    /* ============ P1 · 只有定性描述，没有公开验证过的选择器 ============
     * 拍板 §8-1 = C：这三家也进注册表，但 status 标 uncalibrated ——
     * 下面是"宽泛兜底 + 结构猜测"，命中与否必须 S0 用 DevTools 现场校准后回填。
     * 校准前它们只会漏判不会误判：sources 只取 http 链接、且 extract.js 对
     * uncalibrated 站点要求至少命中一个才出卡，否则走"改版告警"文案（清单 §6）。
     */

    /* 智谱清言：答案末尾【来源】标签 + 下拉展开，每条含标题/域名/发布时间 */
    chatglm: {
      id: 'chatglm',
      label: '智谱清言',
      status: 'uncalibrated',
      urlPatterns: ['chatglm.cn', 'www.chatglm.cn', 'chatglm.ai'],
      selfDomains: ['chatglm.cn'],
      rounds: {
        container: '[class*="chat-message"], [data-msg-id]',
        user: ['[class*="user-message"]', '[class*="message-user"]'],
        userText: null,
        ai: ['[class*="bot-message"]', '[class*="message-ai"]', '[class*="markdown"]'],
        aiText: ['[class*="markdown"]']
      },
      citeMarker: ['[class*="reference"] sup', '[class*="cite"]', 'sup[class*="source"]'],
      sources: [
        { kind: 'link', selector: '[class*="reference"] a[href^="http"]', titleFrom: 'text', note: 'TODO(S0)：【来源】标签下拉里的条目链接' },
        { kind: 'link', selector: '[class*="source"] a[href^="http"]', titleFrom: 'text', note: 'TODO(S0)：兜底' },
        { kind: 'link', selector: '[class*="refectance"] a[href^="http"]', titleFrom: 'text', note: 'TODO(S0)：历史版本拼写' }
      ],
      expand: {
        selector: '[class*="reference"] [class*="collapse"], [class*="source-trigger"]',
        textHas: ['来源', '参考'],
        done: '[class*="reference"] a[href^="http"]',
        maxClicks: 8
      },
      claimedText: { triggerRe: /参考文献|参考来源\s*[：:]/g },
      notes: '依据只有 jiuaidu 这类内容农场级 UI 描述（清单 §2.2），沉思模式"参考文献"区块未实测。S0 校准项 ①。'
    },

    /* 秘塔搜索：全文角标，来源展示最完整（清单 §2.2） */
    metaso: {
      id: 'metaso',
      label: '秘塔 AI 搜索',
      status: 'uncalibrated',
      urlPatterns: ['metaso.cn', 'www.metaso.cn'],
      selfDomains: ['metaso.cn'],
      rounds: {
        container: '[class*="answer"], [class*="qa-item"]',
        user: ['[class*="question"]', '[class*="user"]'],
        userText: null,
        ai: ['[class*="answer"]', '[class*="markdown"]'],
        aiText: ['[class*="markdown"]']
      },
      citeMarker: ['sup a[href^="#"]', '[class*="citation"]', '[class*="ref-index"]'],
      sources: [
        { kind: 'link', selector: '[class*="source-list"] a[href^="http"]', titleFrom: 'text', note: 'TODO(S0)：来源列表条目' },
        { kind: 'link', selector: '[class*="reference"] a[href^="http"]', titleFrom: 'text', note: 'TODO(S0)：兜底' },
        { kind: 'link', selector: 'a[href^="http"][class*="title"]', titleFrom: 'text', note: 'TODO(S0)：最宽兜底，可能混入正文外链，校准后收紧' }
      ],
      expand: null,
      claimedText: { triggerRe: /来源\s*[：(（]\s*(\d+)/g },
      notes: 'S0 校准项 ②。秘塔来源卡片信息最全，校准成功后可反哺其它站的结构备选写法。'
    },

    /* 讯飞星火：来源列表，密度低（清单 §2.2） */
    xinghuo: {
      id: 'xinghuo',
      label: '讯飞星火',
      status: 'uncalibrated',
      urlPatterns: ['xinghuo.xfyun.cn', 'www.xinghuo.xfyun.cn'],
      selfDomains: ['xinghuo.xfyun.cn'],
      rounds: {
        container: '[class*="message-item"], [class*="chat-message"]',
        user: ['[class*="user-message"]', '[class*="question"]'],
        userText: null,
        ai: ['[class*="ai-message"]', '[class*="answer"]', '[class*="markdown"]'],
        aiText: ['[class*="markdown"]']
      },
      citeMarker: ['[class*="cite"] sup', '[class*="ref-tag"]'],
      sources: [
        { kind: 'link', selector: '[class*="reference-list"] a[href^="http"]', titleFrom: 'text', note: 'TODO(S0)：来源列表' },
        { kind: 'link', selector: '[class*="source"] a[href^="http"]', titleFrom: 'text', note: 'TODO(S0)：兜底' }
      ],
      expand: {
        selector: '[class*="reference-trigger"], [class*="source-btn"]',
        textHas: ['来源', '参考'],
        done: '[class*="reference-list"] a[href^="http"]',
        maxClicks: 8
      },
      claimedText: { triggerRe: /参考资料|检索到\s*(\d+)/g },
      notes: 'S0 校准项 ③。调研里只有一句"来源列表，密度低"，且来自未标日期的信源栈地图。'
    }
  };

  /* ---- 配置自检：注册表本身要能被 extract.js 无脑消费（清单 C1 验收） ---- */

  var REQUIRED_FIELDS = ['label', 'urlPatterns', 'selfDomains', 'rounds', 'sources'];

  /** 返回 [{adapter, problems[]}]，只报真实问题，不含风格意见 */
  function validateAdapters(adapters) {
    var report = [];
    Object.keys(adapters).forEach(function (id) {
      var a = adapters[id];
      var problems = [];
      REQUIRED_FIELDS.forEach(function (f) {
        if (a[f] == null) problems.push('缺字段 ' + f);
      });
      if (!Array.isArray(a.sources) || !a.sources.length) problems.push('sources 为空');
      (a.sources || []).forEach(function (s, i) {
        if (['link', 'attr', 'scriptJson', 'panelItem'].indexOf(s.kind) === -1) {
          problems.push('sources[' + i + '] 未知 kind=' + s.kind);
        }
        if (s.kind === 'scriptJson') {
          if (!s.path || !s.fields || !s.fields.url) problems.push('sources[' + i + '] scriptJson 需要 path 与 fields.url');
        } else if (s.kind === 'panelItem') {
          // panelItem 天生没有"一个 selector"：它靠 container + item 两级定位（文心那家）
          if (!s.container || !s.item) problems.push('sources[' + i + '] panelItem 需要 container 与 item');
        } else if (!s.selector) {
          problems.push('sources[' + i + '] 缺 selector');
        }
      });
      (a.urlPatterns || []).forEach(function (p) {
        if (!/^[a-z0-9.\-]+$/i.test(p)) problems.push('urlPatterns 含非法字符：' + p);
      });
      if (a.expand && a.expand.textHas && !Array.isArray(a.expand.textHas)) {
        problems.push('expand.textHas 必须是数组');
      }
      report.push({ adapter: id, problems: problems });
    });
    return report;
  }

  /** hostname 命中哪个适配器；返回适配器或 null（清单 §4.2 第 1 步：不匹配直接 return） */
  function matchAdapter(hostname, adapters) {
    var table = adapters || CITATION_ADAPTERS;   // 允许只传 hostname（content.js 与单测都这么调）
    var host = (hostname || '').toLowerCase();
    if (!host) return null;
    var ids = Object.keys(table);
    for (var i = 0; i < ids.length; i++) {
      var pats = table[ids[i]].urlPatterns || [];
      for (var j = 0; j < pats.length; j++) {
        var p = pats[j].toLowerCase();
        if (host === p || host.endsWith('.' + p)) return table[ids[i]];
      }
    }
    return null;
  }

  var api = {
    CITATION_ADAPTERS: CITATION_ADAPTERS,
    matchAdapter: matchAdapter,
    validateAdapters: validateAdapters
  };
  global.SL_CITATION_ADAPTERS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
