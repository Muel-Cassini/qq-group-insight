# cross-compare 操作指南

> 本文件是**给人看的操作手册**；给 Agent 看的规则在 `SKILL.md`。
> 输入是 `qq-group-summary` 与 `social-crawl` 两个技能的产物；本技能**纯本地文本处理、不联网**。

---

## 1. 它能做什么

把「群聊汇总」与「社媒采集结果」做交叉比对，产出**比对材料**（不是结论）：

- **共同主题**：两边都在讨论的领域词及提及次数（互证点）；
- **高相关配对**：群聊消息 ↔ 社媒内容的相似度配对，带共同词、共同主题、社媒高相关评论；
- **主题明细**：每个共同主题下两侧的代表性材料；
- **单边主题**：只在群里聊的（群内私有经验）／只在社媒火的（信息差）；
- **时效性**：社媒内容相对群聊时间的先后分布（判断群里说法是否已被更新信息覆盖）。

最终「二次总结」由 Agent 读这些材料后撰写（写作要求见 `SKILL.md`）。

---

## 2. 前置产物

| 来源 | 由谁产出 | 本技能需要读的东西 |
|---|---|---|
| 群聊 | `qq-group-summary` | 输出目录里的 `normalized.jsonl` |
| 社媒 | `social-crawl` | 输出目录里的 `*.jsonl`（`contents` 与 `comments`） |

两侧都要非空；缺一侧时脚本返回 `ok:false` 并提示是哪一侧为空。

---

## 3. 跑比对

```powershell
python .agents/skills/cross-compare/scripts/compare.py `
  --qq     "artifacts/qq/示例群A-20260909-20260912" `
  --social "artifacts/social/2026-09-13-xhs-容器内存" `
  --out    "artifacts/compare/2026-09-13"
```

### 参数表

| 参数 | 默认 | 说明 |
|---|---|---|
| `--qq` | 必填 | `qq-group-summary` 的输出目录（读 `normalized.jsonl`） |
| `--social` | 必填 | `social-crawl` 的输出目录（递归读 `*.jsonl`） |
| `--out` | 必填 | 输出目录 |
| `--top` | config：`40` | 最多输出多少组配对 |
| `--min-score` | config：`0.18` | 配对最低相似度（材料太少→调低到 0.12；太杂→调高） |
| `--max-qq` | config：`0` | 只取最近 N 条群聊消息（群消息很多时用它聚焦近期；0=全部） |
| `--config` | 技能目录 `config.json` | 规则配置路径 |

---

## 4. 输出怎么读

| 文件 | 内容 |
|---|---|
| `compare.md` | 五段式报告：① 共同主题 ② 高相关配对 ③ 主题明细 ④ 单边主题 ⑤ 时效性 |
| `compare.json` | 同上的结构化版本（含 `pairs`、`shared_topics`、`topic_detail`、`freshness`），供 Agent 或脚本进一步消费 |

`compare.md` 的「高相关配对」里，**相似度只代表话题接近，不代表观点一致**——必须自己读内容判断是印证、补充还是冲突。

---

## 5. 规则怎么调（改 `config.json`，不用动代码）

配置文件：`.agents/skills/cross-compare/config.json`，**每次运行都会重新读取**。
优先级：`--config <路径>` > 技能目录 `config.json` > 内置默认值。类型写错只忽略该字段并警告。

| 配置块 | 作用 |
|---|---|
| `topic_vocab` | **可比对主题词表**（中英混排），是"共同主题"与配对加分的基础；换领域时主要调这里 |
| `lowercase_short_terms` | 允许**全小写命中**的短词白名单（如 `k8s` `api` `llm`）。不在白名单里的短 ASCII 词（长度 ≤ `ascii_case_sensitive_max_len`）只认大写缩写或"紧邻中文"的写法，用于避开昵称/英文短语的误命中 |
| `ascii_case_sensitive_max_len` | 视为"短词"的长度上限（默认 3） |
| `ascii_min_len` | ASCII 主题词的最短长度（默认 2，更短的直接忽略） |
| `stopwords_extra` | 追加停用词（会被并入内置停用词表） |
| `scoring` | 打分权重：`weight_overlap`（重合度，默认 0.45）、`weight_jaccard`（0.20）、`weight_per_topic`（每个共同主题 0.05，`topic_cap` 上限 4）、`bonus_shared_topic`（有共同主题 +0.10）、`bonus_shared_url`（共享 URL +0.05） |
| `thresholds` | `min_shared_terms`（共同词少于该数直接丢弃，默认 3）、`max_qq_per_social`（每篇社媒最多保留几条群聊配对，默认 2）、`freshness_days`（时效性判定窗口，默认 30 天） |
| `excerpt_chars` | 摘要截断长度：`qq`/`social`/`comment`/`title` |
| `defaults` | `top` / `min_score` / `max_qq` 的默认值（命令行显式给出时以命令行为准） |

### 调参经验

1. **配对太少** → 降 `thresholds.min_shared_terms`（3→2）或 `defaults.min_score`（0.18→0.12）；
2. **配对太杂** → 提 `defaults.min_score`，或把不相关领域词从 `topic_vocab` 删掉；
3. **短英文词刷榜** → 实测教训：群名片"27智能 go&Agent"让短词 `go` 命中 33 次、英文词尾让 `es` 命中 16 次，直接污染了"共同主题"表。处理办法：
   - 该词确实常用且不易误解（`k8s` `api` `llm` `sql` …）→ 加进 `lowercase_short_terms`；
   - 该词歧义大（`go` `es`）→ **不要**加白名单，它会只在出现大写缩写（`Go`/`ES`）或紧邻中文（`go语言`）时才命中；
   - 仍然误判 → 直接从 `topic_vocab` 删掉，用更明确的写法（`golang` `elasticsearch`）；
4. **换领域**（例如从"求职/技术"换到"考研/留学"）→ 主要改 `topic_vocab`，再按需加 `stopwords_extra`；
5. **验证改动**：用同一个 `--out` 重跑，对比 `compare.json` 里的 `pairs` 数量与 `shared_topics` 是否合理。

---

## 6. 方法说明（为什么这样比）

- **分词**：英文/数字按词，中文按二元与三元字组（所以 `shared_terms` 里会出现"容器一""直重启"这类碎片，属正常）；
- **主题词匹配**：中文词按子串匹配；长英文词按词边界不区分大小写；**短英文词（≤3）默认只认大写缩写或"紧邻中文"写法**（`Go`/`go语言` 命中，`go&Agent` 不命中），需要小写也命中的短词请写进 `lowercase_short_terms`；
- **相似度** = 0.45×重合度 + 0.20×Jaccard + 主题加分 + URL 加分；先在 `compare.md` 里给出候选，**语义判断交给人/Agent**；
- **时效性**：`social_newer_Nd` 表示社媒内容比群聊晚 N 天（群里说法可能已过时），`social_older_Nd` 表示社媒内容更早；
- 相似度低但语义相关的配对（群里"容器重启" vs 社媒"OOMKilled"）要靠人的理解补上，`compare.json` 里的 `shared_terms`/`shared_topics` 只是线索。

---

## 7. 常见故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `{"ok": false, ... hint: 缺少群聊消息或社媒内容}` | 某一侧目录为空或路径不对 | 看返回里的 `qq_messages` / `social_items` 判断缺哪侧 |
| `pairs: 0` 但两侧都有数据 | 阈值过高或词表不匹配 | 降 `min_score`/`min_shared_terms`，或补 `topic_vocab` |
| 配对全是"表情包/寒暄"式噪声 | 群聊里短消息太多 | 用 `--max-qq` 聚焦近期，或先在上游把 P3 过滤掉 |
| 中文显示成乱码（只在控制台） | PowerShell 控制台编码问题 | 文件本身是 UTF-8，用编辑器打开正常；需要控制台正常就设 `$env:PYTHONIOENCODING="utf-8"` |
| 打印 `[WARN] config.json ...` | 配置字段类型写错 | 按警告修字段；不修也能跑（用默认值） |

---

## 8. 文件速查

```
.agents/skills/cross-compare/GUIDE.md                     本操作指南
.agents/skills/cross-compare/SKILL.md                     Agent 用技能说明（含二次总结写作要求）
.agents/skills/cross-compare/config.json                  词表与打分阈值
.agents/skills/cross-compare/scripts/compare.py           比对脚本
artifacts/compare/<日期>/compare.md|compare.json          产物
artifacts/qq/<群>-<区间>/normalized.jsonl                 群聊侧输入
artifacts/social/<批次>/**/*.jsonl                        社媒侧输入
```
