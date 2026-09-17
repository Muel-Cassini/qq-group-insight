// 本地服务：静态页面 + JSON API + 任务日志流（SSE）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  APP_DIR, PROJECT_ROOT, WEB_DIR, PATHS,
} from './paths.mjs';
import {
  loadConfig, saveConfig, setSecret, hasSecret, deleteSecret, projectPath,
} from './config.mjs';
import { jobs, listJobs, getJob, cancelJob, bus, runningJobs, pidAlive } from './jobs.mjs';
import {
  ensureEdge, ensureDsh, bootstrap, statusSnapshot, openPath, portOpen,
} from './startup.mjs';
import { sessionStats, cleanupNewSessions } from './dsh-sessions.mjs';
import {
  listExports, archiveExports, deleteExports, readArtifact, summaryTargetDir, listSummaries,
  exportsDirsInfo, inspectDir, resolveOutputDir,
} from './exports.mjs';
import { runQqDigest, runCrawl, runCompare } from './skills.mjs';
import {
  listSummaryDirs, listCompareDirs, listSocialDirs, startSummary, previewSummary,
  startKeywordSuggest, loadMaterial,
} from './summarize.mjs';
import { startClassifyReview, readClassifyReview, startCompareVerdict } from './review.mjs';
import { listPresets, fetchModels, providerReady, findProvider } from './ai.mjs';
import { startKeywordExtract, readKeywords, startKeywordVerify } from './keyword-verify.mjs';
import {
  saveUpload, deleteUpload, listUploads, startExtractUploads, readExtracted,
  startDocSummary, previewDocSummary, listDocSummaries,
  listDocTemplates, saveDocTemplate, deleteDocTemplate,
} from './files.mjs';
import { aiStatus } from './local-summary.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 本次服务进程的启动时间（供 /api/health 与界面识别实例） */
const SERVER_STARTED_AT = new Date().toISOString();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(WEB_DIR, rel);
  // 注意必须带上分隔符再比较：只 startsWith(WEB_DIR) 会放过同级的 webXXX 目录（前缀相同）
  const webRoot = WEB_DIR.endsWith(path.sep) ? WEB_DIR : WEB_DIR + path.sep;
  if (target !== WEB_DIR && !target.startsWith(webRoot)) {
    sendJson(res, 403, { ok: false, error: '非法路径' });
    return;
  }
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { ok: false, error: `未找到 ${rel}` });
  }
}

/** 等待任务结束（供一键流程串行使用） */
function waitJob(job) {
  if (job.status !== 'running') {
    return Promise.resolve({ status: job.status, result: job.result, exitCode: job.exitCode, error: job.error });
  }
  return new Promise((resolve) => {
    const onEvent = (event) => {
      if (event.type === 'status' && event.jobId === job.id) {
        bus.off('event', onEvent);
        resolve({ status: event.status, result: getJob(job.id)?.result, exitCode: event.exitCode, error: event.error });
      }
    };
    bus.on('event', onEvent);
  });
}

function pickDateRange(header) {
  const range = header?.timeRange || {};
  const toDay = (value) => {
    if (typeof value !== 'string' || !value) return '';
    const match = value.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  };
  return { from: toDay(range.start), to: toDay(range.end) };
}

/** 读取导出文件的统计信息（用于自动填日期区间与摘要目录名） */
function readExportMeta(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { chatInfo: data.chatInfo || {}, statistics: data.statistics || {} };
  } catch {
    return null;
  }
}

const routes = {
  'GET /api/health': async () => ({
    ok: true,
    data: { app: 'dsh-summary-app', projectRoot: PROJECT_ROOT, pid: process.pid, startedAt: SERVER_STARTED_AT },
  }),

  'GET /api/config': async () => {
    const config = await loadConfig();
    return {
      ok: true,
      data: {
        config,
        presets: listPresets(),
        secretState: Object.fromEntries((config.ai.providers || []).map((p) => [p.id, hasSecret(`provider:${p.id}`)])),
        projectRoot: PROJECT_ROOT,
        paths: PATHS,
      },
    };
  },

  'POST /api/config': async (body) => {
    const config = await saveConfig(body.patch || {});
    return { ok: true, data: { config } };
  },

  'POST /api/provider': async (body) => {
    const config = await loadConfig();
    const providers = Array.isArray(config.ai.providers) ? [...config.ai.providers] : [];
    const incoming = body.provider || {};
    const id = incoming.id || `p_${Date.now().toString(36)}`;
    const record = {
      id,
      name: incoming.name || '未命名服务',
      presetId: incoming.presetId || 'custom',
      format: incoming.format === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: String(incoming.baseUrl || '').trim(),
      models: Array.isArray(incoming.models) ? incoming.models.filter(Boolean) : [],
      defaultModel: String(incoming.defaultModel || '').trim(),
    };
    const index = providers.findIndex((item) => item.id === id);
    if (index >= 0) providers[index] = { ...providers[index], ...record };
    else providers.push(record);
    const next = await saveConfig({ ai: { providers, activeProviderId: config.ai.activeProviderId || id } });
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      await setSecret(`provider:${id}`, body.apiKey.trim());
    }
    if (body.apiKey === '') await deleteSecret(`provider:${id}`);
    return { ok: true, data: { providers: next.ai.providers, secretState: hasSecret(`provider:${id}`) } };
  },

  'POST /api/provider/delete': async (body) => {
    const config = await loadConfig();
    const providers = (config.ai.providers || []).filter((item) => item.id !== body.id);
    await deleteSecret(`provider:${body.id}`);
    const next = await saveConfig({
      ai: { providers, activeProviderId: config.ai.activeProviderId === body.id ? (providers[0]?.id || '') : config.ai.activeProviderId },
    });
    return { ok: true, data: { providers: next.ai.providers } };
  },

  'POST /api/provider/models': async (body) => {
    const models = await fetchModels(body.id);
    return { ok: true, data: { models } };
  },

  'POST /api/provider/ping': async (body) => {
    const config = await loadConfig();
    const provider = findProvider(config, body.id);
    const ready = await providerReady(provider);
    return { ok: true, data: { ready, provider: provider ? { id: provider.id, name: provider.name, baseUrl: provider.baseUrl } : null } };
  },

  'GET /api/status': async () => ({ ok: true, data: await statusSnapshot() }),
  'POST /api/startup/bootstrap': async () => ({ ok: true, data: await bootstrap() }),
  'POST /api/startup/edge': async () => ({ ok: true, data: await ensureEdge({}) }),
  'POST /api/startup/dsh': async () => ({ ok: true, data: await ensureDsh({}) }),

  'GET /api/exports': async () => ({ ok: true, data: { items: await listExports() } }),

  'POST /api/exports/archive': async (body) => ({ ok: true, data: await archiveExports(body.files || []) }),
  'POST /api/exports/delete': async (body) => ({ ok: true, data: await deleteExports(body.files || []) }),

  // 聊天记录读取位置：查看当前 / 校验候选路径 / 浏览目录树
  'GET /api/dirs': async () => {
    const dirs = await exportsDirsInfo();
    return {
      ok: true,
      data: {
        projectRoot: PROJECT_ROOT,
        dirs: dirs.map((item) => ({
          ...item,
          rel: path.relative(PROJECT_ROOT, item.dir).replace(/\\/g, '/') || '.',
          ...inspectDir(item.dir),
        })),
      },
    };
  },

  'POST /api/dirs/validate': async (body) => {
    const raw = String(body.path || '').trim();
    if (!raw) return { ok: true, data: { empty: true, hint: '留空表示使用项目内默认目录' } };
    const normalized = raw.replace(/\//g, path.sep);
    const abs = path.isAbsolute(normalized) ? path.normalize(normalized) : path.join(PROJECT_ROOT, normalized);
    const info = inspectDir(abs);
    let hint;
    if (!info.exists) hint = '目录不存在：QCE 导出到该目录后才会创建，请确认路径拼写';
    else if (!info.readable) hint = `目录无法读取：${info.error}`;
    else if (info.exportFiles === 0) hint = '目录里没有 .json/.jsonl 导出文件（可能还没导出，或指到了上一级目录）';
    else if (!info.hasResources) hint = '目录里没有 resources 子目录：该导出可能未勾选“下载图片/文件”，媒体清单会缺少实际文件';
    else hint = `可用：发现 ${info.exportFiles} 个导出文件，且包含 resources 媒体目录`;
    return { ok: true, data: { empty: false, path: abs, rel: path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/'), ...info, hint } };
  },

  'GET /api/dirs/browse': async (_body, url) => {
    const raw = String(url.searchParams.get('path') || '').trim();
    const normalized = raw.replace(/\//g, path.sep);
    const abs = !raw
      ? PROJECT_ROOT
      : (path.isAbsolute(normalized) ? path.normalize(normalized) : path.join(PROJECT_ROOT, normalized));
    if (!fs.existsSync(abs)) throw new Error(`目录不存在：${abs}`);
    const stat = fs.statSync(abs);
    const baseDir = stat.isDirectory() ? abs : path.dirname(abs);
    const entries = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(baseDir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(baseDir);
    const drives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
      .filter((letter) => fs.existsSync(`${letter}:\\`))
      .map((letter) => `${letter}:\\`);
    // 常用位置快捷入口（按当前用户环境推导，不写死任何个人路径；不存在的会被过滤掉）
    const home = process.env.USERPROFILE || '';
    const localApp = process.env.LOCALAPPDATA || '';
    const shortcuts = [
      { name: '项目内默认导出目录', path: projectPath(PATHS.exports) },
      { name: '项目内定时导出目录', path: projectPath(PATHS.scheduledExports) },
      home && { name: '我的文档\\QQChatExporter', path: path.join(home, 'Documents', 'QQChatExporter') },
      localApp && { name: 'LocalAppData\\QQChatExporter', path: path.join(localApp, 'QQChatExporter') },
    ].filter((item) => item && fs.existsSync(item.path));
    return {
      ok: true,
      data: {
        current: baseDir,
        rel: path.relative(PROJECT_ROOT, baseDir).replace(/\\/g, '/') || '.',
        parent: parent === baseDir ? '' : parent,
        drives,
        entries,
        shortcuts,
      },
    };
  },


  'POST /api/exports/digest': async (body) => {
    const file = projectPath(body.file);
    if (!fs.existsSync(file)) throw new Error(`导出文件不存在：${body.file}`);
    const meta = readExportMeta(file);
    const { from, to } = pickDateRange(meta?.statistics);
    const name = meta?.chatInfo?.name || path.basename(file);
    const stamp = (path.basename(file).match(/_(\d{8}_\d+)\./) || [])[1] || '';
    // 自定义输出目录：绝对路径原样用；相对路径必须落在项目内（禁止 ../ 越界）
    const outDir = resolveOutputDir(body.outDir) || projectPath(summaryTargetDir(name, from, to, stamp));
    const job = await runQqDigest({
      file,
      outDir,
      mediaRoot: path.dirname(file),
      dateFrom: body.dateFrom || '',
      dateTo: body.dateTo || '',
      chat: body.chat || '',
      mediaCheck: body.mediaCheck !== false,
    });
    const relOut = path.relative(PROJECT_ROOT, outDir).replace(/\\/g, '/');
    job.emit(`[目标] 汇总输出：${relOut}`, 'sys');
    return {
      ok: true,
      data: {
        jobId: job.id, outDir: relOut, absOutDir: outDir, name, range: { from, to },
        applied: {
          dateFrom: body.dateFrom || '', dateTo: body.dateTo || '',
          chat: body.chat || '', mediaCheck: body.mediaCheck !== false,
        },
      },
    };
  },

  'GET /api/artifact': async (_body, url) => {
    const rel = url.searchParams.get('path') || '';
    return { ok: true, data: await readArtifact(rel) };
  },

  // 注意：必须用 exports.mjs 的 listSummaries（带 mtime/files/building 与容错），
  // 之前误用 summarize.mjs 的 listSummaryDirs 只返回三个字段，会让前端渲染报错
  'GET /api/summaries': async () => ({ ok: true, data: { items: listSummaries() } }),

  'GET /api/summary-files': async () => {
    const root = projectPath(PATHS.outSummary);
    if (!fs.existsSync(root)) return { ok: true, data: { items: [] } };
    const items = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => {
        const stat = fs.statSync(path.join(root, entry.name));
        return {
          name: entry.name,
          relFile: `${PATHS.outSummary}/${entry.name}`,
          sizeKB: Number((stat.size / 1024).toFixed(1)),
          mtime: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return { ok: true, data: { items } };
  },
  'GET /api/social': async () => ({ ok: true, data: { items: listSocialDirs() } }),
  'GET /api/compares': async () => ({ ok: true, data: { items: listCompareDirs() } }),

  'POST /api/summarize/classify': async (body) => {
    const job = await startClassifyReview({
      summaryDir: body.summaryDir,
      batchSize: body.batchSize,
      includeAll: Boolean(body.includeAll),
      limit: body.limit,
    });
    return { ok: true, data: { jobId: job.id } };
  },

  'GET /api/summarize/classify': async (_body, url) => ({
    ok: true,
    data: readClassifyReview(url.searchParams.get('dir') || '', {
      onlyChanged: url.searchParams.get('all') !== '1',
    }),
  }),

  'POST /api/collect/crawl': async (body) => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const tag = (body.keywords || body.specifiedId || body.creatorId || 'batch').toString().slice(0, 24).replace(/[\\/:*?"<>|]/g, '_');
    const outDir = body.outDir ? projectPath(body.outDir) : projectPath(path.join(PATHS.outSocial, `${stamp}-${body.platform}-${tag}`));
    const job = await runCrawl({
      platform: body.platform,
      mode: body.mode || 'search',
      keywords: body.keywords || '',
      specifiedId: body.specifiedId || '',
      creatorId: body.creatorId || '',
      limit: body.limit,
      commentsPerItem: body.commentsPerItem,
      noComments: Boolean(body.noComments),
      timeout: body.timeout || 3600,
      outDir,
    });
    const relOut = path.relative(PROJECT_ROOT, outDir).replace(/\\/g, '/');
    job.emit(`[目标] 采集输出：${relOut}`, 'sys');
    return { ok: true, data: { jobId: job.id, outDir: relOut } };
  },

  'POST /api/collect/keywords': async (body) => {
    const job = await startKeywordSuggest({ summaryDir: body.summaryDir, count: body.count || 8 });
    return { ok: true, data: { jobId: job.id } };
  },

  'POST /api/compare/run': async (body) => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const outDir = body.outDir ? projectPath(body.outDir) : projectPath(path.join(PATHS.outCompare, stamp));
    const job = await runCompare({
      qqDir: projectPath(body.qqDir),
      socialDir: projectPath(body.socialDir),
      outDir,
      top: body.top,
      minScore: body.minScore,
    });
    const relOut = path.relative(PROJECT_ROOT, outDir).replace(/\\/g, '/');
    job.emit(`[目标] 比对输出：${relOut}`, 'sys');
    return { ok: true, data: { jobId: job.id, outDir: relOut } };
  },

  'POST /api/compare/verdict': async (body) => {
    const job = await startCompareVerdict({ compareDir: body.compareDir, batchSize: body.batchSize, limit: body.limit });
    return { ok: true, data: { jobId: job.id } };
  },

  'POST /api/summary/preview': async (body) => ({ ok: true, data: await previewSummary(body) }),

  'POST /api/summary/generate': async (body) => {
    const { job, outFile } = await startSummary(body);
    return { ok: true, data: { jobId: job.id, outFile } };
  },

  'GET /api/jobs': async () => ({ ok: true, data: { jobs: listJobs().slice(-50).reverse() } }),

  // 当前正在运行的进程（供日志区展示"现在在跑什么"）
  'GET /api/processes': async () => {
    const running = runningJobs().map((job) => ({
      ...job,
      pidAlive: pidAlive(job.pid),
      commandLine: [job.command, ...(job.args || [])].join(' ').slice(0, 300),
    }));
    return {
      ok: true,
      data: {
        appPid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        runningCount: running.length,
        running,
      },
    };
  },

  'GET /api/jobs/log': async (_body, url) => {
    const job = getJob(url.searchParams.get('id'));
    if (!job) throw new Error('任务不存在');
    const text = job.logs.map((entry) => `[${new Date(entry.t).toLocaleTimeString()}] ${entry.line}`).join('\n');
    return { ok: true, data: { status: job.status, text, result: job.result, error: job.error } };
  },

  'POST /api/jobs/cancel': async (body) => ({ ok: true, data: cancelJob(body.id) }),

  // —— 关键词验证（本地提取候选词 → 社媒检索 → 比对 → AI 判定 → 报告）
  'POST /api/keywords/extract': async (body) => {
    const job = await startKeywordExtract({
      summaryDir: body.summaryDir, top: body.top, minCount: body.minCount, onlyDomain: Boolean(body.onlyDomain),
    });
    return { ok: true, data: { jobId: job.id } };
  },

  'GET /api/keywords': async (_body, url) => {
    const summaryDir = url.searchParams.get('summaryDir') || '';
    return { ok: true, data: readKeywords(summaryDir) };
  },

  'POST /api/keywords/verify': async (body) => {
    const job = await startKeywordVerify({
      keywords: body.keywords,
      platforms: body.platforms,
      summaryDir: body.summaryDir || '',
      limit: body.limit,
      commentsPerItem: body.commentsPerItem,
      useAiVerdict: body.useAiVerdict !== false,
      style: body.style || '',
      focus: body.focus || '',
      compareMode: body.compareMode === 'with-qq' ? 'with-qq' : 'social',
      engine: body.engine || 'auto',       // auto | ai | local
      topPairs: body.topPairs,
      minScore: body.minScore,
    });
    return { ok: true, data: { jobId: job.id } };
  },

  // 当前汇总会用哪条引擎（前端据此提示「本地规则 / AI」）
  'GET /api/summary-engine': async () => {
    const doc = await aiStatus('summary');
    const kw = await aiStatus('compare');
    return {
      ok: true,
      data: {
        docs: { ai: doc.ok, provider: doc.provider?.name || '', reason: doc.reason || '' },
        keywords: { ai: kw.ok, provider: kw.provider?.name || '', reason: kw.reason || '' },
      },
    };
  },

  'GET /api/keywords/verify-results': async () => {
    const root = projectPath(PATHS.outKeywords);
    if (!fs.existsSync(root)) return { ok: true, data: { items: [] } };
    const items = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('verify-'))
      .map((entry) => {
        const dir = path.join(root, entry.name);
        const report = path.join(dir, 'verify-report.md');
        const summary = path.join(dir, 'verify-summary.md');
        const hasSummary = fs.existsSync(summary);
        // 汇总文件头会标注生成方式，这里读回来给界面打标签（本地规则 / AI）
        let summaryEngine = '';
        if (hasSummary) {
          try {
            const head = fs.readFileSync(summary, 'utf8').slice(0, 400);
            if (head.includes('本地规则汇总')) summaryEngine = 'local';
            else if (head.includes('AI 汇总')) summaryEngine = 'ai';
          } catch { /* 读不到就不标 */ }
        }
        return {
          name: entry.name,
          relDir: path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/'),
          hasReport: fs.existsSync(report),
          hasSummary,
          summaryEngine,
          reportFile: fs.existsSync(report) ? `${PATHS.outKeywords}/${entry.name}/verify-report.md` : '',
          summaryFile: hasSummary ? `${PATHS.outKeywords}/${entry.name}/verify-summary.md` : '',
          mtime: fs.statSync(dir).mtime.toISOString(),
        };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return { ok: true, data: { items } };
  },

  // —— 用户提供文件（上传 → 提取 → 汇总）
  'GET /api/uploads': async () => ({ ok: true, data: { batches: await listUploads(), summaries: listDocSummaries() } }),

  'POST /api/uploads': async (body) => {
    const saved = await saveUpload({ name: body.name, base64: body.base64, subdir: body.batch || '' });
    return { ok: true, data: saved };
  },

  'POST /api/uploads/delete': async (body) => ({ ok: true, data: await deleteUpload(body.path) }),

  'POST /api/uploads/extract': async (body) => {
    const job = await startExtractUploads({ batch: body.batch });
    return { ok: true, data: { jobId: job.id } };
  },

  'GET /api/uploads/extracted': async (_body, url) => {
    const batch = url.searchParams.get('batch') || '';
    const file = url.searchParams.get('file') || '';
    return { ok: true, data: readExtracted(batch, { file }) };
  },

  'POST /api/docs/preview': async (body) => ({ ok: true, data: await previewDocSummary(body) }),

  'POST /api/docs/summary': async (body) => {
    const job = await startDocSummary({
      batches: body.batches, style: body.style, focus: body.focus,
      engine: body.engine || 'auto',   // auto | ai | local
    });
    return { ok: true, data: { jobId: job.id } };
  },

  // —— 提示词模板（可保存/复用）
  'GET /api/prompts/doc-summary': async () => ({ ok: true, data: await listDocTemplates() }),

  'POST /api/prompts/doc-summary/save': async (body) => ({
    ok: true,
    data: await saveDocTemplate({ name: body.name, style: body.style, focus: body.focus, id: body.id }),
  }),

  'POST /api/prompts/doc-summary/delete': async (body) => ({
    ok: true,
    data: await deleteDocTemplate(body.id),
  }),

  'POST /api/open': async (body) => {
    const result = await openPath(body.path);
    if (!result.ok) {
      console.warn(`[open] 失败 path=${body.path} → ${result.error}`);
      throw new Error(result.error || '打开失败（未提供原因）');
    }
    console.log(`[open] 已打开 ${result.path || result.url}（方式：${result.via}）`);
    return { ok: true, data: result };
  },

  // DSH 会话：查询与手动清理（总结完成后会自动清理本次产生的会话）
  'GET /api/dsh/sessions': async () => ({ ok: true, data: sessionStats() }),

  'POST /api/dsh/sessions/cleanup': async (body) => {
    const report = await cleanupNewSessions(new Set(body.keepIds || []), {
      markers: Array.isArray(body.markers) ? body.markers : [],
      dryRun: Boolean(body.dryRun),
    });
    return { ok: true, data: report };
  },

  'POST /api/fullrun': async (body) => {
    // 一键全流程：可选步骤、失败即停在当前步（前端可据此「从断点继续」）
    const steps = Array.isArray(body.steps) && body.steps.length
      ? body.steps
      : ['digest', 'keywords', 'crawl', 'compare', 'summary'];
    return {
      ok: true,
      data: {
        steps,
        planned: {
          file: body.file,
          platforms: body.platforms || ['xhs'],
          keywords: body.keywords || '',
          engine: body.engine || 'api',
          summaryDir: body.summaryDir || '',
          compareDir: body.compareDir || '',
        },
        hint: '请按顺序调用各步接口；本接口仅返回编排计划，便于前端逐步执行并支持断点继续。',
      },
    };
  },
};

async function handleApi(req, res, url) {
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) {
    sendJson(res, 404, { ok: false, error: `未知接口 ${key}` });
    return;
  }
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await handler(body, url);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message || String(err) });
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('event: hello\ndata: {"ok":true}\n\n');
  const onEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  bus.on('event', onEvent);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off('event', onEvent);
  });
}

async function findFreePort(preferred, range) {
  for (let port = preferred; port < preferred + range; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await portOpen(port))) return port;
  }
  return 0;
}

export async function startServer() {
  const config = await loadConfig();
  const preferred = Number(config.server.port || 7801);
  const range = Number(config.server.portScanRange || 20);
  const port = await findFreePort(preferred, range);
  if (!port) throw new Error(`端口 ${preferred}~${preferred + range} 都被占用，请在设置里改端口`);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/api/events') {
      handleSse(req, res);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  });

  await new Promise((resolve) => server.listen(port, config.server.host || '127.0.0.1', resolve));
  return { server, port, host: config.server.host || '127.0.0.1' };
}

export { openPath };
