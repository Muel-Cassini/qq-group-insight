#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""交叉比对：群聊汇总 × 社媒采集结果。

纯本地文本比对，不联网。输出「比对材料」而不是结论，
结论（真正的总结）由 Agent 读取材料后撰写。

输入：
  --qq     qq_group_digest.py 产出的目录（读 normalized.jsonl）
  --social MediaCrawler 输出目录（读 _manifest.json + 各 jsonl）
输出（写入 --out）：
  compare.json   结构化比对材料（主题重合、配对、时效性）
  compare.md     人类可读的比对报告草稿
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Iterable

CST = timezone(timedelta(hours=8))

STOPWORDS = set("""
的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好
自己 这 那 他 她 它 们 这个 那个 什么 怎么 为什么 因为 所以 但是 而且 可以 需要
今天 明天 昨天 大家 一下 已经 还是 就是 如果 这样 那样 我们 你们 他们 现在 时候
谢谢 感谢 好的 收到 哈哈 呵呵 emmm ok ok的 嗯 啊 吧 吗 呢 呀 哦 哈
""".split())

# 领域词表：命中即视为“可对比主题”，用于主题级交集
TOPIC_VOCAB = [
    "小红书", "知乎", "b站", "bilibili", "抖音", "快手", "微博", "贴吧", "公众号", "视频号",
    "docker", "k8s", "kubernetes", "linux", "windows", "macos", "nginx", "redis", "mysql",
    "postgres", "sqlite", "mongodb", "es", "elasticsearch", "kafka", "rabbitmq", "grpc",
    "python", "java", "javascript", "typescript", "node", "nodejs", "go", "golang", "rust",
    "c++", "c#", "php", "kotlin", "swift", "sql", "html", "css", "react", "vue", "next",
    "fastapi", "django", "flask", "spring", "pytorch", "tensorflow", "transformers", "llm",
    "大模型", "模型", "微调", "训练", "推理", "量化", "rag", "agent", "mcp", "prompt",
    "openai", "claude", "deepseek", "qwen", "gemini", "gpt", "ollama", "vllm",
    "爬虫", "采集", "反爬", "风控", "封号", "cookie", "登录", "账号", "代理", "指纹",
    "浏览器", "playwright", "selenium", "chrome", "cdp", "无头",
    "报错", "异常", "崩溃", "内存", "oom", "性能", "优化", "并发", "缓存", "数据库",
    "部署", "容器", "服务器", "云服务", "阿里云", "腾讯云", "aws", "vercel", "docker compose",
    "面试", "实习", "招聘", "内推", "简历", "秋招", "春招", "考研", "考公", "留学",
    "副业", "变现", "流量", "选题", "涨粉", "爆款", "运营", "带货", "私域",
    "开源", "github", "gitee", "star", "issue", "pr", "license", "许可",
]

URL_RE = re.compile(r"https?://[^\s，。；、）)】\]]+")
CJK = re.compile(r"[\u4e00-\u9fff]")
WORD = re.compile(r"[a-zA-Z][a-zA-Z0-9_\-\.+#]{1,}")
NUM = re.compile(r"\d{2,}")
WORD_TOK = re.compile(r"[A-Za-z][A-Za-z0-9_\-\.+#]*")

# ---------------------------------------------------------------- config

CONFIG_FILENAME = "config.json"
CONFIG_PATH = Path(__file__).resolve().parents[1] / CONFIG_FILENAME

# 打分与阈值（可被 config.json 覆盖）
SCORING: dict[str, float] = {
    "weight_overlap": 0.45,
    "weight_jaccard": 0.20,
    "weight_per_topic": 0.05,
    "topic_cap": 4.0,
    "bonus_shared_topic": 0.10,
    "bonus_shared_url": 0.05,
}
THRESHOLDS: dict[str, float] = {
    "min_shared_terms": 3.0,
    "max_qq_per_social": 2.0,
    "freshness_days": 30.0,
}
EXCERPT_CHARS: dict[str, int] = {
    "qq": 300,
    "social": 300,
    "comment": 120,
    "title": 120,
}


def load_config(explicit: str = "") -> dict[str, Any]:
    """读取可调规则配置。

    优先级：命令行 --config > 技能目录下的 config.json > 内置默认值。
    文件缺失或字段非法时只警告并回退默认值，绝不因此中断比对。
    """
    path: Path | None = None
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            print(f"[WARN] --config 指定的文件不存在：{path}（回退内置默认值）", file=sys.stderr)
            path = None
    elif CONFIG_PATH.is_file():
        path = CONFIG_PATH
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[WARN] 配置文件读取失败：{path} → {exc}（回退内置默认值）", file=sys.stderr)
        return {}
    if not isinstance(data, dict):
        print(f"[WARN] 配置文件顶层必须是对象：{path}（回退内置默认值）", file=sys.stderr)
        return {}
    return data


def apply_config(cfg: dict[str, Any]) -> None:
    """把配置合并进模块级常量（仅覆盖出现且类型正确的字段）。"""
    global TOPIC_VOCAB, STOPWORDS, DEFAULTS, ASCII_CASE_SENSITIVE_MAX_LEN, ASCII_MIN_LEN, LOWERCASE_SHORT_TERMS

    def warn(msg: str) -> None:
        print(f"[WARN] config.json {msg}", file=sys.stderr)

    for key, lo, hi in (("ascii_case_sensitive_max_len", 0, 32), ("ascii_min_len", 1, 32)):
        if key in cfg:
            val = cfg[key]
            if isinstance(val, int) and not isinstance(val, bool) and lo <= val <= hi:
                if key == "ascii_case_sensitive_max_len":
                    ASCII_CASE_SENSITIVE_MAX_LEN = val
                else:
                    ASCII_MIN_LEN = val
            else:
                warn(f"{key} 必须是 {lo}~{hi} 的整数（已忽略）")

    def str_list(key: str, current: list[str]) -> list[str]:
        val = cfg.get(key)
        if val is None:
            return current
        if isinstance(val, list) and all(isinstance(v, str) for v in val):
            return val
        warn(f"{key} 必须是字符串数组（已忽略）")
        return current

    TOPIC_VOCAB = str_list("topic_vocab", TOPIC_VOCAB)
    LOWERCASE_SHORT_TERMS = str_list("lowercase_short_terms", LOWERCASE_SHORT_TERMS)
    _ASCII_TOPIC_RE.clear()
    _CJK_AFTER_RE.clear()
    if isinstance(cfg.get("stopwords_extra"), list):
        extra = [s for s in cfg["stopwords_extra"] if isinstance(s, str)]
        STOPWORDS = set(STOPWORDS) | set(extra)
    elif cfg.get("stopwords_extra") is not None:
        warn("stopwords_extra 必须是字符串数组（已忽略）")

    for block, current in (("scoring", SCORING), ("thresholds", THRESHOLDS), ("excerpt_chars", EXCERPT_CHARS)):
        val = cfg.get(block)
        if val is None:
            continue
        if not isinstance(val, dict):
            warn(f"{block} 必须是对象（已忽略）")
            continue
        for key, item in val.items():
            if not isinstance(item, (int, float)) or isinstance(item, bool):
                warn(f"{block}.{key} 必须是数字（已忽略）")
                continue
            current[key] = item
        if block == "thresholds":
            current["min_shared_terms"] = int(current["min_shared_terms"])
            current["max_qq_per_social"] = int(current["max_qq_per_social"])
        else:
            for key in list(current):
                current[key] = int(current[key]) if key.endswith("_chars") else current[key]

    val = cfg.get("defaults")
    if val is not None:
        if not isinstance(val, dict):
            warn("defaults 必须是对象（已忽略）")
        else:
            for key in ("top", "min_score", "max_qq"):
                if key in val and isinstance(val[key], (int, float)) and not isinstance(val[key], bool):
                    DEFAULTS[key] = val[key]
                elif key in val:
                    warn(f"defaults.{key} 必须是数字（已忽略）")


# 命令行未显式给出时的默认值（可被 config.json 的 defaults 覆盖）
DEFAULTS: dict[str, float] = {"top": 40, "min_score": 0.18, "max_qq": 0}

# 英文/数字主题词的匹配策略：
# - 短词（长度 ≤ ascii_case_sensitive_max_len）要求**原样大小写**且默认只认大写缩写（Go/ES/AI），
#   以避开昵称与英文短语里的偶然小写（实测：群名片 “27智能 go&Agent” 会把 go 误命中 33 次）。
# - 长词用大小写不敏感 + 词边界（Docker/docker、K8S/k8s 都能命中）。
ASCII_CASE_SENSITIVE_MAX_LEN = 3
ASCII_MIN_LEN = 2
# 允许小写命中的短词白名单（放进 config.json 即可让某个短词两种写法都算）
LOWERCASE_SHORT_TERMS: list[str] = []
_ASCII_TOPIC_RE: dict[tuple[str, bool], re.Pattern[str]] = {}


def _tokenize_ascii(text: str) -> tuple[set[str], set[str]]:
    """返回 (原始大小写词集合, 小写词集合)，用于区分 Go/go 这类同形不同义词。"""
    return set(WORD_TOK.findall(text or "")), set(WORD_TOK.findall((text or "").lower()))


# 短 ASCII 词后面紧跟中文时才算“词”（“go语言” 命中，“go&Agent” 不命中）。
# 因为短词极易出现在昵称/英文短语里造成误判，这是实测（群名片 “27智能 go&Agent” 命中 Go）后的收紧。
_CJK_AFTER_RE: dict[str, re.Pattern[str]] = {}
_CJK_AFTER_WINDOW = 5


def _short_term_hit(term: str, text: str, cased: set[str], lowered: set[str]) -> bool:
    """短 ASCII 主题词：默认只认大写缩写（Go/ES/AI）或紧邻中文的写法（go语言）。

    term 是词表里的原始写法；小写写法默认不算命中，
    否则昵称/英文短语里的偶然小写会把短词刷成高频主题（实测教训）。
    """
    upper_form = term.upper()
    if term.isupper() or term in LOWERCASE_SHORT_TERMS:
        if upper_form in cased or term in cased:
            return True
    elif upper_form in cased:
        return True
    pat = _CJK_AFTER_RE.get(term)
    if pat is None:
        pat = re.compile(re.escape(term) + r"[\u4e00-\u9fff]{1," + str(_CJK_AFTER_WINDOW) + r"}", re.IGNORECASE)
        _CJK_AFTER_RE[term] = pat
    return pat.search(text or "") is not None


def _ascii_topic_hit(term: str, text: str, low: str, cased: set[str], lowered: set[str]) -> bool:
    if len(term) < ASCII_MIN_LEN:
        return False
    if len(term) <= ASCII_CASE_SENSITIVE_MAX_LEN:
        return _short_term_hit(term, text, cased, lowered)
    key = (term, True)
    pat = _ASCII_TOPIC_RE.get(key)
    if pat is None:
        pat = re.compile(r"(?<![a-z0-9_])" + re.escape(term.lower()) + r"(?![a-z0-9_])")
        _ASCII_TOPIC_RE[key] = pat
    return pat.search(low) is not None


# ---------------------------------------------------------------- 文本处理

def tokens(text: str) -> set[str]:
    """中英文混合分词：英文/数字按词，中文按二元字组。"""
    text = (text or "").lower()
    out: set[str] = set()
    for w in WORD.findall(text):
        w = w.strip(".")
        if len(w) >= 2 and w not in STOPWORDS:
            out.add(w)
    for n in NUM.findall(text):
        out.add(n)
    cjk_runs = re.findall(r"[\u4e00-\u9fff]+", text)
    for run in cjk_runs:
        if len(run) == 1:
            if run not in STOPWORDS:
                out.add(run)
            continue
        for i in range(len(run) - 1):
            bg = run[i:i + 2]
            if bg not in STOPWORDS:
                out.add(bg)
        if len(run) >= 3:
            for i in range(len(run) - 2):
                out.add(run[i:i + 3])
    return out


def topics(text: str) -> set[str]:
    low = (text or "").lower()
    cased, lowered = _tokenize_ascii(text)
    hit: set[str] = set()
    for t in TOPIC_VOCAB:
        key = t.lower()
        if key.isascii():
            if " " in key or "-" in key:
                if key in low:
                    hit.add(key)
            elif _ascii_topic_hit(t, text or "", low, cased, lowered):
                # 保留词表里的原始写法作为主题标识（短词大小写敏感，Go ≠ go）
                hit.add(t)
        elif key in low:
            hit.add(t)
    for u in URL_RE.findall(text or ""):
        m = re.search(r"https?://([^/]+)", u)
        if m:
            host = m.group(1).lower().replace("www.", "")
            hit.add("url:" + host)
    return hit


def parse_ts(value: str) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "")
    # 纯数字：epoch 秒（10 位）/ 毫秒（13 位）。MediaCrawler 各平台时间字段类型不一
    # （知乎 created_time 就是 epoch 秒），不处理的话时效性会整段变成「不足判断」。
    if text.isdigit():
        num = float(text)
        if num > 1e11:
            num /= 1000.0
        try:
            return datetime.fromtimestamp(num, tz=CST)
        except (OverflowError, OSError, ValueError):
            return None
    try:
        dt = datetime.fromisoformat(text)
        return dt if dt.tzinfo else dt.replace(tzinfo=CST)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text[:19], fmt).replace(tzinfo=CST)
        except ValueError:
            continue
    return None


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def overlap(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


# ---------------------------------------------------------------- 载入

def load_qq(path: Path) -> list[dict[str, Any]]:
    f = path / "normalized.jsonl" if path.is_dir() else path
    if not f.is_file():
        return []
    out = []
    for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        rec["_ts"] = parse_ts(rec.get("time", ""))
        rec["_tok"] = tokens(rec.get("content", ""))
        rec["_topics"] = topics(rec.get("content", ""))
        out.append(rec)
    return out


CONTENT_KEYS = ["title", "desc", "content", "note_id", "aweme_id", "video_id", "id", "url", "note_url",
                "liked_count", "comment_count", "collected_count", "create_time", "time", "nickname",
                "user_nickname", "author", "question_id", "answer_id", "voteup_count"]


def pick_alias(rec: dict[str, Any], names: Iterable[str]) -> Any:
    lowered = {str(k).lower(): v for k, v in rec.items()}
    for n in names:
        if n in lowered and lowered[n] not in (None, "", [], {}):
            return lowered[n]
    return None


def social_text(rec: dict[str, Any]) -> str:
    parts = []
    for k in ("title", "desc", "content", "question_title", "answer_text", "text", "name"):
        v = pick_alias(rec, [k])
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())
    return " ".join(parts)


def load_social(path: Path) -> list[dict[str, Any]]:
    """读 MediaCrawler 的 jsonl：contents 作为内容，comments 挂到对应内容上。"""
    files: list[Path] = []
    if path.is_file():
        files = [path]
    elif path.is_dir():
        files = sorted(path.rglob("*.jsonl")) + sorted(path.rglob("*.json"))
    contents: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    comments_by_parent: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for f in files:
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip().rstrip(",")
            if not line or line in ("[", "]"):
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict):
                continue
            is_comment = "comment" in f.name.lower()
            text = social_text(rec)
            if not text:
                continue
            if is_comment:
                parent = str(pick_alias(rec, ["note_id", "aweme_id", "video_id", "content_id", "question_id"]) or "")
                if parent:
                    comments_by_parent[parent].append({
                        "text": text,
                        "nickname": pick_alias(rec, ["nickname", "user_nickname"]) or "",
                        "like": pick_alias(rec, ["like_count", "liked_count", "voteup_count"]) or 0,
                    })
                continue
            # content_id 必须在内：知乎的内容与评论都用 content_id 关联，
            # 漏掉它会让评论永远挂不到内容上（实测 153 条知乎评论 → 0 条挂载）。
            cid = str(pick_alias(rec, ["note_id", "aweme_id", "video_id", "content_id", "id",
                                       "question_id", "answer_id"]) or f"{f.name}:{len(order)}")
            if cid in contents:
                continue
            contents[cid] = {
                "id": cid,
                "platform_file": f.name,
                "title": pick_alias(rec, ["title", "question_title", "name"]) or "",
                "text": text,
                # video_url 必须在内：B站内容用它存链接（漏掉会让 B站 配对没有可点链接）。
                # 排在最后，xhs 的 note_url 优先，不受影响。
                "url": pick_alias(rec, ["note_url", "url", "aweme_url", "content_url", "video_url"]) or "",
                "author": pick_alias(rec, ["nickname", "user_nickname", "author"]) or "",
                "likes": int(pick_alias(rec, ["liked_count", "like_count", "voteup_count"]) or 0) if str(
                    pick_alias(rec, ["liked_count", "like_count", "voteup_count"]) or 0).isdigit() else 0,
                "comments_count": int(pick_alias(rec, ["comment_count", "comments_count"]) or 0) if str(
                    pick_alias(rec, ["comment_count", "comments_count"]) or 0).isdigit() else 0,
                "time": str(pick_alias(rec, ["time", "create_time", "created_time", "publish_time"]) or ""),
                "raw_file": str(f),
            }
            order.append(cid)

    for cid, item in contents.items():
        item["comments"] = comments_by_parent.get(cid, [])[:10]
        item["_tok"] = tokens(item["text"] + " " + " ".join(c["text"] for c in item["comments"]))
        item["_topics"] = topics(item["text"] + " " + " ".join(c["text"] for c in item["comments"]))
    return [contents[c] for c in order]


# ---------------------------------------------------------------- 比对

def dedupe_terms(terms: Iterable[str], limit: int = 18) -> list[str]:
    """去掉互相包含的碎词（二元组被三元组覆盖），保留信息量更大的词。"""
    ordered = sorted(set(terms), key=lambda t: (-len(t), t))
    kept: list[str] = []
    for t in ordered:
        if any(t != k and t in k for k in kept):
            continue
        kept.append(t)
        if len(kept) >= limit:
            break
    return kept


def build_pairs(qq: list[dict[str, Any]], soc: list[dict[str, Any]], top_n: int, min_score: float):
    min_shared = int(THRESHOLDS["min_shared_terms"])
    per_social_cap = int(THRESHOLDS["max_qq_per_social"])
    scored = []
    for s in soc:
        for q in qq:
            shared = q["_tok"] & s["_tok"]
            if len(shared) < min_shared:
                continue
            topic_shared = (q["_topics"] & s["_topics"]) - {t for t in q["_topics"] & s["_topics"] if t.startswith("url:")}
            score = SCORING["weight_overlap"] * overlap(q["_tok"], s["_tok"]) \
                + SCORING["weight_jaccard"] * jaccard(q["_tok"], s["_tok"])
            score += SCORING["weight_per_topic"] * min(len(topic_shared), SCORING["topic_cap"])
            if topic_shared:
                score += SCORING["bonus_shared_topic"]
            if shared & set(URL_RE.findall(q.get("content", ""))):
                score += SCORING["bonus_shared_url"]
            if score < min_score:
                continue
            scored.append({
                "score": round(score, 3),
                "shared_terms": dedupe_terms(shared, 14),
                "shared_topics": sorted(topic_shared),
                "qq": {
                    "time": q.get("time", ""), "day": q.get("day", ""),
                    "sender": q.get("sender_name") or q.get("sender_id"),
                    "chat": q.get("chat_name") or q.get("chat_id"),
                    "excerpt": (q.get("content") or "")[:EXCERPT_CHARS["qq"]],
                },
                "social": {
                    "id": s["id"], "title": s["title"][:EXCERPT_CHARS["title"]], "author": s["author"],
                    "likes": s["likes"], "comments_count": s["comments_count"],
                    "time": s["time"], "url": s["url"], "excerpt": s["text"][:EXCERPT_CHARS["social"]],
                    "top_comments": [c["text"][:EXCERPT_CHARS["comment"]] for c in s.get("comments", [])[:3]],
                },
            })
    scored.sort(key=lambda x: -x["score"])
    # 去重：每篇社媒内容只保留最高分的 N 条群聊
    per_social: Counter[str] = Counter()
    out = []
    for item in scored:
        key = item["social"]["id"]
        if per_social[key] >= per_social_cap:
            continue
        per_social[key] += 1
        out.append(item)
        if len(out) >= top_n:
            break
    return out


def classify_freshness(qq_time: datetime | None, social_time: datetime | None) -> str:
    if not qq_time or not social_time:
        return "unknown"
    delta = (social_time - qq_time).days
    window = int(THRESHOLDS["freshness_days"])
    if delta > window:
        return f"social_newer_{delta}d"
    if delta < -window:
        return f"social_older_{abs(delta)}d"
    return f"close_{delta}d"


def main() -> int:
    ap = argparse.ArgumentParser(description="群聊汇总 × 社媒采集 交叉比对")
    ap.add_argument("--qq", required=True, help="qq_group_digest.py 的输出目录")
    ap.add_argument("--social", required=True, help="MediaCrawler 输出目录")
    ap.add_argument("--out", required=True, help="比对结果输出目录")
    ap.add_argument("--top", type=int, default=None, help="最多输出多少组配对（默认取 config 的 defaults.top，内置 40）")
    ap.add_argument("--min-score", type=float, default=None, help="配对最低分（默认取 config 的 defaults.min_score，内置 0.18）")
    ap.add_argument("--max-qq", type=int, default=None, help="只取最近 N 条群聊消息（默认取 config 的 defaults.max_qq，内置 0=全部）")
    ap.add_argument("--config", default="",
                    help=f"规则配置路径（默认用技能目录下的 {CONFIG_FILENAME}；不存在则用内置默认值）")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if cfg:
        apply_config(cfg)
        print(json.dumps({"config": str(args.config or CONFIG_PATH), "keys": sorted(cfg.keys())}, ensure_ascii=False))
    top_n = int(args.top if args.top is not None else DEFAULTS["top"])
    min_score = float(args.min_score if args.min_score is not None else DEFAULTS["min_score"])
    max_qq = int(args.max_qq if args.max_qq is not None else DEFAULTS["max_qq"])

    qq_all = load_qq(Path(args.qq).expanduser())
    soc_all = load_social(Path(args.social).expanduser())
    if max_qq and len(qq_all) > max_qq:
        qq_all = qq_all[-max_qq:]

    if not qq_all or not soc_all:
        print(json.dumps({"ok": False, "qq_messages": len(qq_all), "social_items": len(soc_all),
                          "hint": "缺少群聊消息或社媒内容；请先各自完成汇总与采集"}, ensure_ascii=False))
        return 3

    pairs = build_pairs(qq_all, soc_all, top_n, min_score)

    qq_topics: Counter[str] = Counter()
    for q in qq_all:
        qq_topics.update(q["_topics"])
    soc_topics: Counter[str] = Counter()
    for s in soc_all:
        soc_topics.update(s["_topics"])
    shared_topics = sorted(
        set(qq_topics) & set(soc_topics),
        key=lambda t: -(qq_topics[t] + soc_topics[t]),
    )

    qq_by_topic: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for q in qq_all:
        for t in q["_topics"]:
            qq_by_topic[t].append(q)
    soc_by_topic: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for s in soc_all:
        for t in s["_topics"]:
            soc_by_topic[t].append(s)

    topic_detail = []
    for t in shared_topics[:30]:
        qmsgs = sorted(qq_by_topic[t], key=lambda m: m["_ts"] or datetime.min.replace(tzinfo=CST))[-3:]
        sposts = sorted(soc_by_topic[t], key=lambda s: -s["likes"])[:3]
        topic_detail.append({
            "topic": t,
            "qq_count": len(qq_by_topic[t]),
            "social_count": len(soc_by_topic[t]),
            "qq_examples": [
                {"time": m.get("time", ""), "sender": m.get("sender_name") or m.get("sender_id"),
                 "excerpt": (m.get("content") or "")[:200]} for m in qmsgs
            ],
            "social_examples": [
                {"title": s["title"][:100], "author": s["author"], "likes": s["likes"],
                 "url": s["url"], "excerpt": s["text"][:200]} for s in sposts
            ],
        })

    freshness = Counter()
    for s in soc_all:
        st = parse_ts(s["time"])
        nearest = None
        for p in pairs:
            if p["social"]["id"] == s["id"]:
                qt = parse_ts(p["qq"]["time"])
                if qt and (nearest is None or abs((qt - (st or qt)).days) < abs((nearest - (st or nearest)).days)):
                    nearest = qt
        freshness[classify_freshness(nearest, st)] += 1

    result = {
        "ok": True,
        "qq_messages": len(qq_all),
        "social_items": len(soc_all),
        "pairs": pairs,
        "shared_topics": [{"topic": t, "qq": qq_topics[t], "social": soc_topics[t]} for t in shared_topics[:40]],
        "topic_detail": topic_detail,
        "freshness": dict(freshness),
        "social_only_topics": [{"topic": t, "social": soc_topics[t]} for t, _ in soc_topics.most_common(50)
                               if t not in qq_topics][:20],
        "qq_only_topics": [{"topic": t, "qq": qq_topics[t]} for t, _ in qq_topics.most_common(50)
                           if t not in soc_topics][:20],
    }

    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    (out / "compare.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# 群聊 × 社媒 交叉比对材料", "",
             f"- 群聊消息：**{len(qq_all)}** 条 ｜ 社媒内容：**{len(soc_all)}** 篇 ｜ 配对：**{len(pairs)}** 组", "",
             "## 1. 共同主题（两边都在讨论）", "",
             "| 主题 | 群聊提及 | 社媒篇数 |", "|---|---|---|"]
    for item in result["shared_topics"][:25]:
        lines.append(f"| {item['topic']} | {item['qq']} | {item['social']} |")
    lines += ["", "## 2. 高相关配对（可作为交叉证据）", ""]
    for i, p in enumerate(pairs[:top_n], 1):
        s = p["social"]
        qtime = (p["qq"]["time"] or "")[:16].replace("T", " ")
        lines.append(f"### 配对 {i}（相似度 {p['score']}）")
        lines.append(f"- **群聊** `{qtime}` **{p['qq']['sender']}**（{p['qq']['chat']}）：{p['qq']['excerpt']}")
        lines.append(f"- **社媒** [{s['title'] or s['id']}]({s['url']}) ｜ 作者 {s['author']} ｜ 赞 {s['likes']} ｜ 评论 {s['comments_count']}")
        lines.append(f"  - 摘要：{s['excerpt']}")
        if s["top_comments"]:
            lines.append(f"  - 高相关评论：{' / '.join(s['top_comments'])}")
        lines.append(f"  - 共同词：{', '.join(p['shared_terms'][:12])} ｜ 共同主题：{', '.join(p['shared_topics']) or '—'}")
        lines.append("")
    lines += ["## 3. 主题明细", ""]
    for d in topic_detail[:20]:
        lines.append(f"### {d['topic']}（群聊 {d['qq_count']} 条 / 社媒 {d['social_count']} 篇）")
        for m in d["qq_examples"]:
            lines.append(f"- QQ `{(m['time'] or '')[:16].replace('T', ' ')}` **{m['sender']}**：{m['excerpt']}")
        for s in d["social_examples"]:
            lines.append(f"- 社媒 [{s['title']}]({s['url']})（{s['author']}，赞 {s['likes']}）：{s['excerpt']}")
        lines.append("")
    lines += ["## 4. 只出现在一边的主题", "",
              f"- 仅社媒：{', '.join(x['topic'] for x in result['social_only_topics'][:15]) or '（无）'}",
              f"- 仅群聊：{', '.join(x['topic'] for x in result['qq_only_topics'][:15]) or '（无）'}", "",
              "## 5. 时效性", "",
              "- " + (", ".join(f"{k}: {v}" for k, v in result["freshness"].items()) or "（不足判断）"), ""]
    (out / "compare.md").write_text("\n".join(lines), encoding="utf-8")

    print(json.dumps({"ok": True, "pairs": len(pairs), "shared_topics": len(shared_topics),
                      "compare_json": str(out / "compare.json"), "compare_md": str(out / "compare.md")},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
