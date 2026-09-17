#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨平台互比：同一个关键词在多个社媒平台（小红书/知乎/B站…）采到的内容互相比对。

纯本地文本处理，不联网、不调用大模型，也不修改 MediaCrawler 与 cross-compare 技能脚本。

设计要点：分词、主题词表与相似度打分**直接复用 cross-compare 的 compare.py**
（用 importlib 按路径加载，不复制逻辑），这样「跨平台互比」与「群聊 × 社媒比对」
用的是同一套口径和同一份 config.json，调参只改一处。

输入：
  --src   关键词目录；其下每个子目录是一次平台采集（含 crawl.py 写的 _manifest.json）
          以 _ 开头的子目录会被跳过（keyword-verify 会在同级放 _qq / _compare / _platform）
输出（写入 --out）：
  platform-compare.json  结构化材料（供进一步汇总）
  platform-compare.md    人类可读的比对材料

退出码：0 成功；3 一个平台都没采到数据。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

CST = timezone(timedelta(hours=8))
HERE = Path(__file__).resolve()
PROJECT_ROOT = HERE.parents[3]  # app/server/tools/x.py → 项目根
DEFAULT_SKILL_COMPARE = PROJECT_ROOT / ".agents" / "skills" / "cross-compare" / "scripts" / "compare.py"

# 平台代码 → 中文名（manifest 缺失或没有 platform_name 时的兜底）
PLATFORM_LABELS = {
    "xhs": "小红书", "zhihu": "知乎", "bili": "B站", "douyin": "抖音",
    "kuaishou": "快手", "weibo": "微博", "tieba": "贴吧",
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------- 复用 cross-compare

def load_skill_module(path: Path):
    """按路径加载 compare.py 作为模块（它只有 __main__ 守卫，导入安全）。"""
    if not path.is_file():
        raise SystemExit(f"[ERR] 找不到 cross-compare 的 compare.py：{path}")
    spec = importlib.util.spec_from_file_location("dsh_cross_compare", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"[ERR] 无法加载模块：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- 时间与工具

def parse_any_ts(value: Any, skill) -> datetime | None:
    """尽力解析时间：epoch 秒/毫秒、ISO 字符串、常见日期格式。

    compare.py 的 parse_ts 只吃字符串，而 MediaCrawler 各平台的 time 字段类型不一
    （小红书常是毫秒整数），这里先做一次归一化再交给它兜底。
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        num = float(value)
        if num > 1e11:      # 毫秒
            num /= 1000.0
        try:
            return datetime.fromtimestamp(num, tz=CST)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip()
    if re.fullmatch(r"\d{10}", text):
        return datetime.fromtimestamp(int(text), tz=CST)
    if re.fullmatch(r"\d{13}", text):
        return datetime.fromtimestamp(int(text) / 1000.0, tz=CST)
    parsed = skill.parse_ts(text)
    if parsed:
        return parsed
    for fmt in ("%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(text[:19], fmt).replace(tzinfo=CST)
        except ValueError:
            continue
    return None


def norm_url(url: str) -> str:
    text = (url or "").strip()
    if not text:
        return ""
    text = re.sub(r"[?#].*$", "", text)
    text = re.sub(r"^https?://", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^www\.", "", text, flags=re.IGNORECASE)
    return text.rstrip("/").lower()


def snip(text: str, n: int = 200) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:n]


def fmt_time(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%d %H:%M") if dt else "—"


# ---------------------------------------------------------------- 载入

def platform_dirs(src: Path) -> list[Path]:
    if not src.is_dir():
        return []
    out = []
    for entry in sorted(src.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith("_") or entry.name.startswith("."):
            continue  # _qq / _compare / _platform 之类的中间产物
        out.append(entry)
    return out


def read_manifest(pdir: Path) -> dict[str, Any]:
    file = pdir / "_manifest.json"
    if not file.is_file():
        return {}
    try:
        data = json.loads(file.read_text(encoding="utf-8-sig", errors="replace"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def load_platform(pdir: Path, skill) -> dict[str, Any] | None:
    """读一个平台目录，返回 {code,name,items,...}；没有内容返回 None。"""
    manifest = read_manifest(pdir)
    code = str(manifest.get("platform") or pdir.name).strip()
    name = str(manifest.get("platform_name") or PLATFORM_LABELS.get(code, code)).strip()

    items = skill.load_social(pdir)
    if not items:
        return None

    for item in items:
        item["platform"] = code
        item["platform_name"] = name
        item["_ts"] = parse_any_ts(item.get("time"), skill)

    times = sorted(t for t in (item["_ts"] for item in items) if t)
    likes = [int(item.get("likes") or 0) for item in items]
    comment_total = sum(len(item.get("comments") or []) for item in items)
    topics: Counter[str] = Counter()
    for item in items:
        topics.update(t for t in item.get("_topics", set()) if not t.startswith("url:"))

    return {
        "code": code,
        "name": name,
        "dir": pdir.name,
        "items": items,
        "count": len(items),
        "comments": comment_total,
        "likes_sum": sum(likes),
        "likes_avg": round(sum(likes) / len(likes), 1) if likes else 0.0,
        "likes_max": max(likes) if likes else 0,
        "time_min": times[0] if times else None,
        "time_max": times[-1] if times else None,
        "topics": topics,
        "crawl_exit_code": manifest.get("exit_code"),
        "keywords": manifest.get("keywords") or [],
    }


# ---------------------------------------------------------------- 比对

def make_pair(score: float, a: dict, b: dict, shared: set[str], tshared: set[str], skill) -> dict[str, Any]:
    ex = skill.EXCERPT_CHARS
    return {
        "score": round(score, 3),
        "shared_terms": skill.dedupe_terms(shared, 14),
        "shared_topics": sorted(tshared),
        "left": {
            "platform": a["platform_name"], "code": a["platform"],
            "id": a["id"], "title": a["title"][:ex["title"]], "author": a["author"],
            "likes": a["likes"], "comments_count": a["comments_count"], "url": a["url"],
            "excerpt": a["text"][:ex["social"]],
            "top_comments": [c["text"][:ex["comment"]] for c in (a.get("comments") or [])[:3]],
        },
        "right": {
            "platform": b["platform_name"], "code": b["platform"],
            "id": b["id"], "title": b["title"][:ex["title"]], "author": b["author"],
            "likes": b["likes"], "comments_count": b["comments_count"], "url": b["url"],
            "excerpt": b["text"][:ex["social"]],
            "top_comments": [c["text"][:ex["comment"]] for c in (b.get("comments") or [])[:3]],
        },
    }


def pair_score(a: dict, b: dict, skill, scoring: dict, min_shared: int) -> tuple[float, set[str], set[str]]:
    shared = a["_tok"] & b["_tok"]
    if len(shared) < min_shared:
        return 0.0, set(), set()
    tshared = {t for t in (a.get("_topics", set()) & b.get("_topics", set())) if not t.startswith("url:")}
    score = scoring["weight_overlap"] * skill.overlap(a["_tok"], b["_tok"]) \
        + scoring["weight_jaccard"] * skill.jaccard(a["_tok"], b["_tok"])
    score += scoring["weight_per_topic"] * min(len(tshared), scoring["topic_cap"])
    if tshared:
        score += scoring["bonus_shared_topic"]
    ua, ub = norm_url(a.get("url", "")), norm_url(b.get("url", ""))
    if ua and ua == ub:
        score += scoring["bonus_shared_url"]
    return score, shared, tshared


def build_cross_pairs(platforms: list[dict], skill, scoring: dict, thresholds: dict,
                      top_n: int, min_score: float) -> tuple[list[dict], list[dict]]:
    """返回 (跨平台高相关配对, 疑似同源/搬运)。"""
    min_shared = int(thresholds["min_shared_terms"])
    dup_jaccard = 0.7
    scored: list[dict] = []
    dups: list[dict] = []

    for i in range(len(platforms)):
        for j in range(i + 1, len(platforms)):
            left, right = platforms[i], platforms[j]
            for a in left["items"]:
                for b in right["items"]:
                    score, shared, tshared = pair_score(a, b, skill, scoring, min_shared)
                    if score <= 0:
                        continue
                    same_url = norm_url(a.get("url", "")) and norm_url(a.get("url", "")) == norm_url(b.get("url", ""))
                    jac = skill.jaccard(a["_tok"], b["_tok"])
                    if same_url or (jac >= dup_jaccard and len(shared) >= 8):
                        dups.append(make_pair(score, a, b, shared, tshared, skill))
                    if score >= min_score:
                        scored.append(make_pair(score, a, b, shared, tshared, skill))

    scored.sort(key=lambda x: -x["score"])
    dups.sort(key=lambda x: -x["score"])

    # 去重：同一对内容只保留一次（同一 (id,id) 组合），并限制单个内容出现次数
    seen: set[tuple[str, str]] = set()
    per_item: Counter[str] = Counter()
    pairs: list[dict] = []
    for item in scored:
        key = tuple(sorted((item["left"]["id"], item["right"]["id"])))
        if key in seen:
            continue
        if per_item[item["left"]["id"]] >= 2 or per_item[item["right"]["id"]] >= 2:
            continue
        seen.add(key)
        per_item[item["left"]["id"]] += 1
        per_item[item["right"]["id"]] += 1
        pairs.append(item)
        if len(pairs) >= top_n:
            break

    seen_dup: set[tuple[str, str]] = set()
    uniq_dups: list[dict] = []
    for item in dups:
        key = tuple(sorted((item["left"]["id"], item["right"]["id"])))
        if key in seen_dup:
            continue
        seen_dup.add(key)
        uniq_dups.append(item)
        if len(uniq_dups) >= 15:
            break
    return pairs, uniq_dups


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(description="同一关键词在多个社媒平台之间的互比")
    ap.add_argument("--src", required=True, help="关键词目录（其下每个子目录是一个平台的采集结果）")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--keyword", default="", help="关键词（仅用于报告标题）")
    ap.add_argument("--top", type=int, default=30, help="最多输出多少组跨平台配对（默认 30）")
    ap.add_argument("--min-score", type=float, default=0.12, help="配对最低分（默认 0.12）")
    ap.add_argument("--max-items", type=int, default=200, help="每个平台最多参与比对的条数（按互动量截取，默认 200）")
    ap.add_argument("--skill-compare", default="", help=f"cross-compare 的 compare.py 路径（默认 {DEFAULT_SKILL_COMPARE}）")
    ap.add_argument("--config", default="", help="cross-compare 的 config.json（默认用技能目录下那份）")
    args = ap.parse_args()

    skill = load_skill_module(Path(args.skill_compare).expanduser() if args.skill_compare else DEFAULT_SKILL_COMPARE)
    cfg = skill.load_config(args.config)
    if cfg:
        skill.apply_config(cfg)
    scoring = skill.SCORING
    thresholds = skill.THRESHOLDS

    src = Path(args.src).expanduser()
    out = Path(args.out).expanduser()

    platforms: list[dict] = []
    skipped: list[dict[str, Any]] = []
    for pdir in platform_dirs(src):
        loaded = load_platform(pdir, skill)
        if loaded is None:
            manifest = read_manifest(pdir)
            skipped.append({
                "dir": pdir.name,
                "name": str(manifest.get("platform_name") or PLATFORM_LABELS.get(pdir.name, pdir.name)),
                "exit_code": manifest.get("exit_code"),
                "reason": "没有可解析的社媒内容（未登录 / 无结果 / 被风控）",
            })
            continue
        if args.max_items and loaded["count"] > args.max_items:
            loaded["items"] = sorted(loaded["items"], key=lambda x: -int(x.get("likes") or 0))[:args.max_items]
            loaded["truncated"] = True
        platforms.append(loaded)

    if not platforms:
        print(json.dumps({"ok": False, "platforms": 0, "skipped": skipped,
                          "hint": "该关键词一个平台都没采到内容，无法互比"}, ensure_ascii=False))
        return 3

    total_items = sum(p["count"] for p in platforms)

    # 主题 × 平台矩阵
    topic_matrix: dict[str, dict[str, int]] = {}
    for p in platforms:
        for topic, count in p["topics"].items():
            topic_matrix.setdefault(topic, {})[p["name"]] = count
    consensus = []
    exclusive: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for topic, by_platform in topic_matrix.items():
        entry = {"topic": topic, "platforms": by_platform, "total": sum(by_platform.values()),
                 "platform_count": len(by_platform)}
        if len(by_platform) >= 2:
            consensus.append(entry)
        else:
            exclusive[next(iter(by_platform))].append(entry)
    consensus.sort(key=lambda x: (-x["platform_count"], -x["total"]))
    for name in exclusive:
        exclusive[name].sort(key=lambda x: -x["total"])

    pairs, dups = build_cross_pairs(platforms, skill, scoring, thresholds, int(args.top), float(args.min_score))

    profiles = []
    for p in platforms:
        top_items = sorted(p["items"], key=lambda x: -int(x.get("likes") or 0))[:5]
        profiles.append({
            "platform": p["name"],
            "code": p["code"],
            "dir": p["dir"],
            "items": p["count"],
            "comments": p["comments"],
            "likes_sum": p["likes_sum"],
            "likes_avg": p["likes_avg"],
            "likes_max": p["likes_max"],
            "time_min": fmt_time(p["time_min"]),
            "time_max": fmt_time(p["time_max"]),
            "crawl_exit_code": p["crawl_exit_code"],
            "truncated": bool(p.get("truncated")),
            "top_topics": [{"topic": t, "count": c} for t, c in p["topics"].most_common(12)],
            "top_items": [{
                "title": item["title"][:100] or item["id"],
                "author": item["author"], "likes": item["likes"],
                "comments_count": item["comments_count"], "url": item["url"],
                "time": (item["time"] or "")[:19],
                "excerpt": snip(item["text"], 200),
            } for item in top_items],
        })

    result = {
        "ok": True,
        "keyword": args.keyword,
        "generated_at": datetime.now(tz=CST).isoformat(timespec="seconds"),
        "min_score": float(args.min_score),
        "platform_count": len(platforms),
        "item_count": total_items,
        "platforms": profiles,
        "skipped_platforms": skipped,
        "topic_matrix": [{"topic": t, "by_platform": m, "platform_count": len(m), "total": sum(m.values())}
                         for t, m in sorted(topic_matrix.items(), key=lambda kv: -len(kv[1]))[:60]],
        "consensus_topics": consensus[:30],
        "platform_only_topics": {name: items[:20] for name, items in exclusive.items()},
        "cross_pairs": pairs,
        "duplicates": dups,
        "notes": [
            "相似度只代表话题接近，不代表观点一致；结论需读原文判断。",
            "只出现在一个平台的主题，可能是该平台的内容偏好，也可能是信息差。",
        ],
    }

    out.mkdir(parents=True, exist_ok=True)
    (out / "platform-compare.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    names = [p["name"] for p in platforms]
    lines = [f"# 跨平台互比材料：{args.keyword or '（未指定关键词）'}", "",
             f"- 平台：**{'、'.join(names)}**（{len(platforms)} 个）｜ 内容：**{total_items}** 篇 ｜ 跨平台配对：**{len(pairs)}** 组",
             f"- 生成时间：{datetime.now(tz=CST).strftime('%Y-%m-%d %H:%M:%S')}"]
    if skipped:
        lines.append(f"- 本次跳过：{'、'.join(s['name'] for s in skipped)}（{skipped[0]['reason']}）")
    lines += ["", "## 1. 各平台画像", "",
              "| 平台 | 内容 | 评论 | 总赞 | 平均赞 | 最早 | 最新 |", "|---|---|---|---|---|---|---|"]
    for p in profiles:
        lines.append(f"| {p['platform']} | {p['items']}{'（截取）' if p['truncated'] else ''} | {p['comments']} | "
                     f"{p['likes_sum']} | {p['likes_avg']} | {p['time_min']} | {p['time_max']} |")

    lines += ["", "## 2. 主题 × 平台 矩阵", "",
              "| 主题 | " + " | ".join(names) + " | 出现平台数 |", "|---" * (len(names) + 2) + "|"]
    for item in result["topic_matrix"][:25]:
        cells = " | ".join(str(item["by_platform"].get(n, 0)) for n in names)
        lines.append(f"| {item['topic']} | {cells} | {item['platform_count']} |")

    lines += ["", "## 3. 跨平台共识主题（≥2 个平台都在讨论）", ""]
    if consensus:
        for item in consensus[:20]:
            detail = "、".join(f"{k} {v}" for k, v in item["platforms"].items())
            lines.append(f"- **{item['topic']}**（共 {item['total']} 次）：{detail}")
    else:
        lines.append("（本关键词下各平台没有共同的领域主题，说明讨论方向差异较大）")

    lines += ["", "## 4. 平台独有主题（信息差线索）", ""]
    if any(exclusive.values()):
        for name, items in exclusive.items():
            text = ", ".join(f"{i['topic']}({i['total']})" for i in items[:12])
            lines.append(f"- **仅 {name}**：{text or '（无）'}")
    else:
        lines.append("（无单边主题）")

    lines += ["", "## 5. 跨平台高相关材料（不同平台在讲同一件事）", ""]
    if not pairs:
        lines.append("（没有达到阈值的跨平台配对；可把 --min-score 调低到 0.08 再试）")
    for index, item in enumerate(pairs, 1):
        left, right = item["left"], item["right"]
        lines.append(f"### 配对 {index}（相似度 {item['score']}）")
        lines.append(f"- **{left['platform']}** [{left['title'] or left['id']}]({left['url']}) ｜ {left['author']} ｜ 赞 {left['likes']}")
        lines.append(f"  - {left['excerpt']}")
        lines.append(f"- **{right['platform']}** [{right['title'] or right['id']}]({right['url']}) ｜ {right['author']} ｜ 赞 {right['likes']}")
        lines.append(f"  - {right['excerpt']}")
        lines.append(f"  - 共同词：{', '.join(item['shared_terms'][:12])} ｜ 共同主题：{', '.join(item['shared_topics']) or '—'}")
        lines.append("")

    lines += ["## 6. 疑似同源 / 搬运（同链接或高度重合）", ""]
    if dups:
        for item in dups[:10]:
            lines.append(f"- {item['left']['platform']} [{item['left']['title'] or item['left']['id']}]({item['left']['url']}) "
                         f"↔ {item['right']['platform']} [{item['right']['title'] or item['right']['id']}]({item['right']['url']})"
                         f"（相似度 {item['score']}）")
    else:
        lines.append("（未发现明显的同源内容）")

    lines += ["", "## 7. 各平台互动量最高的内容", ""]
    for p in profiles:
        lines.append(f"### {p['platform']}")
        for item in p["top_items"]:
            lines.append(f"- [{item['title'] or '（无标题）'}]({item['url']}) ｜ {item['author']} ｜ 赞 {item['likes']}"
                         f" ｜ 评论 {item['comments_count']} ｜ {item['time']}")
            if item["excerpt"]:
                lines.append(f"  - {item['excerpt']}")
        lines.append("")

    lines += ["## 8. 说明与局限", "",
              "- 本材料由本地规则生成（分词 + 主题词表 + 相似度打分），**只做话题归并与配对，不下结论**。",
              "- 相似度只代表话题接近，不代表观点一致；赞数只做权重参考，不代表可信度。",
              "- 「只出现在一个平台」不等于另一个平台没有这类内容，可能只是本次采集条数有限。",
              f"- 采集条数上限、平台登录态都会影响覆盖面；本次实际参与比对的平台：{'、'.join(names)}。", ""]

    (out / "platform-compare.md").write_text("\n".join(lines), encoding="utf-8")

    print(json.dumps({
        "ok": True, "platforms": len(platforms), "items": total_items,
        "consensus_topics": len(consensus), "pairs": len(pairs), "duplicates": len(dups),
        "skipped": [s["name"] for s in skipped],
        "platform_compare_json": str(out / "platform-compare.json"),
        "platform_compare_md": str(out / "platform-compare.md"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
