// 技能调用：把三个技能脚本包成函数，统一通过 jobs 执行并回传任务对象
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, PATHS } from './paths.mjs';
import { projectPath, pythonPath, loadConfig } from './config.mjs';
import { runProcess, cancelJob } from './jobs.mjs';
import { edgeInstance, ensureCrawlEdge, listCdpTabs, closeCrawlTabs, resolveDshInvocation } from './startup.mjs';
import { snapshotSessionIds } from './dsh-sessions.mjs';
import { summaryTargetDir } from './exports.mjs';

export function skillPaths() {
  return {
    python: pythonPath(),
    qqDigest: projectPath(PATHS.qqDigest),
    crawl: projectPath(PATHS.crawl),
    compare: projectPath(PATHS.compare),
    edgeLauncher: projectPath(PATHS.edgeLauncher),
  };
}

/** 群聊解析与汇总 */
export async function runQqDigest({ file, outDir, mediaRoot, dateFrom, dateTo, chat, mediaCheck = true }) {
  const { python, qqDigest } = skillPaths();
  if (!fs.existsSync(qqDigest)) throw new Error(`找不到脚本：${qqDigest}`);
  const args = [qqDigest, '--src', file, '--out', outDir];
  if (mediaRoot) args.push('--media-root', mediaRoot);
  if (mediaCheck) args.push('--media-check');
  if (dateFrom) args.push('--from', dateFrom);
  if (dateTo) args.push('--to', dateTo);
  if (chat) args.push('--chat', chat);
  return runProcess({
    kind: 'qq-digest',
    title: `群聊汇总：${path.basename(file)}`,
    command: python,
    args,
    meta: { file, outDir, refresh: ['summaries', 'exports', 'social'] },
    detect: [/\{"files":.*\}$/],
  });
}

/**
 * 社媒采集。
 * ★ 采集走**独立的 Edge 采集实例**（crawlPort/crawlProfile），不再占用界面实例的窗口；
 *   采集结束后（job.onFinish）自动关掉本次它打开的社媒标签页。
 */
export async function runCrawl({
  platform, mode = 'search', keywords = '', specifiedId = '', creatorId = '',
  limit, commentsPerItem, outDir, noComments = false, timeout = 3600,
  cdpPort = 0, edgeProfile = '', onLine = null,
}) {
  const config = await loadConfig();
  const { python, crawl } = skillPaths();
  if (!fs.existsSync(crawl)) throw new Error(`找不到脚本：${crawl}`);
  const instance = await edgeInstance('crawl', { config });
  const port = Number(cdpPort) || instance.port;
  const profile = edgeProfile || instance.profile;

  // 采集前记录已有标签页，结束后只关「新出现的、且属于本次平台域名」的那些
  let beforeIds = [];
  try {
    beforeIds = (await listCdpTabs(port)).map((t) => t.id);
  } catch { /* 实例还没起来也很正常，采集脚本会自己拉起 */ }

  const args = [
    crawl,
    '--platform', platform,
    '--type', mode,
    '--out', outDir,
    '--browser', 'edge',
    '--timeout', String(timeout),
    '--limit', String(limit ?? config.collect.defaultLimit),
    '--comments-per-item', String(commentsPerItem ?? config.collect.defaultComments),
    '--cdp-port', String(port),
    '--edge-profile', profile,
    '--launch-edge',
  ];
  if (mode === 'search') args.push('--keywords', keywords);
  if (mode === 'detail') args.push('--specified-id', specifiedId);
  if (mode === 'creator') args.push('--creator-id', creatorId);
  if (noComments) args.push('--no-comments');

  const job = runProcess({
    kind: 'crawl',
    title: `采集：${platform} / ${mode === 'search' ? keywords : (specifiedId || creatorId)}`,
    command: python,
    args,
    meta: { platform, mode, outDir, cdpPort: port, refresh: ['social'] },
    detect: [/\{"exit_code".*\}$/],
  });

  job.onFinish = async () => {
    const emit = onLine || ((line, level) => job.emit(line, level || 'sys'));
    try {
      const result = await closeCrawlTabs({ port, beforeIds, platforms: [platform], onLine: emit });
      if (result?.closed) emit(`[清理] 本次采集打开 ${result.closed} 个社媒标签页，已自动关闭`, 'sys');
      else emit('[清理] 本次采集没有留下需要关闭的社媒标签页', 'sys');
    } catch (err) {
      emit(`[提示] 采集后清理标签页失败（不影响采集结果）：${err.message}`, 'sys');
    }
  };
  return job;
}

/** 交叉比对 */
export async function runCompare({ qqDir, socialDir, outDir, top, minScore }) {
  const { python, compare } = skillPaths();
  if (!fs.existsSync(compare)) throw new Error(`找不到脚本：${compare}`);
  const args = [compare, '--qq', qqDir, '--social', socialDir, '--out', outDir];
  if (top) args.push('--top', String(top));
  if (minScore !== undefined && minScore !== null && minScore !== '') args.push('--min-score', String(minScore));
  return runProcess({
    kind: 'compare',
    title: `交叉比对：${path.basename(qqDir)} × ${path.basename(socialDir)}`,
    command: python,
    args,
    meta: { qqDir, socialDir, outDir, refresh: ['compares'] },
    detect: [/\{"ok":.*\}$/],
  });
}

/**
 * 用本地 DSH 跑一次非交互任务（headless profile），并返回本次运行前的会话快照，
 * 供调用方在任务结束后清理 DSH 里这次运行产生的会话。
 */
export function runDshHeadlessWithSession(prompt, opts = {}) {
  const sessionBefore = snapshotSessionIds();
  const job = runDshHeadless(prompt, opts);
  return { job, sessionBefore };
}

/**
 * 用本地 DSH 跑一次非交互任务（headless profile），回答在 stdout。
 * 注意：命令行有长度上限（Windows 约 8k），因此把提示词压成单行并限制长度，
 * 长材料一律通过「文件路径」交给 DSH 自行读取，而不是塞进命令行。
 */
export function runDshHeadless(prompt, { timeoutMs = 30 * 60 * 1000, maxChars = 6000 } = {}) {
  let text = String(prompt).replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n（提示词过长已截断，请按上面给出的文件路径自行读取材料）`;
    truncated = true;
  }
  const job = runProcess({
    kind: 'dsh-headless',
    title: '本地 DSH 生成总结',
    // 提示词含用户输入（风格要求/重点关注），必须走「node + CLI 入口」这条不经 shell 的路，
    // 否则参数会经 cmd.exe 二次解析 → 命令注入（见 startup.mjs 的 resolveDshInvocation）
    ...resolveDshInvocation(['--profile', 'headless', text]),
    meta: { promptChars: text.length, truncated },
  });
  if (timeoutMs > 0) {
    const timer = setTimeout(() => {
      if (job.status === 'running') {
        job.emit(`[系统] 超过 ${Math.round(timeoutMs / 60000)} 分钟未完成，自动终止`, 'sys');
        cancelJob(job.id);
      }
    }, timeoutMs);
    job.onFinish = () => clearTimeout(timer);
  }
  return job;
}

/** 拼出产出目录（供界面预览） */
export async function collectSummaryMeta(dirRel) {
  const dir = projectPath(dirRel);
  if (!fs.existsSync(dir)) return null;
  const digestDir = path.join(dir, 'digest');
  const digests = fs.existsSync(digestDir) ? fs.readdirSync(digestDir).filter((f) => f.endsWith('.md')).sort() : [];
  const readIf = (rel) => {
    const file = path.join(dir, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  return {
    dir: dirRel,
    digests,
    p1: readIf('p1-todo.md'),
    report: readIf('_report.md'),
  };
}

export { summaryTargetDir };
