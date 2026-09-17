# 第三方组件与许可声明

本仓库自有代码以 [MIT 许可](LICENSE) 发布，**该许可只覆盖本仓库自有代码**。

下面这些组件**不随本仓库发布**（有的由使用者自行获取），各有自己的许可条款，
使用本项目时请一并遵守：

| 组件 | 许可 | 关键限制 | 获取方式 |
|---|---|---|---|
| [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | **NON-COMMERCIAL LEARNING LICENSE 1.1** | **禁止商业用途**，仅限学习与研究 | `git clone https://github.com/NanmiCoder/MediaCrawler tools/MediaCrawler` |
| [QQ Chat Exporter](https://github.com/shuakami/qq-chat-exporter) | **GPL-3.0** | 按其条款使用；本仓库只读取它导出的 JSON，不修改也不分发它 | 按上游说明安装 |
| Python 依赖（pypdf / python-docx / beautifulsoup4 / pandas / openpyxl / Pillow / jieba 等） | 各自开源许可（多为 BSD/MIT/Apache-2.0） | — | `pip install -r requirements.txt` |
| Microsoft Edge / Chromium（CDP 调试实例） | 各自条款 | 仅以远程调试端口方式本机调用 | 系统自带或自行安装 |
| 小红书 / 知乎 / B站 等目标平台 | 各平台用户条款 | 只读采集公开内容，请自行确认条款与 robots 约定；控制频率，风险自负 | — |

## 商用提醒

> 若要用于商业场景，**必须先替换掉 MediaCrawler**（其许可禁止商用），
> 并自行确认其余依赖与目标平台条款。本项目面向个人学习与研究。

## 为什么这些组件不在仓库里

- **MediaCrawler**：体量大、且许可禁止商用，直接把源码放进本仓库会造成许可混淆，因此由使用者自行克隆；
  本项目只通过 `.agents/skills/social-crawl/scripts/crawl.py` 以子进程方式调用它，
  并在 `tools/MediaCrawler/sitecustomize.py` 里做**不改上游源码**的旁路配置（该文件也随上游一起由使用者获取）。
- **QQ Chat Exporter**：独立程序，本项目只读取它导出的 JSON 文件。

## 本仓库内的示例数据

`artifacts/_samples/` 下的数据（示例群聊导出、示例采集结果、测试用 PDF）均为**合成数据**，
不含任何真实聊天记录、真实账号或个人信息，可用于功能自检。
