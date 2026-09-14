# 群聊汇总 × 社媒比对 工作流（安装说明）

本目录用三个自研 skill + 两个第三方组件实现：

```
QQ 群聊导出 ──▶ qq-group-summary ──▶ artifacts/qq/<群>-<区间>/normalized.jsonl
                                              │
社媒公开内容 ──▶ social-crawl ─────▶ artifacts/social/<批次>/*.jsonl
                                              │
                                              ▼
                                    cross-compare ──▶ artifacts/compare/<日期>/compare.md
                                                              │
                                                              ▼
                                                      Agent 撰写二次总结
```

## 一、已安装内容

| 组件 | 位置 | 来源 / 许可 | 说明 |
|---|---|---|---|
| `qq-group-summary` | `.agents/skills/qq-group-summary/` | 自研（本工作区） | 解析聊天导出 → 分类/重要度/按天汇总。**操作手册：`GUIDE.md`；可调规则：`config.json`** |
| `social-crawl` | `.agents/skills/social-crawl/` | 自研封装 | 调用本地 MediaCrawler 采集，只读 |
| `cross-compare` | `.agents/skills/cross-compare/` | 自研（本工作区） | 群聊 × 社媒交叉比对材料 |
| MediaCrawler | `tools/MediaCrawler/` | 上游 `NanmiCoder/MediaCrawler`（64.9k★）<br>**NON-COMMERCIAL LEARNING LICENSE 1.1** | 小红书/知乎/B站等 7 平台采集后端 |
| qq-chat-exporter（QCE） | **由用户自行安装**（Release 安装包或 Docker） | 上游 `shuakami/qq-chat-exporter`（5.1k★）<br>**GPL-3.0** | 本机导出 QQ 群聊记录与图片/文件 |
| Python 虚拟环境 | `.venv/` | — | MediaCrawler 依赖（Python ≥3.11） |

> 许可提醒：MediaCrawler 限学习研究、**禁止商业用途**；QCE 为 GPL-3.0。若把本工作区公开或商用，请先复核这两项许可。

## 二、已核实的上游安全结论（安装前审读）

- **MediaCrawler**：通过 Playwright/CDP 复用本机浏览器登录态，不做 JS 逆向加密、不内置数据上传；但含代理池、代理服务商 key 等配置项，默认全部关闭，本工作区不启用。
- **qq-chat-exporter**：Rust 实现，本地读取解析，官方声明「没有服务器或数据传输」；仅在 Docker/一键安装包路径下运行，本工作区不编译其源码。
- 本工作区的封装脚本 (`crawl.py`) 只拼命令行、不写任何平台 cookie 到磁盘；`qq_group_digest.py` 只读输入、纯标准库、不联网。

## 三、需要用户执行的两步

1. **安装 QCE 并导出群聊**（唯一必须由你操作的一步，因为需要 QQ 扫码登录）：
   - 从 <https://github.com/shuakami/qq-chat-exporter/releases> 下载 `QQChatExporter-Installer-v6.3.0.exe`（或 `NapCat-QCE-Windows-x64-v6.3.0.zip` 免安装）；
   - 扫码登录 → 选择目标群 → 导出 **JSON**，并勾选下载图片/文件；
   - 把导出目录路径告诉我。
2. **Edge 登录态**（社媒采集用）：运行 `tools\launch-edge-cdp.ps1` 启动带 CDP 调试端口的 Edge，然后在该窗口登录小红书/知乎/B站（详见 `social-crawl` 技能说明）。

## 四、自检命令

```powershell
# 1) 群聊解析（用示例数据可先验证链路）
python .agents/skills/qq-group-summary/scripts/qq_group_digest.py --src "<导出目录>" --out "artifacts/qq/test"

# 2) 采集命令预览（不真正发起请求）
python .agents/skills/social-crawl/scripts/crawl.py --platform xhs --keywords "测试" --out "artifacts/social/_dry" --print-cmd

# 3) 交叉比对
python .agents/skills/cross-compare/scripts/compare.py --qq "artifacts/qq/test" --social "artifacts/social/<批次>" --out "artifacts/compare/test"
```

## 五、目录约定

- 所有产物写在 `artifacts/` 下（`qq/`、`social/`、`compare/`），便于清理与回溯。
- `artifacts/_samples/` 是自检用示例数据（合成，非真实数据）：`qq/export-sample.json`、`social/**/*.jsonl`。
- `artifacts/*/_selftest/` 是用示例数据跑通链路的产物，可随时删。
- `_recon/` 是安装期的调研缓存（上游 README、许可、探查脚本），可整目录删除。

## 六、安装自检结果（本机实测）

| 检查项 | 结果 |
|---|---|
| Python 虚拟环境 + MediaCrawler 全部依赖 | ✅ 已装（Python 3.14.7，含 opencv/pandas/matplotlib/playwright） |
| MediaCrawler CLI 可加载 | ✅ `main.py --help` 正常（**必须在 tools/MediaCrawler 目录下运行**，脚本已处理 cwd） |
| `qq_group_digest.py` | ✅ 示例数据 9 条消息全部解析，输出 3 个日期 digest + 待办 + 媒体清单 + 报告 |
| `compare.py` | ✅ 示例数据产出 4 组配对、5 个共同主题 |
| `crawl.py` 参数组装 | ✅ 命令正确；实测已进入 CDP 模式并等待 `127.0.0.1:9222` |
| MediaCrawler 连接 Microsoft Edge 的 CDP 链路 | ✅ 实测连通：Edge 153.0.4234.32，`/json/version` 返回 `Edg/153`，MediaCrawler 的 CDP 管理器成功接管上下文（UA 含 `Edg/153`，非 Chrome 指纹） |
| 社媒真实采集 | ⏳ **待你在 Edge 调试窗口登录小红书/知乎/B站** |
| QQ 群聊真实数据 | ⏳ **待你安装 QCE 并导出** |

