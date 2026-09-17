// AI 复判：群聊分类与重要度复判、交叉比对的「印证/补充/冲突」判定
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.mjs';
import { projectPath, loadConfig } from './config.mjs';
import { runTask } from './jobs.mjs';
import { chat } from './ai.mjs';

const CATEGORIES = ['公告通知', '提问求助', '资源分享', '技术讨论', '闲聊', '广告灌水', '系统消息'];
const LEVELS = ['P0', 'P1', 'P2', 'P3'];

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function writeJsonl(file, rows) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

/**
 * 用 AI 复判群聊分类与重要度（脚本先跑正则 → AI 复判覆盖）。
 * 只把候选消息送去复判：默认跳过 P0/P1（已很敏感）与系统消息，节省 token。
 */
export async function startClassifyReview({ summaryDir, batchSize = 40, includeAll = false, limit = 400 }) {
  const abs = projectPath(summaryDir);
  const normalized = path.join(abs, 'normalized.jsonl');
  if (!fs.existsSync(normalized)) throw new Error('该汇总目录缺少 normalized.jsonl，请先重新生成汇总');

  return runTask({ kind: 'classify', title: 'AI 复判分类与重要度' }, async ({ job: current, signal }) => {
    const rows = readJsonl(normalized);
    const config = await loadConfig();
    const size = Math.max(10, Math.min(120, Number(batchSize) || config.classify.batchSize || 40));
    const candidates = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => (includeAll ? true : !row.is_system && !row.recalled))
      .slice(0, Math.max(1, Number(limit) || 400));

    current.emit(`[复判] 共 ${rows.length} 条消息，本次复判 ${candidates.length} 条（每批 ${size} 条）`, 'sys');

    const results = [];
    let changed = 0;
    for (let offset = 0; offset < candidates.length; offset += size) {
      const batch = candidates.slice(offset, offset + size);
      const batchNo = Math.floor(offset / size) + 1;
      const totalBatches = Math.ceil(candidates.length / size);
      current.setProgress({ phase: 'classify', batch: batchNo, total: totalBatches, changed });
      current.emit(`—— 第 ${batchNo}/${totalBatches} 批（${batch.length} 条）——`, 'sys');

      const payload = batch.map(({ row, index }) => ({
        i: index,
        time: (row.time || '').slice(0, 16),
        sender: row.sender_name || row.sender_id || '',
        kind: row.kind || 'text',
        text: (row.content || '').slice(0, 400),
      }));

      const prompt = [
        `请对下面 ${payload.length} 条 QQ 群聊消息给出「类别」与「重要度」。`,
        `类别只能是：${CATEGORIES.join(' / ')}`,
        `重要度：P0=决策/截止/紧急通知；P1=@我/待办/求助/真问题；P2=有价值的信息、资源、技术讨论；P3=闲聊或噪音。`,
        '判定要点：玩梗与寒暄不要判 P0/P1；广告、代课、代写一律归「广告灌水」并列 P3；含链接/文件/图片且信息量大的按「资源分享」+ P2。',
        '只输出 JSON 数组，每个元素形如 {"i": 消息序号, "category": "...", "level": "P2", "reason": "不超过 20 字"}，不要任何解释文字。',
        '',
        JSON.stringify(payload, null, 0),
      ].join('\n');

      const answer = await chat({
        step: 'classify',
        job: current,
        signal,
        messages: [
          { role: 'system', content: '你是群聊消息分类器，只输出 JSON。' },
          { role: 'user', content: prompt },
        ],
      });

      let parsed = [];
      try {
        const match = answer.content.match(/\[[\s\S]*\]/);
        parsed = JSON.parse(match ? match[0] : answer.content);
      } catch (err) {
        current.emit(`[警告] 第 ${batchNo} 批返回无法解析为 JSON，已跳过：${err.message}`, 'err');
      }

      const byIndex = new Map(parsed.filter((item) => typeof item?.i === 'number').map((item) => [item.i, item]));
      for (const { row, index } of batch) {
        const verdict = byIndex.get(index);
        const scriptCategory = row.category || '';
        const scriptLevel = row.level || '';
        const next = verdict && CATEGORIES.includes(verdict.category) && LEVELS.includes(verdict.level)
          ? { category: verdict.category, level: verdict.level, reason: String(verdict.reason || '').slice(0, 60) }
          : null;
        const isChanged = Boolean(next) && (next.category !== scriptCategory || next.level !== scriptLevel);
        if (isChanged) changed += 1;
        results.push({
          index,
          time: row.time || '',
          day: row.day || '',
          sender: row.sender_name || row.sender_id || '',
          text: (row.content || '').slice(0, 300),
          script: { category: scriptCategory, level: scriptLevel },
          ai: next,
          changed: isChanged,
          model: answer.model,
        });
      }
    }

    const outFile = path.join(abs, 'ai-review.jsonl');
    await writeJsonl(outFile, results);
    const changedFile = path.join(abs, 'ai-review-changed.md');
    const changedRows = results.filter((item) => item.changed);
    const md = [
      '# AI 复判：与脚本判定不一致的消息',
      '',
      `- 复判总数：${results.length} 条 ｜ 判定被修改：${changedRows.length} 条 ｜ 模型：${results[0]?.model || '-'}`,
      '',
      '| 时间 | 发送人 | 脚本判定 | AI 判定 | 理由 | 消息 |',
      '|---|---|---|---|---|---|',
      ...changedRows.map((item) =>
        `| ${(item.time || '').slice(0, 16)} | ${item.sender} | ${item.script.category}/${item.script.level} `
        + `| ${item.ai.category}/${item.ai.level} | ${item.ai.reason} | ${item.text.replace(/\|/g, '/').slice(0, 80)} |`),
    ].join('\n');
    await fsp.writeFile(changedFile, `${md}\n`, 'utf8');

    const relOut = path.relative(PROJECT_ROOT, changedFile).replace(/\\/g, '/');
    current.emit(`[完成] 复判 ${results.length} 条，修改 ${changedRows.length} 条 → ${relOut}`, 'sys');
    return {
      reviewed: results.length,
      changed: changedRows.length,
      outFile: relOut,
      jsonl: path.relative(PROJECT_ROOT, outFile).replace(/\\/g, '/'),
    };
  });
}

/** 读取某次复判结果（供界面展示对照） */
export function readClassifyReview(summaryDir, { onlyChanged = true, limit = 500 } = {}) {
  const file = path.join(projectPath(summaryDir), 'ai-review.jsonl');
  const rows = readJsonl(file);
  const filtered = onlyChanged ? rows.filter((row) => row.changed) : rows;
  return { total: rows.length, changed: rows.filter((r) => r.changed).length, rows: filtered.slice(0, limit) };
}

/** 交叉比对 + AI 判定：对配对给出 印证 / 补充 / 冲突 */
export async function startCompareVerdict({ compareDir, batchSize = 8, limit = 40 }) {
  const abs = projectPath(compareDir);
  const jsonFile = path.join(abs, 'compare.json');
  if (!fs.existsSync(jsonFile)) throw new Error('该目录缺少 compare.json，请先运行交叉比对');

  return runTask({ kind: 'compare-ai', title: 'AI 判定比对结论' }, async ({ job: current, signal }) => {
    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const pairs = (data.pairs || []).slice(0, Math.max(1, Number(limit) || 40));
    const size = Math.max(1, Math.min(20, Number(batchSize) || 8));
    current.emit(`[判定] 配对 ${pairs.length} 组，每批 ${size} 组`, 'sys');

    const verdicts = [];
    for (let offset = 0; offset < pairs.length; offset += size) {
      const batch = pairs.slice(offset, offset + size);
      const batchNo = Math.floor(offset / size) + 1;
      current.setProgress({ phase: 'verdict', batch: batchNo, total: Math.ceil(pairs.length / size) });
      current.emit(`—— 判定第 ${batchNo} 批（${batch.length} 组）——`, 'sys');

      const payload = batch.map((pair, index) => ({
        i: offset + index,
        qq: { time: pair.qq?.time, sender: pair.qq?.sender, text: pair.qq?.excerpt },
        social: { title: pair.social?.title, author: pair.social?.author, likes: pair.social?.likes, text: pair.social?.excerpt },
      }));

      const answer = await chat({
        step: 'compare',
        job: current,
        signal,
        messages: [
          {
            role: 'system',
            content: '你判断「群聊内容」与「社交媒体内容」的关系，只输出 JSON。'
              + 'verdict 只能是：印证（说法一致）/ 补充（社媒提供了群里没有的做法或数据）/ 冲突（两边矛盾或社媒明显过时）。',
          },
          {
            role: 'user',
            content: `${JSON.stringify(payload)}\n\n`
              + '请对每组输出 {"i": 序号, "verdict": "印证|补充|冲突", "note": "不超过 40 字的理由", "action": "可选：建议动作"}。'
              + '只输出 JSON 数组。',
          },
        ],
      });

      let parsed = [];
      try {
        const match = answer.content.match(/\[[\s\S]*\]/);
        parsed = JSON.parse(match ? match[0] : answer.content);
      } catch (err) {
        current.emit(`[警告] 第 ${batchNo} 批解析失败：${err.message}`, 'err');
      }
      for (const item of parsed) {
        if (typeof item?.i !== 'number') continue;
        const pair = pairs[item.i - offset] || pairs[item.i];
        verdicts.push({
          i: item.i,
          verdict: ['印证', '补充', '冲突'].includes(item.verdict) ? item.verdict : '未判定',
          note: String(item.note || '').slice(0, 120),
          action: String(item.action || '').slice(0, 80),
          score: pair?.score,
          qq: pair?.qq,
          social: pair?.social,
        });
      }
    }

    const counts = verdicts.reduce((acc, item) => {
      acc[item.verdict] = (acc[item.verdict] || 0) + 1;
      return acc;
    }, {});
    const outJson = path.join(abs, 'compare-ai.json');
    await fsp.writeFile(outJson, `${JSON.stringify({ generatedAt: new Date().toISOString(), counts, verdicts }, null, 2)}\n`, 'utf8');

    const md = [
      '# AI 判定：群聊 × 社媒 配对关系',
      '',
      `- 统计：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' ｜ ')}`,
      '',
      '| 判定 | 社群来源 | 社媒来源 | 说明 |',
      '|---|---|---|---|',
      ...verdicts.map((item) =>
        `| ${item.verdict} | ${(item.qq?.sender || '')} ${(item.qq?.excerpt || '').replace(/\|/g, '/').slice(0, 60)} `
        + `| [${(item.social?.title || '').replace(/\|/g, '/').slice(0, 50)}](${item.social?.url || ''}) | ${item.note} |`),
    ].join('\n');
    const outMd = path.join(abs, 'compare-ai.md');
    await fsp.writeFile(outMd, `${md}\n`, 'utf8');

    current.emit(`[完成] ${JSON.stringify(counts)}`, 'sys');
    return {
      counts,
      total: verdicts.length,
      md: path.relative(PROJECT_ROOT, outMd).replace(/\\/g, '/'),
      json: path.relative(PROJECT_ROOT, outJson).replace(/\\/g, '/'),
    };
  });
}
