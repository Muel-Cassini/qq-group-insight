#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从群聊汇总里挑出「值得拿去社媒检索」的关键词，供用户挑选后做社交平台搜索验证。

只用本地库（jieba + 标准库），不联网、不调用大模型。
输入：qq-group-summary 的输出目录（读 normalized.jsonl）
输出：keywords.json（含词、次数、样例上下文）与 keywords.txt（每行一个，便于直接复制）
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

STOPWORDS = set("""
的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 他 她 它 们
这个 那个 什么 怎么 为什么 因为 所以 但是 而且 可以 需要 今天 明天 昨天 大家 一下 已经 还是 就是 如果
这样 那样 我们 你们 他们 现在 时候 谢谢 感谢 好的 收到 哈哈 呵呵 嗯 啊 吧 吗 呢 呀 哦 哈 感觉 应该 可能
知道 觉得 真的 东西 事情 问题 情况 时间 地方 一个 两个 三个 什么 哪些 请问 有人 有没有 大佬 老哥 兄弟
图片 文件 转发 消息 回复 表情 微信 群里 群友 老师 同学 学姐 学长 学弟 学妹 今天 明天 后天 上午 下午
不是 这么 还有 就是 也是 都是 一样 一起 一直 不要 不能 不会 没什么 没事 有点 有些 很多 多少 多少
然后 反正 其实 应该 真的 直接 已经 而且 或者 虽然 不过 至少 大概 可能 肯定 必须 建议 注意 记得
什么 怎 咋 哎 唉 诶 额 呃 嗯嗯 哈哈 笑死 wc 卧槽 牛逼 牛 6 666 ok ok的 好的 行 中 收到 明白
这个 这些 那些 那样 这里 那里 怎么 啥 嘛 啦 咯 嘞 咯 嘿 嗨 噢 咦
羡慕 好像 确实 怎么办 是不是 的话 可以 没有 这么 那么 但是 现在 觉得 感觉 真的 一直 有点 应该
baby 宝宝 同学 舍友 室友 宿舍 大学 高中 初中 小学 成绩 考试 课程 作业 论文 老师 学校 学院
加油 恭喜 可怜 哈哈 笑死 无语 开心 难受 难受 累 困 饿 吃 睡 玩 打 看 说话 什么 那个 这个
https http http 来自 什么 哪里 什么时候 怎么回事 咋办 咋了 咋回事 咋样 咋整
""".split())

CONVERSATIONAL_HINTS = [
    "羡慕", "好像", "确实", "怎么办", "是不是", "的话", "加油", "恭喜", "可怜", "无语", "开心", "难受",
    "宿舍", "舍友", "室友", "宝宝", "吃饭", "睡觉", "打游戏", "出去玩", "表情", "哈哈", "笑死",
]

# 从昵称里拆出来的词也要过滤（群里昵称经常被误当成主题词）
def name_tokens(names: Iterable[str]) -> set[str]:
    out: set[str] = set()
    for name in names:
        for word in EN_RE.findall(name or ""):
            if len(word) >= 2:
                out.add(word.lower())
        for run in CJK_RE.findall(name or ""):
            out.add(run)
            for size in (2, 3):
                for index in range(len(run) - size + 1):
                    out.add(run[index:index + size])
    return out


# 与求职/校园场景相关的"领域词"，命中则提高权重（可按群调整）
DOMAIN_HINTS = [
    "offer", "hc", "内推", "投递", "简历", "面试", "笔试", "一面", "二面", "终面", "群面", "行测",
    "秋招", "春招", "校招", "社招", "实习", "转正", "宣讲", "宣讲会", "双选", "签约", "违约", "三方",
    "保研", "考研", "考公", "留学", "分流", "绩点", "学科评估", "导师", "课题组", "实验室",
    "薪资", "涨薪", "年包", "期权", "加班", "996", "大小周", "双休", "远程", "外包", "大厂", "中厂", "小厂",
    "算法", "后端", "前端", "客户端", "测试", "运维", "数据", "安全", "嵌入式", "硬件", "产品", "运营",
    "agent", "llm", "大模型", "微调", "推理", "训练", "量化", "rag", "prompt", "workflow", "评测",
    "docker", "k8s", "python", "java", "go", "rust", "c++", "linux", "git", "vscode", "cursor",
]

CJK_RE = re.compile(r"[\u4e00-\u9fff]+")
EN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+#._-]{1,}")
NUM_RE = re.compile(r"\d{2,}")


def tokens(text: str) -> list[str]:
    """中文用 jieba 分词（保留 2 字以上词），英文/数字按词。"""
    out: list[str] = []
    for word in EN_RE.findall(text):
        word = word.strip("._-")
        if len(word) >= 2 and word.lower() not in STOPWORDS:
            out.append(word.lower())
    for run in CJK_RE.findall(text):
        try:
            import jieba
            pieces = jieba.lcut(run)
        except ImportError:
            pieces = [run[i:i + 2] for i in range(len(run) - 1)] or [run]
        for piece in pieces:
            piece = piece.strip()
            if len(piece) >= 2 and piece not in STOPWORDS:
                out.append(piece)
    out.extend(NUM_RE.findall(text))
    return out


def load_messages(summary_dir: Path) -> list[dict[str, Any]]:
    file = summary_dir / "normalized.jsonl"
    if not file.is_file():
        raise SystemExit(f"[ERR] 找不到 {file}；请先在该目录生成群聊汇总")
    rows = []
    for line in file.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def build_keywords(rows: Iterable[dict[str, Any]], top: int, min_count: int, per_keyword: int
                   ) -> list[dict[str, Any]]:
    rows = list(rows)
    blocked = name_tokens([(row.get("sender_name") or "") for row in rows])
    df: Counter[str] = Counter()          # 出现该词的消息数
    tf: Counter[str] = Counter()          # 总出现次数
    samples: dict[str, list[dict[str, Any]]] = defaultdict(list)
    level_of: dict[str, Counter[str]] = defaultdict(Counter)
    total = 0
    for row in rows:
        content = row.get("content") or ""
        if row.get("is_system"):
            continue
        total += 1
        local = {word for word in tokens(content) if word not in blocked}
        for word in local:
            df[word] += 1
            if len(samples[word]) < per_keyword:
                samples[word].append({
                    "time": row.get("time", ""), "day": row.get("day", ""),
                    "sender": row.get("sender_name") or row.get("sender_id") or "",
                    "level": row.get("level", ""), "text": content[:180],
                })
            if row.get("level"):
                level_of[word][row["level"]] += 1
        for word in tokens(content):
            if word not in blocked:
                tf[word] += 1

    scored: list[dict[str, Any]] = []
    for word, count in df.items():
        if count < min_count:
            continue
        # TF-IDF 风格打分 + 领域词加权 + 长度偏好
        idf = math.log((1 + total) / (1 + count)) + 1
        score = count * idf
        is_domain = any(hint in word.lower() for hint in DOMAIN_HINTS)
        is_chat = any(hint in word.lower() for hint in CONVERSATIONAL_HINTS)
        if is_domain:
            score *= 2.0
        if is_chat:
            score *= 0.35
        if len(word) >= 3:
            score *= 1.15
        if re.fullmatch(r"\d+", word):
            score *= 0.4
        if re.fullmatch(r"[a-z]{1,3}", word) and not is_domain:
            score *= 0.5   # 短英文词（go/ai 之类）单独出现时容易是噪声
        scored.append({
            "keyword": word,
            "domain": is_domain,
            "messages": count,
            "occurrences": tf.get(word, count),
            "score": round(score, 2),
            "levels": dict(level_of[word]),
            "samples": samples[word],
        })
    scored.sort(key=lambda item: (-item["score"], -item["messages"]))
    return scored


def main() -> int:
    parser = argparse.ArgumentParser(description="从群聊汇总提取候选检索关键词")
    parser.add_argument("--summary", required=True, help="qq-group-summary 的输出目录")
    parser.add_argument("--out", required=True, help="输出目录")
    parser.add_argument("--top", type=int, default=60, help="最多输出多少个候选词")
    parser.add_argument("--min-count", type=int, default=3, help="至少出现在多少条消息里")
    parser.add_argument("--per-keyword", type=int, default=3, help="每个词附带几条样例")
    parser.add_argument("--exclude", default="", help="要排除的词，逗号分隔")
    parser.add_argument("--only-domain", action="store_true", help="只保留与求职/技术相关的领域词")
    args = parser.parse_args()

    rows = load_messages(Path(args.summary).expanduser())
    keywords = build_keywords(rows, max(args.top * 3, 120), args.min_count, args.per_keyword)
    if args.only_domain:
        keywords = [item for item in keywords if item["domain"]]
    if args.exclude.strip():
        drop = {item.strip().lower() for item in args.exclude.split(",") if item.strip()}
        keywords = [item for item in keywords if item["keyword"].lower() not in drop]
    keywords = keywords[:args.top]

    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    (out / "keywords.json").write_text(json.dumps({
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "summaryDir": str(args.summary), "messages": len(rows), "keywords": keywords,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "keywords.txt").write_text(
        "\n".join(f"{item['keyword']}\t{item['messages']}条" for item in keywords) + "\n", encoding="utf-8")

    print(json.dumps({"messages": len(rows), "keywords": len(keywords), "out": str(out),
                      "top": [item["keyword"] for item in keywords[:15]]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
