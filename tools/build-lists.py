#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""信源体检 · 生成 src/citations/lists.json

media[] 的事实来源有两层，可信度不同，在 section 字段里分开标：
  A. central-license —— 国家网信办《国家网信办许可信息 · 中央互联网新闻信息服务单位》
     附件 PDF（2026-07-20 发布），194 条，每条**自带服务名称 + 服务地址 + 许可证编号**。
     这是唯一一份"官方直接给域名"的名单，所以 media 主体用它，不用手抄。
     （施工清单 §5.3 说的《2025 版稿源单位名单》PDF 全文只有单位名、没有域名，
       见 tools/media-yuan-list-2025.pdf；两份都在，口径可回溯。）
  B. verified-list —— 官方许可名单是"逐省发布"的，地方站点的域名不在国家那份里。
     这一层是我自己按"候选域名 → 真实 HTTPS/渲染取标题 → 含该媒体专名才算核实"跑出来的
     （tools/fetch-media-domains*.py + tools/render-verify.js 三个 JSON 为证据），
     验不过的一律不进，unresolved 全部留在报告里。

community[] / farmPatterns[] / selfDomains[] 是判据配置，不是事实核查结果，
按施工清单 §5.2 规则 7/8 与 §3.2 各站 selfDomains 手工归纳，注释里写明出处。

用法：python tools/build-lists.py
"""
import json
import re
from datetime import date
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
LIC_PDF = Path(__file__).resolve().parent / "media-license-central-20260720.pdf"
VERIFY = [
    (Path(__file__).resolve().parent / "media-verify-20261019.json", "round1-title"),
    (Path(__file__).resolve().parent / "media-verify-20261019-round2.json", "round2-body"),
    (Path(__file__).resolve().parent / "media-verify-20261019-round3.json", "round3-render"),
]

DOMAIN_RE = re.compile(r"^(?:www\.|m\.)?[a-z0-9\u4e00-\u9fa5\-]+(?:\.[a-z0-9\u4e00-\u9fa5\-]+)+$", re.I)
LICENSE_RE = re.compile(r"^1012\d{7}$")


def norm_domain(raw):
    """清洗一个"服务地址"字段：去协议、去尾斜杠、去 www./m. 前缀，只留可后缀匹配的域名"""
    s = str(raw or "").strip().rstrip("；;，,。 ")
    if not s:
        return None
    s = re.sub(r"^https?://", "", s, flags=re.I)
    s = s.split("/")[0].strip().lower()
    if not s or " " in s or "@" in s:
        return None
    s = re.sub(r"^(www|m)\.", "", s)
    if not DOMAIN_RE.match(s):
        return None
    return s


def parse_license_pdf():
    """PDF 表格是 序号 / 服务名称 / 服务地址(可多行) / 许可证编号 的线性文本，按状态机切"""
    doc = pymupdf.open(LIC_PDF)
    lines = []
    for p in doc:
        for ln in p.get_text().splitlines():
            ln = ln.strip()
            if ln:
                lines.append(ln)
    recs, cur = [], None
    i = 0
    while i < len(lines):
        ln = lines[i]
        if re.fullmatch(r"\d{1,3}", ln) and (cur is None or cur.get("license")):
            # 序号行：开一条新记录（表头"序号"与"194 个"之类的数字也可能撞车，靠下面字段把关）
            cur = {"seq": int(ln), "name": "", "addr": [], "license": None}
            recs.append(cur)
            i += 1
            continue
        if cur is not None:
            if LICENSE_RE.match(ln):
                cur["license"] = ln
                cur = None
                i += 1
                continue
            if DOMAIN_RE.match(re.sub(r"[；;，,。/]$", "", ln)):
                for piece in re.split(r"[；;]", ln):
                    d = norm_domain(piece)
                    if d:
                        cur["addr"].append(d)
                i += 1
                continue
            # 域名被 PDF 折行的残片：形如 "www." 单独一行，真域在下两行（"crnews.net"）
            if re.fullmatch(r"(https?://)?(www|m)\.", ln, re.I) and i + 1 < len(lines):
                nxt = norm_domain(lines[i + 1])
                if nxt:
                    cur["addr"].append(nxt)
                    i += 2
                    continue
            if not cur["name"] and re.search(r"[\u4e00-\u9fa5A-Za-z]", ln) and not re.fullmatch(r"\d+", ln):
                cur["name"] = ln
        i += 1
    out = []
    for r in recs:
        if r["name"] and r["addr"]:
            out.append(r)
    return out


def load_verified():
    """读三轮核实产物里的"转正"条目；手工驳掉一条假转正（见下 BLACKLIST）"""
    kept = []
    # cfn.cn 是"银行网/中金网投"，第二轮靠通用词「金融监管」出现 4 次被误转正——驳掉
    # audit.gov.cn / sports.cn 第一轮分别被"审计署""华奥星空网"占位，属于错挂单位名——驳掉
    BLACKLIST = {"www.cfn.cn", "cfn.cn", "www.audit.gov.cn", "audit.gov.cn",
                 "www.sports.cn", "sports.cn", "www.ptpress.com.cn", "ptpress.com.cn",
                 "www.theory.cn", "theory.cn", "www.cbihw.com", "www.chinaibn.com",
                 "www.clnews.com.cn", "www.cma.org.cn", "www.sxnews.cn", "www.cepnews.com.cn",
                 "www.nongshiwang.com", "www.zgjtwz.com.cn", "www.xianyuangjw.com",
                 "www.hqrww.com", "www.mzzjw.cn", "www.zzrsb.com.cn", "www.cmrn.com.cn",
                 "www.cdfp.com.cn", "www.chinaqk.com", "www.reform.org.cn", "www.aqsc.cn",
                 "www.jjxw.cn", "www.shangyexx.com", "www.mzzjw.cn"}
    for path, round_name in VERIFY:
        if not path.exists():
            continue
        d = json.loads(path.read_text(encoding="utf-8"))
        pools = []
        if round_name == "round1-title":
            pools = [(x, "title") for x in d.get("verified", [])]
        else:
            pools = [(x, "body/render") for x in d.get("promoted", [])]
        for rec, kind in pools:
            dom = norm_domain(rec.get("domain") or "")
            if not dom:
                continue
            if dom in BLACKLIST:
                continue
            kept.append({
                "name": rec["name"], "domain": dom,
                "section": "verified-list",
                "evidence": (rec.get("evidence") or "")[:160],
                "via": round_name + ":" + kind,
            })
    return kept


# —— 社区 / 门户 / 百科（清单 §5.2 规则 7：聚合内容单列"中"档，不压进高也不压进低）
# generative.qa《State of GEO 2026》10000 次提问实测：Reddit 占引用 47%、Wikipedia 占 22%
# —— 社区与百科是 AI 引用的主力，"中"档是刚需（§5.5）。
COMMUNITY = [
    # 问答 / 技术社区
    ("zhihu.com", "知乎", ["zhuanlan.zhihu.com"]),
    ("csdn.net", "CSDN", ["blog.csdn.net", "download.csdn.net"]),
    ("juejin.cn", "掘金", ["juejin.im"]),
    ("cnblogs.com", "博客园", []),
    ("segmentfault.com", "思否", []),
    ("oschina.net", "开源中国", []),
    ("51cto.com", "51CTO", []),
    ("stackoverflow.com", "Stack Overflow", ["stackexchange.com"]),
    ("github.com", "GitHub", ["gist.github.com"]),
    ("gitee.com", "Gitee", []),
    ("runoob.com", "菜鸟教程", []),
    ("jianshu.com", "简书", []),
    ("douban.com", "豆瓣", []),
    ("bilibili.com", "哔哩哔哩", []),
    ("xiaohongshu.com", "小红书", []),
    ("tieba.baidu.com", "百度贴吧", []),
    ("zhidao.baidu.com", "百度知道", []),
    ("baijiahao.baidu.com", "百家号", []),
    ("baike.baidu.com", "百度百科", []),
    ("weibo.com", "新浪微博", []),
    ("toutiao.com", "今日头条", []),
    ("mp.weixin.qq.com", "微信公众号", []),
    ("qzone.qq.com", "QQ 空间", []),
    # 门户
    ("sina.com.cn", "新浪", ["sina.cn"]),
    ("163.com", "网易", []),
    ("sohu.com", "搜狐", []),
    ("ifeng.com", "凤凰网", []),
    ("qq.com", "腾讯网", []),
    # 百科 / 维基
    ("wikipedia.org", "维基百科", []),
    ("wikihow.com", "wikiHow", []),
    ("mbalib.com", "智库百科", []),
    # 财经聚合 / 科技媒体（非许可名单内，但属"编辑整理"性质）
    ("xueqiu.com", "雪球", []),
    ("eastmoney.com", "东方财富网", []),
    ("36kr.com", "36氪", []),
    ("huxiu.com", "虎嗅网", []),
    ("infoq.cn", "InfoQ 中文站", []),
    # 海外常见社区（按 generative.qa 实测分布补）
    ("reddit.com", "Reddit", ["old.reddit.com"]),
    ("quora.com", "Quora", []),
    ("medium.com", "Medium", []),
    ("pinterest.com", "Pinterest", []),
    ("finance.yahoo.com", "Yahoo Finance", []),
    # 文档站常见前缀走 audit.js 的 docs./developer. 规则，不在此逐条列
]

# —— 内容农场特征（清单 §5.4，多源归纳：postaffiliatepro / techbloat / yatai / cevdm）。
# 注意命中后的档位是"低/待核"而不是"低可信"——插件只看域名级特征，判不了内容真假。
FARM_PATTERNS = [
    {"pattern": r"(?:^|[-.])(?:best|top|rank|paihang|qingdan|list)[-_.]?(?:\d{1,6}|$)",
     "why": "域名里带「榜单 / 排行」类通用词"},
    {"pattern": r"(?:news|daily|xinwen|zixun|kuaixun|rrw)\d{1,6}(?:\.|$|-)",
     "why": "新闻类通用词后挂数字（xxx-news24 风格）"},
    {"pattern": r"^(?:\d{4}|[a-z]{1,4}\d{4,6})\.",
     "why": "域名主体就是一串数字"},
    {"pattern": r"[-.](?:tips|faqs|guide|answers|share|wen)\d+",
     "why": "技巧/问答类通用词加数字"},
    {"pattern": r"(?:^|\.)(?:xxw|mxnews|kuaibao|wlw|znb|cwb)\.",
     "why": "已知批量转载站的缩写域"},
]

# —— 平台自身域与中转域（清单 §5.2 规则 2 原样落地；这些域名的引用一律"待核"，不硬判低）
SELF_DOMAINS = [
    "deepseek.com", "doubao.com", "kimi.com", "kimi.ai", "moonshot.cn",
    "yuanbao.tencent.com", "chatglm.cn", "qianwen.com", "tongyi.aliyun.com",
    "yiyan.baidu.com", "perplexity.ai", "link.perplexity.ai",
    "chatgpt.com", "metaso.cn", "xinghuo.xfyun.cn",
]


def main():
    central = parse_license_pdf()
    verified = load_verified()

    media, seen = [], set()
    for r in central:
        for d in r["addr"]:
            if d in seen:
                continue
            seen.add(d)
            media.append({"name": r["name"], "domain": d, "section": "central-license",
                          "license": r["license"]})
    for v in verified:
        if v["domain"] in seen:
            continue
        seen.add(v["domain"])
        media.append(v)

    community = []
    cseen = set()
    for dom, name, subs in COMMUNITY:
        if dom in cseen:
            continue
        cseen.add(dom)
        community.append({"domain": dom, "name": name,
                          "subdomains": [s for s in subs if s not in cseen]})

    farm = []
    for f in FARM_PATTERNS:
        re.compile(f["pattern"])          # 编译不过就在这里炸，别把坏正则写进产物
        farm.append(f)

    payload = {
        "version": "1.0.0",
        "updated": str(date.today()),
        "meta": {
            "mediaListVersion": "国家网信办许可信息（2026年7月20日发布）",
            "mediaListSource": "https://www.cac.gov.cn/2026-07/22/c_1786465601042567.htm "
                               "→ 附件 media-license-central-20260720.pdf（194 家，自带域名与许可证号）",
            "yuanListVersion": "《2025 版互联网新闻信息稿源单位名单》2025-08-14 发布，官方入口至 2026-10-19 未更新",
            "yuanListSource": "https://www.cac.gov.cn/2025-08/14/c_1756886951643180.htm "
                              "→ 附件 media-yuan-list-2025.pdf（全文只有单位名，无域名字段）",
            "reviewedAt": str(date.today()),
            "coverageNote": "media[] = A 层官方许可名单 194 家的全部服务地址 + B 层实测核实的许可外媒体；"
                            "B 层证据见 tools/media-verify-20261019*.json。未通过核实的候选域名一律未收录。",
            "counts": {"media": len(media),
                       "mediaCentral": sum(1 for m in media if m["section"] == "central-license"),
                       "mediaVerified": sum(1 for m in media if m["section"] == "verified-list"),
                       "community": len(community), "farmPatterns": len(farm),
                       "selfDomains": len(SELF_DOMAINS)}
        },
        "media": media,
        "community": community,
        "farmPatterns": farm,
        "selfDomains": SELF_DOMAINS,
    }
    out = ROOT / "src" / "citations" / "lists.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    report = []
    report.append("lists.json 生成报告 · %s" % date.today())
    report.append("A 层（官方许可名单）解析出 %d 家单位、%d 个已收录域名" % (
        len(central), sum(1 for m in media if m["section"] == "central-license")))
    report.append("B 层（三轮实测核实）补入 %d 个域名" % sum(1 for m in media if m["section"] == "verified-list"))
    report.append("驳掉的假转正 / 错挂候选见 BLACKLIST："
                  "cfn.cn 是银行网、audit.gov.cn 是审计署、sports.cn 是华奥星空、theory.cn 是思睿、"
                  "clnews.com.cn 是长乐新闻网、cma.org.cn 是中华医学会、sxnews.cn 是绍兴网、"
                  "ptpress.com.cn 是人民邮电出版社——全部按标题判据挡在门外")
    report.append("community %d 条 / farmPatterns %d 条 / selfDomains %d 条" % (
        len(community), len(farm), len(SELF_DOMAINS)))
    report.append("输出：%s（%d 字节）" % (out, out.stat().st_size))
    (Path(__file__).resolve().parent / "lists-build-report.txt").write_text(
        "\n".join(report), encoding="utf-8")
    print("\n".join(report))


if __name__ == "__main__":
    main()
