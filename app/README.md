# 本地控制台（桌面端的 Web 形态）

把原来要敲命令的整条链路变成点按钮：**扫描导出 → 群聊汇总 → 采集社媒 → 关键词验证 → 交叉比对 → 文件汇总 → 生成总结**。

- 给别人/给自己看的操作说明：**[`GUIDE.md`](GUIDE.md)**
- 三个技能本身的说明：`../.agents/skills/*/GUIDE.md`

## 快速开始

双击 `启动.cmd`（或在本目录执行 `node server/main.mjs`）。
启动后会自动：挑选空闲端口 → 打开浏览器 → 拉起 Edge 调试实例（9222）→ 拉起 DSH（3080）。

## 目录结构

```
app/
├─ 启动.cmd            双击启动
├─ GUIDE.md            使用说明（含排错）
├─ package.json        仅用于 `npm start`，无第三方依赖
├─ server/             后端（Node 内置模块，零依赖）
│   ├─ main.mjs        入口：启服务 + 拉起 Edge/DSH + 打开浏览器
│   ├─ server.mjs      HTTP 路由（静态页面 + JSON API + 日志 SSE）
│   ├─ paths.mjs       路径与默认配置常量
│   ├─ config.mjs      配置读写 + 密钥（Windows DPAPI 加密）
│   ├─ jobs.mjs        任务模型：子进程执行、日志流、取消
│   ├─ startup.mjs     Edge / DSH 的探测与启动
│   ├─ skills.mjs      调用三个技能脚本（Python）
│   ├─ exports.mjs     导出扫描、归档、删除（回收站）、产物读取
│   ├─ ai.mjs          AI 调用（OpenAI 兼容 / Anthropic / 预设）+ 费用估算
│   ├─ summarize.mjs   总结生成：DSH / API / 提示词 三条路，按天分块
│   ├─ review.mjs      AI 复判分类与重要度、AI 判定比对结论
│   ├─ keyword-verify.mjs  关键词验证：采前登录判定 → 逐词逐平台采集 → 跨平台互比（可选叠加群聊对照）→ 汇总
│   ├─ files.mjs       上传文件：接收 → 提取文本 → 文档汇总（含提示词模板）
│   ├─ local-summary.mjs  汇总引擎选择：AI 可用性探测 + 本地规则保底（没配 AI 也能出汇总）
│   └─ tools/          本地 Python 工具（均已并入 .venv）
│       ├─ extract_keywords.py  候选关键词提取（jieba + TF-IDF，不联网）
│       ├─ extract_files.py     PDF/Word/PPT/Excel/HTML 抽文本
│       ├─ compare_platforms.py 跨平台互比（复用 cross-compare 的分词/主题/打分）
│       ├─ summarize_local.py   本地规则汇总（social / docs 两种模式，不联网）
│       └─ check_login.py       采前真实登录态判定（cookie 存在性 + 页面/接口判定）
├─ web/                前端（原生 HTML/CSS/JS，无框架）
│   ├─ index.html      六页布局
│   ├─ styles.css
│   └─ app.js
└─ .local/             运行时私有目录（首次启动自动创建）
    ├─ config.json     配置
    └─ secrets/        API Key（DPAPI 加密后的二进制）
```

## 设计要点

- **零第三方依赖**：只用 Node 内置模块，不需要 `npm install`，升级 Node 即可。
- **密钥加密**：API Key 用 `ProtectedData`（Windows DPAPI，CurrentUser）加密后落盘，只有当前 Windows 用户能解密；界面只显示"已配置/未配置"。
- **两条总结路径并列**：本地 DSH（走技能、无需额外配置）或自有 API（OpenAI 兼容 / Anthropic / 常见厂家预设）。
- **一键流程可断点继续**：勾选本次要跑的步骤，失败停在当前步，可「从断点继续」，已完成步骤不重跑。
- **只读采集**：社媒采集沿用 `social-crawl` 技能，不发布、不评论、不点赞。
- **采前登录判定**：采集与关键词验证开跑前先做一次真实登录检查（小红书看个人页是否被重定向到 `/login`，知乎/B站打「我是谁」接口）。
  未登录的平台跳过、全部未登录则立即失败——避免 MediaCrawler 卡在扫码轮询上白等 8 分钟。
- **汇总引擎 AI 优先、本地保底**：关键词社媒汇总与文件汇总都走 `local-summary.mjs`——配了可用的 AI 服务就用大模型，
  没配（或调用失败）就用本地 Python 规则汇总，产物同名同位置、只在文件头标「生成方式」，配好 AI 重跑即自动升级。
- **跨平台互比**：同一个关键词在各平台采到的内容互相比对（共识主题 / 平台独有视角 / 跨平台配对 / 疑似同源），
  不依赖群聊；比对口径与 `cross-compare` 共用同一份分词、主题词表与打分参数。
- **提示词模板**：文件汇总的「风格要求 + 重点关注」可存成模板复用，存在本机 `config.json`，不上传、不进 AI。
  只看 cookie 会误判：实测小红书会保留 `web_session` 而服务端会话已失效。
- **本地解析不上传**：关键词提取与文档抽文本全部在本机 Python 完成，不联网、不经过 AI。
- **删除可恢复**：导出记录删除走回收站；归档是移动到 `data/qq-chat-exporter/archive/`。
