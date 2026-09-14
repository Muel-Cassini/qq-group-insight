---
name: social-crawl
description: 通过本地 MediaCrawler（复用本机 Chrome 登录态）只读采集小红书 / 知乎 / B站等平台的公开内容与评论，输出 JSONL 与清单文件，供后续交叉比对与总结使用。适用于用户要求爬取/采集社媒内容、按关键词做舆情或选题调研、抓取某篇笔记或某位创作者的内容时。
whenToUse: 用户要求采集小红书/知乎/B站等社媒公开内容、评论或创作者作品，或需要为交叉比对准备社媒数据时使用。
---

# 社媒公开内容采集（MediaCrawler）

后端：工作区 `tools/MediaCrawler`（[NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)，**NON-COMMERCIAL LEARNING LICENSE 1.1：仅限学习研究、禁止商业用途**）。
本技能只做**读取公开内容**，不使用任何写操作（不发布、不评论、不点赞、不关注）。

> 面向人的操作手册在 `GUIDE.md`（Edge 前置、参数表、故障对照、风控护栏）；本机环境与限流参数在 `config.json`，脚本每次运行自动读取，无需改代码。

## 一、合规与风控（先读）

- 仅采集公开信息，遵守目标平台条款与 robots 约定；不绕过登录门槛、不采集非公开数据、不做规模化抓取。
- 频控：默认并发 1、单关键词条数有限；被要求「抓十万条」这类任务时，先提醒风险并建议缩小范围。
- 账号风险：自动化访问可能触发风控甚至封号。**建议使用小号**，并优先复用本机已登录的 Chrome（CDP 模式）以降低指纹异常。
- Cookie/登录态属于敏感凭据：不要写入工作区文件、不要打印到对话里、不要提交到任何仓库。

## 二、前置：让 Edge 暴露 CDP 调试端口

采集走 **Microsoft Edge**（本机 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`），而不是 Chrome。一次性准备：

```powershell
# 1) 启动一个带远程调试端口的 Edge 调试实例（独立 profile，不影响日常 Edge）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch-edge-cdp.ps1

# 关闭调试实例（需要时）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch-edge-cdp.ps1 -Kill
```

脚本会打印 `CDP 就绪：Edg/153.x` 与 WebSocket 地址，即代表可用。

2. 在该 Edge 窗口里**登录小红书 / 知乎 / B站**（登录态保存在 `%LOCALAPPDATA%\dsh-edge-cdp`，后续采集自动复用）。

> 想复用你日常 Edge 的登录态：不要用上面的脚本，而是打开你日常 Edge 的 `edge://inspect/#remote-debugging`，勾选 *Allow remote debugging for this browser instance*，然后保持该 Edge 运行即可（MediaCrawler 会用同一端口 9222 连接）。

补充事实（都已实测）：

- MediaCrawler 的 CDP 端口写死为 `config.CDP_DEBUG_PORT = 9222`，只认 9222；Edge 侧必须用同一个端口。
- 它的浏览器自动探测顺序是 **Chrome 优先**。本机同时装了 Chrome，所以本技能默认走 `--browser edge`，通过 `tools/MediaCrawler/sitecustomize.py`（在 config 导入前读 `DSH_CDP_BROWSER_PATH`）把 `CUSTOM_BROWSER_PATH` 指向 msedge.exe——**没有改动 MediaCrawler 任何源码**。需要临时切回 Chrome 时加 `--browser chrome` 或 `--browser auto`。

若尚未安装依赖：

```powershell
# 在仓库根目录执行（Python 需 ≥3.11，MediaCrawler 的 .python-version 为 3.11）
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r tools\MediaCrawler\requirements.txt
# 仅在用标准 Playwright 模式（非 CDP）时才需要
.\.venv\Scripts\python.exe -m playwright install
```

## 三、执行采集

```powershell
# 关键词搜索（默认平台参数：--platform xhs|zhihu|bili；默认浏览器 Edge）
python .agents/skills/social-crawl/scripts/crawl.py `
  --platform xhs --keywords "容器 内存 排查" `
  --limit 20 --comments-per-item 20 `
  --out "artifacts/social/2026-09-13-xhs-容器内存" --launch-edge

# 指定笔记/帖子（detail 模式）
python .agents/skills/social-crawl/scripts/crawl.py --platform zhihu --type detail `
  --specified-id "https://www.zhihu.com/question/123456" --out "artifacts/social/zhihu-q123456"

# 指定创作者（creator 模式）
python .agents/skills/social-crawl/scripts/crawl.py --platform bili --type creator `
  --creator-id "<UID 或主页 URL>" --limit 30 --out "artifacts/social/bili-up-xxx"

# 先看将执行的命令（不真正运行，便于向用户确认）
python .agents/skills/social-crawl/scripts/crawl.py --platform xhs --keywords "测试" --out "artifacts/social/_dry" --print-cmd
```

| 参数 | 说明 |
|---|---|
| `--browser edge/chrome/auto` | 默认 `edge`（强制用本机 Edge）；`auto` 交给 MediaCrawler 自动探测（Chrome 优先） |
| `--launch-edge` | CDP 端口未开放时自动拉起 Edge 调试实例（独立 profile，需在该窗口登录） |
| `--cdp-port` | 默认 9222；**非 9222 会导致连接失败**（MediaCrawler 端口写死） |
| `--limit` | 最多采集多少条内容（建议 ≤ 30） |
| `--comments-per-item` | 每条内容最多多少条一级评论（建议 ≤ 30） |
| `--no-comments` | 完全不要评论 |
| `--headless yes/no` | 首次登录/需要扫码时用 `no`（有窗口） |
| `--login qrcode/phone/cookie` | 登录方式；`cookie` 时用 `--cookies`，注意不要落盘 |
| `--timeout` | 子进程超时秒数（扫码等待时可能较久） |

输出（MediaCrawler 自己写出）：

```
<out>/<platform>/jsonl/search_contents_<日期>.jsonl    内容
<out>/<platform>/jsonl/search_comments_<日期>.jsonl    评论
<out>/_manifest.json                                   本次采集清单（关键词、条数、文件、退出码）
```

## 四、结果处理约定

1. **先看 `_manifest.json` 的 `exit_code` 与文件数**：为 0 才算成功；为空说明未登录、无结果或被风控，别急着做结论。
2. 采集到的内容不要整篇复述，抽取「标题 + 作者 + 互动量 + 链接 + 关键结论」。
3. 图片/视频封面无需下载即可总结；确有必要时先向用户确认再下载。
4. 采集完成后立刻交给 `cross-compare` 技能做比对，不要各写一份互不相干的总结。

## 五、红线

- 不采集、不推断任何非公开信息（私信、手机号、身份信息等）；发现采集结果里含此类内容时，汇总中脱敏处理。
- 不把采集结果用于商业用途（受 MediaCrawler 许可限制）。
- 不修改 `tools/MediaCrawler` 的源码与配置默认值；所有参数通过本技能的封装脚本传入。
