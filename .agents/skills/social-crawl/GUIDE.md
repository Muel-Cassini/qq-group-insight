# social-crawl 操作指南

> 本文件是**给人看的操作手册**；给 Agent 看的规则在 `SKILL.md`。
> 实测口径：Microsoft Edge 153 + MediaCrawler（Python 3.14 venv）+ Windows PowerShell。

---

## 1. 它能做什么

用本机 **Microsoft Edge** 的登录态，通过 MediaCrawler 的 CDP 模式**只读**采集公开内容：

- 关键词搜索（`search`）、指定笔记/帖子（`detail`）、指定创作者（`creator`）；
- 平台：小红书 `xhs`、知乎 `zhihu`、B站 `bili`（其余 `dy/wb/ks/tieba` 也支持，见 §5）；
- 输出 JSONL（内容 + 评论）+ `_manifest.json` 清单，供 `cross-compare` 比对。

**它不做**：不发布、不评论、不点赞、不关注（MediaCrawler 的写接口一律不调用）；不采集非公开信息；不绕过登录门槛；不把 cookie 写进任何文件。

---

## 2. 前置：Edge 打开 CDP 调试端口

```powershell
# 启动带远程调试端口的 Edge（独立 profile，不影响日常 Edge）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch-edge-cdp.ps1

# 需要时关闭该调试实例
powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch-edge-cdp.ps1 -Kill
```

脚本打印 `CDP 就绪：Edg/153.x` 即成功。然后**在这个 Edge 窗口里登录小红书 / 知乎 / B站**（登录态保存在 `%LOCALAPPDATA%\dsh-edge-cdp`，后续复用）。

> 想复用日常 Edge 的登录态：不要用上面的脚本，改成打开你日常 Edge 的 `edge://inspect/#remote-debugging`，勾选 *Allow remote debugging for this browser instance* 并保持该 Edge 运行（端口同为 9222）。

两个必须知道的实现细节：

1. MediaCrawler 的 CDP 端口**写死 9222**（`config.CDP_DEBUG_PORT`），所以浏览器侧必须是 9222；
2. 它的浏览器探测顺序是 **Chrome 优先**。本机同时装了 Chrome，所以本技能默认 `--browser edge`，通过 `tools/MediaCrawler/sitecustomize.py`（在 config 导入前读 `DSH_CDP_BROWSER_PATH`）把 `CUSTOM_BROWSER_PATH` 指向 msedge.exe——**没有改动 MediaCrawler 任何源码**。

依赖（如需重装）：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r tools\MediaCrawler\requirements.txt
```

---

## 3. 跑采集

### 3.1 标准命令

```powershell
# 关键词搜索（最常见）
python .agents/skills/social-crawl/scripts/crawl.py `
  --platform xhs --keywords "容器 内存 排查" `
  --limit 20 --comments-per-item 20 `
  --out "artifacts/social/2026-09-13-xhs-容器内存" --launch-edge

# 指定笔记/帖子
python .agents/skills/social-crawl/scripts/crawl.py --platform zhihu --type detail `
  --specified-id "https://www.zhihu.com/question/123456" --out "artifacts/social/zhihu-q123456"

# 指定创作者
python .agents/skills/social-crawl/scripts/crawl.py --platform bili --type creator `
  --creator-id "<UID 或主页 URL>" --limit 30 --out "artifacts/social/bili-up-xxx"
```

### 3.2 参数表

| 参数 | 默认 | 说明 |
|---|---|---|
| `--platform` | config：`xhs` | `xhs/zhihu/bili/dy/wb/ks/tieba` |
| `--keywords` | — | `search` 模式必填；多个关键词用逗号分隔 |
| `--type` | `search` | `search` / `detail`（配 `--specified-id`）/ `creator`（配 `--creator-id`） |
| `--limit` | config：`20` | 最多采集条数；**`-1` = 交给 MediaCrawler 默认**。注意它按搜索页取数，实际常多于该值（实测 `--limit 1` 仍返回 20 条） |
| `--comments-per-item` | config：`20` | 每条内容的一级评论上限；`-1` = 默认 |
| `--no-comments` | 关 | 完全不采评论（最快、最省） |
| `--sub-comments` | 关 | 采二级评论 |
| `--out` | 必填 | 输出目录（传给 MediaCrawler 的 `--save_data_path`） |
| `--browser` | config：`edge` | `edge` 强制本机 Edge；`chrome`；`auto` 交给 MediaCrawler 自动探测 |
| `--cdp-port` | `9222` | 建议不要改（见 §2） |
| `--launch-edge` | 关 | 端口未开放时自动拉起 Edge 调试实例 |
| `--edge-profile` | config | Edge 调试实例的 user-data-dir |
| `--login` | config：`qrcode` | `qrcode` / `phone` / `cookie`（cookie 用 `--cookies`，**不要落盘**） |
| `--headless` | config：`no` | 首次登录/需扫码用 `no` |
| `--concurrency` | config：`1` | 并发，保持 1 以降风控 |
| `--timeout` | config：`3600` | 子进程超时秒；`-1` = 不设超时 |
| `--print-cmd` | 关 | 只打印将执行的命令，不真正运行（**推荐先跑一次确认**） |
| `--config` | 技能目录 `config.json` | 参数配置文件路径 |

### 3.3 推荐节奏

1. `--print-cmd` 先看命令是否符合预期；
2. 首次用 `--headless no` + 少量条数（`--limit 5`）跑通；
3. 确认数据正常后再扩大条数；采集完把 `--out` 目录交给 `cross-compare`。

---

## 4. 输出怎么读

```
<out>/<平台slug>/jsonl/search_contents_<日期>.jsonl    内容（xml/xhs/zhihu/bilibili 字段不同）
<out>/<平台slug>/jsonl/search_comments_<日期>.jsonl    评论（未开启评论时不存在）
<out>/_manifest.json                                   本次清单：平台、关键词、条数、文件列表、exit_code
```

- **先看 `_manifest.json`**：`exit_code` 为 0 且 `files` 非空才算成功；
- 常见字段：小红书 `note_id/title/desc/nickname/liked_count/note_url`；知乎 `content_id/content_type/title/content_text/voteup_count`；B站 `video_id/title/video_play_count/video_danmaku`；
- 不要把内容整篇复述，抽「标题 + 作者 + 互动量 + 链接 + 关键结论」。

---

## 5. 参数怎么调（改 `config.json`，不用动代码）

配置文件：`.agents/skills/social-crawl/config.json`，**每次运行都会重新读取**。
优先级：`--config <路径>` > 技能目录 `config.json` > 内置默认值。类型写错只忽略该字段并警告。

| 配置块 | 作用 |
|---|---|
| `platforms` | 平台代码 → 中文名（决定 `--platform` 可选值） |
| `slug_candidates` | MediaCrawler 输出目录名映射（如 `bili → bilibili/bili`），用于生成 `_manifest.json` |
| `edge_paths` | 查找 `msedge.exe` 的顺序（本机装在 `Program Files (x86)`） |
| `edge_user_data_dir` | Edge 调试实例的 profile 目录 |
| `defaults` | `platform` / `browser` / `login` / `headless` 的默认值（**非法值会回退并告警**） |
| `guardrails` | 限流护栏：`timeout`、`warn_timeout_below`、`limit`、`comments_per_item`、`concurrency`、`max_limit` |

`guardrails.max_limit` 是**风控提醒阈值**：`--limit` 超过它就会打印警告（不会阻止执行）：

```
[WARN] --limit 500 超过配置建议上限 200：大规模抓取会显著提高风控/封号风险，建议缩小范围
[WARN] --timeout 60s 偏短：首次扫码或采集较慢时会被中断
```

---

## 6. 合规与风控红线

- 只采公开内容；遵守平台条款与 robots 约定；不采集非公开数据、不做规模化抓取。
- 建议使用小号；优先复用本机已登录的 Edge 以降低指纹异常。
- Cookie/登录态属敏感凭据：不写入工作区文件、不打印到对话、不提交仓库。
- 采集结果受 MediaCrawler 许可限制（**NON-COMMERCIAL LEARNING LICENSE 1.1，禁止商业用途**）。

---

## 7. 常见故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `CDP port 9222 is not accessible` 并等 60s 后失败 | Edge 调试实例没起 | 跑 `tools\launch-edge-cdp.ps1`，或加 `--launch-edge` |
| 连上了但取不到数据 / 要求登录 | 调试 profile 里没登录该平台 | 在该 Edge 窗口登录目标平台后重试 |
| `未找到 .../tools/MediaCrawler/main.py` | `tools/MediaCrawler` 缺失或路径不对 | 确认目录存在，或用 `--mc-dir` 指定 |
| `FileNotFoundError: libs/douyin.js` | 在错误的工作目录下直接跑了 `main.py` | 只能用本技能脚本调用（它会把 cwd 设为 MediaCrawler 目录） |
| 打印 `[WARN] 未找到 msedge.exe` | Edge 安装路径不在 `edge_paths` 里 | 把实际路径加进 `config.json` 的 `edge_paths` |
| 输出文件为空 / `_manifest.files` 为空 | 无结果、被风控、或未登录 | 看 stderr 日志；稍后重试；换更具体的关键词 |
| 结果条数远多于 `--limit` | MediaCrawler 按搜索页取数，条数控制不精确 | 属预期；在汇总阶段截断，或改用 `detail` 模式指定目标 |
| B站结果相关性差 | 泛关键词在 B站召回较杂 | 用更具体的关键词（报错原文、专有名词） |
| 报了 CDP 端口不一致的警告 | `--cdp-port` 不是 9222 | 改回 9222（MediaCrawler 端口写死） |

---

## 8. 接下一步

```powershell
python .agents/skills/cross-compare/scripts/compare.py `
  --qq "artifacts/qq/<群>-<区间>" `
  --social "artifacts/social/<本次采集目录>" `
  --out "artifacts/compare/<日期>"
```

---

## 9. 文件速查

```
.agents/skills/social-crawl/GUIDE.md                       本操作指南
.agents/skills/social-crawl/SKILL.md                       Agent 用技能说明
.agents/skills/social-crawl/config.json                    可调参数
.agents/skills/social-crawl/scripts/crawl.py               封装脚本
tools/launch-edge-cdp.ps1                                  启动 Edge 调试实例
tools/MediaCrawler/sitecustomize.py                        把 CDP 指向 Edge（不改上游源码）
tools/MediaCrawler/                                        上游采集后端（禁商用许可）
artifacts/social/<批次>/                                    采集产物
```
