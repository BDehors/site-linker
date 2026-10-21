#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 tests/citations/ 下的结构复刻快照（构建期工具）。

这些不是真实页面抓取——AI 对话站要登录，真实 outerHTML 由 S0 现场校准后用
DevTools「Copy outerHTML」替换。快照的 DOM 形状照抄调研 §3.2 各站点段落，
用例断言的是"提取出来的来源集合"，不是具体哈希类名，所以真快照换进来照样跑。
"""
import io
import os
import sys

HEAD = (
    "<!DOCTYPE html>\n"
    "<!-- 结构复刻快照（不是真实页面抓取）：DOM 形状照抄《信源体检-引用识别调研与施工清单》\n"
    "     §3.2 对应站点段落。真实 outerHTML 需登录后用 DevTools「Copy outerHTML」替换本文件\n"
    "     （清单 S0 第 3 步）。替换后用例只认提取结果，不认具体哈希类名。 -->\n"
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>fixture</title></head><body>\n'
)
TAIL = "\n</body></html>\n"

FIXTURES = {}

FIXTURES["deepseek-sample.html"] = """
<div class="ds-message"><div class="d29f3d7d"><div class="fbb737a4">第二个问题呢？</div></div></div>
<div class="ds-message"><div class="ds-markdown"><p>这条不需要联网，直接回答。</p></div></div>
<div class="ds-message"><div class="d29f3d7d"><div class="fbb737a4">知网有哪些学位论文库？</div></div></div>
<div class="ds-message"><div class="ds-markdown">
  <p>中国知网是国内主要的学术数据库<span class="ds-markdown-cite">1</span>，网上教程也不少<span class="ds-markdown-cite">2</span>。</p>
  <div class="_04ab7b1_wrap">
    <a class="_04ab7b1" href="https://www.cnki.net/">中国知网</a>
    <a class="_04ab7b1" href="https://blog.csdn.net/u0100/article/details/123456">知网使用教程</a>
    <a class="_04ab7b1" href="https://www.stats.gov.cn/sj/ndsj/">国家统计局年度数据</a>
    <a class="_04ab7b1" href="https://www.doubao.com/router/xyz">某条挂了豆包中转的链接</a>
  </div>
</div></div>
"""

FIXTURES["deepseek-collapsed.html"] = """
<div class="ds-message"><div class="d29f3d7d"><div class="fbb737a4">问一个需要联网的问题</div></div></div>
<div class="ds-message"><div class="ds-markdown"><p>搜索到 5 个网页后我给出了下面的判断，但没有附任何链接。</p></div></div>
"""

FIXTURES["deepseek-streaming.html"] = """
<div class="ds-message"><div class="d29f3d7d"><div class="fbb737a4">正在问的问题</div></div></div>
<div class="ds-message"><div class="ds-markdown">
  <p>答案还在逐字往外冒<span class="ds-markdown-cite">1</span></p>
  <div class="_04ab7b1_wrap"><a class="_04ab7b1" href="https://www.gov.cn/">中国政府网</a></div>
  <div class="loading-indicator" style="width:10px;height:10px">生成中</div>
</div></div>
"""

FIXTURES["kimi-sample.html"] = """
<div class="message-container-user"><div>最近的新能源政策影响大吗？</div></div>
<div class="markdown-container"><div class="markdown-body">
  <p>据澎湃新闻报道<span class="rag-tag">1</span>，另据环球网消息<span class="rag-tag">2</span>。</p>
</div></div>
<div class="info-container">
  <div class="title"><a href="https://www.thepaper.cn/newsDetail_forward_100">澎湃新闻：补贴退坡落地</a></div>
  <div class="title"><a href="https://www.huanqiu.com/article/200">环球网：行业口径</a></div>
  <div class="title"><a href="https://www.thepaper.cn/newsDetail_forward_100">澎湃新闻（与上面同一条，应去重）</a></div>
</div>
"""

FIXTURES["doubao-sample.html"] = """
<div data-message-id="1"><div class="bg-g-send-msg-bubble-bg">帮我找数字经济的相关资料</div></div>
<div data-message-id="2">
  <div class="message-content"><div class="markdow-body">
    <p>可以先在中国知网建检索式，再看下面的资料。</p>
    <div class="cursor-pointer">已搜索 关键词 数字经济 共找到 8 篇资料</div>
    <div class="text-dbx-neutral-400">“数字经济” 与 “税收”</div>
    <div class="thinking-box">
      <a data-thinking-box-tool-call="true" href="https://www.doubao.com/link?to=https%3A%2F%2Fzhuanlan.zhihu.com%2Fp%2F999">知乎上的一篇解读</a>
      <a data-thinking-box-tool-call="true" href="https://www.gov.cn/zhengce/">中国政府网某文件</a>
      <a data-thinking-box-tool-call="true" href="https://www.doubao.com/router/abc">豆包站内中转页</a>
      <a data-tool-call-item-id="9" href="https://www.doubao.com/router/abc">豆包站内中转页（同一 URL，应去重）</a>
    </div>
  </div></div>
</div>
"""

FIXTURES["doubao-no-source.html"] = """
<div data-message-id="1"><div class="bg-g-send-msg-bubble-bg">随便聊两句</div></div>
<div data-message-id="2"><div class="message-content"><div class="markdow-body">
  <div class="cursor-pointer">已搜索 关键词 数字经济 共找到 3 篇资料（折叠着，没展开就没有链接）</div>
  <p>这个问题参考 3 篇资料，但一条链接都没给。</p>
</div></div></div>
"""

FIXTURES["yuanbao-sample.html"] = """
<div class="agent-chat__list">
  <div class="agent-chat__list__item agent-chat__list__item--human"><div>查一下人工智能产业政策</div></div>
  <div class="agent-chat__list__item agent-chat__list__item--ai" data-conv-id="conv-1">
    <div class="hyc-common-markdown">第一轮的回答</div>
  </div>
  <div class="agent-chat__list__item agent-chat__list__item--human"><div>再查新能源汽车销量</div></div>
  <div class="agent-chat__list__item agent-chat__list__item--ai" data-conv-id="conv-2">
    <div class="hyc-common-markdown">第二轮的回答</div>
  </div>
</div>
<div class="agent-dialogue-references">
  <div class="agent-dialogue-references__item" dt-ext6="https://www.gov.cn/zhengce/content/1" dt-ext3="中国政府网" dt-cid="conv-1">A</div>
  <div class="agent-dialogue-references__item" dt-ext6="https://www.zhihu.com/question/2" dt-ext3="知乎" dt-cid="conv-1">B</div>
  <div class="agent-dialogue-references__item" dt-ext6="https://www.people.com.cn/n1/3" dt-ext3="人民网" dt-cid="conv-2">C</div>
  <div class="agent-dialogue-references__item" dt-ext6="https://www.people.com.cn/n1/3" dt-ext3="人民网（重复，应去重）" dt-cid="conv-2">D</div>
</div>
"""

FIXTURES["qianwen-sample.html"] = """
<div class="chat-round" data-chat="req-1-question">
  <div class="chat-question-wrap">帮我查一下量子计算进展</div>
  <div class="chat-answer-container"><div class="markdown">回答正文</div></div>
</div>
<script type="application/json">{"data":{"originalData":{"content":{"list":[
  {"title":"新华社报道：量子计算新进展","norm_url":"https://www.news.cn/tech/1.htm","author":"新华网","publishTime":"2026-10-01"},
  {"title":"知乎上的讨论","norm_url":"https://www.zhihu.com/question/777","author":"知乎","publishTime":"2026-09-30"},
  {"title":"某榜单类内容农场站","norm_url":"https://www.top100-news24.com/a/1","author":"","publishTime":""},
  {"title":"只给了站名没给链接的一条","norm_url":"","author":"某不知名站点","publishTime":"2026-09-29"}
]}}}}</script>
"""

FIXTURES["yiyan-sample.html"] = """
<div class="chatFlow">
  <div class="answerBox flowBox"><p>第二轮的回答</p>
    <div class="container__MWtKSa6G"><span class="titleText">参考 3 个网页</span></div>
  </div>
  <div class="questionBox flowBox"><p>第二轮的提问</p></div>
  <div class="answerBox flowBox"><p>第一轮的回答</p>
    <div class="container__MWtKSa6G"><span class="titleText">参考 2 个网页</span></div>
  </div>
  <div class="questionBox flowBox"><p>第一轮的问题</p></div>
</div>
<div class="sourceContainer">
  <div class="item__abc"><span class="titleInfo">某研究报告的标题</span><span class="siteText">中国新闻网</span><span class="date">2026-10-18</span></div>
  <div class="item__abc"><span class="item__abc2"><span class="titleInfo">另一篇报道的标题</span></span><span class="siteText">环球网</span><span class="date">2026-10-17</span></div>
  <div class="item__abc"><span class="titleInfo">第三条：只有标题、来源名是空的</span><span class="siteText"></span><span class="date"></span></div>
</div>
"""

FIXTURES["perplexity-sample.html"] = """
<div class="user-message">What is the population of China?</div>
<div class="answer-shell"><div class="prose">
  <p>According to the National Bureau of Statistics<a href="https://www.perplexity.ai/api/redirect?url=https%3A%2F%2Fdata.stats.gov.cn%2Feasyquery.htm">stats</a>
  and <span data-pplx-citation-url="https://en.wikipedia.org/wiki/Demographics_of_China">Wikipedia</span>
  and <a href="https://link.perplexity.ai/?target=https%3A%2F%2Fwww.stats.gov.cn%2Fsj%2F">again stats</a>.</p>
</div></div>
"""

FIXTURES["chatgpt-sample.html"] = """
<section data-testid="conversation-turn-1"><div data-message-author-role="user"><div>最近的CPI数据</div></div></section>
<section data-testid="conversation-turn-2"><div data-message-author-role="assistant">
  <div class="markdown"><p>据国家统计局<span class="footnote">1</span>与新华社报道<span class="footnote">2</span>。</p>
  <button class="footnote-btn">Sources</button>
  <a class="flex-col rounded-xl py-2.5" href="https://www.stats.gov.cn/sj/zxfb/?utm_source=chatgpt.com&amp;utm_medium=search#:~:text=%E5%9B%BD%E6%B0%91%E7%BB%8F%E6%B5%8E">国家统计局发布</a>
  <a href="https://www.news.cn/fortune/?utm_source=chatgpt#:~:text=x">新华网财经</a>
  <a href="https://www.stats.gov.cn/sj/zxfb/?utm_source=chatgpt#:~:text=%E5%85%B6%E4%BB%96">同一条链接的第二个片段（应去重）</a>
  </div>
</div></section>
"""

FIXTURES["chatglm-sample.html"] = """
<div class="chat-message"><div class="user-message">问一个普通问题</div></div>
<div class="bot-message"><div class="markdown-answer">
  <p>这是一段没有任何来源标注的回答：按经验先去中国知网查一遍综述，正文里只有一个站内链接<a href="https://chatglm.cn/settings">设置</a>。</p>
</div></div>
"""


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "citations")
    os.makedirs(out, exist_ok=True)
    for name, body in FIXTURES.items():
        text = HEAD + body + TAIL
        with io.open(os.path.join(out, name), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        print("写入", name, len(text), "字节")
    print("共", len(FIXTURES), "个快照 ->", out)


if __name__ == "__main__":
    main()
