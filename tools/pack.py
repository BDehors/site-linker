#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按显式文件清单打包，杜绝"整目录复制"误带上内部文件。

用法：
  python tools/pack.py store  [输出目录]   # 商店 zip（默认 dist/store/站点链接助手-v1.6.0.zip）
  python tools/pack.py github [输出目录]   # 公开源码树（默认 dist/github）
  python tools/pack.py verify <zip 路径>   # 校验已有 zip 是否与清单完全一致

清单之外的一切（研究资料、协作记录、测试扫描件……）都不会进包；
打包前还会对每个文件做路径与内容双重断言，命中敏感词直接报错退出。
"""

import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZIP_NAME = "站点链接助手-v2.0.0.zip"

# —— 显式清单（新增内容必须在这里登记，否则不会进包）——
STORE_FILES = [
    "manifest.json",
    "src/dictionary.json",
    "src/content.js",
    "src/background.js",
    # v2.0.0 信源体检：五个模块 + 名单，少一个扩展就报错，必须在包里
    "src/citations/adapters.js",
    "src/citations/extract.js",
    "src/citations/audit.js",
    "src/citations/card.js",
    "src/citations/ledger.js",
    "src/citations/lists.json",
    "src/options.html",
    "src/options.css",
    "src/options.js",
    "src/popup.html",
    "src/popup.css",
    "src/popup.js",
    "src/manual.html",
    "src/manual-images/popup.png",
    "src/manual-images/popup-search.png",
    "src/manual-images/page-links.jpg",
    "src/manual-images/options.jpg",
    "src/manual-images/options-prefs.jpg",
    "src/manual-images/user-sites.jpg",
    "src/manual-images/options-edit.jpg",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
    "icons/logo300.png",
    "icons/promo440x280.png",
    "README.md",
    "PRIVACY.md",
    "LICENSE",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "NOTICE.md",
]

GITHUB_FILES = STORE_FILES + [
    "demo.html",
    ".gitignore",
    "tests/index.html",
    "tests/quiz.html",
    "tests/article.html",
    "tests/samples/article-sample.pdf",
    "tests/samples/article-sample.docx",
    # v2.0.0 信源体检：快照 + 名单的可复现来源（官方 PDF、核实证据、生成脚本）
    "tests/citations/deepseek-sample.html",
    "tests/citations/deepseek-collapsed.html",
    "tests/citations/deepseek-streaming.html",
    "tests/citations/kimi-sample.html",
    "tests/citations/doubao-sample.html",
    "tests/citations/doubao-no-source.html",
    "tests/citations/yuanbao-sample.html",
    "tests/citations/qianwen-sample.html",
    "tests/citations/yiyan-sample.html",
    "tests/citations/perplexity-sample.html",
    "tests/citations/chatgpt-sample.html",
    "tests/citations/chatglm-sample.html",
    "tools/media-license-central-20260720.pdf",
    "tools/media-verify-20261019.json",
    "tools/media-verify-20261019-round2.json",
    "tools/media-verify-20261019-round3.json",
    "tools/lists-build-report.txt",
    "tools/build-lists.py",
    "tools/fetch-media-domains.py",
    "tools/fetch-media-domains-round2.py",
    "tools/render-verify.js",
    "tools/make-citation-fixtures.py",
    "tools/calibrate.js",
    "tools/make_icons.py",
    "tools/smoke-test.js",
    "tools/browser-test.js",
    "tools/e2e-test.js",
    "tools/make-manual-shots.js",
    "tools/make-store-shots.js",
    "tools/make-samples.py",
    "tools/pack.py",
]

# 出现即报错的内部词（入库的只放通用词；本地专属词写 tools/_pack-forbidden.txt，存在即并入，不入库不随包）
FORBIDDEN = [".workbuddy"]
_local_words = ROOT / "tools" / "_pack-forbidden.txt"
if _local_words.exists():
    FORBIDDEN += [w.strip() for w in _local_words.read_text(encoding="utf-8").splitlines() if w.strip()]
TEXT_EXT = {".md", ".json", ".js", ".css", ".html", ".py", ".txt", ".gitignore"}


def _check_path(rel):
    for word in FORBIDDEN:
        if word in rel:
            raise SystemExit(f"拒绝打包：路径含敏感词“{word}” → {rel}")


def _check_content(path, rel):
    if path.suffix.lower() not in TEXT_EXT and path.name != ".gitignore":
        return
    text = path.read_text(encoding="utf-8", errors="ignore")
    # pack.py 与 .gitignore 自身会出现这些词，跳过内容断言（两者都不含任何内部内容）
    if rel in ("tools/pack.py", ".gitignore"):
        return
    for word in FORBIDDEN:
        if word in text:
            raise SystemExit(f"拒绝打包：{rel} 内容含敏感词“{word}”")


def collect(files):
    missing = [f for f in files if not (ROOT / f).exists()]
    if missing:
        raise SystemExit("清单中的文件不存在：\n  " + "\n  ".join(missing))
    for rel in files:
        _check_path(rel)
        _check_content(ROOT / rel, rel)
    print(f"清单校验通过：{len(files)} 个文件，无敏感词命中")


def build_store(out_dir=None):
    collect(STORE_FILES)
    out_dir = Path(out_dir) if out_dir else ROOT / "dist" / "store"
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / ZIP_NAME
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        # manifest.json 放第一个，且必须位于 zip 根目录（商店要求）
        for rel in ["manifest.json"] + [f for f in STORE_FILES if f != "manifest.json"]:
            zf.write(ROOT / rel, arcname=rel)
    print(f"已生成商店包：{zip_path}")
    verify_zip(zip_path)


def build_github(out_dir=None):
    collect(GITHUB_FILES)
    out_dir = Path(out_dir) if out_dir else ROOT / "dist" / "github"
    out_dir.mkdir(parents=True, exist_ok=True)
    for rel in GITHUB_FILES:
        dst = out_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)
    # 报告清单之外的多余文件（不自动删除，只提示）
    extra = []
    for p in out_dir.rglob("*"):
        if p.is_file():
            rel = p.relative_to(out_dir).as_posix()
            if rel not in GITHUB_FILES:
                extra.append(rel)
    print(f"已组装公开源码树：{out_dir}（{len(GITHUB_FILES)} 个文件）")
    if extra:
        print("⚠ 目标目录里还有清单之外的文件，请确认是否应删除：")
        for rel in extra:
            print("   -", rel)
    else:
        print("目标目录内容与清单完全一致。")


def verify_zip(zip_path):
    zip_path = Path(zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        bad = [n for n in names if n.startswith(("/", "../")) or "\\" in n]
        if bad:
            raise SystemExit(f"zip 内部路径异常：{bad}")
        if names[0] != "manifest.json":
            raise SystemExit("zip 第一个条目不是根目录的 manifest.json")
        expect = set(STORE_FILES)
        got = set(names)
        if expect != got:
            raise SystemExit(
                "zip 内容与清单不一致：\n  缺少: %s\n  多余: %s"
                % (sorted(expect - got) or "无", sorted(got - expect) or "无")
            )
        for n in names:
            for word in FORBIDDEN:
                if word in n:
                    raise SystemExit(f"zip 含敏感路径：{n}")
    print(f"zip 校验通过：{len(names)} 个条目，与清单完全一致，无敏感词。")
    return True


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else ""
    if cmd == "store":
        build_store(args[1] if len(args) > 1 else None)
    elif cmd == "github":
        build_github(args[1] if len(args) > 1 else None)
    elif cmd == "verify" and len(args) > 1:
        verify_zip(args[1])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
