// 关键词验证：把关键词逐个拿到社媒检索 → 跨平台互比（可选叠加群聊对照）→ 汇总成一份报告
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, PATHS } from './paths.mjs';
import { projectPath, pythonPath } from './config.mjs';
import { runProcess, runTask, cancelJob } from './jobs.mjs';
import { runCrawl, runCompare } from './skills.mjs';
import { startCompareVerdict } from './review.mjs';
import { chat } from './ai.mjs';
import { ensureEdge } from './startup.mjs';
import {
  toolPaths, waitJobWithTimeout, runLocalSummary, summarizeWithFallback, relPath, LOCAL_BANNER,
} from './local-summary.mjs';

// 从本模块再导出，保持既有调用方的引用不变
export { toolPaths };

/** 采前登录检查：避免 MediaCrawler 卡在"等待扫码"（会等 120s×N 轮） */
export async function checkLogins(platforms, { onLine } = {}) {
  const script = projectPath('app/server/tools/check_login.py');
  if (!fs.existsSync(script)) return { ok: false, error: '缺少 check_login.py', platforms: {} };
  const crawlDir = projectPath(PATHS.mediaCrawler);
  const args = [script, ...platforms];
  const job = runProcess({
    kind: 'login-check',
    title: `登录状态检查：${platforms.join('/')}`,
    command: pythonPath(),
    args,
    cwd: crawlDir,
    meta: {},
  });
  const done = await waitJobWithTimeout(job, { timeoutMs: 90 * 1000, label: '登录检查' });
  const text = (job.logs || []).map((entry) => entry.line).join('\n');
  const line = text.split('\n').reverse().find((item) => item.trim().startsWith('{') && item.includes('platforms'));
  if (!line) {
    onLine?.(`[登录检查] 无法解析结果（${done.status}）`, 'err');
    return { ok: false, error: '登录检查未返回结果', platforms: {} };
  }
  try {
    const parsed = JSON.parse(line.trim());
    return { ok: parsed.ok, platforms: parsed.platforms || {}, error: parsed.error || '' };
  } catch (err) {
    return { ok: false, error: `解析失败：${err.message}`, platforms: {} };
  }
}

/** 从群聊汇总里提取候选关键词（本地 jieba，不调用大模型） */
export async function startKeywordExtract({ summaryDir, top = 60, minCount = 3, onlyDomain = false }) {
  const summaryAbs = projectPath(summaryDir);
  if (!fs.existsSync(path.join(summaryAbs, 'normalized.jsonl'))) {
    throw new Error('该汇总目录缺少 normalized.jsonl，请先生成群聊汇总');
  }
  const outDir = path.join(projectPath(PATHS.outKeywords), path.basename(summaryAbs));
  const args = [toolPaths().keywords, '--summary', summaryAbs, '--out', outDir,
    '--top', String(top), '--min-count', String(minCount)];
  if (onlyDomain) args.push('--only-domain');
  return runProcess({
    kind: 'keywords-extract',
    title: `提取候选关键词：${path.basename(summaryAbs)}`,
    command: pythonPath(),
    args,
    meta: { summaryDir, outDir: path.relative(PROJECT_ROOT, outDir).replace(/\\/g, '/') },
    detect: [/\{"messages".*\}$/],
  });
}

/** 读取已提取的关键词（供界面展示） */
export function readKeywords(summaryDir) {
  const file = path.join(projectPath(PATHS.outKeywords), path.basename(projectPath(summaryDir)), 'keywords.json');
  if (!fs.existsSync(file)) return { ok: false, keywords: [] };
  try {
    return { ok: true, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, keywords: [], error: err.message };
  }
}

function keywordSlug(keyword) {
  return String(keyword).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30) || 'kw';
}

/** 平台英文名 → 中文名（只用于日志与报错文案） */
const PLATFORM_LABELS = { xhs: '小红书', zhihu: '知乎', bili: 'B站', douyin: '抖音', kuaishou: '快手', weibo: '微博', tieba: '贴吧' };
function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || platform;
}

/**
 * 跨平台互比：把一个关键词在各平台采到的内容互相比较（不依赖群聊）。
 * 产出 <kwDir>/_platform/platform-compare.md 与 platform-compare.json。
 */
export async function startPlatformCompare({ kwDir, keyword, outDir, top = 30, minScore = 0.12 }) {
  if (!fs.existsSync(toolPaths().comparePlatforms)) throw new Error(`缺少跨平台互比脚本：${toolPaths().comparePlatforms}`);
  return runProcess({
    kind: 'platform-compare',
    title: `跨平台互比：${keyword}`,
    command: pythonPath(),
    args: [toolPaths().comparePlatforms, '--src', kwDir, '--out', outDir,
      '--keyword', keyword, '--top', String(top), '--min-score', String(minScore)],
    meta: { keyword, outDir: relPath(outDir), refresh: ['keywords'] },
    detect: [/\{"ok".*\}$/],
  });
}

/**
 * 关键词验证主流程（一次任务内串行完成）：
 *  1) 逐个关键词 × 平台采集
 *  2) 跨平台互比（同一关键词在各平台之间的比对材料）—— 不依赖群聊
 *  3) 可选叠加「群聊对照」（compareMode = 'with-qq' 时，用群聊里命中该关键词的消息再做一次比对 + AI 判定）
 *  4) 汇总成一份面向人的报告：配了 AI 用大模型，没配就用本地规则（同一路径同名文件，只标生成方式）
 */
export async function startKeywordVerify(opts) {
  const {
    keywords, platforms, summaryDir, limit = 10, commentsPerItem = 5,
    useAiVerdict = true, style = '', focus = '',
    compareMode = 'social',      // social | with-qq
    engine = 'auto',             // auto | ai | local
    topPairs = 30, minScore = 0.12,
  } = opts;

  // 关键词既可能来自输入框（字符串），也可能直接把候选词对象传进来（前端/脚本都有可能）：
  // 统一取出词面，避免出现 "[object Object]" 这种脏值。
  const rawList = Array.isArray(keywords) ? keywords : String(keywords || '').split(/[,，\n]/);
  const list = [];
  for (const item of rawList) {
    const word = typeof item === 'string'
      ? item.trim()
      : String(item?.keyword ?? item?.word ?? item?.term ?? '').trim();
    if (word && !list.includes(word)) list.push(word);
  }
  if (!list.length) throw new Error('请至少选择一个关键词');
  if (!Array.isArray(platforms) || !platforms.length) throw new Error('请至少选择一个平台');

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const rootRel = path.join(PATHS.outKeywords, `verify-${stamp}`);
  const root = projectPath(rootRel);
  // 实际参与采集的平台：前置登录检查之后才知道，先占位，检查完回填
  const activePlatforms = [...platforms];

  return runTask({
    kind: 'keyword-verify',
    title: `关键词验证：${list.slice(0, 4).join('、')}${list.length > 4 ? ` 等 ${list.length} 个` : ''}`,
    meta: {
      keywords: list, platforms: activePlatforms, requestedPlatforms: platforms,
      summaryDir, compareMode, engine,
      outDir: rootRel.replace(/\\/g, '/'), refresh: ['keywords'],
    },
  }, async ({ job, signal }) => {
    await fsp.mkdir(root, { recursive: true });

    // 前置：确保采集用的 Edge 调试实例在跑（否则 MediaCrawler 会一直等 CDP 端口）
    job.emit('[前置] 检查 Edge 调试实例…', 'sys');
    const edge = await ensureEdge({});
    if (!edge.ok) {
      job.emit(`[错误] Edge 调试实例不可用：${edge.reason || '未知原因'}。请先在左侧点「启动 Edge」。`, 'err');
      throw new Error(`Edge 调试实例不可用：${edge.reason || '未知原因'}`);
    }
    job.emit(`[前置] Edge 就绪（${edge.version || `端口 ${edge.port}`}）`, 'sys');

    // 前置：检查各平台登录态。MediaCrawler 在未登录时会反复弹扫码并等待 120s×N 轮，
    // 与其白等 8 分钟，不如在这里快速失败并告诉用户去哪个窗口登录。
    job.emit('[前置] 检查各平台登录状态…', 'sys');
    const login = await checkLogins(platforms, { onLine: (line, level) => job.emit(line, level || 'sys') });
    const notLogged = platforms.filter((platform) => !login.platforms?.[platform]?.loggedIn);
    for (const platform of platforms) {
      const info = login.platforms?.[platform];
      if (info?.loggedIn) job.emit(`   ${platform}：已登录（${info.primary}）`, 'sys');
      else job.emit(`   ${platform}：未登录 —— ${info?.reason || '未知原因'}`, 'err');
    }
    const usable = platforms.filter((platform) => login.platforms?.[platform]?.loggedIn);
    if (!usable.length) {
      const names = notLogged.map(platformLabel).join('、');
      const subject = notLogged.length > 1 ? `${names} 均未登录` : `${names} 未登录`;
      job.emit(`[错误] ${subject}或登录已过期。请在「启动 Edge」打开的调试窗口里重新登录后再试。`, 'err');
      job.emit('       注意：cookie 还在不等于登录有效（实测小红书会保留 web_session 但服务端会话已失效）。', 'sys');
      throw new Error(`${subject}或登录已过期（请在弹出的 Edge 调试窗口内重新登录后再试）`);
    }
    if (notLogged.length) {
      job.emit(`[提示] ${notLogged.map(platformLabel).join('、')} 未登录或登录已过期，本次将跳过这些平台`, 'warn');
    }
    activePlatforms.splice(0, activePlatforms.length, ...usable);
    if (job.meta) job.meta.platforms = usable;

    job.emit(`[计划] ${list.length} 个关键词 × ${usable.length} 个平台 = ${list.length * usable.length} 次采集`, 'sys');

    const results = [];
    for (const [index, keyword] of list.entries()) {
      job.setProgress({ phase: 'keyword', index: index + 1, total: list.length, keyword });
      job.emit(`\n===== (${index + 1}/${list.length}) 关键词：${keyword} =====`, 'sys');
      const kwDir = path.join(root, keywordSlug(keyword));
      await fsp.mkdir(kwDir, { recursive: true });

      const socialDirs = [];
      for (const platform of usable) {
        if (signal.aborted) break;
        const outDir = path.join(kwDir, `${platform}`);
        job.emit(`—— 采集 ${platform}：${keyword}（最多等 8 分钟）——`, 'sys');
        const crawlJob = await runCrawl({
          platform, mode: 'search', keywords: keyword, limit, commentsPerItem,
          timeout: 1800, outDir,
        });
        crawlJob.meta = { ...crawlJob.meta, parentJob: job.id };
        // 父任务被取消时，连带终止子任务
        const abortHandler = () => cancelJob(crawlJob.id);
        signal.addEventListener('abort', abortHandler, { once: true });
        // eslint-disable-next-line no-await-in-loop
        const done = await waitJobWithTimeout(crawlJob, { timeoutMs: 8 * 60 * 1000, job, label: `${platform} 采集「${keyword}」` });
        signal.removeEventListener('abort', abortHandler);
        job.emit(`   ${platform} 采集${done.status === 'done' ? '完成' : `未完成（${done.error || done.status}）`}`, done.status === 'done' ? 'sys' : 'err');
        if (done.status === 'done') socialDirs.push(outDir);
      }
      if (!socialDirs.length) {
        job.emit('   该关键词没有采到任何数据，跳过比对与汇总', 'err');
        results.push({
          keyword, socialDirs: [], platformDir: '', platformCompareJson: '',
          platformCount: 0, qqDir: '', compareDir: '', verdicts: null, notes: '无采集结果',
        });
        continue;
      }

      // —— 跨平台互比（本功能的主线：不依赖群聊）——
      let platformDir = '';
      let platformCompareJson = '';
      let platformSummary = null;
      {
        const platformOut = path.join(kwDir, '_platform');
        job.emit('—— 跨平台互比 ——', 'sys');
        const compareJob = await startPlatformCompare({
          kwDir, keyword, outDir: platformOut, top: topPairs, minScore,
        });
        const done = await waitJobWithTimeout(compareJob, {
          timeoutMs: 5 * 60 * 1000, job, label: `跨平台互比：${keyword}`,
        });
        if (done.status === 'done') {
          platformDir = relPath(platformOut);
          platformCompareJson = path.join(platformOut, 'platform-compare.json');
          try {
            const data = JSON.parse(fs.readFileSync(platformCompareJson, 'utf8'));
            job.emit(`   ${usable.length} 个平台：共识主题 ${(data.consensus_topics || []).length} 个`
              + ` ｜ 跨平台配对 ${(data.cross_pairs || []).length} 组`
              + ` ｜ 疑似同源 ${(data.duplicates || []).length} 组`, 'sys');
          } catch { /* 材料读取失败不影响流程，报告里会体现 */ }
          if (usable.length < 2) {
            job.emit('   只采到一个平台，无法做跨平台互比（材料里只有单平台画像）', 'warn');
          }
        } else {
          job.emit(`   跨平台互比失败：${done.error || done.status}`, 'err');
        }
      }

      // —— 可选：叠加群聊对照（compareMode = 'with-qq'）——
      let qqDir = '';
      let compareDir = '';
      if (compareMode === 'with-qq') {
        qqDir = await buildKeywordQqSubset({ summaryDir, keyword, targetDir: path.join(kwDir, '_qq') });
        if (!qqDir) {
          job.emit('   群里没有与该关键词相关的消息，本次只有社媒侧材料', 'warn');
        } else {
          job.emit('—— 群聊对照（群聊 × 社媒）——', 'sys');
          const compareJob = await runCompare({
            qqDir, socialDir: socialDirs[0], outDir: path.join(kwDir, '_compare'), top: 30, minScore: 0.12,
          });
          const done = await waitJobWithTimeout(compareJob, {
            timeoutMs: 5 * 60 * 1000, job, label: '比对：' + keyword,
          });
          if (done.status === 'done') compareDir = relPath(path.join(kwDir, '_compare'));
          else job.emit(`   群聊对照失败：${done.error || done.status}`, 'err');
        }
      } else if (summaryDir) {
        job.emit('   （当前为「纯社媒跨平台互比」模式，未做群聊对照；需要时把比对方式切到「含群聊对照」）', 'sys');
      }

      let verdicts = null;
      if (useAiVerdict && compareDir) {
        job.emit('—— AI 判定印证/补充/冲突 ——', 'sys');
        const verdictJob = await startCompareVerdict({ compareDir, limit: 12 });
        const done = await waitJobWithTimeout(verdictJob, {
          timeoutMs: 10 * 60 * 1000, job, label: 'AI 判定：' + keyword,
        });
        verdicts = done.status === 'done' ? done.result : null;
        if (done.status !== 'done') job.emit(`   AI 判定失败：${done.error || done.status}`, 'err');
      }

      results.push({
        keyword,
        socialDirs: socialDirs.map((dir) => relPath(dir)),
        platformDir,
        platformCompareJson,
        platformCount: usable.length,
        qqDir: qqDir ? relPath(qqDir) : '',
        compareDir,
        verdicts,
      });
    }

    // 材料索引报告（Markdown）
    const skipped = platforms.filter((platform) => !usable.includes(platform));
    const lines = [`# 关键词社媒验证报告`, '',
      `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
      `- 关键词：${list.join('、')}`,
      `- 比对方式：${compareMode === 'with-qq' ? '跨平台互比 + 群聊对照' : '纯社媒跨平台互比'}`,
      `- 实际采集平台：${usable.map(platformLabel).join('、')}`,
      skipped.length ? `- 本次跳过（未登录/登录过期）：${skipped.map(platformLabel).join('、')}` : '',
      `- 请求的平台：${platforms.map(platformLabel).join('、')}`,
      `- 群聊汇总来源：${summaryDir || '（未指定）'}`, ''].filter(Boolean);
    for (const item of results) {
      lines.push(`## ${item.keyword}`);
      if (!item.socialDirs.length) { lines.push('', '（未采集到社媒内容）', ''); continue; }
      lines.push('', `- 社媒数据：${item.socialDirs.map((dir) => `\`${dir}\``).join('、')}`);
      if (item.platformDir) {
        lines.push(`- 跨平台互比：\`${item.platformDir}/platform-compare.md\`（${item.platformCount} 个平台）`);
      } else {
        lines.push('- 跨平台互比：（未产出）');
      }
      if (item.qqDir) lines.push(`- 群聊对照：\`${item.qqDir}\``);
      if (item.compareDir) lines.push(`- 群聊比对材料：\`${item.compareDir}/compare.md\``);
      if (item.verdicts?.counts) {
        lines.push(`- AI 判定：${Object.entries(item.verdicts.counts).map(([k, v]) => `${k} ${v}`).join(' ｜ ')}`);
        if (item.verdicts.md) lines.push(`- 判定明细：\`${item.verdicts.md}\``);
      }
      lines.push('');
    }
    const reportFile = path.join(root, 'verify-report.md');
    await fsp.writeFile(reportFile, `${lines.join('\n')}\n`, 'utf8');

    // —— 汇总：配了 AI 用大模型，没配（或 AI 调用失败）就用本地规则 ——
    const summaryFile = path.join(root, 'verify-summary.md');
    let summaryEngine = '';
    let summaryError = '';
    try {
      job.emit('—— 生成汇总（关键词社媒跨平台互比）——', 'sys');
      const materialParts = [fs.readFileSync(reportFile, 'utf8')];
      for (const item of results) {
        if (item.platformDir) {
          const file = path.join(projectPath(item.platformDir), 'platform-compare.md');
          if (fs.existsSync(file)) materialParts.push(`\n\n=== ${item.keyword}｜跨平台互比 ===\n${fs.readFileSync(file, 'utf8').slice(0, 24000)}`);
        }
        if (item.compareDir) {
          const file = path.join(projectPath(item.compareDir), 'compare.md');
          if (fs.existsSync(file)) materialParts.push(`\n\n=== ${item.keyword}｜群聊对照 ===\n${fs.readFileSync(file, 'utf8').slice(0, 12000)}`);
        }
      }
      const material = materialParts.join('');
      const outcome = await summarizeWithFallback({
        engine,
        step: 'compare',
        job,
        signal,
        chatFn: chat,
        fallbackToLocal: true,
        label: '关键词社媒汇总',
        system: '你在为「关键词社媒跨平台互比」写结论：对每个关键词说明各平台在讲什么、跨平台共识、'
          + '平台独有视角（信息差）、可交叉印证的材料，并给可执行建议。只依据材料；证据不足写「需核实」，不要编造。',
        material: `${style ? `风格要求：${style}\n` : ''}${focus ? `重点关注：${focus}\n` : ''}\n`
          + `材料：\n${material.slice(0, 60000)}\n\n`
          + '请按「关键词 → 各平台在讲什么 → 跨平台共识 → 平台独有/信息差 → 需核实 → 建议下一步」的格式输出 Markdown。',
        buildLocal: () => buildLocalSocialSummary({ parentJob: job, results, list, root, usable, skipped }),
      });
      summaryEngine = outcome.engine;
      await fsp.writeFile(summaryFile, `${outcome.content}\n`, 'utf8');
      job.emit(`[完成] 汇总（${outcome.engine === 'ai' ? 'AI' : '本地规则'}）已写入 ${relPath(summaryFile)}`, 'sys');
    } catch (err) {
      summaryError = err.message;
      job.emit(`[警告] 汇总失败（材料报告仍可用）：${err.message}`, 'err');
    }

    const rel = relPath(root);
    job.emit(`[完成] 验证报告：${rel}/verify-report.md`, 'sys');
    return {
      keywordCount: list.length, platforms, outDir: rel, results,
      summaryEngine, summaryError, summaryFile: summaryEngine ? relPath(summaryFile) : '',
      hasAiSummary: summaryEngine === 'ai',
    };
  });
}

/**
 * 本地规则汇总（social 模式）：逐关键词跑一次本地汇总，再拼成一份总的汇总。
 * 每个关键词的单独汇总留在 `<关键词>/_platform/keyword-summary.md`，便于单看。
 */
async function buildLocalSocialSummary({ parentJob, results, list, root, usable, skipped }) {
  const parts = [];
  const stats = [];
  for (const item of results) {
    if (!item.platformCompareJson || !fs.existsSync(item.platformCompareJson)) {
      parts.push(`## ${item.keyword}`, '', '（该关键词没有产出跨平台互比材料）', '');
      continue;
    }
    const perKeyword = path.join(root, keywordSlug(item.keyword), '_platform', 'keyword-summary.md');
    const sub = runLocalSummary({
      mode: 'social', outFile: perKeyword, compareFile: item.platformCompareJson,
      keyword: item.keyword, refresh: ['keywords'],
    });
    // eslint-disable-next-line no-await-in-loop
    const done = await waitJobWithTimeout(sub, {
      timeoutMs: 3 * 60 * 1000, job: parentJob, label: `本地汇总：${item.keyword}`,
    });
    if (done.status !== 'done' || !fs.existsSync(perKeyword)) {
      parts.push(`## ${item.keyword}`, '', `（本地汇总失败：${done.error || done.status}）`, '');
      continue;
    }
    stats.push({ keyword: item.keyword, file: relPath(perKeyword), platforms: item.platformCount });
    parts.push(`## ${item.keyword}`, '', bodyFromFirstSection(fs.readFileSync(perKeyword, 'utf8')), '');
  }

  const header = [
    '# 关键词社媒汇总（跨平台互比）', '',
    `- 关键词：${list.join('、')}`,
    `- 实际采集平台：${usable.map(platformLabel).join('、')}`,
    skipped.length ? `- 本次跳过（未登录/登录过期）：${skipped.map(platformLabel).join('、')}` : '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    LOCAL_BANNER, '',
  ].filter(Boolean).join('\n');

  return { content: [header, ...parts].join('\n'), meta: { keywords: stats } };
}

/** 去掉本地汇总文件自带的标题/元信息/生成方式块，只保留正文小节（避免拼接后重复） */
function bodyFromFirstSection(markdown) {
  const index = String(markdown || '').indexOf('\n## ');
  return index >= 0 ? markdown.slice(index + 1).trim() : String(markdown || '').trim();
}

/** 从群聊汇总里筛出与关键词相关的消息，写出一个可被 cross-compare 使用的小汇总 */
async function buildKeywordQqSubset({ summaryDir, keyword, targetDir }) {
  if (!summaryDir) return '';
  const src = projectPath(summaryDir);
  const file = path.join(src, 'normalized.jsonl');
  if (!fs.existsSync(file)) return '';
  const needle = String(keyword).toLowerCase();
  const rows = fs.readFileSync(file, 'utf8').split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter((row) => (row.content || '').toLowerCase().includes(needle));
  if (!rows.length) return '';

  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(path.join(targetDir, 'normalized.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const byDay = new Map();
  for (const row of rows) {
    const day = row.day || '未知日期';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(`- ${(row.time || '').slice(11, 19)} **${row.sender_name || row.sender_id || ''}**：${(row.content || '').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  const md = [`# 群聊中与「${keyword}」相关的消息（共 ${rows.length} 条）`, ''];
  for (const [day, list] of [...byDay.entries()].sort()) {
    md.push(`## ${day}`, ...list, '');
  }
  await fsp.mkdir(path.join(targetDir, 'digest'), { recursive: true });
  await fsp.writeFile(path.join(targetDir, 'digest', '全部.md'), md.join('\n'), 'utf8');
  await fsp.writeFile(path.join(targetDir, 'p1-todo.md'), `# 「${keyword}」相关消息（${rows.length} 条）\n\n${md.join('\n')}`, 'utf8');
  await fsp.writeFile(path.join(targetDir, '_report.md'), `# 关键词子集\n\n- 关键词：${keyword}\n- 命中消息：${rows.length} 条\n`, 'utf8');
  return targetDir;
}
