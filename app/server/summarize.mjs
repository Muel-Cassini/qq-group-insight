// 总结生成：本地 DSH（headless）或自有 API 两条路；支持「按天分块读原文」深度模式
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, PATHS } from './paths.mjs';
import { projectPath, loadConfig } from './config.mjs';
import { runTask, bus } from './jobs.mjs';
import { runDshHeadless, runDshHeadlessWithSession } from './skills.mjs';
import { cleanupNewSessions } from './dsh-sessions.mjs';
import { chat, preview } from './ai.mjs';

const OUTPUT_FORMAT = `严格按以下结构输出（Markdown，不要额外寒暄）：

# 群聊 × 社媒 汇总报告
## 一句话结论
## 交叉印证的关键结论
（每条都标注来源：群聊写「群名 日期 时间 发送人」，社媒写「标题 + 链接 + 作者/互动量」）
## 群聊盲区（社媒有、群聊没提到）
## 群聊私有价值（群里有、社媒没有的经验）
## 冲突与待核实
（两边说法矛盾或可能过时的，标「需核实」，不要替用户拍板）
## 建议的下一步动作`;

function safeRel(rel) {
  const abs = path.isAbsolute(rel) ? rel : projectPath(rel);
  const root = PROJECT_ROOT;
  const normalized = path.resolve(abs);
  if (!normalized.startsWith(root)) throw new Error('路径必须位于项目内');
  return normalized;
}

function readIfExists(file, limit = 200000) {
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
}

/** 汇总产物目录清单（仅 name/relDir/digests；完整字段见 exports.mjs 的 listSummaries） */
export function listSummaryDirs() {
  const root = projectPath(PATHS.outQq);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const dir = path.join(root, entry.name);
      const digestDir = path.join(dir, 'digest');
      const digests = fs.existsSync(digestDir)
        ? fs.readdirSync(digestDir).filter((f) => f.endsWith('.md')).sort()
        : [];
      out.push({ name: entry.name, relDir: path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/'), digests });
    } catch (err) {
      console.warn(`[summaries] 跳过 ${entry.name}：${err.message}`);
    }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** 比对结果清单 */
export function listCompareDirs() {
  const root = projectPath(PATHS.outCompare);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      return {
        name: entry.name,
        relDir: path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/'),
        hasMd: fs.existsSync(path.join(dir, 'compare.md')),
        hasJson: fs.existsSync(path.join(dir, 'compare.json')),
      };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** 采集批次清单（social-crawl 输出的目录） */
export function listSocialDirs() {
  const root = projectPath(PATHS.outSocial);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => {
      const dir = path.join(root, entry.name);
      let records = 0;
      let files = 0;
      const walk = (base) => {
        for (const item of fs.readdirSync(base, { withFileTypes: true })) {
          const full = path.join(base, item.name);
          if (item.isDirectory()) walk(full);
          else if (item.name.endsWith('.jsonl') || item.name.endsWith('.json')) {
            files += 1;
            const text = readIfExists(full, 5_000_000);
            records += text.split('\n').filter((line) => line.trim().startsWith('{')).length;
          }
        }
      };
      try {
        walk(dir);
      } catch { /* 忽略读取异常 */ }
      return {
        name: entry.name,
        relDir: path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/'),
        files,
        records,
        mtime: fs.statSync(dir).mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** 组装材料：汇总 digest + 待办 + 媒体 + 比对结果 */
export function loadMaterial({ summaryDir, compareDir = '', deep = false, perDayLimit = 60000 }) {
  const parts = [];
  const summaryAbs = safeRel(summaryDir);
  const digestDir = path.join(summaryAbs, 'digest');
  let dayFiles = [];
  if (fs.existsSync(digestDir)) {
    dayFiles = fs.readdirSync(digestDir).filter((f) => f.endsWith('.md')).sort();
  }
  const daily = dayFiles.map((file) => ({
    day: file.replace(/\.md$/, ''),
    text: readIfExists(path.join(digestDir, file), perDayLimit),
  }));
  const p1 = readIfExists(path.join(summaryAbs, 'p1-todo.md'), 40000);
  const media = readIfExists(path.join(summaryAbs, 'media-index.md'), 30000);
  const normalized = path.join(summaryAbs, 'normalized.jsonl');

  if (!deep) {
    parts.push(`【群聊每日汇总】\n${daily.map((d) => `\n### ${d.day}\n${d.text}`).join('\n')}`);
    if (p1) parts.push(`【跨天待办 P0/P1】\n${p1}`);
    if (media) parts.push(`【群内媒体清单】\n${media}`);
  } else {
    parts.push(`【群聊每日汇总（深度模式：逐日分块）】\n${daily.map((d) => `\n### ${d.day}\n${d.text}`).join('\n')}`);
    if (p1) parts.push(`【跨天待办 P0/P1】\n${p1}`);
  }

  let compareText = '';
  if (compareDir) {
    compareText = readIfExists(path.join(safeRel(compareDir), 'compare.md'), 120000);
    if (compareText) parts.push(`【群聊 × 社媒 交叉比对材料】\n${compareText}`);
  }

  return { text: parts.join('\n\n'), daily, p1, media, compareText, normalized };
}

/** 按天读取原文（深度模式的原料） */
export function loadRawByDay(summaryDir, { perDayLimit = 45000 } = {}) {
  const summaryAbs = safeRel(summaryDir);
  const file = path.join(summaryAbs, 'normalized.jsonl');
  if (!fs.existsSync(file)) return [];
  const byDay = new Map();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const day = rec.day || '未知日期';
    if (!byDay.has(day)) byDay.set(day, []);
    const who = rec.sender_name || rec.sender_id || '未知';
    const kind = rec.kind && rec.kind !== 'text' ? `[${rec.kind}]` : '';
    byDay.get(day).push(`- ${(rec.time || '').slice(11, 19)} ${who}${kind}：${(rec.content || '').replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, rows]) => {
    let text = rows.join('\n');
    if (text.length > perDayLimit) text = `${text.slice(0, perDayLimit)}\n…（当日消息已截断，共 ${rows.length} 条）`;
    return { day, text, count: rows.length };
  });
}

function buildPrompt({ style, focus, material, extra = '' }) {
  const header = [
    '你是群聊与社交媒体信息的分析助手。请基于下面的材料写一份汇总报告。',
    style ? `【风格要求】${style}` : '',
    focus ? `【重点关注】${focus}` : '',
    extra,
    '要求：结论必须有据可依；不确定的地方标注「需核实」；不要编造材料里没有的内容。',
    '',
    OUTPUT_FORMAT,
  ].filter(Boolean).join('\n');
  return `${header}\n\n================ 材料开始 ================\n${material}\n================ 材料结束 ================`;
}

/** 发送前预估（供界面弹窗确认） */
export async function previewSummary({ summaryDir, compareDir = '', deep = false, style = '', focus = '', engine = 'api' }) {
  const config = await loadConfig();
  if (engine === 'dsh' || engine === 'prompt') {
    return { engine, chars: 0, note: engine === 'dsh' ? '本地 DSH 生成，不消耗 API 额度' : '仅生成提示词' };
  }
  const { text } = loadMaterial({ summaryDir, compareDir, deep });
  const raw = deep ? loadRawByDay(summaryDir) : [];
  const rawChars = raw.reduce((sum, day) => sum + day.text.length, 0);
  const prompt = buildPrompt({ style, focus, material: text });
  const base = await preview('summary', prompt + 'x'.repeat(rawChars), 2000);
  const calls = deep ? raw.length + 1 : 1;
  return {
    engine: 'api',
    calls,
    chars: prompt.length + rawChars,
    days: raw.map((d) => ({ day: d.day, chars: d.text.length, messages: d.count })),
    ...base,
    cost: base.cost ? { ...base.cost, amount: Number((base.cost.amount * (deep ? calls : 1)).toFixed(4)) } : null,
  };
}

/**
 * 生成总结任务。
 * engine: 'dsh' | 'api' | 'prompt'
 */
export async function startSummary(opts) {
  const config = await loadConfig();
  const {
    summaryDir, compareDir = '', engine = config.summarize.engine, deep = false,
    style = '', focus = '', outName = '',
  } = opts;

  if (!summaryDir) throw new Error('请先选择要总结的群聊汇总');
  const outDir = projectPath(PATHS.outSummary);
  await fsp.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const outFile = path.join(outDir, `${outName || path.basename(summaryDir)}-${stamp}.md`);
  const relOut = path.relative(PROJECT_ROOT, outFile).replace(/\\/g, '/');

  if (engine === 'prompt') {
    const { text } = loadMaterial({ summaryDir, compareDir, deep });
    const prompt = buildPrompt({ style, focus, material: text });
    await fsp.writeFile(outFile, `<!-- 这是提示词，复制到任意 AI 使用 -->\n\n${prompt}`, 'utf8');
    const job = runTask({ kind: 'summary', title: '生成提示词' }, async ({ job: current }) => {
      current.emit(`[提示词] 已写入 ${relOut}（${prompt.length} 字符）`, 'sys');
      return { outFile: relOut, chars: prompt.length, engine: 'prompt' };
    });
    return { job, outFile: relOut };
  }

  if (engine === 'dsh') {
    const materialDir = projectPath(summaryDir);
    const compareAbs = compareDir ? projectPath(compareDir) : '';
    const instruction = [
      '请用 qq-group-summary 与 cross-compare 两个技能的材料，写一份汇总报告。',
      `群聊汇总目录：${materialDir}`,
      compareAbs ? `交叉比对目录：${compareAbs}` : '（本次不需要交叉比对）',
      style ? `风格要求：${style}` : '',
      focus ? `重点关注：${focus}` : '',
      '',
      `把最终报告（Markdown 全文）写入文件：${outFile}`,
      '写完后只输出该文件的相对路径与一句话结论。',
      '',
      OUTPUT_FORMAT,
    ].filter(Boolean).join('\n');

    const { job, sessionBefore } = runDshHeadlessWithSession(instruction);
    const relOutSafe = relOut;

    // DSH 结束后：① 校验是否真的产出了报告（被中断/取消要显式报错）② 清理本次产生的 DSH 会话
    job.onFinish = () => {
      const logLines = job.logs.map((entry) => entry.line);
      const tail = logLines.slice(-40).join('\n');
      const cancelled = job.status === 'cancelled';
      const interrupted = /Interrupted|interrupted|aborted|Aborted|cancelled|已中断|中断|terminated/i.test(tail);
      const wroteFile = fs.existsSync(outFile);

      if (wroteFile) {
        job.emit(`[完成] 报告已生成：${relOutSafe}`, 'sys');
      } else {
        const partialFile = path.join(outDir, `${path.basename(outFile, '.md')}.partial.md`);
        const summaryText = logLines
          .filter((line) => !line.startsWith('$ ') && !line.startsWith('[cwd]') && !line.startsWith('[进程]')
            && !line.startsWith('[系统]') && !line.startsWith('[目标]') && !line.startsWith('[DSH]')
            && !line.startsWith('[完成]'))
          .join('\n').trim();
        let partialRel = '';
        if (summaryText) {
          try {
            fs.writeFileSync(partialFile,
              `<!-- DSH 未写出报告文件（${cancelled ? '任务被取消' : '运行结束'}），以下为其原始输出，可能不完整 -->\n\n${summaryText}\n`, 'utf8');
            partialRel = path.relative(PROJECT_ROOT, partialFile).replace(/\\/g, '/');
          } catch { /* 落盘失败则只记日志 */ }
        }
        const reason = cancelled
          ? '任务被取消，DSH 未生成报告文件（可重新运行）'
          : interrupted
            ? 'DSH 会话被中断（可能在 DSH 里被停止，或超出等待时间），没有生成报告文件'
            : `DSH 没有写出报告文件：${relOutSafe}（请查看日志区输出）`;
        job.status = 'running'; // 允许 finish 覆盖 cancelled/done
        job.finish('failed', {
          error: reason,
          result: { outFile: '', partialFile: partialRel, interrupted: interrupted || cancelled, engine: 'dsh', cancelled },
        });
      }

      // markers：本次会话内容里应当出现的关键字（输出文件名 / 汇总目录名 / 任务路径）
      cleanupNewSessions(sessionBefore, {
        markers: [path.basename(outFile), path.basename(summaryDir), relOutSafe, '汇总报告'],
      })
        .then((report) => {
          const line = report.deleted.length
            ? `[DSH] 已清理 ${report.deleted.length} 个本次任务产生的会话：${report.deleted.map((s) => s.id).join(', ')}`
            : '[DSH] 没有需要清理的会话';
          job.logs.push({ t: Date.now(), stream: 'sys', line });
          bus.emit('event', { type: 'log', jobId: job.id, t: Date.now(), stream: 'sys', line });
          for (const kept of report.kept) {
            const keepLine = `[DSH] 保留会话 ${kept.id}：${kept.reason}`;
            job.logs.push({ t: Date.now(), stream: 'sys', line: keepLine });
            bus.emit('event', { type: 'log', jobId: job.id, t: Date.now(), stream: 'sys', line: keepLine });
          }
          bus.emit('event', {
            type: 'dsh-cleanup', jobId: job.id, deleted: report.deleted.length, kept: report.kept.length,
          });
        })
        .catch((err) => {
          const line = `[DSH] 会话清理失败：${err.message}`;
          job.logs.push({ t: Date.now(), stream: 'err', line });
          bus.emit('event', { type: 'log', jobId: job.id, t: Date.now(), stream: 'err', line });
        });
    };

    return { job, outFile: relOut };
  }

  // engine === 'api'
  return {
    job: runTask({ kind: 'summary', title: 'API 生成总结' }, async ({ job: current, signal }) => {
      const configNow = await loadConfig();
      const { text, compareText } = loadMaterial({ summaryDir, compareDir, deep: false });
      const dayChunks = deep ? loadRawByDay(summaryDir, {
        perDayLimit: Math.max(20000, Number(configNow.ai.maxCharsPerCall) || 24000),
      }) : [];
      const sections = [];

      if (deep && dayChunks.length) {
        current.emit(`[深度模式] 共 ${dayChunks.length} 天，逐日阅读原文后汇总`, 'sys');
        for (const [index, chunk] of dayChunks.entries()) {
          current.setProgress({ phase: 'day', index: index + 1, total: dayChunks.length, day: chunk.day });
          current.emit(`—— 第 ${index + 1}/${dayChunks.length} 块：${chunk.day}（${chunk.count} 条）——`, 'sys');
          const partial = await chat({
            step: 'summary',
            job: current,
            signal,
            messages: [
              { role: 'system', content: '你在逐日阅读 QQ 群聊原文，输出当日要点，供后续合并成报告。' },
              { role: 'user', content: `日期：${chunk.day}\n\n群聊原文：\n${chunk.text}\n\n请输出当日要点（3-8 条），每条注明时间与发送人，并标出待办/公告/资源。` },
            ],
          });
          sections.push(`### ${chunk.day}\n${partial.content}`);
        }
      }

      const material = [
        sections.length ? `【逐日要点】\n${sections.join('\n\n')}` : '',
        text,
        compareText && !text.includes(compareText) ? `【交叉比对材料】\n${compareText}` : '',
      ].filter(Boolean).join('\n\n');

      current.emit('[AI] 正在生成最终报告…', 'sys');
      const final = await chat({
        step: 'summary',
        job: current,
        signal,
        messages: [
          { role: 'system', content: '你是严谨的分析助手，只依据给定材料写作。' },
          { role: 'user', content: buildPrompt({ style, focus, material }) },
        ],
      });
      await fsp.writeFile(outFile, final.content, 'utf8');
      current.emit(`[完成] 已写入 ${relOut}`, 'sys');
      return {
        outFile: relOut,
        engine: 'api',
        model: final.model,
        provider: final.provider,
        tokensIn: final.tokensIn,
        tokensOut: final.tokensOut,
        elapsedMs: final.elapsedMs,
        cost: final.cost,
        calls: (deep ? dayChunks.length : 0) + 1,
      };
    }),
    outFile: relOut,
  };
}

/** 关键词推荐：把群聊要点交给 AI，返回候选关键词 */
export async function startKeywordSuggest({ summaryDir, count = 8 }) {
  return runTask({ kind: 'keywords', title: 'AI 推荐关键词' }, async ({ job: current, signal }) => {
    const { daily, p1 } = loadMaterial({ summaryDir });
    const digestText = daily.map((d) => `### ${d.day}\n${d.text}`).join('\n').slice(0, 12000);
    const todoText = (p1 || '').slice(0, 3000);
    // 材料为空就别浪费一次调用：模型面对空材料只会回一句"没有内容"或空数组，
    // 上层就会显示成"推荐 0 组"，用户完全没法排查（实测踩过）
    if (!digestText.trim() && !todoText.trim()) {
      throw new Error('没有可用的汇总材料：请在上方选一份群聊汇总（该目录要有 digest/ 或 p1-todo.md），'
        + '或先在「① 导出与汇总」跑一次群聊汇总');
    }
    current.emit(`[材料] 每日汇总 ${daily.length} 天 ｜ 待办 ${todoText.length} 字`, 'sys');

    const result = await chat({
      step: 'keywords',
      job: current,
      signal,
      messages: [
        { role: 'system', content: '你从群聊记录里提取适合在社交媒体（小红书/知乎/B站）检索的关键词。只输出 JSON 数组。' },
        {
          role: 'user',
          content: `以下是某 QQ 群最近几天的汇总材料：\n\n${digestText}\n\n待办：\n${todoText}\n\n`
            + `请给出 ${count} 组检索关键词，每组 2-4 个词、以空格分隔，覆盖群里讨论的主要话题（尤其是有信息差价值的）。`
            + `\n只输出 JSON 数组，形如 ["关键词1 关键词2", "..."]，不要解释。`,
        },
      ],
    });

    const keywords = parseKeywordGroups(result.content, count);
    if (!keywords.length) {
      const head = String(result.content || '').replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`模型没有返回可用的关键词（返回内容开头：${head || '（空）'}）`);
    }
    current.emit(`[AI] 推荐 ${keywords.length} 组关键词`, 'sys');
    return { keywords, model: result.model, cost: result.cost, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
  });
}

/**
 * 从模型回答里解析关键词组：
 * ① 去掉 ```json 围栏后按 JSON 数组解析；
 * ② 解析不出来就退回按行拆（容忍 "- xxx"、"1. xxx"、带引号的写法）；
 * ③ 过滤掉明显是解释性文本的行（模型偶尔不顾"只输出 JSON"的要求）。
 */
export function parseKeywordGroups(content, count = 8) {
  const text = String(content || '').replace(/```[a-zA-Z]*\n?/g, '').trim();
  const tryArray = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .map((item) => (typeof item === 'string' ? item : String(item?.keyword ?? item?.word ?? '')))
        .map((item) => item.trim())
        .filter(Boolean);
    } catch { return null; }
  };
  const direct = tryArray(text);
  if (direct) return direct.slice(0, count);
  const wrapped = text.match(/\[[\s\S]*\]/);
  if (wrapped) {
    const parsed = tryArray(wrapped[0]);
    if (parsed) return parsed.slice(0, count);
  }
  // 兜底：按行拆，并丢掉看起来像解释/道歉的行
  const noise = /^(抱歉|不好意思|无法|没有|材料|根据|以下|说明|注[:：]|注意)/;
  return text.split('\n')
    .map((line) => line.replace(/^[-\d.、\s"']+/, '').replace(/[",]+$/, '').trim())
    .filter((line) => line && line.length <= 40 && !noise.test(line))
    .slice(0, count);
}
