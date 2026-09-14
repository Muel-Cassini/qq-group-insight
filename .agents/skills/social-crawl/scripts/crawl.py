#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MediaCrawler 调用封装（小红书 / 知乎 / B站 只读采集）。

约定：
- 只做“读取公开内容”，不加任何写操作（不发布、不评论、不点赞），不发任何请求到第三方；
- 通过子进程调用本地 tools/MediaCrawler/main.py，使用工作区 .venv 解释器；
- 不修改 MediaCrawler 的配置默认值，一切通过命令行参数传递。

输出（MediaCrawler 自身写出）：
  <out>/<platform>/jsonl/<type>_<contents|comments>_<YYYY-MM-DD>.jsonl
本脚本在此基础上生成 <out>/_manifest.json，供交叉比对使用。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

PLATFORMS = {
    "xhs": "小红书",
    "zhihu": "知乎",
    "bili": "B站",
    "dy": "抖音",
    "wb": "微博",
    "ks": "快手",
    "tieba": "贴吧",
}

EDGE_PATHS = [
    r"%PROGRAMFILES%\Microsoft\Edge\Application\msedge.exe",
    r"%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe",
    r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe",
]

# ---------------------------------------------------------------- config

CONFIG_FILENAME = "config.json"
CONFIG_PATH = Path(__file__).resolve().parents[1] / CONFIG_FILENAME

# 命令行未显式给出时的默认值（可被 config.json 的 defaults 覆盖）
DEFAULTS: dict[str, Any] = {"platform": "xhs", "browser": "edge", "login": "qrcode", "headless": "no"}
# 限流/规模护栏（可被 config.json 的 guardrails 覆盖）
GUARDRAILS: dict[str, Any] = {
    "timeout": 3600,          # -1 表示不设超时
    "warn_timeout_below": 300,  # 低于该秒数时提示可能不够扫码/抓取
    "limit": 20,              # -1 表示交给 MediaCrawler 默认
    "comments_per_item": 20,  # -1 表示交给 MediaCrawler 默认
    "concurrency": 1,
    "max_limit": 200,         # 超过该条数时打印风控提醒
}
EDGE_USER_DATA_DIR = r"%LOCALAPPDATA%\dsh-edge-cdp"


def load_config(explicit: str = "") -> dict[str, Any]:
    """读取可调参数配置。

    优先级：命令行 --config > 技能目录下的 config.json > 内置默认值。
    文件缺失或字段非法时只警告并回退默认值，绝不因此中断采集。
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


def _warn(msg: str) -> None:
    print(f"[WARN] config.json {msg}", file=sys.stderr)


def apply_config(cfg: dict[str, Any]) -> None:
    """把配置合并进模块级常量（仅覆盖出现且类型正确的字段）。"""
    global PLATFORMS, SLUG_CANDIDATES, EDGE_PATHS, EDGE_USER_DATA_DIR

    val = cfg.get("platforms")
    if val is not None:
        if isinstance(val, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in val.items()):
            PLATFORMS = dict(val)
        else:
            _warn("platforms 必须是 {代码: 名称} 对象（已忽略）")

    val = cfg.get("slug_candidates")
    if val is not None:
        if isinstance(val, dict) and all(isinstance(v, list) for v in val.values()):
            SLUG_CANDIDATES = {k: [str(x) for x in v] for k, v in val.items()}
        else:
            _warn("slug_candidates 必须是 {平台: [目录名]} 对象（已忽略）")

    val = cfg.get("edge_paths")
    if val is not None:
        if isinstance(val, list) and all(isinstance(v, str) for v in val):
            EDGE_PATHS = val
        else:
            _warn("edge_paths 必须是字符串数组（已忽略）")

    val = cfg.get("edge_user_data_dir")
    if val is not None:
        if isinstance(val, str) and val.strip():
            EDGE_USER_DATA_DIR = val.strip()
        else:
            _warn("edge_user_data_dir 必须是非空字符串（已忽略）")

    for block, current in (("defaults", DEFAULTS), ("guardrails", GUARDRAILS)):
        val = cfg.get(block)
        if val is None:
            continue
        if not isinstance(val, dict):
            _warn(f"{block} 必须是对象（已忽略）")
            continue
        for key, item in val.items():
            if not isinstance(item, (int, float, str)) or isinstance(item, bool):
                _warn(f"{block}.{key} 类型不支持（已忽略）")
                continue
            current[key] = item


def resolve_edge() -> str:
    """按顺序找 msedge.exe（本机 Edge 常装在 Program Files (x86)）。"""
    for raw in EDGE_PATHS:
        path = os.path.expandvars(raw)
        if os.path.isfile(path):
            return path
    return ""


# MediaCrawler 输出目录名可能使用 slug（bili → bilibili、wb → weibo、dy → douyin...）
SLUG_CANDIDATES = {
    "xhs": ["xhs"],
    "zhihu": ["zhihu"],
    "bili": ["bilibili", "bili"],
    "dy": ["douyin", "dy"],
    "wb": ["weibo", "wb"],
    "ks": ["kuaishou", "ks"],
    "tieba": ["tieba"],
}


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 1.5) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def launch_edge_debug(port: int, user_data_dir: str) -> str:
    """启动一个带远程调试端口的 Edge 实例（独立 profile，不影响日常 Edge）。"""
    edge = resolve_edge()
    if not edge:
        return ""
    Path(user_data_dir).mkdir(parents=True, exist_ok=True)
    flags = [
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run", "--no-default-browser-check", "--start-maximized",
        "--disable-features=TranslateUI",
    ]
    try:
        subprocess.Popen([edge, *flags], close_fds=True,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
    except OSError as exc:
        return ""
    for _ in range(20):
        if port_open(port):
            break
        import time
        time.sleep(0.8)
    return edge


def default_paths() -> tuple[Path, Path]:
    here = Path(__file__).resolve()
    ws = here.parents[4]  # .agents/skills/<skill>/scripts/<file> → 工作区根
    return ws / "tools" / "MediaCrawler", ws / ".venv" / "Scripts" / "python.exe"


def find_python(ws_python: Path) -> str:
    if ws_python.is_file():
        return str(ws_python)
    for cand in ("python", "python3"):
        from shutil import which
        if which(cand):
            return cand
    raise SystemExit("[ERR] 找不到可用解释器：请先创建 .venv 或把 python 加入 PATH")


def main() -> int:
    mc_dir, ws_python = default_paths()
    ap = argparse.ArgumentParser(description="调用 MediaCrawler 采集公开内容（只读）")
    # 第一遍：只为拿到 --config，再据此决定其余参数的默认值
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--config", default="")
    known, _ = pre.parse_known_args()
    cfg = load_config(known.config)
    if cfg:
        apply_config(cfg)
        print(json.dumps({"config": str(known.config or CONFIG_PATH), "keys": sorted(cfg.keys())}, ensure_ascii=False))

    # 配置里的默认值也要是合法选项，否则回退到内置值（避免 --platform nope 这类静默错误）
    if str(DEFAULTS.get("platform")) not in PLATFORMS:
        print(f"[WARN] config.json defaults.platform={DEFAULTS.get('platform')!r} 不是受支持平台，回退为 xhs", file=sys.stderr)
        DEFAULTS["platform"] = "xhs" if "xhs" in PLATFORMS else sorted(PLATFORMS)[0]
    if str(DEFAULTS.get("browser")) not in ("edge", "chrome", "auto"):
        print(f"[WARN] config.json defaults.browser={DEFAULTS.get('browser')!r} 非法，回退为 edge", file=sys.stderr)
        DEFAULTS["browser"] = "edge"
    if str(DEFAULTS.get("login")) not in ("qrcode", "phone", "cookie"):
        print(f"[WARN] config.json defaults.login={DEFAULTS.get('login')!r} 非法，回退为 qrcode", file=sys.stderr)
        DEFAULTS["login"] = "qrcode"

    ap.add_argument("--platform", default=str(DEFAULTS["platform"]), choices=sorted(PLATFORMS))
    ap.add_argument("--keywords", default="", help="搜索关键词，多个用逗号分隔（--type search 时必填）")
    ap.add_argument("--type", dest="crawler_type", default="search", choices=["search", "detail", "creator"])
    ap.add_argument("--specified-id", default="", help="detail 模式：笔记/帖子 ID 或完整 URL，逗号分隔")
    ap.add_argument("--creator-id", default="", help="creator 模式：创作者 ID 或主页 URL，逗号分隔")
    ap.add_argument("--limit", type=int, default=int(GUARDRAILS["limit"]),
                    help="最多采集多少条内容（-1 = 用 MediaCrawler 默认；注意它按搜索页取数，实际常多于该值）")
    ap.add_argument("--comments-per-item", type=int, default=int(GUARDRAILS["comments_per_item"]),
                    help="每条内容最多多少条一级评论（-1 = 用 MediaCrawler 默认）")
    ap.add_argument("--no-comments", action="store_true", help="不采集评论")
    ap.add_argument("--sub-comments", action="store_true", help="采集二级评论")
    ap.add_argument("--out", required=True, help="采集结果输出目录（会传给 MediaCrawler 的 --save_data_path）")
    ap.add_argument("--mc-dir", default=str(mc_dir), help="MediaCrawler 目录")
    ap.add_argument("--login", default=str(DEFAULTS["login"]), choices=["qrcode", "phone", "cookie"])
    ap.add_argument("--cookies", default="", help="cookie 登录时的 Cookie 字符串（不要写进命令历史以外的文件）")
    ap.add_argument("--headless", default=str(DEFAULTS["headless"]), help="yes 无头 / no 有窗口（首次扫码登录建议 no）")
    ap.add_argument("--browser", default=str(DEFAULTS["browser"]), choices=["edge", "chrome", "auto"],
                    help="CDP 目标浏览器：edge（默认）/ chrome / auto（按 MediaCrawler 自动探测顺序）")
    ap.add_argument("--cdp-port", type=int, default=9222,
                    help="CDP 调试端口。注意：MediaCrawler 的连接端口写死在 config.CDP_DEBUG_PORT=9222，"
                         "非 9222 时必须自行改配置，因此这里默认且推荐 9222")
    ap.add_argument("--edge-profile", default=os.path.expandvars(str(EDGE_USER_DATA_DIR)),
                    help="Edge 调试实例的 user-data-dir")
    ap.add_argument("--launch-edge", action="store_true",
                    help="若 CDP 端口未开放，则自动启动 Edge 调试实例（独立 profile，需在该窗口重新登录）")
    ap.add_argument("--concurrency", type=int, default=int(GUARDRAILS["concurrency"]),
                    help="并发数，默认 1 以降低风控概率")
    ap.add_argument("--timeout", type=int, default=int(GUARDRAILS["timeout"]), help="子进程超时秒数（-1 = 不设超时）")
    ap.add_argument("--print-cmd", action="store_true", help="只打印将执行的命令，不真正运行")
    ap.add_argument("--config", default="",
                    help=f"参数配置路径（默认用技能目录下的 {CONFIG_FILENAME}；不存在则用内置默认值）")
    args = ap.parse_args()

    if int(GUARDRAILS["max_limit"]) and args.limit > int(GUARDRAILS["max_limit"]):
        print(f"[WARN] --limit {args.limit} 超过配置建议上限 {GUARDRAILS['max_limit']}："
              f"大规模抓取会显著提高风控/封号风险，建议缩小范围", file=sys.stderr)
    if 0 < args.timeout < int(GUARDRAILS["warn_timeout_below"]):
        print(f"[WARN] --timeout {args.timeout}s 偏短：首次扫码或采集较慢时会被中断", file=sys.stderr)

    mc = Path(args.mc_dir).expanduser().resolve()
    main_py = mc / "main.py"
    if not main_py.is_file():
        print(f"[ERR] 未找到 {main_py}；请先获取 MediaCrawler 到该目录", file=sys.stderr)
        return 2
    if args.crawler_type == "search" and not args.keywords:
        print("[ERR] --type search 需要 --keywords", file=sys.stderr)
        return 2
    if args.crawler_type == "detail" and not args.specified_id:
        print("[ERR] --type detail 需要 --specified-id", file=sys.stderr)
        return 2
    if args.crawler_type == "creator" and not args.creator_id:
        print("[ERR] --type creator 需要 --creator-id", file=sys.stderr)
        return 2

    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)

    cmd = [
        find_python(ws_python), str(main_py),
        "--platform", args.platform,
        "--lt", args.login,
        "--type", args.crawler_type,
        "--keywords", args.keywords,
        "--start", "1",
        "--get_comment", "no" if args.no_comments else "yes",
        "--get_sub_comment", "yes" if args.sub_comments else "no",
        "--headless", args.headless,
        "--save_data_option", "jsonl",
        "--save_data_path", str(out),
        "--max_concurrency_num", str(args.concurrency),
    ]
    # -1 表示“交给 MediaCrawler 默认值”（不传该参数）
    if args.limit >= 0:
        cmd += ["--crawler_max_notes_count", str(args.limit)]
    if args.comments_per_item >= 0:
        cmd += ["--max_comments_count_singlenotes", str(args.comments_per_item)]
    if args.specified_id:
        cmd += ["--specified_id", args.specified_id]
    if args.creator_id:
        cmd += ["--creator_id", args.creator_id]
    if args.cookies:
        cmd += ["--cookies", args.cookies]

    if args.print_cmd:
        print(" ".join(f'"{c}"' if " " in c else c for c in cmd))
        return 0

    # MediaCrawler 必须在自己的目录下运行（它用相对路径导入 config 等包）
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    env["PYTHONPATH"] = str(mc) + os.pathsep + env.get("PYTHONPATH", "")

    # 浏览器准备：Edge 默认走本机 msedge.exe；CDP 端口不通时可自动拉起调试实例
    env["DSH_CDP_PORT"] = str(args.cdp_port)
    if args.browser == "edge":
        edge = resolve_edge()
        if not edge:
            print("[WARN] 未找到 msedge.exe；将回退到 MediaCrawler 的自动探测（可能选中 Chrome）", file=sys.stderr)
        else:
            # tools/MediaCrawler/sitecustomize.py 会在 config 导入前读取这些变量
            env["DSH_CDP_BROWSER_PATH"] = edge
            print(f"[browser] 强制使用 Edge：{edge}（CDP 端口 {args.cdp_port}）")
    env["DSH_CDP_CONNECT_EXISTING"] = "1"
    if args.cdp_port != 9222:
        print(f"[WARN] CDP 端口 {args.cdp_port} 与 MediaCrawler 的 config.CDP_DEBUG_PORT(9222) 不一致，"
              f"连接会失败；请改 config 或使用 9222", file=sys.stderr)
    if not port_open(args.cdp_port):
        if args.launch_edge and args.browser == "edge":
            profile = args.edge_profile or os.path.expandvars(str(EDGE_USER_DATA_DIR))
            print(f"[browser] CDP 端口 {args.cdp_port} 未开放，自动启动 Edge 调试实例（profile: {profile}）")
            if not launch_edge_debug(args.cdp_port, profile):
                print("[WARN] 自动启动 Edge 失败，请手动运行 tools/launch-edge-cdp.ps1", file=sys.stderr)
            else:
                print("[browser] Edge 调试实例已就绪；若该 profile 尚未登录目标平台，请先在窗口里登录")
        else:
            print(f"[WARN] CDP 端口 {args.cdp_port} 未开放：MediaCrawler 会尝试自行启动浏览器并等待最多 60s。"
                  f"建议先运行 tools/launch-edge-cdp.ps1（或加 --launch-edge）", file=sys.stderr)

    print(f"[run] {PLATFORMS[args.platform]} 采集 → {out}")
    try:
        rc = subprocess.call(cmd, cwd=str(mc), env=env, timeout=(args.timeout if args.timeout > 0 else None))
    except subprocess.TimeoutExpired:
        print(f"[ERR] 超过 {args.timeout}s 未结束，已终止（MediaCrawler 可能仍在等待扫码）", file=sys.stderr)
        rc = 124

    manifest = {
        "platform": args.platform,
        "platform_name": PLATFORMS[args.platform],
        "crawler_type": args.crawler_type,
        "keywords": [k.strip() for k in args.keywords.split(",") if k.strip()],
        "limit": args.limit,
        "comments": not args.no_comments,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "exit_code": rc,
        "files": [],
    }
    for slug in SLUG_CANDIDATES[args.platform]:
        base = out / slug
        if not base.is_dir():
            continue
        for f in sorted(base.rglob("*")):
            if f.is_file():
                manifest["files"].append({
                    "path": str(f),
                    "rel": str(f.relative_to(out)).replace("\\", "/"),
                    "bytes": f.stat().st_size,
                    "kind": "comments" if "comment" in f.name else "contents",
                })
    (out / "_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    if not manifest["files"]:
        print(f"[WARN] 未发现输出文件；exit_code={rc}。常见原因：未登录/需要扫码、关键词无结果、平台风控。",
              file=sys.stderr)
    print(json.dumps({"exit_code": rc, "files": len(manifest["files"]), "manifest": str(out / '_manifest.json')},
                     ensure_ascii=False))
    return rc if rc != 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
