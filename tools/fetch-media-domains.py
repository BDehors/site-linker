#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""信源体检 · 中央权威媒体域名核实工具（构建期脚本，不随插件发布）

背景：网信办《2025 版互联网新闻信息稿源单位名单》PDF 只列单位名、不列域名
（施工清单 §5.3 假设"从 PDF 提域名"，实测该 PDF 全文无域名字段）。
本地词典 dictionary.json 只覆盖 3/31 家中央新闻网站。

做法：候选域名 → 真的发一次 HTTPS 请求取首页 <title> / og:site_name / keywords →
标题里出现该媒体的**专名**才算"已核实"。命不中的一律进 unresolved，不写进 lists.json。
判据故意保守：错挂一家媒体 = 把一个陌生域名判成"官方/权威"，比漏一家严重得多
（清单 §5.2 规则 6 就是用来抓"自称与域名不符"的，工具自己更不能这么干）。

两版修正记录（都记在这里，别以后又踩）：
  ① 第一版直接按 utf-8 解码，把 youth.cn / taiwan.cn / cnr.cn / dbw.cn 这类
     GBK 页面解成乱码 → 一片"标题未含关键词"的假阴性。现按
     HTTP charset → 页面 meta charset → utf-8 → gb18030 依次试（decode_body）。
  ② 第一版关键词给了"税务""质量""检察"这类单名，会命中别的站（国家税务总局官网
     被当成"中国税务报"）。现只认专名或明确别名。

输出：tools/media-verify-<日期>.json（每条含 HTTP 状态、页面标题证据、判定轨迹）
用法：python tools/fetch-media-domains.py [输出文件名]
"""
import html
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# (PDF 里的单位名, 标题里出现任一即认定该域名属于此单位, 候选域名按顺序试)
# 候选域名是"待验证假设"，不是结论；验不过就不进名单。
CANDIDATES = [
    # —— 中央新闻网站和重点理论网站（31 家）——
    ("人民网", ["人民网"], ["www.people.com.cn"]),
    ("新华网", ["新华网", "新华社"], ["www.news.cn", "www.xinhuanet.com"]),
    ("央视网", ["央视网"], ["www.cctv.com", "tv.cctv.com"]),
    ("中国网", ["中国网"], ["www.china.com.cn"]),
    ("国际在线", ["国际在线", "CRI"], ["www.cri.cn"]),
    ("中国日报网", ["中国日报", "China Daily"], ["www.chinadaily.com.cn"]),
    ("中国青年网", ["中国青年网"], ["www.youth.cn"]),
    ("中国经济网", ["中国经济网"], ["www.ce.cn"]),
    ("中国台湾网", ["中国台湾网"], ["www.taiwan.cn"]),
    ("中国西藏网", ["中国西藏网"], ["www.tibet.cn"]),
    ("光明网", ["光明网"], ["www.gmw.cn"]),
    ("央广网", ["央广网", "中央人民广播电台"], ["www.cnr.cn"]),
    ("中国军网", ["中国军网"], ["www.81.cn"]),
    ("中国新闻网", ["中国新闻网", "中新网"], ["www.chinanews.com.cn", "www.chinanews.com"]),
    ("人民政协网", ["人民政协"], ["www.rmzxb.com.cn"]),
    ("法治网", ["法治网", "法治日报"], ["www.legaldaily.com.cn"]),
    ("中青在线", ["中青在线", "中国青年报"], ["www.cyol.com"]),
    ("环球网", ["环球网"], ["www.huanqiu.com"]),
    ("中工网", ["中工网"], ["www.workercn.cn", "www.chinaworker.cn"]),
    ("未来网", ["未来网"], ["www.k618.cn", "news.k618.cn"]),
    ("海外网", ["海外网", "人民日报海外版"], ["www.haiwainet.cn"]),
    ("正义网", ["正义网"], ["www.jcrb.com"]),
    ("中国搜索", ["中国搜索"], ["www.chinaso.com"]),
    ("中国文明网", ["中国文明网"], ["www.wenming.cn"]),
    ("学习强国", ["学习强国"], ["www.xuexi.cn"]),
    ("求是网", ["求是", "红旗文稿"], ["www.qstheory.cn"]),
    ("理论网", ["理论网", "理论"], ["www.theory.cn"]),
    ("中国社会科学网", ["中国社会科学网", "社会科学报"], ["www.cssn.cn"]),
    ("党建网", ["党建网", "党建"], ["www.dangjian.cn"]),
    ("旗帜网", ["旗帜网", "旗帜"], ["www.qizhiwang.org.cn"]),
    ("人民论坛网", ["人民论坛"], ["www.rmlt.com.cn"]),
    # —— 中央新闻单位主管主办的报刊网站（67 家里 AI 回答高频出现的部分）——
    ("参考消息网", ["参考消息"], ["www.cankaoxiaoxi.com"]),
    ("环球时报", ["环球时报", "Global Times"], ["www.globaltimes.cn"]),
    ("证券时报网", ["证券时报"], ["www.stcn.com"]),
    ("经济网", ["经济网", "中国经济周刊"], ["www.ceweekly.cn"]),
    ("中国证券网", ["中国证券网", "上海证券报"], ["www.cnstock.com"]),
    ("中证网", ["中证网", "中国证券报"], ["www.cs.com.cn"]),
    ("中国财富网", ["中国财富"], ["www.cfbond.com"]),
    ("中国科技网", ["中国科技网", "科技日报"], ["www.stdaily.com"]),
    ("中国侨网", ["中国侨网"], ["www.chinaqw.com"]),
    ("中国新闻周刊", ["中国新闻周刊", "新闻周刊"], ["www.inewsweek.cn"]),
    ("中新经纬", ["中新经纬"], ["www.jwview.com"]),
    ("中国妇女网", ["中国妇女网"], ["www.women.org.cn"]),
    ("半月谈网", ["半月谈"], ["www.banyuetan.org"]),
    ("人民周刊网", ["人民周刊"], ["www.peopleweekly.cn"]),
    ("民生网", ["民生周刊", "民生网"], ["www.msweekly.com"]),
    ("中国工信新闻网", ["中国工信新闻网", "工信"], ["www.cnii.com.cn"]),
    ("健康报网", ["健康报"], ["www.jkb.com.cn"]),
    ("中国能源网", ["中国能源网", "中国能源报"], ["www.china5e.com"]),
    ("中国水利网", ["中国水利网", "中国水利报"], ["www.chinawater.com.cn"]),
    ("中国质量新闻网", ["中国质量新闻网", "中国质量报"], ["www.cqn.com.cn"]),
    ("中国税务报", ["中国税务报", "中国税网"], ["www.ctaxnews.net.cn"]),
    ("华夏时报网", ["华夏时报"], ["www.chinatimes.net.cn"]),
    ("中宏网", ["中宏网", "中宏"], ["www.zhonghongwang.com"]),
    ("北京周报", ["北京周报", "Beijing Review"], ["www.bjreview.com"]),
    ("中国法院网", ["中国法院网", "人民法院报"], ["www.chinacourt.org"]),
    ("科普中国网", ["科普中国"], ["www.kepuchina.cn"]),
    ("中国文艺网", ["中国文艺网"], ["www.cflac.org.cn"]),
    ("中国人权网", ["中国人权网"], ["www.humanrights.cn"]),
    ("中国食品安全网", ["中国食品安全", "食品安全报"], ["www.cfsn.cn"]),
    ("中国商报网", ["中国商报"], ["www.zgswcn.com"]),
    ("消费日报网", ["消费日报"], ["www.xfrb.com.cn"]),
    ("人民铁道网", ["人民铁道"], ["www.peoplerail.com"]),
    ("中国基金报网", ["中国基金报"], ["www.chnfund.com"]),
    ("环球人物网", ["环球人物"], ["www.hqrww.com"]),
    ("国际金融报网", ["国际金融报"], ["www.ifnews.com"]),
    ("中国县域经济报", ["县域经济"], ["www.xianyuangjw.com"]),
    ("人民邮电报", ["人民邮电报"], ["www.ptpress.com.cn"]),
    ("中国教育新闻网", ["中国教育报", "中国教育新闻网"], ["www.jyb.cn"]),
    ("中国民族网", ["中国民族网", "中国民族报"], ["www.mzzjw.cn"]),
    ("中国环境网", ["中国环境网", "中国环境报"], ["www.cenews.com.cn"]),
    ("中国知识产权资讯网", ["中国知识产权报", "知识产权资讯网"], ["www.iprnews.com"]),
    ("中国安全生产网", ["中国安全生产网", "中国应急管理报"], ["www.aqsc.cn"]),
    ("民主与法制网", ["民主与法制"], ["www.mzyfz.com"]),
    ("中国经营网", ["中国经营报", "中国经营网"], ["www.cbihw.com"]),
    ("中国经济新闻网", ["中国经济时报", "中国经济新闻网"], ["www.cet.com.cn"]),
    ("改革网", ["改革网", "中国改革报"], ["www.reform.org.cn"]),
    ("中国气象新闻网", ["中国气象新闻网", "中国气象报"], ["www.nmc.cn"]),
    ("中国绿色时报", ["中国绿色时报", "绿色中国"], ["www.cdfp.com.cn"]),
    ("中国农村网", ["中国农村网"], ["www.crnews.net"]),
    ("农视网", ["农视网", "中国农业"], ["www.nongshiwang.com"]),
    ("中国旅游新闻网", ["中国旅游报", "中国旅游新闻网"], ["www.ctnews.com.cn"]),
    ("中国交通新闻网", ["中国交通报", "中国交通新闻网"], ["www.zgjtwz.com.cn"]),
    ("中国建设新闻网", ["中国建设报", "中国建设新闻网"], ["www.chinajsb.cn"]),
    ("中国劳动保障新闻网", ["中国劳动保障报", "劳动保障"], ["www.clnews.com.cn"]),
    ("中国组织人事报新闻网", ["中国组织人事报"], ["www.zzrsb.com.cn"]),
    ("中国财经报网", ["中国财经报"], ["www.cfn.cn"]),
    ("中国审计报", ["中国审计报", "审计署"], ["www.audit.gov.cn"]),
    ("中国市场监管新闻网", ["中国市场监管报", "市场监管"], ["www.cmrn.com.cn"]),
    ("中国消费者网", ["中国消费者报", "中国消费网"], ["www.ccn.com.cn"]),
    ("中国银行保险报网", ["中国银行保险报", "金融监管"], ["www.cfn.cn"]),
    ("中国体育报", ["中国体育报", "中国体育"], ["www.sports.cn"]),
    ("中国邮政快递报", ["中国邮政快递报", "快递"], ["www.cepnews.com.cn"]),
    ("中国中医药报", ["中国中医药报", "中医药"], ["www.cntcm.com.cn"]),
    ("中国煤炭报", ["中国煤炭报"], ["www.ccn.com"]),
    ("中国医药报", ["中国医药报"], ["www.cma.org.cn"]),
    ("中国民航报", ["中国民航报", "民航局"], ["www.caacnews.com.cn"]),
    ("华夏经纬网", ["华夏经纬"], ["www.huaxia.com"]),
    ("中国侨刊", ["中国侨刊"], ["www.chinaqk.com"]),
    # —— 地方新闻网站里 AI 高频引用的头部几家（名单里属"地方新闻网站"，非中央级）——
    ("澎湃新闻", ["澎湃新闻", "澎湃"], ["www.thepaper.cn"]),
    ("界面新闻", ["界面新闻", "界面"], ["www.jiemian.com"]),
    ("千龙网", ["千龙网"], ["www.qianlong.com"]),
    ("东方网", ["东方网"], ["www.eastday.com"]),
    ("北青网", ["北青网", "北京青年报"], ["www.ynet.com", "www.benber.com"]),
    ("新京报网", ["新京报"], ["www.bjnews.com.cn"]),
    ("荆楚网", ["荆楚网", "湖北日报"], ["www.cnhubei.com"]),
    ("南方网", ["南方网", "南方日报"], ["www.southcn.com"]),
    ("金羊网", ["金羊网", "羊城晚报"], ["www.ycwb.com"]),
    ("大众网", ["大众网", "大众日报"], ["www.dzwww.com"]),
    ("齐鲁网", ["齐鲁网", "山东"], ["www.iqilu.com"]),
    ("大河网", ["大河网", "河南日报"], ["www.dahe.cn"]),
    ("红网", ["红网"], ["www.rednet.cn"]),
    ("华声在线", ["华声在线"], ["www.voc.com.cn"]),
    ("华龙网", ["华龙网"], ["www.cqnews.net"]),
    ("上游新闻", ["上游新闻"], ["www.shangyexx.com", "cqcb.com"]),
    ("封面新闻", ["封面新闻"], ["www.thecover.cn"]),
    ("四川在线", ["四川在线", "四川日报"], ["www.scol.com.cn"]),
    ("东南网", ["东南网"], ["www.fjsen.com"]),
    ("中安在线", ["中安在线"], ["www.anhuinews.com"]),
    ("浙江在线", ["浙江在线"], ["www.zjol.com.cn"]),
    ("中国江苏网", ["中国江苏网", "新华报业"], ["jsnews.jschina.com.cn", "www.chinajs.gov.cn"]),
    ("中国吉林网", ["中国吉林网"], ["www.chinajilin.com.cn"]),
    ("东北新闻网", ["东北新闻网"], ["www.nen.com.cn"]),
    ("东北网", ["东北网"], ["www.dbw.cn"]),
    ("南海网", ["南海网", "海南日报"], ["www.hinews.cn"]),
    ("广西新闻网", ["广西新闻网", "广西日报"], ["www.gxnews.com.cn"]),
    ("云南网", ["云南网", "云南日报"], ["www.yunnan.cn"]),
    ("贵州网", ["多彩贵州网"], ["www.gog.cn"]),
    ("中国甘肃网", ["中国甘肃网"], ["www.gscn.com.cn"]),
    ("青海新闻网", ["青海新闻网"], ["www.qhnews.com"]),
    ("宁夏新闻网", ["宁夏新闻网"], ["www.nxnews.net"]),
    ("天山网", ["天山网"], ["www.ts.cn"]),
    ("西部网", ["西部网", "陕西"], ["www.cnwest.com"]),
    ("长城网", ["长城网"], ["www.hebei.com.cn"]),
    ("黄河新闻网", ["黄河新闻网"], ["www.sxgov.cn"]),
    ("中国江西网", ["中国江西网", "大江网"], ["www.jxnews.com.cn"]),
    ("北方网", ["北方网"], ["www.enorth.com.cn"]),
    ("内蒙古新闻网", ["内蒙古新闻网", "正北方网"], ["www.nmgnews.com.cn", "www.northnews.cn"]),
    ("黑龙江新闻网", ["黑龙江新闻网", "哈尔滨"], ["www.hljnews.cn", "www.my310.com"]),
    ("山西新闻网", ["山西新闻网"], ["www.sxnews.cn"]),
    # 名单"地方新闻网站"里另外三家高频被 AI 引用的
    ("上观新闻网", ["上观新闻", "解放日报"], ["www.jfdaily.com"]),
    ("新民网", ["新民网", "新民晚报"], ["www.xinmin.cn"]),
    ("长江网", ["长江网"], ["www.cjn.cn"]),
]


def decode_body(raw, http_charset):
    """HTTP charset → meta charset → utf-8 → gb18030，返回 (文本, 实际用的编码)"""
    cands = []
    if http_charset:
        cands.append(http_charset)
    head = raw[:6144].decode("ascii", "ignore")
    m = re.search(r'charset=["\']?\s*([A-Za-z0-9_\-]+)', head, re.I)
    if m:
        cands.append(m.group(1))
    cands += ["utf-8", "gb18030"]
    tried = set()
    for c in cands:
        if not c:
            continue
        norm = c.lower().replace("_", "-")
        if norm in ("gb2312", "gbk"):
            norm = "gb18030"
        if norm in tried:
            continue
        tried.add(norm)
        try:
            s = raw.decode(norm)
        except Exception:
            continue
        if "\ufffd" in s[:4000]:
            continue
        return s, c
    return raw.decode("utf-8", "ignore"), "utf-8(ignore)"


def fetch_once(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
            raw = r.read(300000)
            body, enc = decode_body(raw, r.headers.get_content_charset())
            return r.status, body, enc, None
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location") if e.headers else None
        return e.code, None, None, loc
    except Exception as e:  # noqa: BLE001  构建期脚本，失败如实记下来
        return None, None, None, "%s: %s" % (type(e).__name__, e)


def fetch(url, depth=0):
    """302 手动跟一次（部分站点给相对 Location，urllib 自动跟会抛 HTTPError 302）"""
    st, body, enc, extra = fetch_once(url)
    if st in (301, 302, 303, 307, 308) and extra and depth < 2:
        nxt = extra if extra.startswith("http") else url.rstrip("/") + "/" + extra.lstrip("/")
        return fetch(nxt, depth + 1)
    if st == 200:
        return st, body, enc
    return st, (extra if isinstance(extra, str) else ""), enc


def page_signal(body):
    """首页 title + og:site_name + keywords，作为判定依据的原文（存进 JSON 便于人工复核）"""
    out = []
    m = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
    if m:
        out.append("title=" + html.unescape(re.sub(r"\s+", " ", m.group(1))).strip()[:160])
    m = re.search(r'property=["\']og:site_name["\'][^>]*content=["\']([^"\']+)', body, re.I)
    if not m:
        m = re.search(r'content=["\']([^"\']+)["\'][^>]*property=["\']og:site_name["\']', body, re.I)
    if m:
        out.append("og:site_name=" + html.unescape(m.group(1)).strip()[:80])
    m = re.search(r'name=["\']keywords["\'][^>]*content=["\']([^"\']+)', body, re.I)
    if m:
        out.append("keywords=" + html.unescape(m.group(1)).strip()[:80])
    return " | ".join(out)


def main():
    out_name = sys.argv[1] if len(sys.argv) > 1 else "media-verify-%s.json" % date.today().strftime("%Y%m%d")
    verified, unresolved = [], []
    for name, tokens, domains in CANDIDATES:
        hit, hit_sig = None, ""
        log = []
        for d in domains:
            if not re.fullmatch(r"[a-z0-9.\-]+", d):
                log.append("bad-candidate %s" % d)
                continue
            st, body, enc = fetch("https://" + d + "/")
            if st != 200:
                log.append("%s -> %s %s" % (d, st, str(body)[:70]))
                continue
            sig = page_signal(body)
            low = sig.lower()
            if any(t.lower() in low for t in tokens):
                hit, hit_sig = d, sig[:200]
                log.append("%s -> 200 [%s] %s" % (d, enc, sig[:140]))
                break
            log.append("%s -> 200 [%s] 标题未含专名 %s | %s" % (d, enc, tokens, sig[:140]))
        rec = {"name": name, "domain": hit, "evidence": hit_sig, "tokens": tokens, "trace": log}
        (verified if hit else unresolved).append(rec)
        print("%s %-14s %s" % ("OK " if hit else "NO ", name, hit or ""), flush=True)
        time.sleep(0.3)

    payload = {
        "generatedAt": str(date.today()),
        "source": "网信办《2025 版互联网新闻信息稿源单位名单》 "
                  "https://www.cac.gov.cn/2025-08/14/c_1756886951643180.htm "
                  "(PDF: /rootimages/uploadimg/1756886952378281/1756886952378281.pdf)",
        "method": "候选域名逐个 HTTPS 取首页 title/og:site_name，标题含该媒体专名才算已核实；"
                  "编码按 HTTP charset→meta charset→utf-8→gb18030 依次试",
        "verifiedCount": len(verified),
        "unresolvedCount": len(unresolved),
        "verified": verified,
        "unresolved": unresolved,
    }
    path = Path(__file__).resolve().parent / out_name
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n核实 %d 条 / 未核实 %d 条 -> %s" % (len(verified), len(unresolved), path))


if __name__ == "__main__":
    main()
