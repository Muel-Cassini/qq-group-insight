#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把聊天记录导出（QQ Chat Exporter 等）解析成结构化数据 + 按天分类汇总。

只读输入、只在 --out 下写文件；纯标准库，不联网、不执行外部命令。
输出：
  <out>/normalized.jsonl     归一化消息（每行一条，UTF-8）
  <out>/digest/YYYY-MM-DD.md 按天汇总（主题分类 + 重要度 + 时间倒序）
  <out>/p1-todo.md           跨天 P1（待办/@我）清单
  <out>/media-index.md       文件/图片/视频清单（含来源消息与发送人）
  <out>/_report.md           解析统计与告警（例如未识别的字段）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Iterable

CST = timezone(timedelta(hours=8))

# ---------------------------------------------------------------- key mapping

# 每类字段的候选键（小写比较，支持中英混排的导出格式）
KEY_CANDIDATES: dict[str, list[str]] = {
    "id": ["msgid", "msg_id", "id", "messageid", "message_id", "seq", "msgsvrid"],
    "time": [
        "time", "timestamp", "ts", "sendtime", "send_time", "msgtime", "msg_time",
        "datetime", "date", "createtime", "create_time", "时间", "发送时间",
    ],
    "sender_id": ["senderuin", "sender_uin", "senderid", "sender_id", "uin", "userid", "user_id", "qq", "from"],
    "sender_name": [
        "sendername", "sender_name", "sendernick", "sender_nick", "nickname", "nick",
        "name", "card", "membername", "member_name", "sender", "fromname", "from_name", "发送人",
    ],
    "content": [
        "content", "text", "message", "msg", "plaintext", "plain_text", "elements_text",
        "raw_message", "body", "内容", "消息",
    ],
    "type": ["type", "msgtype", "msg_type", "elementtype", "element_type", "messagetype", "message_type", "chattype"],
    "chat_id": ["chatid", "chat_id", "groupid", "group_id", "peeruid", "peer_uin", "conversationid", "conversation_id", "sessionid", "session_id"],
    "chat_name": ["chatname", "chat_name", "groupname", "group_name", "peer_name", "peerName", "conversationtitle", "conversation_title", "title", "群名"],
    "reply_to": ["replyto", "reply_to", "quoteid", "quote_id", "replymsgid", "reply_msg_id"],
    "forwarded": ["forward", "forwarded", "isforward", "is_forward", "forwardflag"],
    "elements": ["elements", "element", "segments", "messages", "msgs", "parts", "body"],
}

# 时间字段里可能出现的毫秒/秒/字符串
TS_MS_THRESHOLD = 10_000_000_000  # >= 1e10 视为毫秒

# ---------------------------------------------------------------- config

CONFIG_FILENAME = "config.json"
CONFIG_PATH = Path(__file__).resolve().parents[1] / CONFIG_FILENAME


def load_config(explicit: str = "") -> dict[str, Any]:
    """读取可调规则配置。

    优先级：命令行 --config > 技能目录下的 config.json > 内置默认值。
    文件缺失或字段非法时只警告并回退默认值，绝不因此中断解析。
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
    """把配置合并进模块级规则常量（仅覆盖出现且类型正确的字段）。"""
    global CATEGORY_RULES, P0_TIME_PATTERNS, P0_ACTION_PATTERNS, P1_PATTERNS, P1_EXCLUDE
    global P2_HINT, MEDIA_EXT, DISPLAY_LIMITS

    def warn(msg: str) -> None:
        print(f"[WARN] config.json {msg}", file=sys.stderr)

    cats = cfg.get("categories")
    if cats is not None and not isinstance(cats, list):
        warn("categories 必须是数组（已忽略）")
    if isinstance(cats, list):
        parsed: list[tuple[str, list[str]]] = []
        for item in cats:
            if isinstance(item, dict) and isinstance(item.get("name"), str) and isinstance(item.get("keywords"), list):
                parsed.append((item["name"], [str(k) for k in item["keywords"]]))
            else:
                warn("categories 条目需为 {name, keywords}")
        if parsed:
            CATEGORY_RULES = parsed

    def take(key: str, current: list[str]) -> list[str]:
        val = cfg.get(key)
        if val is None:
            return current
        if isinstance(val, list) and all(isinstance(v, str) for v in val):
            return val
        warn(f"{key} 必须是字符串数组（已忽略）")
        return current

    P0_TIME_PATTERNS = take("p0_time_patterns", P0_TIME_PATTERNS)
    P0_ACTION_PATTERNS = take("p0_action_patterns", P0_ACTION_PATTERNS)
    P1_PATTERNS = take("p1_patterns", P1_PATTERNS)
    P1_EXCLUDE = take("p1_exclude_patterns", P1_EXCLUDE)

    if isinstance(cfg.get("p2_category_hint"), str):
        P2_HINT = cfg["p2_category_hint"]

    media_ext = cfg.get("media_ext")
    if isinstance(media_ext, dict):
        merged = {k: set(v) for k, v in MEDIA_EXT.items()}
        for kind, exts in media_ext.items():
            if isinstance(exts, list):
                merged[kind] = {str(e).lower() if str(e).startswith(".") else "." + str(e).lower() for e in exts}
            else:
                warn(f"media_ext.{kind} 必须是字符串数组（已忽略）")
        MEDIA_EXT = merged

    limits = cfg.get("display_limits")
    if isinstance(limits, dict):
        for key in ("preview_chars", "focus_preview_chars", "pending_question_preview_chars",
                    "media_summary_chars", "reason_chars"):
            val = limits.get(key)
            if isinstance(val, int) and val > 0:
                DISPLAY_LIMITS[key] = val
            elif val is not None:
                warn(f"display_limits.{key} 必须是正整数（已忽略）")


# 展示用长度上限（可被 config.json 覆盖）
DISPLAY_LIMITS: dict[str, int] = {
    "preview_chars": 400,
    "focus_preview_chars": 300,
    "pending_question_preview_chars": 200,
    "media_summary_chars": 60,
    "reason_chars": 200,
}

# ---------------------------------------------------------------- classification

# 主题分类规则：命中即计分，取最高分；无命中归为「闲聊」
CATEGORY_RULES: list[tuple[str, list[str]]] = [
    ("公告通知", [
        "公告", "通知", "周知", "调整", "更新说明", "维护", "停服", "直播预告",
        "报名", "截止", "开始时间", "会议", "日程", "发布", "规则变更",
    ]),
    ("提问求助", [
        "请问", "问一下", "求助", "有没有人", "怎么", "为什么", "报错", "error",
        "异常", "故障", "不会", "求教", "大佬", "帮忙看", "如何", "什么原因", "求解",
    ]),
    ("资源分享", [
        "http://", "https://", "github.com", "网盘", "链接", "下载", "分享", "pdf",
        "文档", "资料", "教程", "源码", "仓库", "附件", "提取码", "arxiv", "论文",
    ]),
    ("技术讨论", [
        "docker", "k8s", "python", "java", "rust", "linux", "windows", "api", "sdk",
        "编译", "部署", "性能", "架构", "数据库", "sql", "nginx", "redis", "gpu",
        "模型", "训练", "推理", "agent", "prompt", "bug", "修复", "版本", "代码",
    ]),
    ("广告灌水", [
        "加群", "进群", "扫码", "推广", "优惠券", "代刷", "接单", "返现", "薅羊毛",
        "点击链接", "助力", "拼多多", "砍一刀", "广告", "推广位", "私聊我", "代购",
    ]),
]

# 重要度规则（P0 最高）
# P0 需要「时间/紧迫标记 + 行动词」共现，否则群里玩梗（“马上学硕倒闭了”“🐟神务必教我”）
# 会把 P0 刷满。单独命中时间标记或行动词只降级为 P2。
P0_TIME_PATTERNS = [
    r"@全体成员", r"@all", r"全体成员", r"重要通知", r"紧急",
    r"今日截止", r"今天截止", r"明天截止", r"截止(时间|日期)?[:：]?\s*\d",
    r"\d{1,2}\s*月\s*\d{1,2}\s*日?\s*(前|截止)", r"今(日|天)(内|之前)", r"尽快", r"务必",
]
P0_ACTION_PATTERNS = [
    r"投递", r"报名", r"截止", r"提交", r"确认", r"面试", r"笔试", r"宣讲会", r"截止时间",
    r"领取", r"填写", r"参加", r"开通", r"缴纳",
]
# P1 = 待办 / 指名求助 / 真正的提问句（不再用裸 "？" 判定，避免群里"@某人 ？"式闲聊刷屏）
P1_PATTERNS = [
    r"@我(?![0-9A-Za-z\u4e00-\u9fff])",
    r"待办", r"记得", r"麻烦", r"帮忙", r"帮我", r"求(助|教|带|内推)", r"回复我",
    r"确认一下", r"审批", r"报名",
    r"(请问|问一下|有没有人|谁知道|谁有|求解|求问)[^。！？]{2,}",
    r"(什么(原因|情况|问题)|怎么(办|样|弄|做|回事)|为什么|如何|哪里|哪个)[^。！？]{2,}[?？]?",
    r"^[^。！？]{4,}[?？]$",
]
# 纯情绪/寒暄，不算提问
P1_EXCLUDE = [
    r"^[?？]+$", r"^[哈呵嘿嘻]{2,}$", r"^(牛逼|牛|好|好的|收到|谢谢|感谢|笑死|草|6|666|确实|真的假的)[!！。~～]*$",
]
P2_HINT = "资源分享|技术讨论|公告通知"

MEDIA_TYPE_HINTS = {
    "image": ("image", "img", "pic", "picture", "photo", "图片", "photo"),
    "video": ("video", "mp4", "视频"),
    "file": ("file", "doc", "document", "attach", "附件", "文件", "zip", "rar"),
    "audio": ("audio", "voice", "record", "语音"),
    "forward": ("forward", "merge", "转发", "聊天记录"),
    "reply": ("reply", "quote", "引用", "回复"),
    "system": ("system", "notice", "tip", "revoke", "recall", "撤回", "系统"),
}

MEDIA_EXT = {
    "image": {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"},
    "video": {".mp4", ".mov", ".mkv", ".avi", ".webm"},
    "audio": {".amr", ".mp3", ".wav", ".m4a", ".ogg", ".silk"},
    "file": {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md",
             ".zip", ".rar", ".7z", ".csv", ".json", ".py", ".js", ".ts", ".apk", ".exe"},
}


@dataclass
class Msg:
    chat_id: str = ""
    chat_name: str = ""
    msg_id: str = ""
    ts: datetime | None = None
    sender_id: str = ""
    sender_name: str = ""
    content: str = ""
    raw_type: str = ""
    media: list[dict[str, Any]] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    recalled: bool = False
    is_system: bool = False
    reply_to: str = ""
    forwarded: bool = False
    source_file: str = ""

    @property
    def kind(self) -> str:
        """归一化消息类型：text / image / video / file / audio / forward / reply / system。"""
        t = self.raw_type.lower()
        for kind, hints in MEDIA_TYPE_HINTS.items():
            if any(h in t for h in hints) and kind != "reply":
                return kind
        if self.media:
            return self.media[0]["kind"]
        if self.reply_to:
            return "reply"
        return "text"

    @property
    def day(self) -> str:
        return self.ts.strftime("%Y-%m-%d") if self.ts else "unknown-date"


def norm_key(k: str) -> str:
    return re.sub(r"[\s_\-]+", "", str(k)).lower()


ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff"), None)


def clean_text(value: str) -> str:
    """去掉零宽字符与首尾空白（QQ 群名片/备注里常带 \\u200b）。"""
    return (value or "").translate(ZERO_WIDTH).strip()


def sender_fields(value: Any) -> tuple[str, str]:
    """从 QCE 的 sender 对象里取 (群名片/显示名, uid 或 uin)。

    QCE v6 形如 {"uid":..,"uin":..,"name":..,"nickname":..,"groupCard":..,"remark":..}。
    展示名优先级：groupCard(群名片) > name > remark > nickname > uin。
    """
    if isinstance(value, dict):
        idx = build_index(value)
        for key in ("groupcard", "name", "remark", "nickname", "card", "membername", "sendername"):
            val = idx.get(key)
            if isinstance(val, str) and clean_text(val):
                for id_key in ("uid", "uin", "userid", "id"):
                    ident = idx.get(id_key)
                    if ident not in (None, "", 0):
                        return clean_text(val), str(ident)
                return clean_text(val), ""
        return "", ""
    if isinstance(value, str):
        return clean_text(value), ""
    return "", ""


def sender_name_of(idx: dict[str, Any]) -> tuple[str, str]:
    """从消息记录里解析发送人显示名与 ID。"""
    for key in ("sender", "from", "member", "user", "author"):
        if key in idx:
            name, ident = sender_fields(idx[key])
            if name or ident:
                return name, ident
    name = str(pick(idx, "sender_name") or "")
    ident = str(pick(idx, "sender_id") or "")
    return name, ident


def build_index(record: dict[str, Any]) -> dict[str, Any]:
    idx: dict[str, Any] = {}
    for k, v in record.items():
        if isinstance(k, str):
            idx.setdefault(norm_key(k), v)
    return idx


def pick(idx: dict[str, Any], kind: str) -> Any:
    for cand in KEY_CANDIDATES[kind]:
        key = norm_key(cand)
        if key in idx and idx[key] not in (None, "", [], {}):
            return idx[key]
    return None


def parse_time(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip().isdigit()):
        num = float(value)
        if num > TS_MS_THRESHOLD:
            num /= 1000.0
        try:
            return datetime.fromtimestamp(num, tz=CST)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip().replace("T", " ").replace("Z", "")
    text = re.sub(r"\.\d+$", "", text)
    for fmt in (
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M",
        "%Y-%m-%d", "%Y/%m/%d", "%Y年%m月%d日 %H:%M:%S", "%Y年%m月%d日 %H:%M", "%Y年%m月%d日",
    ):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=CST)
        except ValueError:
            continue
    m = re.search(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})", text)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=CST)
        except ValueError:
            return None
    return None


def flatten_text(value: Any, depth: int = 0) -> str:
    """把各种元素结构拍平成可读文本（图片/文件等记成占位标记）。"""
    if depth > 6 or value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        parts = [flatten_text(v, depth + 1) for v in value]
        return " ".join(p for p in parts if p).strip()
    if isinstance(value, dict):
        idx = build_index(value)
        # 常见元素形态：{"type":"text","text":"..."} / {"type":"image","file":"..."}
        etype = str(idx.get("type", "") or idx.get("elementtype", "") or "").lower()
        for k in ("text", "content", "plaintext", "value", "title", "name", "filename"):
            if isinstance(idx.get(k), str) and idx[k].strip():
                if any(h in etype for h in ("image", "pic", "图片")):
                    return f"[图片 {idx[k].strip()}]"
                if any(h in etype for h in ("file", "附件", "doc")):
                    return f"[文件 {idx[k].strip()}]"
                return idx[k].strip()
        for k in ("file", "path", "url", "filepath"):
            if isinstance(idx.get(k), str) and idx[k].strip():
                return f"[媒体 {idx[k].strip()}]"
        return ""
    return ""


DISPLAY_ONLY_KEYS = ("name", "filename", "title")

# 资源条目里可能存放“可解析路径”的键（QCE v6: url / localPath 都是导出目录内的相对路径）
RESOURCE_PATH_KEYS = ("localpath", "url", "path", "filepath", "file", "src")


def relpath_hint(idx: dict[str, Any]) -> str:
    """从记录中取一个可用于解析的路径提示（优先 localPath，其次 url）。"""
    for key in RESOURCE_PATH_KEYS:
        val = idx.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def extract_media(
    idx: dict[str, Any],
    record: dict[str, Any],
    base_dir: Path | None,
    check: bool,
) -> list[dict[str, Any]]:
    """从记录中找出图片/视频/文件引用。

    check=False 时不做文件系统探测（导入导出目录）：
    此时只记录导出里的引用，exists 保持 None 表示“未校验”。
    真实路径优先取 file/path/url；只有 name/filename 这类展示名且没有可校验路径时，标记为 unverified。
    """
    found: list[dict[str, Any]] = []
    seen: set[str] = set()

    def consider(kind: str, ref: str, verified_path: bool, sub_type: str = "") -> None:
        ref = str(ref).strip().strip('"')
        if not ref or ref in seen:
            return
        seen.add(ref)
        if not check:
            found.append({"kind": kind, "ref": ref, "abspath": "", "exists": None,
                          "size": 0, "verified": False, "sub_type": sub_type})
            return
        path = Path(ref)
        if not path.is_absolute() and base_dir is not None:
            path = base_dir / ref
        try:
            exists = path.is_file()
        except OSError:
            exists = False
        found.append({
            "kind": kind, "ref": ref,
            "abspath": str(path) if exists else "",
            "exists": exists, "size": path.stat().st_size if exists else 0,
            "verified": bool(exists and verified_path), "sub_type": sub_type,
        })

    def walk(node: Any, depth: int = 0) -> None:
        if depth > 8 or node is None:
            return
        if isinstance(node, list):
            for item in node:
                walk(item, depth + 1)
            return
        if not isinstance(node, dict):
            return
        sub = build_index(node)
        # QCE 把真正的字段放在 element["data"] 里：需要把内层键合并进来，再优先用内层 type
        inner = sub.get("data")
        if isinstance(inner, dict):
            merged = dict(build_index(inner))
            if isinstance(merged.get("type"), str):
                sub.update(merged)
            else:
                merged.update({k: v for k, v in sub.items() if k not in merged})
                sub = merged
        etype = str(sub.get("type", "") or sub.get("elementtype", "") or "").lower()
        sub_type = str(sub.get("subtype", "") or sub.get("sub_type", "") or "").lower()
        # 1) 真实路径键（file/path/url/localPath/src）
        for key in ("file", "path", "filepath", "localpath", "url", "src"):
            val = sub.get(key)
            if isinstance(val, str) and val.strip():
                ext = Path(val.split("?")[0]).suffix.lower()
                kind = ""
                for k, exts in MEDIA_EXT.items():
                    if ext in exts:
                        kind = k
                        break
                if not kind:
                    if any(h in etype for h in ("image", "pic", "图片")):
                        kind = "image"
                    elif any(h in etype for h in ("video", "视频")):
                        kind = "video"
                    elif any(h in etype for h in ("audio", "voice", "语音")):
                        kind = "audio"
                    elif any(h in etype for h in ("file", "attach", "附件")):
                        kind = "file"
                if kind:
                    consider(kind, val, True, sub_type)
        # 2) 只有展示名、没有可校验路径的元素：登记为未校验，避免误报“文件缺失”
        if not any(isinstance(sub.get(k), str) and sub[k].strip()
                   for k in ("file", "path", "filepath", "localpath", "url", "src")):
            for key in DISPLAY_ONLY_KEYS:
                val = sub.get(key)
                if isinstance(val, str) and val.strip():
                    ext = Path(val).suffix.lower()
                    kind = ""
                    for k, exts in MEDIA_EXT.items():
                        if ext in exts:
                            kind = k
                            break
                    if not kind and any(h in etype for h in ("image", "pic", "图片")):
                        kind = "image"
                    if not kind and any(h in etype for h in ("file", "attach", "附件")):
                        kind = "file"
                    if kind:
                        consider(kind, val, False, sub_type)
                    break
        for key, val in node.items():
            if isinstance(val, (dict, list)):
                walk(val, depth + 1)

    for k in ("elements", "element", "segments", "messages", "msgs", "parts", "media",
              "attachments", "files", "resources"):
        walk(idx.get(norm_key(k)))
    # 正文里的 [图片:xxx.jpg] / [文件:xxx.pdf] 占位符：QCE 有时只在正文保留文件名
    text = flatten_text(pick(idx, "content"))
    for m in re.finditer(r"\[(图片|文件|视频|语音|表情)[:：]([^\]]+)\]", text or ""):
        kind_hint, name = m.group(1), m.group(2).strip()
        kind = {"图片": "image", "视频": "video", "语音": "audio", "文件": "file", "表情": "image"}.get(kind_hint, "file")
        # 用同一 md5 前缀在导出目录里找实际文件
        stem = name.rsplit(".", 1)[0]
        if base_dir is not None:
            hits = list(base_dir.glob(f"resources/*/{stem.lower()}*")) or \
                   list(base_dir.glob(f"resources/*/{stem}*"))
            if hits:
                try:
                    rel = str(hits[0].relative_to(base_dir))
                except ValueError:
                    rel = str(hits[0])
                consider(kind, rel, True)
                continue
        consider(kind, name, False)
    return found


# JSON 卡片（小红书/公众号分享等）里可提取出真实链接
CARD_LINK_KEYS = ("jumpurl", "jump_url", "url", "qqdocurl", "targeturl")


def extract_card_links(idx: dict[str, Any]) -> list[str]:
    """从 json 类型消息的卡片数据里挖出外链（例如 xhslink.com 的小红书分享）。"""
    links: list[str] = []

    def walk(node: Any, depth: int = 0) -> None:
        if depth > 10 or node is None or len(links) >= 5:
            return
        if isinstance(node, list):
            for item in node:
                walk(item, depth + 1)
            return
        if isinstance(node, str):
            for m in re.findall(r"https?://[^\s\"'\\<>）)]+", node):
                if m not in links:
                    links.append(m)
            # 卡片数据本身常常是嵌套 JSON 字符串
            s = node.strip()
            if len(s) > 20 and s.startswith("{") and s.endswith("}"):
                try:
                    walk(json.loads(s), depth + 1)
                except json.JSONDecodeError:
                    pass
            return
        if not isinstance(node, dict):
            return
        sub = build_index(node)
        for key in CARD_LINK_KEYS:
            val = sub.get(key)
            if isinstance(val, str) and val.strip().startswith("http") and val.strip() not in links:
                links.append(val.strip())
        for val in node.values():
            if isinstance(val, (dict, list, str)):
                walk(val, depth + 1)

    for k in ("elements", "element", "content"):
        walk(idx.get(norm_key(k)))
    return links


def normalize(record: dict[str, Any], source_file: str, base_dir: Path | None, media_check: bool) -> Msg | None:
    if not isinstance(record, dict):
        return None
    idx = build_index(record)

    # 会话/群信息（QCE 放在 chatInfo / conversation 里）
    chat_name = str(pick(idx, "chat_name") or "")
    chat_id = str(pick(idx, "chat_id") or "")
    for key in ("chatinfo", "conversation", "chat", "session", "group"):
        node = idx.get(key)
        if isinstance(node, dict):
            sub = build_index(node)
            chat_name = chat_name or str(sub.get("name") or sub.get("title") or "")
            chat_id = chat_id or str(sub.get("peeruid") or sub.get("id") or sub.get("groupcode") or "")
        elif isinstance(node, str) and not chat_name:
            chat_name = node

    # 有些导出把消息包在 {"message": {...}} 里
    for wrapper in ("message", "msg", "data", "item"):
        inner = idx.get(wrapper)
        if isinstance(inner, dict) and not pick(idx, "content"):
            child = normalize(inner, source_file, base_dir, media_check)
            if child is not None:
                child.chat_name = child.chat_name or chat_name
                child.chat_id = child.chat_id or chat_id
            return child

    content = flatten_text(pick(idx, "content"))
    if not content:
        for k in ("elements", "element", "segments", "parts", "messages"):
            content = flatten_text(idx.get(norm_key(k)))
            if content:
                break

    ts = parse_time(pick(idx, "time"))
    media = extract_media(idx, record, base_dir, media_check)
    links = extract_card_links(idx)
    recalled = bool(idx.get("recalled"))
    is_system = bool(idx.get("system")) or str(pick(idx, "type") or "").lower() == "system"

    if not content and not media and not links:
        return None

    # JSON/卡片类消息：把挖到的外链补进正文，便于识别“小红书分享”等跨平台线索
    if links:
        extra = " ".join(links)
        if extra not in content:
            content = (content + " " + extra).strip()

    forwarded_raw = pick(idx, "forwarded")
    forwarded = bool(forwarded_raw) if not isinstance(forwarded_raw, str) else forwarded_raw.lower() in ("1", "true", "yes", "y")

    reply_to = pick(idx, "reply_to")
    sender_name, sender_id = sender_name_of(idx)
    if not sender_id:
        sender_id = str(pick(idx, "sender_id") or "")
    return Msg(
        chat_id=chat_id,
        chat_name=chat_name,
        msg_id=str(pick(idx, "id") or ""),
        ts=ts,
        sender_id=sender_id,
        sender_name=sender_name,
        content=content,
        raw_type=str(pick(idx, "type") or ""),
        media=media,
        links=links,
        recalled=recalled,
        is_system=is_system,
        reply_to=str(reply_to or ""),
        forwarded=forwarded or str(pick(idx, "type") or "").lower() == "forward",
        source_file=source_file,
    )


# ---------------------------------------------------------------- loading

def file_defaults(text: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """从导出文件顶层取「会话信息」与「统计/选项」，作为每条消息的默认上下文。

    QCE 把 chatInfo / statistics / exportOptions 放在文件顶层，而消息在 messages 里。
    """
    try:
        data = json.loads(text.strip())
    except (json.JSONDecodeError, ValueError):
        return {}, {}
    if not isinstance(data, dict):
        return {}, {}
    chat: dict[str, Any] = {}
    for key in ("chatInfo", "chat", "conversation", "session"):
        node = data.get(key)
        if isinstance(node, dict):
            chat = node
            break
    meta = {k: data[k] for k in ("statistics", "exportOptions", "metadata") if k in data}
    return chat, meta


def iter_records(path: Path) -> Iterable[dict[str, Any]]:
    """把文件读成一条条记录：支持 JSONL、JSON 数组、以及 {key: [ ... ]} 包装。"""
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    stripped = text.strip()
    if not stripped:
        return
    if path.suffix.lower() in (".jsonl", ".ndjson") or (stripped[0] == "{" and "\n{" in stripped and not stripped.endswith("]")):
        for line in stripped.splitlines():
            line = line.strip().rstrip(",")
            if not line or line in ("[", "]"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                yield obj
        return
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        # 退化为逐行 JSON
        for line in stripped.splitlines():
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                yield obj
        return
    yield from walk_json(data)


def walk_json(node: Any, depth: int = 0) -> Iterable[dict[str, Any]]:
    """深度优先找出所有"像消息"的字典。"""
    if depth > 6 or node is None:
        return
    if isinstance(node, list):
        for item in node:
            yield from walk_json(item, depth + 1)
        return
    if not isinstance(node, dict):
        return
    idx = build_index(node)
    looks_like_msg = bool(
        (pick(idx, "content") is not None or idx.get("elements") is not None)
        and (pick(idx, "time") is not None or pick(idx, "sender_name") is not None or pick(idx, "sender_id") is not None)
    )
    if looks_like_msg:
        yield node
        return
    for key, val in node.items():
        if isinstance(val, (dict, list)):
            yield from walk_json(val, depth + 1)


SKIP_DIRS = {".git", "node_modules", "__pycache__", "assets", "images", "img", "video", "videos", "emoji", "cache"}


def discover_inputs(src: Path) -> list[Path]:
    if src.is_file():
        return [src]
    out: list[Path] = []
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d.lower() not in SKIP_DIRS and not d.startswith(".")]
        for name in files:
            low = name.lower()
            if name.startswith("."):
                continue
            if low.endswith((".jsonl", ".ndjson", ".json")) or (low.endswith(".txt") and "chat" in low):
                out.append(Path(root) / name)
    return sorted(out)


# ---------------------------------------------------------------- classify

def classify(msg: Msg) -> tuple[str, str, list[str]]:
    """返回 (类别, 重要度, 命中的理由)。"""
    text = msg.content or ""
    lowered = text.lower()
    reasons: list[str] = []

    # 系统提示（撤回/入群/群公告等）与撤回消息：单独归「系统消息」，不参与重要度竞争
    if msg.is_system or msg.recalled or "撤回了一条消息" in text:
        return ("系统消息", "P3", ["系统/撤回消息"])

    cat_scores: Counter[str] = Counter()
    for rule_cat, words in CATEGORY_RULES:
        for w in words:
            if w.lower() in lowered:
                cat_scores[rule_cat] += 1
    if msg.media:
        cat_scores["资源分享"] += 1

    # 重要度：P0 需要「时间/紧迫标记 + 行动词」共现
    level = "P3"
    excluded = any(re.search(p, text.strip()) for p in P1_EXCLUDE)
    hit_time = next((p for p in P0_TIME_PATTERNS if re.search(p, text)), "")
    hit_action = next((p for p in P0_ACTION_PATTERNS if re.search(p, text)), "")
    if hit_time and hit_action:
        level = "P0"
        cat_scores["公告通知"] += 2
        reasons.append(f"P0：时间标记 + 行动词共现（{hit_time} / {hit_action}）")
    elif hit_time:
        reasons.append(f"仅命中时间标记（{hit_time}），不判 P0")
    if level != "P0":
        for pat in P1_PATTERNS:
            if re.search(pat, text):
                if excluded and not re.search(r"(请问|求助|求解|求教|帮忙|帮我|确认一下)", text):
                    reasons.append("P1 候选因寒暄被排除")
                    break
                level = "P1"
                reasons.append(f"P1：{pat}")
                break

    category = "闲聊"
    # 规则顺序即优先级：公告 > 提问 > 资源 > 技术 > 广告 > 闲聊（避免“公告里被薅羊毛”误判）
    for rule_cat, _words in CATEGORY_RULES:
        if cat_scores.get(rule_cat):
            category = rule_cat
            reasons.append(f"类别命中：{rule_cat}（{cat_scores[rule_cat]} 分）")
            break

    if level == "P3":
        if re.search(P2_HINT, category) or (msg.kind in ("file", "image", "video") and category != "广告灌水"):
            level = "P2"
            reasons.append("P2：类别或含媒体")
        elif hit_time:
            level = "P2"
            reasons.append("P2：仅命中时间/紧迫标记，按信息类处理")
    if msg.forwarded and level == "P3":
        level = "P2"
        reasons.append("P2：转发合并记录")
    if category == "广告灌水" and level == "P2":
        level = "P3"
        reasons.append("降级：广告灌水")
    return category, level, reasons


# ---------------------------------------------------------------- render

def fmt_time(msg: Msg) -> str:
    return msg.ts.strftime("%H:%M:%S") if msg.ts else "??:??:??"


def render_overall(msgs: list[Msg]) -> str:
    """整体汇总：覆盖全部聊天记录（不按天切分）的总览报告。

    与每日 digest 的区别：面向"整个时间段"的统计、主题分布、发言排行、
    资源与链接清单、以及全部 P0/P1（不是单日）。
    """
    tagged = [(m, *classify(m)) for m in msgs]
    level_count: Counter[str] = Counter()
    cat_count: Counter[str] = Counter()
    day_count: Counter[str] = Counter()
    sender_count: Counter[str] = Counter()
    sender_ids: dict[str, str] = {}
    media_kinds: Counter[str] = Counter()
    by_cat: dict[str, list[tuple[Msg, str]]] = defaultdict(list)
    links: list[tuple[Msg, str]] = []
    cat_msgs: dict[str, list[tuple[Msg, str]]] = defaultdict(list)

    for m, cat, level, _reasons in tagged:
        level_count[level] += 1
        cat_count[cat] += 1
        day_count[m.day] += 1
        who = m.sender_name or m.sender_id or "未知"
        sender_count[who] += 1
        if who not in sender_ids and (m.sender_id or m.sender_name):
            sender_ids[who] = m.sender_id or ""
        for item in m.media:
            media_kinds[item["kind"]] += 1
        cat_msgs[cat].append((m, level))
        for link in m.links:
            links.append((m, link))

    ts_sorted = [m.ts for m in msgs if m.ts]
    span = ""
    if ts_sorted:
        span = f"{min(ts_sorted).strftime('%Y-%m-%d %H:%M')} ~ {max(ts_sorted).strftime('%Y-%m-%d %H:%M')}"

    lines = [f"# {msgs[0].chat_name or '群聊'} · 整体汇总", ""]
    lines.append(f"> 覆盖范围：**{span or '未知时间范围'}**（共 {len(day_count)} 天）")
    lines.append(f"> 消息总数 **{len(msgs)}** ｜ 发言人数 **{len(sender_count)}** ｜ 媒体条目 **{sum(media_kinds.values())}** ｜ 外部链接 **{len(links)}**")
    lines.append("")
    lines.append("## 一、重要度分布")
    lines.append("")
    lines.append("| 重要度 | 条数 | 占比 |")
    lines.append("|---|---|---|")
    for lv in ("P0", "P1", "P2", "P3"):
        n = level_count.get(lv, 0)
        pct = f"{n / len(msgs) * 100:.1f}%" if msgs else "0%"
        lines.append(f"| {lv} | {n} | {pct} |")
    lines.append("")
    lines.append("## 二、主题分类分布")
    lines.append("")
    order = ["公告通知", "提问求助", "资源分享", "技术讨论", "闲聊", "广告灌水", "系统消息"]
    cats = [c for c in order if c in cat_count] + [c for c in cat_count if c not in order]
    lines.append("| 主题 | 条数 | 占比 |")
    lines.append("|---|---|---|")
    for cat in cats:
        n = cat_count[cat]
        lines.append(f"| {cat} | {n} | {n / len(msgs) * 100:.1f}% |")
    lines.append("")
    lines.append("## 三、按天分布")
    lines.append("")
    lines.append("| 日期 | 条数 |")
    lines.append("|---|---|")
    for day in sorted(day_count):
        lines.append(f"| {day} | {day_count[day]} |")
    lines.append("")
    lines.append("## 四、全部 P0 / P1（需要关注）")
    lines.append("")
    focus = [(m, lv) for m, _c, lv, _r in tagged if lv in ("P0", "P1")]
    if focus:
        for m, lv in sorted(focus, key=lambda x: x[0].ts or datetime.min.replace(tzinfo=CST)):
            who = m.sender_name or m.sender_id or "未知"
            lines.append(f"- `{m.day} {fmt_time(m)}` **[{lv}]** **{who}**：{compact(m.content, DISPLAY_LIMITS['focus_preview_chars'])}")
    else:
        lines.append("- （无 P0/P1 消息）")
    lines.append("")
    lines.append("## 五、发言排行（前 20）")
    lines.append("")
    lines.append("| 排名 | 成员 | 条数 | 占比 |")
    lines.append("|---|---|---|---|")
    for index, (who, n) in enumerate(sender_count.most_common(20), 1):
        label = f"{who}（{sender_ids.get(who, '')}）" if sender_ids.get(who) else who
        lines.append(f"| {index} | {label} | {n} | {n / len(msgs) * 100:.1f}% |")
    lines.append("")
    lines.append("## 六、各主题要点（每类最多 40 条，时间正序）")
    lines.append("")
    for cat in cats:
        items = sorted(cat_msgs.get(cat, []), key=lambda x: x[0].ts or datetime.min.replace(tzinfo=CST))
        lines.append(f"### {cat}（{len(items)}）")
        if not items:
            lines.append("")
            continue
        for m, lv in items[:40]:
            who = m.sender_name or m.sender_id or "未知"
            suffix = ""
            if m.media:
                kinds = Counter(x["kind"] for x in m.media)
                suffix = "  " + " ".join(f"`[{k}×{v}]`" for k, v in kinds.items())
            lines.append(f"- `{m.day} {fmt_time(m)}` **[{lv}]** **{who}**：{compact(m.content, 200)}{suffix}")
        if len(items) > 40:
            lines.append(f"- …… 其余 {len(items) - 40} 条见 `digest/` 下对应日期")
        lines.append("")
    lines.append("## 七、资源与链接清单")
    lines.append("")
    if links:
        lines.append("| 时间 | 发送人 | 链接 |")
        lines.append("|---|---|---|")
        for m, link in sorted(links, key=lambda x: x[0].ts or datetime.min.replace(tzinfo=CST)):
            who = m.sender_name or m.sender_id or "未知"
            lines.append(f"| {m.day} {fmt_time(m)} | {who} | {link} |")
    else:
        lines.append("- （无外部链接）")
    lines.append("")
    lines.append("## 八、媒体统计")
    lines.append("")
    if media_kinds:
        for kind, n in media_kinds.most_common():
            lines.append(f"- {kind}：{n}")
        lines.append("")
        lines.append("> 明细见 `media-index.md`")
    else:
        lines.append("- （无媒体）")
    lines.append("")
    return "\n".join(lines)


def render_digest(day: str, msgs: list[Msg]) -> str:
    """按天渲染：先给 P0/P1 聚焦区，再按主题分类、类内时间倒序。"""
    tagged = [(m, *classify(m)) for m in msgs]  # (msg, category, level, reasons)

    by_cat: dict[str, list[tuple[Msg, str, list[str]]]] = defaultdict(list)
    level_count: Counter[str] = Counter()
    for m, cat, level, reasons in tagged:
        by_cat[cat].append((m, level, reasons))
        level_count[level] += 1

    order = ["公告通知", "提问求助", "资源分享", "技术讨论", "闲聊", "广告灌水", "系统消息"]
    cats = [c for c in order if c in by_cat] + [c for c in by_cat if c not in order]

    total_media = sum(len(m.media) for m in msgs)
    senders = {m.sender_name or m.sender_id or "未知" for m in msgs}
    link_msgs = [m for m in msgs if any("xhslink" in l or "xiaohongshu" in l or "zhihu" in l or "bilibili" in l
                                       or "b23.tv" in l for l in m.links)]

    lines = [f"# 群聊汇总 · {day}", ""]
    lines.append(f"- 消息数：**{len(msgs)}** ｜ 发言人数：**{len(senders)}** ｜ 媒体条目：**{total_media}**")
    lines.append("- 重要度分布：" + " ｜ ".join(f"{lv} {level_count.get(lv, 0)}" for lv in ("P0", "P1", "P2", "P3")))
    if link_msgs:
        lines.append(f"- 含社媒分享链接的消息：**{len(link_msgs)}** 条（与社媒比对时的直接线索）")
    lines.append("")
    lines.append("## 待办 / 需要你关注（P0-P1）")
    focus = [(m, lv) for m, _cat, lv, _rs in tagged if lv in ("P0", "P1")]
    if focus:
        for m, lv in sorted(focus, key=lambda x: (x[1], x[0].ts or datetime.min.replace(tzinfo=CST))):
            lines.append(f"- **[{lv}]** `{fmt_time(m)}` **{m.sender_name or m.sender_id or '未知'}**：{compact(m.content, DISPLAY_LIMITS['focus_preview_chars'])}")
    else:
        lines.append("- （本日无 P0/P1 消息）")
    lines.append("")
    # 待回应提问：P1 且含疑问特征，便于回头核查是否有人答过
    pending = [(m, lv) for m, _cat, lv, _rs in tagged
               if lv == "P1" and re.search(r"(请问|问一下|有没有人|谁知道|求解|求问|怎么|为什么|如何|哪里|哪个)|[?？]", m.content or "")]
    if pending:
        lines.append("## 待回应提问（可能还没人答）")
        for m, lv in sorted(pending, key=lambda x: x[0].ts or datetime.min.replace(tzinfo=CST)):
            lines.append(f"- `{fmt_time(m)}` **{m.sender_name or m.sender_id or '未知'}**：{compact(m.content, DISPLAY_LIMITS['pending_question_preview_chars'])}")
        lines.append("")

    for cat in cats:
        items = sorted(by_cat[cat], key=lambda x: x[0].ts or datetime.min.replace(tzinfo=CST), reverse=True)
        lines.append(f"## {cat}（{len(items)}）")
        for m, lv, _ in items:
            who = m.sender_name or m.sender_id or "未知"
            suffix = ""
            if m.media:
                kinds = Counter(x["kind"] for x in m.media)
                suffix = "  " + " ".join(f"`[{k}×{v}]`" for k, v in kinds.items())
            lines.append(f"- `{fmt_time(m)}` **[{lv}]** **{who}**：{compact(m.content)}{suffix}")
        lines.append("")
    return "\n".join(lines)


def compact(text: str, limit: int = 0) -> str:
    """截断长文本用于单行展示。limit=0 时取配置里的 preview_chars。"""
    limit = limit or DISPLAY_LIMITS["preview_chars"]
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[:limit] + ("…" if len(text) > limit else "")


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description="聊天记录解析与按天分类汇总（只读输入）")
    ap.add_argument("--src", required=True, help="聊天导出所在目录或单个文件")
    ap.add_argument("--out", required=True, help="输出目录（本工具只在此目录下写文件）")
    ap.add_argument("--media-root", default="", help="媒体文件根目录（用于解析导出中的相对路径）")
    ap.add_argument("--media-check", action="store_true",
                    help="在 --media-root 下真实探测媒体文件是否存在（默认不探测，避免误报缺失）")
    ap.add_argument("--from", dest="date_from", default="", help="起始日期 YYYY-MM-DD")
    ap.add_argument("--to", dest="date_to", default="", help="结束日期 YYYY-MM-DD")
    ap.add_argument("--chat", default="", help="只要包含该子串的会话（不区分大小写）")
    ap.add_argument("--config", default="",
                    help=f"规则配置文件路径（默认用技能目录下的 {CONFIG_FILENAME}；不存在则用内置默认值）")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if cfg:
        apply_config(cfg)
        print(json.dumps({"config": str(args.config or CONFIG_PATH), "keys": sorted(cfg.keys())}, ensure_ascii=False))

    src = Path(args.src).expanduser()
    if not src.exists():
        print(f"[ERR] 输入不存在：{src}", file=sys.stderr)
        return 2
    out = Path(args.out).expanduser()
    (out / "digest").mkdir(parents=True, exist_ok=True)
    media_root = Path(args.media_root).expanduser() if args.media_root else (src if src.is_dir() else src.parent)

    files = discover_inputs(src)
    if not files:
        print(f"[ERR] 在 {src} 下没找到 .jsonl/.json 导出文件", file=sys.stderr)
        return 2

    msgs: list[Msg] = []
    stats: dict[str, Any] = {"files": [], "skipped": 0, "no_time": 0, "unknown_sender": 0}

    for f in files:
        before = len(msgs)
        raw_text = f.read_text(encoding="utf-8-sig", errors="replace")
        chat_defaults, file_meta = file_defaults(raw_text)
        for rec in iter_records(f):
            msg = normalize(rec, str(f), media_root, args.media_check)
            if msg is None:
                stats["skipped"] += 1
                continue
            if not msg.chat_name and chat_defaults:
                msg.chat_name = str(chat_defaults.get("name") or chat_defaults.get("title") or "")
                msg.chat_id = msg.chat_id or str(chat_defaults.get("peerUid") or chat_defaults.get("groupId") or "")
            if not msg.ts:
                stats["no_time"] += 1
            if not (msg.sender_name or msg.sender_id):
                stats["unknown_sender"] += 1
            msgs.append(msg)
        stats["files"].append({"path": str(f), "parsed": len(msgs) - before,
                               "chat": chat_defaults.get("name", ""),
                               "statistics": file_meta.get("statistics", {})})

    if args.chat:
        needle = args.chat.lower()
        msgs = [m for m in msgs if needle in (m.chat_name or "").lower() or needle in (m.chat_id or "").lower()]
    if args.date_from:
        d0 = parse_time(args.date_from)
        msgs = [m for m in msgs if m.ts and d0 and m.ts >= d0]
    if args.date_to:
        d1 = parse_time(args.date_to)
        if d1:
            d1 = d1.replace(hour=23, minute=59, second=59)
            msgs = [m for m in msgs if m.ts and m.ts <= d1]

    msgs.sort(key=lambda m: (m.ts or datetime.min.replace(tzinfo=CST)))

    with (out / "normalized.jsonl").open("w", encoding="utf-8") as fh:
        for m in msgs:
            category, level, reasons = classify(m)
            fh.write(json.dumps({
                "chat_id": m.chat_id, "chat_name": m.chat_name, "msg_id": m.msg_id,
                "time": m.ts.isoformat() if m.ts else "", "day": m.day,
                "sender_id": m.sender_id, "sender_name": m.sender_name,
                "kind": m.kind, "raw_type": m.raw_type, "content": m.content,
                "media": m.media, "links": m.links,
                "recalled": m.recalled, "is_system": m.is_system,
                "reply_to": m.reply_to, "forwarded": m.forwarded,
                # 脚本判定结果一并落盘：供交叉比对参考，也供 AI 复判做「改了什么」的对照
                "category": category, "level": level, "classify_reason": reasons,
                "source_file": m.source_file,
            }, ensure_ascii=False) + "\n")

    by_day: dict[str, list[Msg]] = defaultdict(list)
    for m in msgs:
        by_day[m.day].append(m)
    for day, items in by_day.items():
        (out / "digest" / f"{day}.md").write_text(render_digest(day, items), encoding="utf-8")

    # 整体汇总：覆盖全部聊天记录的一份报告（与每日 digest 并存）
    (out / "overall.md").write_text(render_overall(msgs), encoding="utf-8")

    # 跨天 P1/P0 清单
    focus_lines = ["# 跨天待办与高优消息（P0 / P1）", ""]
    focus = [(m, classify(m)[1]) for m in msgs if classify(m)[1] in ("P0", "P1")]
    if focus:
        for m, lv in sorted(focus, key=lambda x: x[0].ts or datetime.min.replace(tzinfo=CST), reverse=True):
            focus_lines.append(
                f"- `{m.day} {fmt_time(m)}` **[{lv}]** **{m.sender_name or m.sender_id or '未知'}**"
                f"（{m.chat_name or m.chat_id or '群聊'}）：{compact(m.content, DISPLAY_LIMITS['focus_preview_chars'])}"
            )
    else:
        focus_lines.append("- （无）")
    (out / "p1-todo.md").write_text("\n".join(focus_lines) + "\n", encoding="utf-8")

    # 媒体清单（提示：--media-check 关闭时“存在”列显示为“未校验”）
    media_lines = [
        "# 文件 / 图片 / 视频清单", "",
        "> 需要我真正“看”图片内容时，以本表 `abspath` 为准；未校验的行请先确认导出时是否勾选了媒体下载。", "",
        "| 时间 | 群 | 发送人 | 类型 | 消息摘要 | 引用/本地路径 | 存在 |", "|---|---|---|---|---|---|---|",
    ]
    media_rows = 0
    seen_media: set[str] = set()
    for m in msgs:
        for item in m.media:
            # 同一条转发记录里的图片会在嵌套消息中被重复提取：按绝对路径/引用名去重
            key = item["abspath"] or item["ref"]
            if key in seen_media:
                continue
            seen_media.add(key)
            media_rows += 1
            body = re.sub(r"\[(图片|文件|媒体|视频|语音)[^\]]*\]", "", m.content or "").strip()
            if item["exists"] is True:
                flag = "✅"
            elif item["exists"] is False:
                flag = "❌"
            else:
                flag = "未校验"
            media_lines.append(
                f"| {m.day} {fmt_time(m)} | {m.chat_name or m.chat_id} | {m.sender_name or m.sender_id} "
                f"| {item['kind']} | {compact(body, DISPLAY_LIMITS['media_summary_chars'])} | `{item['abspath'] or item['ref']}` | {flag} |"
            )
    if media_rows == 0:
        media_lines.append("| - | - | - | - | （未发现媒体条目） | - | - |")
    (out / "media-index.md").write_text("\n".join(media_lines) + "\n", encoding="utf-8")

    # 解析报告
    report = ["# 解析报告", "", f"- 输入文件数：{len(files)}", f"- 归一化消息数：{len(msgs)}",
              f"- 丢弃记录数（无法识别）：{stats['skipped']}", f"- 缺时间戳：{stats['no_time']}",
              f"- 缺发送人：{stats['unknown_sender']}",
              f"- 覆盖日期：{', '.join(sorted(by_day)) or '（无）'}", "",
              "## 产出文件", "",
              "- `overall.md`：**整体汇总**（覆盖全部聊天记录的总览报告）",
              "- `digest/<日期>.md`：每日汇总",
              "- `p1-todo.md`：跨天 P0/P1 清单 ｜ `media-index.md`：媒体清单",
              "- `normalized.jsonl`：归一化原文（供交叉比对使用）", "",
              "## 时间口径说明", "",
              "- 时间取自导出里的毫秒时间戳（epoch）并转换为 **UTC+8** 本地时间。",
              "- 若导出同时带 `time` 字符串，注意 QCE v6.3.0 的该字符串可能与其自身时间戳不一致"
              "（实测相差 8 小时）；本工具以时间戳为准，因此显示的钟点会与 JSON 里的 `time` 字段相差 8 小时。",
              "- 判断依据：相邻消息的 `seq` 递增（例如 116464 → 116465），时间戳可线性对应当日活跃时段。", "",
              "## 每个文件的解析量", ""]
    for item in stats["files"]:
        report.append(f"- `{item['path']}` → {item['parsed']} 条"
                      + (f"（会话：{item['chat']}）" if item.get("chat") else ""))
        st = item.get("statistics") or {}
        if st:
            report.append(f"    - 导出侧统计：{json.dumps(st, ensure_ascii=False)[:300]}")
    if stats["no_time"] or stats["skipped"]:
        report += ["", "## 告警", "", "- 存在缺时间戳或无法识别的记录，请确认导出格式；必要时用 `--media-root` 或先查看原始 JSON 字段名。"]
    (out / "_report.md").write_text("\n".join(report) + "\n", encoding="utf-8")

    print(json.dumps({
        "files": len(files), "messages": len(msgs), "days": sorted(by_day),
        "out": str(out), "skipped": stats["skipped"], "no_time": stats["no_time"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
