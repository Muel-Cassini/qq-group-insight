# 项目交接文档（HANDOFF）

> 用途：让**新的对话**在完全不看历史聊天记录的情况下，直接接着干。
> 读者假设：一个能读写文件、能跑命令的编码代理（或未来的我）。
> 最后更新：2026-09-13（新增：关键词「社媒跨平台互比」+ 无 AI 时的「本地规则汇总」保底 + 文件汇总提示词模板）
>
> **先读这三节就够开工**：`1. 这是什么` → `2. 当前状态` → `8. 待办与已知问题`。
> 其余章节按需查（目录结构、数据格式、踩坑清单、验证脚本）。

---

## 1. 这是什么

把 QQ 群聊记录变成「可读、可核对」的结论，并用社媒内容做交叉验证。三条主线：

1. **群聊汇总**：读 QQ Chat Exporter（QCE）导出的 JSON → 按「主题分类 + 重要度分级 + 按天切分」生成每日 digest、P0/P1 待办、媒体清单，以及一份 `overall.md` 整体汇总。
2. **社媒采集 + 关键词验证**：用本地 MediaCrawler 只读采集小红书/知乎/B站，并从群聊汇总里提取候选关键词，逐词到社媒上检索、与群聊消息交叉比对、必要时用 AI 判定「印证/补充/冲突」。
3. **汇总与文件汇总**：把上面所有材料（群聊汇总 + 采集结果 + 比对材料 + 用户上传的 PDF/Word/Excel 等文档）交给 AI 写一份最终总结。

**交付形态（重要）**：不是一个只能敲命令的脚本集合，而是

- **三个技能**（`.agents/skills/`，给 agent 用）+ 每个技能配 `GUIDE.md`（给人看）与 `config.json`（可调参数）；
- **一个本地 Web 控制台**（`app/`，双击 `app\启动.cmd` 启动），把这套链路变成点按钮：自动拉起 Edge 调试实例与 DSH、六个页面、任务日志 SSE 实时上屏。

---

## 2. 当前状态（截至本文档更新时）

### 2.1 已经做完并且**实测验证过**的

| 功能 | 验证方式与结果 |
|---|---|
| 群聊汇总（整体 + 每日 + P0/P1 + 媒体） | 5 份导出全部汇总成功；最大群 `示例群B` 25,863 条 / 51 天，`overall.md` 188.4 KB，digest 9.7 s |
| 社媒采集（小红书/知乎/B站） | 3 个采集批次；CDP 复用 Edge 调试实例（9222） |
| 交叉比对 + AI 判定 | 1 个比对目录（`artifacts/compare/20260912`），AI 判定产出 `compare-ai.md` |
| 总结三条路（本地 DSH / 我的 API / 只生成提示词） | DSH 路径自动清理本次会话；API 路径有费用预估与发送前确认 |
| **关键词验证**（提取候选词 → 逐词逐平台采集 → 比对 → 报告） | 实测：2 关键词 × 知乎，213 s 跑完，产出 `verify-report.md` 与 `_qq`/`_compare` 材料（详见 8.1 的注意事项） |
| **采前登录判定** | 实测：小红书 12 s 内被判「未登录（个人页被重定向到登录页）」并被跳过；全部未登录时任务 **8 s 快速失败**，不再白等 8 分钟 |
| **文件汇总**（上传 → 抽文本 → AI 汇总） | 端到端 8/8 步通过：PDF 上传 → 解析出 328 字 → AI 汇总 → 产物登记并可校验 |
| 界面按钮审计 | 六页全部按钮审计：真正「点了没反应」的 **0 个**（加完①页新区域后为 84 个） |
| **①页「单条聊天记录汇总」**（在下拉里挑任意扫描到的记录单独汇总，含日期范围/会话名子串/媒体校验/自定义输出目录） | 实测：界面 12/12（下拉列出全部记录含已汇总、「填充时间范围」正常）；接口：全量 1119 条 = 记录条数、限日期区间 368 条（证明真的过滤）、会话名子串可用、产物 5 件齐全；输出目录 `../` 越界被拒绝 |
| **社媒跨平台互比**（关键词 → 各平台采集 → 平台之间互比 → 汇总） | 实测：`示例关键词` × B站/小红书/知乎，3 平台 58 篇 → 8 个共识主题、20 组跨平台配对、平台独有主题（小红书「宣讲会/招聘」、知乎「docker/容器」、B站「考研」）全部归出来 |
| **本地规则汇总保底**（无 AI 也能出汇总） | 实测：文件汇总端到端 **33/33 步通过**（上传 4 个文件含 762KB 真实 PDF → 提取 → 本地汇总 → 抽到日期/电话/邮箱/金额/跨文件共性主题）；关键词侧真实采集跑通（见 8.1） |
| **提示词模板**（保存/覆盖/删除/套用） | 实测：保存 → 读回 → 同名覆盖不重复 → 删除，模板落 `app/.local/config.json`，不进 AI |
| 布局（拖动分隔条 / 双击复位）、目录位置设置、单条导出、整体汇总 | 均有独立验证脚本（见第 9 节） |

### 2.2 环境与运行中的服务

| 项 | 值 |
|---|---|
| 项目根 | `D:\summary-workspace`（发布副本是 git 仓库） |
| 控制台 | 进程 `node server/main.mjs`，端口 **7801**，`/api/health` 返回 `{app:'dsh-summary-app', pid, startedAt}` |
| Edge 调试实例 | 端口 **9222**，独立配置 `%LOCALAPPDATA%\dsh-edge-cdp` |
| DSH Web | 端口 **3080**（DSH 本体；`--profile headless` 用于总结） |
| QCE 服务 | 端口 40653（QQ Chat Exporter 自身） |
| Python | `.venv\Scripts\python.exe`（pypdf / python-docx / beautifulsoup4 / pandas / jieba 已装） |
| 界面打开位置 | **受控 Edge 调试窗口**里的标签页（不是用户日常浏览器） |

> ⚠️ **控制台的启动方式很关键（本次踩到）**：控制台会大量派生子进程（Python 技能链、启动 Edge）。
> 如果它在**受限沙箱**里被启动（例如由编码代理在一个受沙箱约束的后台任务里 `node server/main.mjs`），
> 子进程会因为管道 stdio 被拦而全部报 **`spawn EPERM`** —— 表现为「提取文本失败」「启动 Edge 失败」，看起来像应用 bug，其实是环境限制。
> 正确做法：由用户双击 `app\启动.cmd` 启动，或在**完整权限**下启动。

### 2.3 当前数据

- **导出**：5 份（手动 2：`示例群A` 1778 条、`示例群B` 25863 条；定时 3），全部已汇总。
- **汇总产物**：`artifacts/qq/` 4 份（含 `overall.md`）。
- **采集批次**：`artifacts/social/` 3 个；**比对**：`artifacts/compare/` 1 个；**总结**：`artifacts/summary/` 1 份。
- **上传/文档汇总**：当前为空（测试产物已清理）。
- **AI 服务**：当前**没有配置任何服务**（`ai.providers = []`，`activeProviderId = ""`）。要走 API 总结或关键词验证的 AI 判定，得先在「⑥ 设置」里加一个服务。
- **登录态**：知乎、B站 **已登录**；**小红书未登录/已过期**，采集时会被自动跳过。要采小红书必须先在 Edge 调试窗口里重新扫码登录。

---

## 3. 目录结构（根锚定，不要随意搬）

```
D:\summary-workspace\
├─ README.md                 工作区总览 + 一分钟快速上手
├─ HANDOFF.md                本文档
├─ .agents\skills\           ★ 技能（必须留在根目录，DSH 只认这个位置）
│   ├─ qq-group-summary\     SKILL.md + GUIDE.md + config.json + scripts\qq_group_digest.py（约 45KB）
│   ├─ social-crawl\         ... scripts\crawl.py（封装 MediaCrawler）
│   └─ cross-compare\        ... scripts\compare.py（主题词匹配 + 配对打分）
├─ app\                      ★ 本地 Web 控制台（零第三方依赖）
│   ├─ 启动.cmd              ASCII-only 启动器（cmd.exe 用 ANSI 读，千万别加中文）
│   ├─ GUIDE.md              给人看的完整使用说明（六页 + 排错表）
│   ├─ README.md             设计要点 + 目录结构
│   ├─ server\               后端（Node 内置模块）
│   │   ├─ main.mjs          入口：起服务 → 拉起 Edge/DSH → 打开界面
│   │   ├─ server.mjs        54 个路由（静态资源 + JSON API + SSE）
│   │   ├─ paths.mjs         PATHS 常量 + DEFAULT_CONFIG
│   │   ├─ config.mjs        配置读写（deepMerge）+ DPAPI 密钥
│   │   ├─ jobs.mjs          任务模型（子进程/纯 JS 任务、日志、取消）
│   │   ├─ startup.mjs       Edge/DSH 探测与启动、ShellExecuteW 打开
│   │   ├─ skills.mjs        调用三个技能的 Python 脚本
│   │   ├─ exports.mjs       导出扫描/归档/删除/产物读取
│   │   ├─ ai.mjs            OpenAI 兼容 / Anthropic / 预设 + 费用估算
│   │   ├─ summarize.mjs     总结三条路 + 按天分块
│   │   ├─ review.mjs        AI 复判分类、AI 判定比对
│   │   ├─ dsh-sessions.mjs  逐帧解压 DSH 会话 + 精准清理
│   │   ├─ keyword-verify.mjs  ★ 关键词验证编排 + 采前登录判定 + 跨平台互比接入
│   │   ├─ files.mjs         ★ 上传/抽取/文档汇总（含提示词模板）
│   │   ├─ local-summary.mjs  ★ 汇总引擎选择：AI 可用性探测 + 本地规则保底 + 任务等待
│   │   └─ tools\            ★ 本地 Python 工具（不联网）
│   │       ├─ extract_keywords.py  jieba + TF-IDF 提候选词，昵称碎片过滤，领域词加权
│   │       ├─ extract_files.py     PDF/docx/pptx/xlsx/html/txt/图片 抽文本
│   │       ├─ compare_platforms.py ★ 跨平台互比（按路径加载并复用 compare.py 的分词/主题/打分）
│   │       ├─ summarize_local.py   ★ 本地规则汇总（--mode social / docs）
│   │       └─ check_login.py       采前**真实**登录判定（见 5.3）
│   ├─ web\                  前端（原生 HTML/CSS/JS）
│   │   ├─ index.html        六页：① 导出与汇总 ② 采集与关键词 ③ 交叉比对 ④ 总结 ⑤ 文件汇总 ⑥ 设置
│   │   ├─ styles.css        grid: var(--sidebar-w) 8px 1fr；底部面板 var(--bottom-h)
│   │   └─ app.js            ~1960 行，含 SSE、布局拖动、全局错误提示
│   └─ .local\               运行时私有（gitignore）：config.json、secrets\（DPAPI 加密）
├─ tools\                    ★ 外部工具（根锚定）
│   ├─ MediaCrawler\         上游采集器（禁商用许可）；sitecustomize.py 是我们加的唯一补丁
│   ├─ launch-edge-cdp.ps1   启动 Edge 调试实例
│   └─ ...
├─ data\qq-chat-exporter\    exports\ / scheduled-exports\ / archive\
├─ artifacts\                所有产物：qq  social  compare  summary  keywords  uploads  docs  _samples
├─ docs\                     小白上手指南.md、资产说明.md、README-legacy.md
├─ .venv\                    Python 虚拟环境（根锚定）
└─ _recon\                   侦察/验证脚本（见第 9 节），可整目录删除
```

**根锚定约束**：`.agents`、`tools`、`.venv`、`artifacts`、`data` 必须留在项目根，因为 DSH 的技能发现与脚本里的相对路径都以此为准。

---

## 4. 六页界面 ↔ 后端 ↔ 技能 的对应关系

| 页面 | 主要接口 | 落到哪个技能/模块 |
|---|---|---|
| ① 导出与汇总 | `/api/exports`、`/api/exports/digest`、`/api/summaries`、`/api/artifact`、`/api/exports/archive|delete` | `qq-group-summary`；`exports.mjs` |
| ② 采集与关键词 | `/api/collect/crawl`、`/api/collect/keywords`、`/api/keywords/extract`、`/api/keywords/verify`、`/api/keywords/verify-results`、`/api/summary-engine` | `social-crawl` + `cross-compare`；`keyword-verify.mjs` + `tools/compare_platforms.py` + `tools/summarize_local.py` |
| ③ 交叉比对 | `/api/compare/run`、`/api/compare/verdict` | `cross-compare`；`review.mjs` |
| ④ 总结 | `/api/summary/preview`、`/api/summary/generate`、`/api/summary-files` | `summarize.mjs`（DSH / API / 提示词） |
| ⑤ 文件汇总 | `/api/uploads`、`/api/uploads/extract`、`/api/uploads/extracted`、`/api/docs/preview`、`/api/docs/summary`、`/api/prompts/doc-summary`(+`/save`、`/delete`) | `files.mjs` + `tools/extract_files.py` + `tools/summarize_local.py`（本地保底） |
| ⑥ 设置 | `/api/config`、`/api/provider*`、`/api/dirs*`、`/api/startup/*` | `config.mjs`、`startup.mjs` |
| 全局（底部面板） | `/api/jobs`、`/api/jobs/log`、`/api/jobs/cancel`、`/api/processes`、`/api/events`(SSE)、`/api/open` | `jobs.mjs` |

任务的 `meta.refresh`（`summaries`/`exports`/`social`/`compares`/`keywords`）决定任务结束后前端刷新哪个列表——**新增功能时记得带上它**，否则会出现"跑完了但列表不更新"。

---

## 5. 关键机制（改代码前必须知道）

### 5.1 技能发现与路径

- DSH 从 `<项目根>/.agents/skills/<name>/SKILL.md` 发现技能（**只找一层**，目录名 kebab-case，frontmatter 需要 `name` + `description`）。
- 项目根 = 最近的含 `.git` 的祖先目录，否则是 cwd（本项目**没有 .git**，所以 cwd 必须是 `D:\summary-workspace`，否则技能加载不到）。

### 5.2 MediaCrawler 接入方式

- 上游把 CDP 端口硬编码为 `config.CDP_DEBUG_PORT = 9222`，且浏览器自动探测**优先 Chrome**。
- 我们的做法：**不改上游源码**，在 `tools/MediaCrawler/sitecustomize.py` 里读 `DSH_CDP_BROWSER_PATH` / `DSH_CDP_PORT` / `DSH_CDP_CONNECT_EXISTING` 强制指定 Edge。
- `check_login.py` 与采集脚本的 cwd 都必须是 `tools/MediaCrawler`。

### 5.3 采前登录判定（`app/server/tools/check_login.py`）★ 重要

**为什么需要**：MediaCrawler 自带的 `pong()` 判定失败后会进入交互式扫码，每轮等 120s，一次采集能卡 8 分钟以上；而**只看 cookie 会误判**——实测小红书 `web_session` 还在（17 个 cookie、值 38 字符），但服务端会话已失效。

判定方式（不打印任何 cookie 值）：

| 平台 | 判定 |
|---|---|
| xhs | cookie 存在 + 打开 `/user/profile/me`，若被重定向到 `/login`（或弹出登录框）即未登录 |
| zhihu | 页内同源 `fetch /api/v4/me`，需返回 `id` 与 `name` |
| bili | 页内同源 `fetch /x/web-interface/na`…（实为 `/x/web-interface/nav`），需 `data.isLogin` |
| 其他 | 仅 cookie 存在性（结果里 `how: "cookie"` 标注） |

实测耗时：三平台一轮约 27 s；只查小红书约 7–12 s。
失败**不抛异常**，而是返回 `{ok:false, platforms:{...reason}}`，由 `startKeywordVerify` 决定「跳过 / 整体失败」。

### 5.4 QCE 导出结构（写解析代码时对照）

- 顶层：`metadata / chatInfo / statistics / messages / exportOptions`。
- 消息：`{id, seq, timestamp(ms epoch), time, sender{uid,uin,name,nickname,groupCard,remark}, type, content{text,html,elements[],resources[],mentions}, recalled, system}`。
- 媒体：相对导出目录 `resources/images/<md5>_<NAME>.ext`。
- **坑**：ISO `time` 字符串与 epoch 差 8 小时 —— 以 epoch 为准（UTC+8）。

### 5.5 DSH 会话清理

- 会话文件：`~/.dsh/sessions/<project-key>/session-<uuid>/session.jsonl.zstd`。
- **该文件是多个独立 zstd 帧拼接的**（实测 393 帧），`zstdDecompressSync`/流式解压只解第一帧 → 必须按魔数 `28 b5 2f fd` 逐帧扫（已实现在 `dsh-sessions.mjs`）。
- 清理策略：只删「本次运行期间新建 **且** 内容命中本次输出文件名/汇总目录/`汇总报告`」的会话，其余保留并打日志。

### 5.6 Windows 特有坑（全部踩过并已修）

| 坑 | 正确做法 |
|---|---|
| `spawn` 不能跑 `.cmd`/`.bat`（EINVAL） | 经 `cmd.exe /d /s /c` 包装（`startup.mjs` 的 `resolveCommand`） |
| `explorer` 需要绝对路径，相对路径静默无效 | 统一解析成绝对路径 |
| `Start-Process` 会弄坏中文路径 | 用 `ShellExecuteW`（返回 >32 为成功） |
| `.cmd` 必须是纯 ASCII | `启动.cmd` 无 BOM、0 个非 ASCII；中文提示只在 Node 输出 |
| PowerShell `Invoke-RestMethod` 打 GitHub 报 `SEC_E_NO_CREDENTIALS` | 用 Node 的 `fetch`/https |
| 浏览器没打开界面（`cmd start` 打开了用户日常 Edge） | 用 CDP `PUT /json/new?<url>` 在受控实例里开标签页；并先等端口可连再开 |
| **受限沙箱里启动控制台 → 所有子进程 `spawn EPERM`** | 控制台会派生 Python/Edge；不要在受限沙箱（含编码代理的后台任务）里启动它，否则「提取文本」「启动 Edge」全失败。见 2.2 的警告 |
| **动态模板里的元素被「常驻 handler」引用** | `#kvSelectionInfo` 原本只在「已有候选词」时由 `renderKvCandidates()` 动态生成，而关键词输入框的 `input`（用户手打关键词时必然触发，此时通常还没有候选词）会无条件写它 → 报 `Cannot set properties of null (setting 'textContent')`。**凡是要被常驻 handler 引用的元素，一律写进 `index.html` 静态结构**，别依赖动态模板；本次已改成静态 + `if (!el) return` 兜底，回归脚本见第 9 节 `verify-kv-typing.mjs` |
| **「已汇总」判定只看群身份、不看日期范围** | 同一个群今天又导出一次，旧汇总目录（如 `示例群A-20260909-20260912`）会把新导出（`09-11~09-14`）也标成「已汇总」；用户又勾了「隐藏已汇总」→ **表格一条都不显示，看起来像新记录没被扫到**（实测踩过）。已改为**范围覆盖判定**：解析汇总目录名末尾的 `YYYYMMDD-YYYYMMDD`，只有导出区间被完整覆盖才算已汇总；目录名没写区间（`-all`/时间戳）仍按覆盖全部处理 |
| **两个目录设置填成同一个路径 → 每条记录列两遍** | 「手动导出目录」与「定时导出目录」可以填同一路径，`listExports()` 原样遍历两个来源 → 同一文件出现两次（还会被「汇总选中项」汇总两遍）。已按**绝对路径去重**。另外①页表格空状态原来硬编码提示"导出到 data/qq-chat-exporter/exports"，现在改成说明配置目录 + 被「隐藏已汇总」藏了几条 |

| **参数经 `cmd.exe` 被二次解析 → 命令注入** | `.cmd`/`.bat` 必须经 `cmd.exe /d /s /c` 调用，而 cmd 会**重新解析参数**（Node 只在参数含空格时才加引号）。④页「风格要求 / 重点关注」是自由文本、直接进 DSH 提示词，形如 `x&calc&rem` 会被当成命令执行。**修法**：DSH 改走 `node <CLI 入口>`（`startup.mjs` 的 `resolveDshInvocation`，完全不经 shell）；`openPath` 的 URL 分支改走 `ShellExecuteW`；仍走 cmd 的兜底路径对含 `& \| < > ^ ( ) " % !` 或换行的参数**直接拒绝**（fail closed） |
| **路径包含判断少了分隔符** | `startsWith(root)` 会放过同级目录（`webXXX` / `artifactsXXX` / `uploadsXXX`）。静态资源（`serveStatic`）、产物读取（`readArtifact`）、上传删除（`deleteUpload`）三处都有；统一改为「等于 root 或 `startsWith(root + path.sep)`」 |
| **进程面板把「进程内任务」误标成「已退出」** | PID 列原来写成 `${job.pid ?? '—'}${job.pidAlive ? '' : ' 已退出'}`；而关键词验证 / 一键流程这类任务用 `runTask` **在控制台进程内执行**（`pid` 为 null → `pidAlive` 必然 false），于是**正在正常跑的任务被标「已退出」**，看上去像任务挂了（实测被用户当成故障报过来，其实任务好好的）。已改为：无 pid 显示「内部任务」，只有**确实有子进程且进程已不存在**时才提示「已退出」 |

### 5.7 汇总引擎：AI 优先、本地规则保底（`local-summary.mjs`）★ 重要

**动机**：原本「关键词验证的汇总」和「文件汇总」都**硬依赖 AI 服务**（直接 `chat()`），
没配服务就整个功能不可用（以前的后端里，文件汇总点下去必然抛错，HANDOFF 里那次 8/8 通过用的是临时 mock AI）。

现在的规则（`summarizeWithFallback`，两条链路共用）：

1. `aiStatus(step)` 判断该环节**能不能**用 AI：同时看 `ai.activeProviderId` 与 `ai.perStep[step]`（设置页的按环节覆盖），
   任何一个是可用状态（有 baseUrl、除 `noKey` 预设外有 Key）就算可用。
2. 可用 → 走 `chat()`，产物文件头写 `> 生成方式：**AI 汇总**（服务：X ｜ 模型：Y）`。
3. 不可用 → 跑本地 Python 规则汇总，文件头写 `> 生成方式：**本地规则汇总**…`。
4. **AI 调用失败也会退回本地**（`fallbackToLocal`），保证「汇总」这一步永远有产物，不会只剩一份材料索引。

两种模式的产物**同名同位置**（`verify-summary.md` / `文件汇总-*.md`），所以配好 AI 后重跑一次就自动升级，用户不用改任何参数；
`GET /api/summary-engine` 给界面提供「当前会用哪条引擎」的提示，`GET /api/keywords/verify-results` 会读汇总文件头回填 `summaryEngine`。

`--mode docs` 的本地汇总做的是：文件总览 / 每文件要点（标题行、章节、高频词、日期、要求）/ 跨文件共性主题 /
时间与截止行动项 / 关键数据（金额、百分比、电话、邮箱、链接）/ 待核实与缺口。
关键词用 jieba TF-IDF 并**限词性 + 剔数字碎片**（不这么做短文本会把 `2026`、`09`、`22` 当成「跨平台/跨文件共性主题」，实测踩过）。

### 5.8 跨平台互比（`app/server/tools/compare_platforms.py`）

- 输入一个关键词目录（其下每个子目录是一次平台采集，**跳过 `_` 开头的** `_qq`/`_compare`/`_platform`），
  用 crawl.py 写的 `_manifest.json` 取平台代码与中文名（没有 manifest 就退回目录名）。
- 分词、主题词表、相似度打分**直接 import 复用 `cross-compare/scripts/compare.py`**（按路径 `importlib` 加载，
  它只有 `__main__` 守卫，导入安全）——所以跨平台互比和「群聊 × 社媒比对」是同一套口径、同一份 `config.json`，调参只改一处。
- 产出：各平台画像、主题 × 平台矩阵、跨平台共识主题（≥2 平台）、平台独有主题（信息差）、
  跨平台高相关配对、疑似同源/搬运。只做归并与配对，**不下结论**。

**本次顺带修了 `compare.py` 两个字段漏项**（它是本项目自己的技能，不是 MediaCrawler 上游）：

| 问题 | 影响 | 修法 |
|---|---|---|
| 内容 ID 别名漏了 `content_id` | 知乎的内容与评论都用 `content_id` 关联，导致 153 条评论**一条都挂不上** | 别名表加上 `content_id`（实测评论挂载从 0 → 30） |
| URL 别名漏了 `video_url` | B站内容用它存链接，配对里链接是空的 `[标题]()` | 别名表最后加上 `video_url`（xhs 的 `note_url` 优先，不受影响） |

---

## 6. 数据与产物约定

| 路径 | 内容 |
|---|---|
| `data/qq-chat-exporter/exports`、`scheduled-exports`、`archive` | 导出、定时导出、归档（路径可在设置页改成**绝对路径**） |
| `artifacts/qq/<群名-起止>/` | `overall.md`（整体汇总）、`digest/<日期>.md`、`p1-todo.md`、`media-index.md`、`_report.md`、`normalized.jsonl`（含 `category`/`level`/`classify_reason`） |
| `artifacts/social/<平台>.../` | MediaCrawler JSONL + 清单 |
| `artifacts/compare/<日期>/` | `compare.json`、`compare.md`、`compare-ai.md` |
| `artifacts/summary/` | 最终总结（失败时另有 `.partial.md`） |
| `artifacts/keywords/<汇总目录名>/` | `keywords.json` / `keywords.txt` 候选词 |
| `artifacts/keywords/verify-<时间戳>/` | `verify-report.md`（必有，材料索引）、`verify-summary.md`（必有，文件头标注「生成方式：AI / 本地规则」）、`<关键词>/<平台>/`、`<关键词>/_platform/`（`platform-compare.md`+`.json`、`keyword-summary.md`）、`<关键词>/_qq/`、`<关键词>/_compare/`（后两个仅在「含群聊对照」时产出） |
| `artifacts/uploads/<批次>/` | 用户上传的原始文件（单文件上限 40MB，危险后缀拒绝） |
| `artifacts/docs/<批次>/` | `extracted/*.txt`、`files.json`、`all-in-one.md`、`local-summary.md`（本地规则版单批次汇总，不计入产物列表） |
| `artifacts/docs/文件汇总-<批次>-<时间>.md` | 文档汇总产物（AI 版或本地规则版，看文件头标注） |

**归位规则**：每次汇总都会产出 `overall.md` + `digest/<日期>.md`；`overall.md` 是"整体汇总"，是预览下拉的默认项。

---

## 7. 安全 / 隐私边界（不要越线）

- **密钥**：DPAPI（CurrentUser）加密存 `app/.local/secrets/`，界面只显示"已配置/未配置"；删除服务会同时删密钥。
- **发给 AI 的内容**：只有**汇总文本、比对材料、上传文档抽出的文本**；不发原始聊天记录文件、不发图片二进制。API 路径发送前有费用预估 + 确认弹窗（`confirmBeforeSend`）。
- **本地优先**：关键词提取、文档抽文本、登录判定全部在本机 Python 完成，不联网、不经 AI。
- **登录态**：只读用户 Edge 调试配置里已有的登录状态，**只判断 cookie 是否存在、绝不读取或上传 cookie 值**。
- **采集边界**：只读公开内容，不发布/不评论/不点赞；建议小号 + 控频。
- **许可**：MediaCrawler 是 **NON-COMMERCIAL LEARNING LICENSE 1.1（禁商用）**；QCE 是 GPL-3.0。别把工具链用于商业用途。
- **数据**：`data/` 与 `artifacts/` 含真实昵称与聊天内容，不要提交公开仓库、不要上传网盘。

---

## 8. 待办与已知问题

### 8.1 最近的实测结论 / 注意事项

1. **关键词验证现在以「纯社媒跨平台互比」为默认**（`compareMode: 'social'`，②页可选）。不再必须选群聊汇总：
   不选也能跑出跨平台互比 + 汇总；只有切到「跨平台互比 + 群聊对照」时才需要 `summaryDir`（那时才会有 `_qq`/`_compare`）。
2. **汇总不再依赖 AI**：没配 AI 时出的是**本地规则版汇总**，文件头会写「生成方式」。配好 AI 重跑即自动升级为大模型版（见 5.7）。
   AI 判定（印证/补充/冲突）仍然只在「含群聊对照」这条路里、且需要已配置 AI 服务。
3. **只采到一个平台时无法真正互比**：材料里只有单平台画像，日志会提示「只采到一个平台，无法做跨平台互比」。
4. **小红书当前未登录** → 涉及它的采集会跳过；要全平台验证先去 Edge 调试窗口重新扫码登录（知乎、B站已登录）。
5. **关键词验证耗时**：成本 ≈ 关键词数 × 平台数 次采集，单平台单次最长等 8 分钟。建议先 1–2 个词 + 1–2 个平台试跑。
6. **`/api/keywords/verify` 的关键词兼容三种入参**：字符串、逗号/换行分隔的长字符串、候选词对象数组（`{keyword,...}`）。
7. **`/api/docs/summary` 与 `/api/keywords/verify` 都多了 `engine` 入参**（`auto|ai|local`，默认 auto）；`/api/docs/summary` 另接受 `style`/`focus`。

### 8.2 真正的待办（按优先级）

| 优先级 | 事项 | 说明 / 入手点 |
|---|---|---|
| P1 | **配置一个真实 AI 服务** | 关键路径已不阻塞（本地规则可保底），但 AI 判定 / API 总结 / 分类复判、以及「AI 版汇总」仍需服务；在⑥设置里加（预设或 OpenAI 兼容中转站） |
| P1 | **让用户实测一次全平台（含小红书）关键词验证** | 需先在 Edge 调试窗口登录小红书；之后②页选词 + 三平台跑一次，检查 `verify-summary.md` 的「各平台画像 / 平台独有视角」是否合理 |
| P2 | 关键词验证加「复用已采数据」 | 同一关键词重复跑会重新采集（慢且容易被风控）；可先查 `artifacts/keywords/verify-*/<词>/<平台>` 是否已有当日结果，命中则跳过采集 |
| P2 | 每平台采集超时从 8 分钟下调 | 登录判定已经把最常见的卡点前置了，8 分钟可以缩到 3–4 分钟 |
| P2 | 本地规则汇总继续打磨 | 目前是「归并 + 摘录 + 计数」：可加同义词归并、配对结论的句式化、把 `platform-compare.json` 的配对按平台对拆开展示 |
| P2 | 提示词模板扩展到更多环节 | 现在只有「⑤ 文件汇总」的 style/focus；关键词验证的 style/focus 还是手填 |
| P3 | 文件汇总支持 OCR | `extract_files.py` 对扫描件只提示不识别；可接 PaddleOCR / tesseract（属于新依赖，需用户同意） |
| P3 | 把关键词验证接进「一键全流程」 | 现在一键流程没有这一步 |
| P3 | 导出目录变更后自动迁移产物 | 现在改目录只影响扫描，历史产物仍在旧路径 |

### 8.3 明确**不要**做的事

- 不要移动 `.agents` / `tools` / `.venv` / `artifacts` / `data` 出项目根（会破坏技能发现与相对路径）。
- 不要给 `启动.cmd` 加中文（cmd 会解析失败）。
- 不要改 `tools/MediaCrawler` 的上游源码（只允许 `sitecustomize.py` 这种旁路）。
- 不要为了排错而 `git clean`/删 `artifacts`（里面是真实数据）；要清就只清 `_recon/` 与 `verify-*` 测试目录。
- 不要在没确认的情况下把服务重启到别的端口或另起一个服务实例（会导致"两个进程抢 7801"的假故障）。

---

## 9. 验证脚本（`_recon/scripts/`，可随时删）

这些脚本是"用真实浏览器/真实接口验证界面，而不是靠断言"的工具箱：

| 脚本 | 用途 |
|---|---|
| `ui-audit2.mjs` | 逐页遍历所有按钮，检查「点击是否派发 / 是否有请求 / 是否有反应 / 控制台报错 / 4xx-5xx」。已覆盖六页，会自动跳过"真跑/花钱"的长任务按钮。⚠️ **跳过名单靠标签文字匹配，改界面文案后必须同步**：实测「开始一键流程」因为名单里写的是「一键全流程」而漏跳，审计真的把整条流水线跑起来了（生成了汇总、还起过 DSH 总结）。同理「汇总」系列（`汇总` / `汇总选中项` / `汇总这一条`）都必须跳过 |
| `verify-login-preflight.mjs` | 触发一次只选未登录平台的关键词验证，验证「全部未登录 → 快速失败」分支 |
| `verify-kv-typing.mjs` | 回归「②页手打关键词报 `Cannot set properties of null`」：连受控 Edge 硬刷新②页 → 真实输入/切平台 → 断言 `#kvSelectionInfo` 正常回填且页面零未捕获异常（9/9 通过） |
| `e2e-one-digest.mjs` | ①页「单条聊天记录汇总」端到端：挑一条扫描到的记录 → 全量 / 限日期范围 / 会话名子串 / 关媒体校验 / 自定义输出目录 → 校验 5 件产物与条数 → 越界写入拦截 → 自动清理 |
| `verify-one-digest-ui.mjs` | ①页新区域的界面验证（连受控 Edge）：下拉是否列出全部记录（含已汇总）、信息行、参数默认值、「填充时间范围」是否真填上、按钮与状态联动、零异常（12/12 通过） |
| `verify-exports-hide-filter.mjs` | 验证①页「隐藏已汇总」把所有记录藏起来时表格会给出可读说明 + 计数徽标（而不是让人以为新记录没扫到），并在结束时恢复现场（6/6 通过） |
| `e2e-docs-summary.mjs` | 文件汇总端到端：临时注册 mock AI → 上传 PDF → 解析 → AI 汇总 → 校验产物 → **自动清理** |
| `e2e-docs-local.mjs` | ★ **文件汇总的「无 AI 本地规则」路径**端到端：上传（0.9KB 样本 PDF + 762KB 真实 PDF + 合成中文通知）→ 提取 → 汇总 → 校验六个小节与抽出的日期/电话/邮箱/金额/跨文件共性主题 → 模板保存·覆盖·删除 → 自动清理（实测 33/33 步） |
| `e2e-keyword-local.mjs` | ★ **关键词「跨平台互比 + 本地汇总」**端到端（真实采集）：登录判定 → 逐平台采集 → 跨平台互比 → 汇总 → 校验 `verify-report.md`/`verify-summary.md` 与 `_platform/` 产物。可传参：`node _recon/scripts/e2e-keyword-local.mjs "关键词" "zhihu,bili" 5` |
| `e2e-keyword-verify.mjs` | 关键词验证端到端：提候选词 → 逐词采集（知乎）→ 比对 → 报告 |
| `mock-ai.mjs` | 本地零依赖 mock OpenAI 服务（7899），用于不花钱验证 AI 链路 |
| `probe-login-api.py` / `probe-xhs-login.py` | 登录判定的侦察脚本（对比 cookie / 接口 / DOM 三种判法） |
| `verify-splitters*.mjs`、`verify-dblclick-reset.mjs` | 布局拖动与双击复位 |
| `verify-dir-settings.mjs` | 目录位置设置（含无效路径回退） |
| `verify-badge*.mjs`、`verify-events.mjs` | 列表徽标刷新、SSE 事件 |
| `cleanup-mock-provider.mjs` | 清理测试期间注册的 mock AI 服务 |
| `check-edge-tabs.cjs` | 查看/清理 Edge 调试实例里的标签页（审计前用） |

**用 mock AI 测试后一定要清理**：删除临时服务（`POST /api/provider/delete`）+ 停掉 mock 进程 + 删掉测试产物目录。当前状态是干净的（`ai.providers = []`，`secrets/` 为空）。

> ⚠️ **别用 PowerShell 的 `Invoke-RestMethod` 发带中文的 JSON 请求体**：它不会按 UTF-8 编码，中文会变成 `????`，
> 结果是生出一堆 `_`（关键词变成空字符串）的假产物——这不是应用 bug。要发中文要么用**浏览器界面**，
> 要么用 **Node 的 `fetch` + `JSON.stringify`**（`_recon/scripts/e2e-keyword-verify.mjs` 就是这么做的，实测中文正常）。
> 顺带一提：日志/报告里的中文在 PowerShell 控制台也可能显示成 `??`，那只是终端编码，文件本身没问题——用 `read` 工具看文件确认。

---

## 10. 常见操作速查

```powershell
# 启动控制台（或直接双击 app\启动.cmd）
cd "D:\summary-workspace\app"; node server\main.mjs

# 健康检查 / 是否已有实例
Invoke-RestMethod http://127.0.0.1:7801/api/health

# 语法检查（改完前后端各来一次）
node --check app\server\keyword-verify.mjs
node --check app\web\app.js

# 单独跑群聊汇总（技能层，不经界面）
.venv\Scripts\python.exe .agents\skills\qq-group-summary\scripts\qq_group_digest.py --export "data\qq-chat-exporter\exports\<目录>" --out "artifacts\qq\<目录>" --media-check

# 采前登录判定（cwd 必须是 tools\MediaCrawler）
cd tools\MediaCrawler
& "..\..\.venv\Scripts\python.exe" "..\..\app\server\tools\check_login.py" xhs zhihu bili

# 六页按钮审计
node _recon\scripts\ui-audit2.mjs
```

**改完前端后**：用户必须在 Edge 调试窗口里按 **Ctrl+F5** 强刷（缓存旧 `app.js` 会导致"点了没反应"），并且只保留一个控制台标签页。
**改完后端后**：重启 `node server/main.mjs`（有健康检查防重复实例）。

---

## 11. 一句话交接

> 技能三件套（qq-group-summary / social-crawl / cross-compare）+ 本地控制台（app，六页）已经全部打通并实测；
> 关键词验证现在是**「纯社媒跨平台互比」**（不需要群聊，可选叠加群聊对照），文件汇总也有**可保存复用的提示词模板**；
> 两条链路的「汇总」都**不再硬依赖 AI**：没配 AI 时走本地规则版（`local-summary.mjs` + `tools/summarize_local.py`），配好后重跑自动升级为大模型版。
> 现在**卡在用户侧的只剩两件事**：小红书登录态（登录后即可跑全平台互比）、以及**还没有配置真实 AI 服务**（配了才有观点层面的结论、AI 判定与 API 总结）。
> 剩下的都是 P2/P3 打磨项，见 8.2。
