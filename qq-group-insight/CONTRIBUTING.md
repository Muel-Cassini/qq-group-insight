# 参与贡献

感谢愿意一起改进这个项目。为了不踩隐私与许可的坑，动手前请先看下面几条。

## 绝对不要提交的内容

| 内容 | 原因 |
|---|---|
| `data/`（聊天导出、图片、文件） | 真实昵称与聊天内容，属于个人隐私 |
| `artifacts/`（汇总、采集、比对、上传产物） | 同上，且包含真实社媒作者与链接 |
| `app/.local/`（`config.json`、`secrets/`） | 本地路径信息与 API Key（DPAPI 也只能当前用户解密） |
| 任何 Cookie / Token / 登录态 | 敏感凭据，且会直接导致账号风险 |
| `tools/MediaCrawler/`（上游源码） | 第三方项目、禁商用许可，应由使用者自行获取 |

`.gitignore` 已覆盖以上路径；提交前请用 `git status` 再确认一次。
需要演示数据时，请**自己造合成数据**放进 `artifacts/_samples/`（不要从真实数据里剪一段）。

## 开发环境

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd app; node server\main.mjs     # http://127.0.0.1:7801/
```

## 改代码时的约定

- **根锚定**：`.agents/`、`tools/`、`.venv/`、`artifacts/`、`data/` 必须留在项目根，脚本里大量使用相对路径。
- **零第三方依赖（Node 侧）**：后端只用 Node 内置模块，不要引入 npm 依赖。
- **前端改动要强刷**：控制台页面按 `Ctrl+F5`，否则会加载缓存的 `app.js`，表现为「点了没反应」。
- **后端改动要重启**：`node server/main.mjs`（有健康检查，防止重复实例抢同一端口）。
- **改完先做语法检查**：`node --check <file>.mjs`、`.\.venv\Scripts\python.exe -m py_compile <file>.py`。
- **不要改 `tools/MediaCrawler`**：需要调整行为时，通过环境变量或旁路（如 `sitecustomize.py`）实现。
- **不要给 `app/启动.cmd` 加中文**：`cmd.exe` 按 ANSI 读取，加中文会导致启动失败（该文件必须 ASCII-only）。

## 提交前自检

```powershell
node --check app\web\app.js
git status                # 确认没有 data/ artifacts/ app/.local/ 混进来
git diff --cached --stat  # 确认改动范围
```

如果改动涉及采集、登录判定、密钥或路径处理，请**实际跑一次**并把结果写在 PR 描述里
（说明你验证了哪条链路、看到了什么现象），而不是只写「应该没问题」。

## 提交信息

建议用一句中文或英文说清「改了什么、为什么」：

```
fix(auth): 采前登录判定不再把失效的 cookie 当作已登录
feat(digest): ①页支持按日期区间汇总单条记录
docs(readme): 补充 MediaCrawler 的许可限制说明
```

## 报告问题

- 一般问题 / 功能建议：开 Issue，请**脱敏**后再贴日志（把群名、昵称、链接都替换掉）。
- 安全漏洞：按 [`SECURITY.md`](SECURITY.md) 的方式私下报告，**不要**开公开 Issue。
