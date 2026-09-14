# qq-group-summary 操作指南

> 本文件是**给人看的操作手册**；给 Agent 看的规则在 `SKILL.md`。两者内容分工：SKILL.md 说明"该怎么写汇总"，
> 本文件说明"怎么把脚本跑起来、参数怎么填、出问题怎么查、规则怎么调"。
>
> 实测口径：QQ Chat Exporter (QCE) v6.3.0 + Python 3.14 + Windows PowerShell。

---

## 1. 它能做什么

读取 QCE 导出的 QQ 群聊记录（文本 / 图片 / 文件 / 转发 / 系统提示），归一化成统一字段，然后产出：

- **每日汇总**（`digest/YYYY-MM-DD.md`）：P0/P1 聚焦区 → 待回应提问 → 按主题分类，类内时间倒序；
- **跨天待办清单**（`p1-todo.md`）：所有 P0/P1，时间倒序，带群名；
- **媒体清单**（`media-index.md`）：图片/文件/视频的时间、群、发送人、消息摘要、磁盘路径、是否存在；
- **归一化数据**（`normalized.jsonl`）：供交叉比对（`cross-compare` 技能）或自写脚本消费；
- **解析报告**（`_report.md`）：消息统计、时间口径说明、导出侧原始统计。

**它不做**：不导出聊天记录（那是 QCE 的活）、不修改/移动原始导出、不联网、不上传任何内容、不"看"图片（图片内容由 Agent 在支持视觉的模型下读取）。

---

## 2. 前置：用 QCE 导出

QCE 位置：`%LOCALAPPDATA%\QQChatExporter`，服务端口 **40653**，界面 <http://localhost:40653/qce>（若提示要令牌，见启动控制台输出的 token）。

1. 打开界面 → 左侧选目标群；
2. 格式选 **JSON**（记录特别长可用 JSONL）；
3. **务必勾选下载图片/文件/表情** —— 不勾选时媒体清单只能登记引用名，无法读图；
4. 输出目录（本工作区统一放在项目根的 `data/qq-chat-exporter/` 下，便于整目录备份与迁移）：
   - 手动导出 → `<项目根>\data\qq-chat-exporter\exports`
   - 定时导出 → `<项目根>\data\qq-chat-exporter\scheduled-exports`

导出后的目录结构（`--media-root` 要指向这一层）：

```
exports\
  group_示例群A_1011090214_20260912_214920323.json   记录本体（群号 1011090214，末尾为导出时间）
  resources\images\<md5>_<原文件名>.jpg                 图片实际文件
  resources\file\  resources\video\  resources\audio\   其它媒体
```

---

## 3. 跑汇总

### 3.1 标准命令

```powershell
python .agents/skills/qq-group-summary/scripts/qq_group_digest.py `
  --src "data/qq-chat-exporter/exports/group_示例群A_1011090214_20260912_214920323.json" `
  --out "artifacts/qq/示例群A-20260909-20260912" `
  --media-root "data/qq-chat-exporter/exports" `
  --media-check
```

`--src` 既可以是**单个文件**，也可以是**整个目录**（目录会递归找 `.jsonl/.ndjson/.json`，并自动跳过 `images/ emoji/ cache/ node_modules/` 等子目录，所以直接指向 `exports` 也安全）。

### 3.2 参数表

| 参数 | 必填 | 说明 |
|---|---|---|
| `--src` | ✅ | 导出文件或目录 |
| `--out` | ✅ | 输出目录（工具**只**在此目录下写文件） |
| `--media-root` | 建议 | 媒体根目录；省略则默认取 `--src` 所在目录 |
| `--media-check` | 建议 | 在每个媒体路径上真实探测文件是否存在；不加则"存在"列显示"未校验" |
| `--chat "子串"` | 多群时用 | 只保留群名/群号含该子串的会话（不区分大小写） |
| `--from YYYY-MM-DD` | 可选 | 起始日期（闭区间，UTC+8） |
| `--to YYYY-MM-DD` | 可选 | 结束日期（闭区间） |
| `--config <路径>` | 可选 | 指定规则配置；默认用技能目录下的 `config.json` |

### 3.3 推荐节奏

1. **先干跑**：`--src` 指单个 JSON、不加 `--media-check`，确认消息数对得上（对照 `_report.md` 与 QCE 界面的条数）；
2. **再加媒体校验**：补 `--media-root` + `--media-check`，看"存在=❌"的比例；
3. **最后让 Agent 写汇总**：把输出目录交给 Agent（或直接说"用 qq-group-summary 汇总这个目录"）。

### 3.4 自检（换群 / 换 QCE 版本后建议做）

```powershell
python .agents/skills/qq-group-summary/scripts/qq_group_digest.py `
  --src "artifacts/_samples/qq" --out "artifacts/qq/_selftest"
```

预期：`messages: 9`、`days: 3 个`、`skipped: 0`。

---

## 4. 输出怎么读

| 文件 | 关键内容 | 用法 |
|---|---|---|
| `digest/YYYY-MM-DD.md` | 头部统计（消息数/发言人数/媒体数/重要度分布/社媒链接数）→ P0/P1 聚焦区 → 待回应提问 → 分类小节 | 主读物 |
| `p1-todo.md` | 跨天 P0/P1，时间倒序 | 只要"要我做什么"看这个 |
| `media-index.md` | 媒体表（时间/群/发送人/类型/摘要/路径/存在） | 读图时按 `abspath` 取文件 |
| `normalized.jsonl` | 每行一条：`time/day/sender_name/kind/content/media/links/recalled/is_system/forwarded` | 交给比对脚本，或自己 grep/jq |
| `_report.md` | 解析统计 + 时间口径 + 导出侧统计 | 先看它确认没丢数据 |

标记含义：

- `[P0]`~`[P3]` 重要度（见 §5）；
- `` `[image×2]` `` 该条消息带 2 张图；
- `[图片:xxx.jpg]` / `[回复消息]` / `[JSON消息]` 是 QCE 原文里的占位文本，未做二次加工。

---

## 5. 规则怎么调（改 `config.json`，不用动代码）

配置文件：`.agents/skills/qq-group-summary/config.json`，**每次运行都会重新读取**，改完直接生效。
优先级：`--config <路径>` > 技能目录 `config.json` > 脚本内置默认值。字段写错只会忽略该字段并打印警告，不会中断解析。

| 配置块 | 作用 |
|---|---|
| `categories[]` | 主题分类：`name` + `keywords`；**数组顺序即优先级**（先命中先归类）。末尾自动兜底为「闲聊」 |
| `p0_time_patterns[]` | P0 的一侧：时间/紧迫标记（@全体成员、紧急、今日截止、尽快、务必…） |
| `p0_action_patterns[]` | P0 的另一侧：行动词（投递、报名、截止、提交、面试…）。**两者共现才判 P0** |
| `p1_patterns[]` | P1：@我、待办、记得、麻烦、求助/求内推、确认一下、真实提问句 |
| `p1_exclude_patterns[]` | 寒暄/情绪白名单（"？"、"好的"、"牛逼"…），命中则不判 P1 |
| `p2_category_hint` | 哪些类别默认按 P2 处理（正则，默认 `资源分享|技术讨论|公告通知`） |
| `media_ext{}` | 各类型媒体扩展名，决定图片/视频/音频/文件的归类 |
| `display_limits{}` | 预览截断长度：`preview_chars`、`focus_preview_chars`、`pending_question_preview_chars`、`media_summary_chars` |

### 调参经验（实测教训）

1. **P0 必须要求"共现"**。第一版只用 `务必/马上/紧急` 单词判定，结果"🐟神务必教我人情世故""马上学硕倒闭了"这类玩梗把 P0 刷到 7 条；改成「时间标记 + 行动词共现」后精准落到 3 条（全部是 OPPO 校招截止公告那串）。
2. **P1 不要用裸 `？`**。群友"@某人 ？"式闲聊会淹没真问题（实测 375 → 43 条）；改用"疑问词 + 至少 2 个后续字符"来提高门槛。
3. **按群定制关键词**。同一份默认规则在求职群会把"面试/offer/薪资"算成技术讨论，改成领域词（本仓库已在 config 里加了 `宣讲会/校招/内推/投递/综测/学时/问卷`）归类明显更准。
4. **改完做对比**：改配置后用同一个 `--out` 重跑，对比各日「重要度分布」与分类小节数量，判断改动是否符合预期。

---

## 6. 数据口径（必须知道的几个坑）

1. **时间以 epoch 时间戳为准，转 UTC+8**。QCE v6.3.0 的 `time` 字符串与它自己的 `timestamp` 相差 8 小时（本地时间被当成 UTC 又加了一次 +8 的典型 bug）——JSON 里 `"time": "...T04:23:40Z"` 的真实本地时间是 **12:23**。日期分组两种口径落在同一天，所以按天切分不受影响，但钟点会差 8 小时。`_report.md` 也记录了这一条。
2. **群名/群号在文件顶层 `chatInfo`**（不在消息里），工具会自动补到每条消息上。
3. **发送人取群名片优先**：`groupCard > name > remark > nickname > uin`，并剔除群名片里的零宽字符（`\u200b`，群里很常见）。
4. **媒体路径相对导出目录**（`resources/images/...`）；同一张图可能被多条消息（含转发内部）引用，媒体清单已按绝对路径去重。
5. **QCE v6 把元素字段放在 `element["data"]`**（`type/url/localPath/subType`），老版本结构不同；换版本后建议先跑 §3.4 自检。
6. 转发的合并聊天记录里的图片也会被提取，归属到转发容器消息上。

---

## 7. 常见故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 媒体清单全是"未校验" | 没传 `--media-check` | 加上 `--media-check` 与正确的 `--media-root` |
| 媒体"存在=❌" | 导出时没勾选媒体下载，或 `--media-root` 指错 | 重导并勾选媒体；确认 `resources/images` 下真有文件 |
| 正文有 `[图片:xxx.jpg]` 但清单里没有该图 | 磁盘上找不到对应文件（导出被裁剪/移动） | 检查导出目录是否完整 |
| 消息数少于 QCE 界面显示 | `--chat/--from/--to` 过滤，或 `--src` 指到了旧文件 | 去掉过滤重跑，看 `_report.md` 每文件解析量 |
| 日期/钟点与 QCE 界面不一致 | 见 §6 第 1 条 | 以 epoch 为准，属预期行为 |
| 发送人显示成一坨 JSON | 用了修复前版本的脚本 | 确认用的是本技能目录下的 `qq_group_digest.py` |
| 打印 `[WARN] config.json ...` | 配置某字段类型写错 | 按警告里的字段名修正；不修也能跑（用默认值） |
| 列表混入大量广告/玩梗 | 该群语境与默认关键词不匹配 | 按 §5 调 `categories` / `p0_*` / `p1_*` |

**自检三步**（换群、换版本、怀疑结果时）：① 跑 §3.4 样例；② 真数据跑完看 `_report.md` 的"丢弃/缺时间戳/缺发送人"是否都为 0；③ 抽 3 条消息与 QCE 界面原文比对。

---

## 8. 图片与后续流程

- **图片内容需要视觉模型**：`media-index.md` 中标 ✅ 的图片，由 Agent 用图片读取能力逐张查看，并把视觉信息写进摘要。若当前模型不支持图片输入（`read_image` 会直接报错），必须显式说明"图片未读取"，或先切到支持视觉的模型再跑这一环——**不要凭文件名/体积编造图片内容**。
- **接交叉比对**（`cross-compare` 技能）：

```powershell
python .agents/skills/cross-compare/scripts/compare.py `
  --qq "artifacts/qq/示例群A-20260909-20260912" `
  --social "artifacts/social/<采集批次>" `
  --out "artifacts/compare/<日期>"
```

- **定时导出 / 增量**：QCE 定时任务输出到 `scheduled-exports` 后，重复执行 §3.1 即可；每次建议换新的 `--out`（例如带日期），或先用 `--from/--to` 只处理新增日期。

---

## 9. 文件速查

```
.agents/skills/qq-group-summary/GUIDE.md                      本操作指南
.agents/skills/qq-group-summary/SKILL.md                      Agent 用技能说明
.agents/skills/qq-group-summary/config.json                   可调规则
.agents/skills/qq-group-summary/scripts/qq_group_digest.py    解析与汇总脚本
artifacts/_samples/qq/export-sample.json                      自检样例
artifacts/qq/<群>-<日期区间>/                                  产物输出位
data/qq-chat-exporter/exports                                 手动导出（QCE 输出到这里）
data/qq-chat-exporter/scheduled-exports                       定时导出（按需创建）
```
