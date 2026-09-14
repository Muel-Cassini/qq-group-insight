#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""采集前置检查：确认 Edge 调试实例里各平台是否**真的**已登录。

为什么要单独做这一步：
  - MediaCrawler 自带的 pong() 判定失败后会进入交互式扫码，每轮等 120s，
    一次采集最多卡 8 分钟以上，用户只能看着日志干等；
  - 只看 cookie 是否存在并不可靠（实测小红书 web_session 还在、值也没变，
    但服务端会话已过期），必须做一次真实的登录态判定。

判定方式（不打印任何 cookie 值）：
  xhs   : cookie 存在性 + 打开 /user/profile/me，若被重定向到 /login 即未登录
  zhihu : 同源读取 z_c0 等 cookie 后请求 /api/v4/me（失败再看 z_c0）
  bili  : 请求 /x/web-interface/nav，读 isLogin
  其他  : 仅做 cookie 存在性判断（并标注 how="cookie"）

用法（cwd 必须是 tools/MediaCrawler）：
    python check_login.py xhs zhihu bili
输出：一行 JSON
    {"ok": true, "platforms": {"xhs": {"loggedIn": true, "how": "api", ...}}}
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.getcwd())

from playwright.async_api import async_playwright  # noqa: E402

from tools.cdp_browser import CDPBrowserManager  # noqa: E402

# 各平台的"登录关键 cookie"（只看是否存在，不读值）
AUTH = {
    "xhs": {"domain": "xiaohongshu.com", "primary": "web_session", "related": ["a1", "webId"]},
    "zhihu": {"domain": "zhihu.com", "primary": "z_c0", "related": ["d_c0", "q_c1"]},
    "bili": {"domain": "bilibili.com", "primary": "SESSDATA", "related": ["DedeUserID", "bili_jct"]},
    "dy": {"domain": "douyin.com", "primary": "sessionid", "related": ["passport_csrf_token"]},
    "wb": {"domain": "weibo.com", "primary": "SUB", "related": ["SUBP"]},
    "ks": {"domain": "kuaishou.com", "primary": "kuaishou.web.cp.api_ph", "related": ["did"]},
    "tieba": {"domain": "baidu.com", "primary": "BDUSS", "related": ["STOKEN"]},
}

# 登录态判定接口：(入口页, 接口) —— 用页面内同源 fetch，避免签名/CORS 问题
API_PROBES = {
    "zhihu": (
        "https://www.zhihu.com/",
        "https://www.zhihu.com/api/v4/me?include=account_status",
        lambda body: bool(body.get("id") and body.get("name")),
    ),
    "bili": (
        "https://www.bilibili.com/",
        "https://api.bilibili.com/x/web-interface/nav",
        lambda body: bool(body.get("data", {}).get("isLogin")),
    ),
}

FETCH_JS = """
async (url) => {
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*' },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: res.status, json, body: text.slice(0, 200) };
  } catch (e) {
    return { status: -1, json: null, body: String(e) };
  }
}
"""


async def check_xhs(ctx) -> dict:
    """小红书：打开个人页，看是否被踢到登录页。"""
    page = await ctx.new_page()
    try:
        await page.goto(
            "https://www.xiaohongshu.com/user/profile/me",
            wait_until="domcontentloaded",
            timeout=45000,
        )
        await page.wait_for_timeout(2500)
        url = page.url
        if "/login" in url:
            return {"loggedIn": False, "how": "page", "reason": "个人页被重定向到登录页"}
        # 页面上有登录弹窗/二维码也说明未登录
        dialog = await page.evaluate(
            "() => Boolean(document.querySelector('.login-container, .login-box, .sign-container'))"
        )
        if dialog:
            return {"loggedIn": False, "how": "page", "reason": "页面弹出登录框"}
        return {"loggedIn": True, "how": "page", "reason": "个人页可正常访问"}
    finally:
        await page.close()


async def check_api(ctx, platform: str) -> dict:
    """知乎 / B站：页面内同源请求「我是谁」接口。"""
    page_url, api_url, judge = API_PROBES[platform]
    page = await ctx.new_page()
    try:
        await page.goto(page_url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(1200)
        result = await page.evaluate(FETCH_JS, api_url)
        body = result.get("json") or {}
        try:
            logged_in = bool(judge(body))
        except Exception:  # noqa: BLE001
            logged_in = False
        return {
            "loggedIn": logged_in,
            "how": "api",
            "status": result.get("status"),
            "reason": "" if logged_in else f"接口未返回已登录信息（HTTP {result.get('status')}）",
        }
    finally:
        await page.close()


async def main() -> int:
    wanted = [item.strip() for item in sys.argv[1:] if item.strip()] or list(AUTH)
    manager = CDPBrowserManager()
    result: dict[str, dict] = {}
    async with async_playwright() as playwright:
        try:
            ctx = await manager.launch_and_connect(playwright)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"无法连接 Edge 调试实例：{exc}",
                              "platforms": {name: {"loggedIn": False} for name in wanted}}, ensure_ascii=False))
            return 1

        cookies = await ctx.cookies()
        by_domain: dict[str, set[str]] = {}
        for cookie in cookies:
            by_domain.setdefault(cookie.get("domain", ""), set()).add(cookie.get("name", ""))

        for name in wanted:
            spec = AUTH.get(name)
            if not spec:
                result[name] = {"loggedIn": False, "reason": "未知平台"}
                continue
            names: set[str] = set()
            for domain, cookie_names in by_domain.items():
                if spec["domain"] in domain:
                    names |= cookie_names
            present = [cookie for cookie in spec["related"] if cookie in names]
            base = {
                "primary": spec["primary"],
                "present": present,
                "cookieCount": len(names),
                "hasPrimary": spec["primary"] in names,
            }

            # 1) cookie 层面就不完整 → 直接判未登录，不必开页面
            if not base["hasPrimary"]:
                result[name] = {**base, "loggedIn": False, "how": "cookie",
                                "reason": f"缺少登录 cookie {spec['primary']}"}
                continue

            # 2) 做一次真实判定
            try:
                if name == "xhs":
                    verdict = await check_xhs(ctx)
                elif name in API_PROBES:
                    verdict = await check_api(ctx, name)
                else:
                    verdict = {"loggedIn": True, "how": "cookie", "reason": "仅按 cookie 存在判定"}
            except Exception as exc:  # noqa: BLE001
                # 判定过程本身出错 → 不阻断，退化为 cookie 判定并说明
                verdict = {"loggedIn": True, "how": "cookie",
                           "reason": f"在线判定失败（{type(exc).__name__}: {exc}），按 cookie 存在处理"}
            result[name] = {**base, **verdict}

    ok = all(item.get("loggedIn") for item in result.values())
    print(json.dumps({"ok": ok, "platforms": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
