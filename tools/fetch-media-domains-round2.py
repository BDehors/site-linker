#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""第二轮：对第一轮"HTTP 200 但 title 没抓到专名"的条目，改用整页正文自名匹配。

判据（比第一轮弱，所以单独记 evidence 类型）：专名在首页正文里出现 >= 2 次
（站点自指：栏目名 / 页脚版权 / 分享组件里都会带自己的名字）。
一次都不算，避免"某篇文章标题里提了一句"被当成站点自称。
仍然命不中的，就是没核实——不进 lists.json，写进 unresolved（清单 §5.3 的纪律）。
"""
import importlib.util
import json
import re
import sys
import time
from pathlib import Path

_here = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("fmd", _here / "fetch-media-domains.py")
_fmd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fmd)
fetch = _fmd.fetch          # 复用同一套编码兜底与 302 跟跳，别另写一份判据

IN = _here / (sys.argv[1] if len(sys.argv) > 1 else "media-verify-20261019.json")
OUT = _here / "media-verify-20261019-round2.json"


def main():
    d = json.loads(IN.read_text(encoding="utf-8"))
    promoted, still = [], []
    for rec in d["unresolved"]:
        trace = " ".join(rec["trace"])
        m = re.search(r"([a-z0-9.\-]+) -> 200", trace)
        if not m:                      # 全是超时 / DNS 不存在 / 4xx：没拿到正文，谈不上核实
            still.append(rec)
            continue
        dom = m.group(1)
        st, body, enc = fetch("https://" + dom + "/")
        if st != 200:
            still.append(rec)
            continue
        text = re.sub(r"<[^>]+>", " ", body)
        hits = []
        for t in rec["tokens"]:
            n = len(re.findall(re.escape(t), text, re.I))
            if n:
                hits.append((t, n))
        strong = [(t, n) for t, n in hits if n >= 2]
        if strong:
            rec2 = dict(rec)
            rec2["domain"] = dom
            rec2["evidence"] = "body-grep [%s] %s" % (enc, strong[:3])
            promoted.append(rec2)
            print("UP  %-14s %-26s %s" % (rec["name"], dom, strong[:2]), flush=True)
        else:
            rec2 = dict(rec)
            rec2["trace"] = rec["trace"] + ["round2 body-grep 命中 %s（不足 2 次）" % (hits or "无")]
            still.append(rec2)
            print("NO  %-14s %-26s %s" % (rec["name"], dom, hits or "正文里没有专名"), flush=True)
        time.sleep(0.3)

    OUT.write_text(json.dumps({
        "round": 2,
        "method": "第一轮 title 判据没命中的，第二轮改整页正文自名匹配（出现 >=2 次才算站点自称）",
        "promotedCount": len(promoted),
        "unresolvedCount": len(still),
        "promoted": promoted,
        "unresolved": still,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n第二轮转正 %d 条 / 仍未核实 %d 条 -> %s" % (len(promoted), len(still), OUT))


if __name__ == "__main__":
    main()
