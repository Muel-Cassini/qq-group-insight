#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地规则汇总：在没有配置 AI 服务时，把已有材料整理成一份「可读、可核对」的汇总。

纯本地处理，不联网、不调用大模型。它是 AI 汇总的**保底方案**：
配了 AI 服务后，上层会自动改用大模型汇总（结论更深），本脚本仍可随时手动重跑。

两种模式：
  --mode social  读 compare_platforms.py 产出的 platform-compare.json → 关键词社媒跨平台汇总
  --mode docs    读 extract_files.py 产出的 files.json + extracted/*.txt → 用户文档汇总

输出：一份 Markdown（--out 指定；给目录则自动命名）。

设计原则：只做「归并 + 摘录 + 计数」，不做主观判断；凡是推断出来的结论都标明依据，
证据不足的写「需核实」，绝不编造。
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

CST = timezone(timedelta(hours=8))

LOCAL_BANNER = ("> 生成方式：**本地规则汇总**（当前未配置 AI 服务）。"
                "配置 AI 服务后重新生成，会自动升级为大模型汇总；本文件仍可随时重跑。")

# ---------------------------------------------------------------- 正则

RE_DATE_FULL = re.compile(r"(20\d{2})\s*[-/年\.]\s*(\d{1,2})\s*[-/月\.]\s*(\d{1,2})\s*日?")
RE_DATE_MD = re.compile(r"(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日")
RE_MONEY = re.compile(r"(?:￥|¥|\$)?\s*\d[\d,]*(?:\.\d+)?\s*(?:万元|亿元|万|元/月|元/年|元|块)")
RE_PERCENT = re.compile(r"\d+(?:\.\d+)?\s*%")
RE_PHONE = re.compile(r"(?<!\d)(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?!\d)")
RE_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
RE_URL = re.compile(r"https?://[^\s，。；、）)】\]\"]+")
RE_SECTION = re.compile(r"^\s*(?:#{1,4}\s+\S|[一二三四五六七八九十]+\s*[、.．]|第\s*[一二三四五六七八九十百]+\s*[章节条部分]|\d{1,2}\s*[、.．]\s*\S)")
RE_PAGE_MARK = re.compile(r"^-{2,}\s*第\s*\d+\s*页\s*-{2,}$")
RE_HEADER_LINE = re.compile(r"^#\s*(来源|类型|导出时间)")

# 行动项 / 关注点关键词（命中即摘出该行）
ACTION_WORDS = ["截止", "报名", "申请", "提交", "请于", "务必", "需在", "时间：", "地点", "资格",
                "条件", "要求", "联系", "咨询", "缴费", "确认", "回复", "注意", "提醒", "办理",
                "领取", "面试", "笔试", "材料", "审核", "公示", "名单"]


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def snip(text: str, n: int = 200) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:n]


def uniq_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


# ---------------------------------------------------------------- 关键词（jieba 可选）

_JIEBA = {"ok": None}

# 只保留这些词性（名词/专名/动名词/英文），避免把「2026」「09」「22」这类
# 日期碎片当成「跨文件共性主题」——实测 TF-IDF 在短文本上会大量吐出数字。
ALLOW_POS = ('n', 'nr', 'ns', 'nt', 'nz', 'nw', 'vn', 'an', 'eng', 'l', 'i', 'j')
# 纯数字/日期/百分比之类的碎片
JUNK_KEYWORD = re.compile(r'^[\d\s年月日时分秒\.\-/:：，,、%]+$')


def is_meaningful(word: str) -> bool:
    text = (word or '').strip()
    if len(text) < 2:
        return False
    if JUNK_KEYWORD.match(text):
        return False
    if text.isdigit():
        return False
    # 单个 ASCII 字母、纯标点
    if re.fullmatch(r'[a-zA-Z]', text):
        return False
    return True


def keywords_of(text: str, topk: int = 12) -> list[str]:
    """优先用 jieba TF-IDF（限词性）；不可用时退化为「中文二元组 + 英文词」词频。"""
    if _JIEBA["ok"] is None:
        try:
            import jieba  # noqa: F401
            import jieba.analyse  # noqa: F401
            import jieba.posseg  # noqa: F401
            jieba.setLogLevel(logging.WARNING)
            _JIEBA["ok"] = True
        except Exception:  # noqa: BLE001
            _JIEBA["ok"] = False
            log("[WARN] 未安装 jieba，关键词改用词频统计")
    if not text.strip():
        return []
    if _JIEBA["ok"]:
        import jieba.analyse
        # 多取一些再过滤，保证过滤后仍有 topk 个
        tags = [w for w in jieba.analyse.extract_tags(text, topK=topk * 3, allowPOS=ALLOW_POS) if is_meaningful(w)]
        if not tags:
            tags = [w for w in jieba.analyse.extract_tags(text, topK=topk * 3) if is_meaningful(w)]
        # 去掉互相包含的碎词（如「研究生」与「研究生院」同时出现时保留长的）
        kept: list[str] = []
        for word in sorted(set(tags), key=lambda w: (-len(w), w)):
            if any(word != k and word in k for k in kept):
                continue
            kept.append(word)
            if len(kept) >= topk:
                break
        return kept
    stop = set("的 了 是 在 我 有 和 就 不 人 都 一 上 也 很 到 说 要 去 你 会 着 没有 看 好 这 那 我们 你们 可以 需要 进行 以及 相关 如下 附件".split())
    counter: Counter[str] = Counter()
    for run in re.findall(r"[\u4e00-\u9fff]{2,}", text):
        for i in range(len(run) - 1):
            bg = run[i:i + 2]
            if bg not in stop:
                counter[bg] += 1
    for word in re.findall(r"[A-Za-z][A-Za-z0-9_\-\.]{2,}", text):
        counter[word.lower()] += 1
    return [w for w, _ in counter.most_common(topk * 3) if is_meaningful(w)][:topk]


# ---------------------------------------------------------------- 文本分析

def analyze_text(text: str) -> dict[str, Any]:
    lines = [line.rstrip() for line in (text or "").splitlines()]
    body = [line for line in lines if line.strip() and not RE_HEADER_LINE.match(line)]
    clean = [line for line in body if not RE_PAGE_MARK.match(line.strip())]

    title = ""
    for line in clean[:12]:
        candidate = line.strip().lstrip("#").strip()
        if 3 <= len(candidate) <= 80:
            title = candidate
            break

    sections = [line.strip()[:80] for line in clean if RE_SECTION.match(line)][:20]

    dates: list[str] = []
    for match in RE_DATE_FULL.finditer(text or ""):
        dates.append(f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}")
    for match in RE_DATE_MD.finditer(text or ""):
        dates.append(f"{int(match.group(1))}月{int(match.group(2))}日")

    actions: list[str] = []
    for line in clean:
        stripped = line.strip()
        if 4 <= len(stripped) <= 200 and any(word in stripped for word in ACTION_WORDS):
            actions.append(stripped)

    return {
        "title": title,
        "sections": uniq_keep_order(sections),
        "dates": uniq_keep_order(dates)[:15],
        "actions": uniq_keep_order(actions)[:15],
        "money": uniq_keep_order(RE_MONEY.findall(text or ""))[:10],
        "percents": uniq_keep_order(RE_PERCENT.findall(text or ""))[:10],
        "phones": uniq_keep_order(RE_PHONE.findall(text or ""))[:6],
        "emails": uniq_keep_order(RE_EMAIL.findall(text or ""))[:6],
        "urls": uniq_keep_order(RE_URL.findall(text or ""))[:8],
        "keywords": keywords_of(text or "", 12),
        "chars": len(text or ""),
    }


def read_extracted_text(docs_dir: Path, stem: str) -> str:
    file = docs_dir / "extracted" / f"{stem}.txt"
    if not file.is_file():
        return ""
    try:
        return file.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        log(f"[WARN] 读取失败 {file}：{exc}")
        return ""


# ---------------------------------------------------------------- docs 模式

def build_docs_summary(docs_dir: Path, batch: str) -> tuple[str, dict[str, Any]]:
    files_json = docs_dir / "files.json"
    if not files_json.is_file():
        raise SystemExit(f"[ERR] 缺少 {files_json}，请先在界面里执行「提取文本」")
    manifest = json.loads(files_json.read_text(encoding="utf-8-sig", errors="replace"))
    entries = manifest.get("files") or []

    analyzed: list[dict[str, Any]] = []
    for entry in entries:
        name = str(entry.get("name") or "")
        stem = Path(name).stem
        text = read_extracted_text(docs_dir, stem) if entry.get("ok") else ""
        item = {
            "name": name,
            "ext": entry.get("ext") or "",
            "sizeKB": entry.get("sizeKB") or 0,
            "ok": bool(entry.get("ok")),
            "chars": entry.get("chars") or len(text),
            "error": entry.get("error") or "",
            "warning": entry.get("warning") or "",
            "scanned_likely": bool(entry.get("scanned_likely")),
            "pages": entry.get("pages"),
            "sheets": entry.get("sheets"),
        }
        item.update(analyze_text(text) if text else {
            "title": "", "sections": [], "dates": [], "actions": [], "money": [], "percents": [],
            "phones": [], "emails": [], "urls": [], "keywords": [], "chars": item["chars"],
        })
        analyzed.append(item)

    ok_items = [i for i in analyzed if i["ok"]]
    total_chars = sum(i["chars"] for i in ok_items)

    # 跨文件共性关键词
    keyword_files: dict[str, list[str]] = defaultdict(list)
    for item in ok_items:
        for word in item["keywords"]:
            keyword_files[word].append(item["name"])
    shared_keywords = sorted(
        ({"keyword": w, "files": names, "count": len(names)} for w, names in keyword_files.items() if len(names) >= 2),
        key=lambda x: (-x["count"], -len(x["keyword"])),
    )[:20]

    all_dates: list[str] = []
    for item in ok_items:
        all_dates.extend(item["dates"])

    all_actions: list[tuple[str, str]] = []
    for item in ok_items:
        for action in item["actions"]:
            all_actions.append((item["name"], action))

    now = datetime.now(tz=CST)
    lines = [f"# 文件汇总报告（本地规则版）", "",
             f"- 批次：`{batch}` ｜ 文件：**{len(analyzed)}** 个（成功提取 {len(ok_items)}）｜ 提取文本合计 **{total_chars}** 字符",
             f"- 生成时间：{now.strftime('%Y-%m-%d %H:%M:%S')}", LOCAL_BANNER, "",
             "## 一、总览", "",
             "| 文件 | 类型 | 大小 | 提取字数 | 状态 |", "|---|---|---|---|---|"]
    for item in analyzed:
        status = "✅ 成功" if item["ok"] else f"❌ {item['error'][:60] or '提取失败'}"
        if item["scanned_likely"]:
            status += "（疑似扫描件）"
        lines.append(f"| {item['name']} | {item['ext'] or '—'} | {item['sizeKB']} KB | {item['chars']} | {status} |")

    if ok_items:
        themes = uniq_keep_order([w for item in ok_items for w in item["keywords"]])[:12]
        lines += ["", f"- 全部文件的高频词（合并后）：{'、'.join(themes) or '（不足）'}"]
    lines.append("")

    lines += ["## 二、每个文件的要点", ""]
    for item in analyzed:
        lines.append(f"### {item['name']}")
        if not item["ok"]:
            lines += ["", f"- 提取失败：{item['error'] or '未知原因'}（该文件未参与汇总）", ""]
            continue
        if item["warning"]:
            lines.append(f"- ⚠️ {item['warning']}")
        if item["pages"]:
            lines.append(f"- 页数：{item['pages']}")
        if item["sheets"]:
            lines.append(f"- 工作表：{'、'.join(str(s) for s in item['sheets'])}")
        if item["title"]:
            lines.append(f"- 开头/标题行：{snip(item['title'], 120)}")
        if item["keywords"]:
            lines.append(f"- 高频词：{'、'.join(item['keywords'])}")
        if item["sections"]:
            lines.append(f"- 章节结构（{len(item['sections'])} 处）：{' ｜ '.join(item['sections'][:12])}")
        if item["dates"]:
            lines.append(f"- 出现的日期：{'、'.join(item['dates'][:10])}")
        if item["actions"]:
            lines.append("- 可能的要求/行动项：")
            for action in item["actions"][:8]:
                lines.append(f"  - {snip(action, 160)}")
        if not any([item["title"], item["keywords"], item["sections"], item["dates"], item["actions"]]):
            lines.append("- （提取到的文本过少，无法给出要点；可能是扫描件或空文档）")
        lines.append("")

    lines += ["## 三、跨文件共性主题", ""]
    if shared_keywords:
        for item in shared_keywords:
            lines.append(f"- **{item['keyword']}**（{item['count']} 个文件）：{'、'.join(item['files'][:6])}")
    else:
        lines.append("（各文件之间没有明显共同的高频词，可能是彼此独立的材料）")
    lines.append("")

    lines += ["## 四、时间与截止 / 行动项", ""]
    if all_dates:
        lines += [f"- 材料中出现的日期：{'、'.join(uniq_keep_order(all_dates)[:20])}", ""]
    if all_actions:
        lines.append("| 来源文件 | 内容 |")
        lines.append("|---|---|")
        for name, action in all_actions[:30]:
            lines.append(f"| {name} | {snip(action, 160).replace('|', '/')} |")
    else:
        lines.append("（没有识别到「截止/报名/提交」这类行动项）")
    lines.append("")

    money = uniq_keep_order([m for item in ok_items for m in item["money"]])[:15]
    percents = uniq_keep_order([p for item in ok_items for p in item["percents"]])[:15]
    phones = uniq_keep_order([p for item in ok_items for p in item["phones"]])[:10]
    emails = uniq_keep_order([e for item in ok_items for e in item["emails"]])[:10]
    urls = uniq_keep_order([u for item in ok_items for u in item["urls"]])[:12]
    lines += ["## 五、关键数据与联系方式（本地正则抽取）", ""]
    lines.append(f"- 金额类：{'、'.join(money) or '（无）'}")
    lines.append(f"- 百分比：{'、'.join(percents) or '（无）'}")
    lines.append(f"- 电话：{'、'.join(phones) or '（无）'}")
    lines.append(f"- 邮箱：{'、'.join(emails) or '（无）'}")
    lines.append(f"- 链接：{'、'.join(urls) or '（无）'}")
    lines.append("")
    lines.append("> 抽取结果按正则命中，可能包含误命中（例如年份里的数字），引用前请回原文核对。")
    lines.append("")

    failed = [i for i in analyzed if not i["ok"]]
    scanned = [i for i in ok_items if i["scanned_likely"]]
    thin = [i for i in ok_items if i["chars"] < 50]
    lines += ["## 六、待核实与缺口", ""]
    if failed:
        lines.append(f"- {len(failed)} 个文件提取失败，未纳入汇总：{'、'.join(i['name'] for i in failed)}")
    if scanned:
        lines.append(f"- {len(scanned)} 个文件疑似扫描件（无文字层），需要 OCR 才能汇总：{'、'.join(i['name'] for i in scanned)}")
    if thin:
        lines.append(f"- {len(thin)} 个文件提取到的文本少于 50 字符：{'、'.join(i['name'] for i in thin)}")
    if not failed and not scanned and not thin:
        lines.append("- 所有文件都成功提取出文本，未发现明显缺口。")
    lines += ["- 本报告不含主观结论；涉及判断、取舍与建议的内容，建议配置 AI 服务后重新生成，"
              "或把本文件与 `all-in-one.md` 一起交给大模型。", ""]

    meta = {
        "mode": "docs", "batch": batch, "files": len(analyzed), "ok": len(ok_items),
        "chars": total_chars, "failed": [i["name"] for i in failed],
        "scanned": [i["name"] for i in scanned], "thin": [i["name"] for i in thin],
        "shared_keywords": [i["keyword"] for i in shared_keywords[:10]],
        "actions": len(all_actions), "dates": uniq_keep_order(all_dates)[:10],
    }
    return "\n".join(lines), meta


# ---------------------------------------------------------------- social 模式

def find_platforms_root(compare_json: Path) -> Path | None:
    """从 platform-compare.json 里的平台目录名反推 --src 目录（用于补读原始 jsonl）。"""
    data = json.loads(compare_json.read_text(encoding="utf-8-sig", errors="replace"))
    dirs = [p.get("dir") for p in (data.get("platforms") or []) if p.get("dir")]
    if not dirs:
        return None
    parent = compare_json.parent
    for candidate in [parent, parent.parent]:
        if all((candidate / d).is_dir() for d in dirs):
            return candidate
    return None


def build_social_summary(compare_json: Path, keyword: str) -> tuple[str, dict[str, Any]]:
    if not compare_json.is_file():
        raise SystemExit(f"[ERR] 缺少 {compare_json}，请先运行跨平台互比")
    data = json.loads(compare_json.read_text(encoding="utf-8-sig", errors="replace"))
    if not data.get("ok"):
        raise SystemExit(f"[ERR] 互比材料无效：{data.get('hint') or '未知原因'}")

    keyword = keyword or data.get("keyword") or "（未指定）"
    platforms = data.get("platforms") or []
    names = [p["platform"] for p in platforms]
    consensus = data.get("consensus_topics") or []
    only = data.get("platform_only_topics") or {}
    pairs = data.get("cross_pairs") or []
    dups = data.get("duplicates") or []
    skipped = data.get("skipped_platforms") or []
    total_items = data.get("item_count") or 0

    hottest = max(platforms, key=lambda p: p.get("likes_avg") or 0) if platforms else None
    busiest = max(platforms, key=lambda p: p.get("items") or 0) if platforms else None
    distinct_platforms = [n for n, items in only.items() if items]

    conclusion_bits = [f"「{keyword}」在 {len(names)} 个平台（{'、'.join(names)}）共采到 {total_items} 篇内容"]
    if consensus:
        conclusion_bits.append(f"其中 {len(consensus)} 个主题被 ≥2 个平台同时讨论，最大共识是「{consensus[0]['topic']}」")
    else:
        conclusion_bits.append("各平台之间没有出现共同主题，讨论方向差异明显")
    if hottest:
        conclusion_bits.append(f"互动最集中的是{hottest['platform']}（平均赞 {hottest['likes_avg']}）")
    if distinct_platforms:
        conclusion_bits.append(f"{'、'.join(distinct_platforms)} 各有独家话题")
    if pairs:
        conclusion_bits.append(f"有 {len(pairs)} 组跨平台高相关材料可做交叉印证")
    else:
        conclusion_bits.append("没有形成可交叉印证的高相关配对")

    now = datetime.now(tz=CST)
    lines = [f"# 关键词社媒汇总报告（本地规则版）", "",
             f"- 关键词：**{keyword}** ｜ 平台：{'、'.join(names)} ｜ 内容：**{total_items}** 篇 ｜ 跨平台配对：**{len(pairs)}** 组",
             f"- 生成时间：{now.strftime('%Y-%m-%d %H:%M:%S')}", LOCAL_BANNER, ""]
    if skipped:
        lines.append(f"- 本次跳过：{'、'.join(s['name'] for s in skipped)}（{skipped[0]['reason']}）")
        lines.append("")

    lines += ["## 一、一句话结论", "", "；".join(conclusion_bits) + "。", "",
              "> 以上结论只由本地统计得出（条数、共同主题、互动量），不代表观点是否成立；观点层面的印证/冲突需要读原文或交给大模型。", ""]

    lines += ["## 二、各平台画像", "", "| 平台 | 内容 | 评论 | 总赞 | 平均赞 | 最早 | 最新 | 主力话题 |",
              "|---|---|---|---|---|---|---|---|"]
    for p in platforms:
        topics = "、".join(t["topic"] for t in (p.get("top_topics") or [])[:5]) or "—"
        lines.append(f"| {p['platform']} | {p['items']} | {p['comments']} | {p['likes_sum']} | "
                     f"{p['likes_avg']} | {p['time_min']} | {p['time_max']} | {topics} |")
    lines.append("")

    lines += ["## 三、跨平台共识主题（≥2 个平台都在讨论）", ""]
    if consensus:
        lines.append("| 主题 | 出现平台数 | " + " | ".join(names) + " |")
        lines.append("|---" * (len(names) + 2) + "|")
        for item in consensus[:20]:
            cells = " | ".join(str(item["platforms"].get(n, 0)) for n in names)
            lines.append(f"| {item['topic']} | {item['platform_count']} | {cells} |")
        lines.append("")
        lines.append("> 多平台同时出现的主题，通常是该关键词下最主流的话题，可作为结论的主干。")
    else:
        lines.append("（没有共同主题）")
    lines.append("")

    lines += ["## 四、平台独有视角（信息差线索）", ""]
    if any(only.values()):
        for name, items in only.items():
            text = "、".join(f"{i['topic']}({i['total']})" for i in items[:10])
            lines.append(f"- **仅 {name}**：{text or '（无）'}")
        lines.append("")
        lines.append("> 只在一个平台出现的主题，可能是该平台的用户偏好，也可能是别的平台没被采到——"
                     "建议把这些词单独到其它平台再检索一次确认。")
    else:
        lines.append("（各平台话题重合度高，没有单边主题）")
    lines.append("")

    lines += ["## 五、跨平台高相关材料（不同平台在讲同一件事）", ""]
    if pairs:
        for index, item in enumerate(pairs[:20], 1):
            left, right = item["left"], item["right"]
            lines.append(f"### 配对 {index}（相似度 {item['score']}）")
            lines.append(f"- **{left['platform']}** [{left['title'] or left['id']}]({left['url']}) ｜ {left['author']} ｜ 赞 {left['likes']}")
            lines.append(f"  - {left['excerpt']}")
            lines.append(f"- **{right['platform']}** [{right['title'] or right['id']}]({right['url']}) ｜ {right['author']} ｜ 赞 {right['likes']}")
            lines.append(f"  - {right['excerpt']}")
            lines.append(f"  - 共同词：{', '.join(item['shared_terms'][:12])} ｜ 共同主题：{', '.join(item['shared_topics']) or '—'}")
            lines.append("")
        lines.append("> 相似度只说明话题接近。两边说法是印证、补充还是冲突，要读原文判断。")
    else:
        lines.append("（没有达到阈值的跨平台配对；可能是该关键词在各平台的内容本就不同，或采集条数太少）")
    lines.append("")

    lines += ["## 六、疑似同源 / 搬运", ""]
    if dups:
        for item in dups[:10]:
            lines.append(f"- {item['left']['platform']} [{item['left']['title'] or item['left']['id']}]({item['left']['url']})"
                         f" ↔ {item['right']['platform']} [{item['right']['title'] or item['right']['id']}]({item['right']['url']})"
                         f"（相似度 {item['score']}）")
        lines.append("")
        lines.append("> 同源内容不能当作两个独立信源；统计「多少平台提到」时要先去重。")
    else:
        lines.append("（未发现明显的同源内容）")
    lines.append("")

    lines += ["## 七、各平台热度最高的内容", ""]
    for p in platforms:
        lines.append(f"### {p['platform']}")
        for item in p.get("top_items") or []:
            lines.append(f"- [{item['title'] or '（无标题）'}]({item['url']}) ｜ {item['author']} ｜ 赞 {item['likes']}"
                         f" ｜ 评论 {item['comments_count']} ｜ {item['time']}")
            if item.get("excerpt"):
                lines.append(f"  - {item['excerpt']}")
        lines.append("")

    lines += ["## 八、时效性", ""]
    for p in platforms:
        lines.append(f"- {p['platform']}：{p['time_min']} ~ {p['time_max']}")
    lines.append("")
    lines.append("> 采集结果里时间字段缺失较多时，这一节参考价值有限；越新的内容越应优先参考。")
    lines.append("")

    lines += ["## 九、需核实与局限", ""]
    if busiest and len(platforms) > 1:
        thin_platforms = [p["platform"] for p in platforms if p["items"] < max(1, busiest["items"] // 3)]
        if thin_platforms:
            lines.append(f"- {'、'.join(thin_platforms)} 的样本量明显少于{busiest['platform']}，"
                         f"该平台「没提到」某事不能当作结论。")
    if dups:
        lines.append(f"- 存在 {len(dups)} 组疑似同源内容，计算平台覆盖度前需要去重。")
    if not consensus:
        lines.append("- 平台间没有共同主题，说明结论只能按平台分别陈述，不宜合并成统一结论。")
    lines.append("- 本报告由本地规则生成，**只做归并、摘录与计数，不做推理和判断**；"
                 "结论深度有限，配置 AI 服务后重新生成可获得观点层面的印证/冲突分析。")
    lines.append(f"- 覆盖范围受采集条数上限与登录态限制；本次实际参与比对的平台：{'、'.join(names)}。")
    lines.append("")

    lines += ["## 十、建议的下一步", ""]
    if distinct_platforms:
        words = [i["topic"] for n in distinct_platforms for i in only[n][:3]]
        lines.append(f"- 把单边话题（{'、'.join(words[:6]) or '见第四节'}）拿到其它平台补检索，确认是真信息差还是采样偏差。")
    if pairs:
        lines.append("- 对第五节的高相关配对逐条读原文，标注「印证 / 补充 / 冲突」，再形成结论。")
    else:
        lines.append("- 放宽配对阈值（`--min-score` 降到 0.08）或提高每平台采集条数，再跑一次互比。")
    lines.append("- 若需要观点层面的判断与可执行建议，到「⑥ 设置」配置一个 AI 服务后重新生成汇总。")
    lines.append("")

    meta = {
        "mode": "social", "keyword": keyword, "platforms": names, "items": total_items,
        "consensus_topics": len(consensus), "pairs": len(pairs), "duplicates": len(dups),
        "skipped": [s["name"] for s in skipped],
        "platform_only": {k: len(v) for k, v in only.items()},
    }
    return "\n".join(lines), meta


# ---------------------------------------------------------------- main

def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(description="本地规则汇总（无 AI 服务时的保底方案）")
    ap.add_argument("--mode", required=True, choices=["social", "docs"])
    ap.add_argument("--out", required=True, help="输出 Markdown 文件（给目录则自动命名）")
    ap.add_argument("--compare", default="", help="social 模式：platform-compare.json 路径")
    ap.add_argument("--docs", default="", help="docs 模式：artifacts/docs/<批次> 目录")
    ap.add_argument("--keyword", default="", help="social 模式：关键词（默认读材料里的）")
    ap.add_argument("--batch", default="", help="docs 模式：批次名（默认取目录名）")
    args = ap.parse_args()

    if args.mode == "social":
        if not args.compare:
            raise SystemExit("[ERR] social 模式需要 --compare")
        body, meta = build_social_summary(Path(args.compare).expanduser(), args.keyword)
        default_name = "verify-summary.md"
    else:
        if not args.docs:
            raise SystemExit("[ERR] docs 模式需要 --docs")
        docs_dir = Path(args.docs).expanduser()
        if not docs_dir.is_dir():
            raise SystemExit(f"[ERR] 目录不存在：{docs_dir}")
        batch = args.batch or docs_dir.name
        body, meta = build_docs_summary(docs_dir, batch)
        stamp = datetime.now(tz=CST).strftime("%Y-%m-%d-%H-%M")
        default_name = f"文件汇总-{batch}-{stamp}.md"

    out = Path(args.out).expanduser()
    if out.is_dir() or not out.suffix:
        out = out / default_name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(body + "\n", encoding="utf-8")

    print(json.dumps({
        "ok": True, "mode": args.mode, "out": str(out),
        "chars": len(body), "sections": body.count("\n## "), **meta,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
