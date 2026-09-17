# QQ 群聊汇总 × 社媒交叉比对工具链

把一个 QQ 群的聊天导出，变成**可读、可核对**的结论；再用小红书 / 知乎 / B站 的**公开内容**做交叉验证；
并自带一个本地 Web 控制台，把整条链路变成点按钮。

> **本地优先**：聊天记录、上传文档、API Key 全部留在你自己的机器上。
> 只读采集公开内容，不发布、不评论、不点赞；只判断登录态存在性，**绝不读取或上传 cookie 值**。

---

## 1. 它解决什么问题

群聊里真正有用的信息（报名截止、内推渠道、踩坑经验）会被大量闲聊淹没；而群外的公开平台上往往有更新、
更完整的说法。这个项目做三件事：

1. **群聊汇总**：按「主题分类 + 重要度分级 + 按天切分」生成每日 digest、P0/P1 待办、媒体清单与整体汇总；
2. **社媒交叉比对**：把群里的说法与小红书/知乎/B站 的公开内容对照，标出**互证 / 补充 / 冲突**；
3. **文档汇总**：把招聘公告、通知 PDF、报名表等群外文档也纳入总结，并能保存/复用提示词模板。

---

## 2. 功能一览

| 页面 | 能做什么 |
|---|---|
| ① 导出与汇总 | 扫描导出记录 → 批量汇总 / **单条记录汇总**（可限定日期范围、会话名、媒体校验、自定义输出目录）；查看汇总产物（`overall.md`、每日 digest、P1 待办、媒体清单） |
| ② 采集与关键词 | 本地提取候选关键词（jieba + TF-IDF，不联网）→ 逐词逐平台采集 → **跨平台互比**（共识主题 / 平台独有视角 / 跨平台配对 / 疑似同源）→ 汇总 |
| ③ 交叉比对 | 群聊汇总 × 社媒采集 交叉比对，并可让 AI 判定「印证 / 补充 / 冲突」 |
| ④ 总结 | 三条路生成最终总结：本地 DSH / 自有 API / 只生成提示词 |
| ⑤ 文件汇总 | 上传 PDF/Word/Excel/PPT/文本 → 本地抽文本 → 汇总（含可保存复用的提示词模板） |
| ⑥ 设置 | AI 服务与密钥、导出目录、端口、分类模式等 |

**汇总引擎是「AI 优先、本地保底」**：配了可用的 AI 服务就用大模型，没配（或调用失败）就用本地规则汇总，
两种产物同名同位置、只在文件头标注「生成方式」，配好 AI 重跑一次即自动升级。

**可选**：一键全流程（汇总 → 推荐关键词 → 采集 → 比对 → 总结，可断点继续）、拖动布局、任务日志实时上屏。

---

## 3. 架构

```
本地 Web 控制台（Node 内置模块，零第三方依赖）
  app/server/*.mjs  ── JSON/SSE 路由、任务管理、配置与 DPAPI 密钥
  app/web/*         ── 原生 HTML/CSS/JS 六页界面
        │
        ├─ 调用技能脚本（Python）
        │    .agents/skills/qq-group-summary  群聊解析与按天汇总（读 QCE 导出 JSON）
        │    .agents/skills/social-crawl      小红书/知乎/B站 只读采集（封装 MediaCrawler）
        │    .agents/skills/cross-compare     两侧交叉比对（纯本地文本比对，不联网）
        │
        ├─ 本地工具（Python，不联网）
        │    extract_keywords.py   候选关键词（jieba + TF-IDF）
        │    extract_files.py      PDF/Word/Excel/HTML 抽文本
        │    compare_platforms.py  跨平台互比（复用 cross-compare 的分词与打分）
        │    summarize_local.py    本地规则汇总（social / docs 两种模式）
        │    check_login.py        采前真实登录判定
        │
        └─ 外部程序（不随本仓库发布）
             QQ Chat Exporter（QCE）：把 QQ 聊天记录导成 JSON
             MediaCrawler：社媒采集后端（CDP 复用本机 Edge 登录态）
```

**为什么技能必须放在 `.agents/skills/`**：DSH（DeepSeek Harness）从项目根的
`.agents/skills/<name>/SKILL.md` 发现技能，因此该目录要留在项目根、目录名保持 kebab-case。

---

## 4. 快速开始

**前置**：Windows 10/11、Node.js ≥ 20、Python ≥ 3.11、Microsoft Edge。

```powershell
# 1) 取代码
git clone https://github.com/Muel-Cassini/<仓库名>.git summary-workspace
cd summary-workspace

# 2) Python 虚拟环境（根锚定：.venv 必须放在项目根）
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 3) 外部依赖：MediaCrawler（见「许可与合规」，需自行获取）
git clone https://github.com/NanmiCoder/MediaCrawler tools/MediaCrawler
.\.venv\Scripts\python.exe -m pip install -r tools\MediaCrawler\requirements.txt

# 4) 启动控制台（或直接双击 app\启动.cmd）
cd app
node server\main.mjs
# 浏览器打开 http://127.0.0.1:7801/
```

首次使用建议按顺序走一遍：**⑥ 设置**（填 QCE 导出目录，可选配 AI 服务）→ **① 导出与汇总**（扫描 → 汇总）
→ **② 采集与关键词**（提取候选词或手打关键词 → 选平台 → 开始验证）。

社媒采集前需要让 Edge 暴露调试端口，并在该窗口里登录目标平台：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch-edge-cdp.ps1
```

详细图文步骤见 **`docs/小白上手指南.md`**；界面逐页说明见 **`app/GUIDE.md`**；
想接着开发请看 **`HANDOFF.md`**（设计决策、踩坑清单、验证方法）。

---

## 5. 数据与隐私

- **真实数据不进仓库**：`.gitignore` 已排除 `data/`（聊天导出与图片）、`artifacts/`（汇总产物、采集结果）、
  `app/.local/`（配置与密钥）。仓库里只保留 `artifacts/_samples/` 下的**合成示例**。
- **本地解析**：关键词提取、文档抽文本、登录判定全部在本机 Python 完成，不联网、不经 AI。
- **发给 AI 的内容**：只有汇总文本、比对材料与上传文档抽出的文本；不发原始聊天记录文件、不发图片二进制。
  走 API 时发送前有费用预估与确认弹窗（可在设置里关闭）。
- **密钥**：API Key 用 Windows DPAPI（CurrentUser）加密后落盘，界面只显示「已配置 / 未配置」。
- **采集边界**：只读公开内容，不发布 / 不评论 / 不点赞 / 不关注；建议使用小号并控制频率。
- **提醒**：`data/` 与 `artifacts/` 含真实昵称与聊天内容——**不要**提交到公开仓库、不要上传网盘。

---

## 6. 安全

安全模型、已修复问题与已知取舍见 **`SECURITY.md`**。要点：

- **无 SQL 注入面**：自有代码**不使用任何数据库**（架构是 JSON/JSONL 文件 + 内存计算），
  全仓库检索无 SQL 调用；第三方 MediaCrawler 的数据层走 SQLAlchemy ORM。
- 已修复：命令行参数注入（`.cmd` 被 `cmd.exe` 二次解析）、静态资源与产物读取的路径包含判断、
  上传文件删除的目录边界。
- 已知取舍：控制台是**仅监听 127.0.0.1 的本地工具、没有鉴权**——不要把它暴露到公网或局域网。

---

## 7. 许可与合规（使用前请读）

| 组件 | 许可 | 说明 |
|---|---|---|
| 本仓库自有代码 | **MIT**（见 [`LICENSE`](LICENSE)） | 可自由使用、修改、分发 |
| [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | **NON-COMMERCIAL LEARNING LICENSE 1.1** | **禁止商业用途**；不随本仓库发布，需自行获取。商用必须替换掉它 |
| [QQ Chat Exporter](https://github.com/shuakami/qq-chat-exporter) | **GPL-3.0** | 独立程序；本仓库只读取它导出的 JSON |
| 小红书 / 知乎 / B站 | 各平台用户条款 | 采集前请自行确认条款与 robots 约定，控制频率，风险自负 |

> 第三方组件的完整清单、获取方式与「为什么不在仓库里」的说明见
> [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

> ⚠️ 本项目面向**个人学习与研究**。请勿用于商业用途，也不要用于批量抓取或绕开平台限制。

---

## 8. 目录结构

```
├─ app/                      本地 Web 控制台
│   ├─ 启动.cmd              一键启动（ASCII-only，勿加中文）
│   ├─ GUIDE.md              界面逐页说明（给人看）
│   ├─ server/               后端（Node 内置模块）
│   │   └─ tools/            本地 Python 工具（不联网）
│   └─ web/                  前端（原生 HTML/CSS/JS）
├─ .agents/skills/           ★ 三个技能（DSH 只认这个位置）
├─ tools/launch-edge-cdp.ps1 启动带调试端口的 Edge
├─ docs/                     上手指南与资产说明
├─ artifacts/_samples/       合成示例数据（自检用，非真实数据）
├─ SECURITY.md               安全模型与审查结论
└─ HANDOFF.md                维护者交接文档
```

运行时目录（`data/`、`artifacts/`、`app/.local/`、`.venv/`）不在仓库里，首次运行会自动创建。

---

## 9. 已知限制

- **仅支持 Windows**：依赖 DPAPI、`ShellExecuteW`、Edge CDP 与 QCE。
- **扫描件无 OCR**：`extract_files.py` 对没有文字层的 PDF 只给出提示，需要 OCR 才能汇总。
- **社媒采集受登录态与风控影响**：未登录的平台会被跳过（采前有真实登录判定），
  采集失败会明确报错，而不是静默给出空结果。
- **本地规则汇总不产生观点**：只做归并 / 摘录 / 计数；观点层面的印证与冲突需要配置 AI 服务。
- 关键词验证耗时与「关键词数 × 平台数」成正比，建议先用 1–2 个词 + 1 个平台试跑。

---

## 10. 作者与引用

作者：**卡西尼回旋于夜空**（[ORCID 0009-0005-8727-5342](https://orcid.org/0009-0005-8727-5342)）

如果这个项目对你的工作或研究有帮助，欢迎引用（仓库里已放 [`CITATION.cff`](CITATION.cff)，
GitHub 侧边栏会出现「Cite this repository」）：

```bibtex
@software{qq_group_insight_toolkit,
  author = {卡西尼回旋于夜空},
  title  = {QQ 群聊汇总 × 社媒交叉比对工具链},
  year   = {2026},
  version = {0.1.0},
  license = {MIT},
  note   = {ORCID: 0009-0005-8727-5342}
}
```

本项目基于 [MIT 许可](LICENSE) 发布；使用的第三方组件（MediaCrawler、QQ Chat Exporter 等）
各有自己的许可条款，详见上方「许可与合规」。

## 11. 参与贡献

见 `CONTRIBUTING.md`。安全问题请按 `SECURITY.md` 中的方式报告。
