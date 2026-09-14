// 汇总引擎选择 + 本地规则汇总（无 AI 服务时的保底）
//
// 上层（关键词验证、文件汇总）统一走这里，保证「汇总」这一步**永远有产物**：
//   - 配了可用的 AI 服务 → 用大模型汇总（结论更深）
//   - 没配 / 配了但不可用 → 用本地 Python 规则汇总（不联网、不花钱）
// 两种产物同名同位置，只在文件头用「生成方式」标注来源，配好 AI 重新生成即自动升级。
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.mjs';
import { projectPath, pythonPath, loadConfig } from './config.mjs';
import { runProcess, bus, getJob, cancelJob } from './jobs.mjs';
import { findProvider, providerReady } from './ai.mjs';

export const TOOLS = {
  keywords: projectPath('app/server/tools/extract_keywords.py'),
  extractFiles: projectPath('app/server/tools/extract_files.py'),
  comparePlatforms: projectPath('app/server/tools/compare_platforms.py'),
  summarizeLocal: projectPath('app/server/tools/summarize_local.py'),
};

export function toolPaths() {
  return TOOLS;
}

/** 相对项目根的路径（统一用 / 分隔，写进日志与产物索引） */
export function relPath(abs) {
  return path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/');
}

export const LOCAL_BANNER = '> 生成方式：**本地规则汇总**（当前未配置 AI 服务）。'
  + '配置 AI 服务后重新生成，会自动升级为大模型汇总；本文件仍可随时重跑。';

export function aiBanner({ provider = '', model = '' } = {}) {
  return `> 生成方式：**AI 汇总**（服务：${provider || '未知'} ｜ 模型：${model || '未知'}）。`;
}

/**
 * 判断某个环节能否用 AI。
 * 同时考虑「当前使用的服务」和该环节的单独覆盖（设置页的 perStep），
 * 任何一个是可用状态就算可用（与 ai.mjs 的 resolveTarget 口径一致）。
 */
export async function aiStatus(step = 'summary') {
  const config = await loadConfig();
  const override = (config.ai.perStep || {})[step] || '';
  const overrideId = override.includes('/') ? override.split('/')[0] : override;
  const ids = [];
  for (const id of [overrideId, config.ai.activeProviderId]) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return { ok: false, reason: '未配置 AI 服务', config, provider: null };
  const reasons = [];
  for (const id of ids) {
    const provider = findProvider(config, id);
    if (!provider) {
      reasons.push(`找不到服务 ${id}`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const ready = await providerReady(provider);
    if (ready.ok) return { ok: true, provider, config };
    reasons.push(`${provider.name}：${ready.reason}`);
  }
  return { ok: false, reason: reasons.join('；') || 'AI 服务不可用', config, provider: null };
}

/** 等待一个子任务结束，支持超时（超时则终止子任务并把原因写进父任务日志） */
export function waitJobWithTimeout(job, { timeoutMs = 0, job: parent = null, label = '' } = {}) {
  const wait = new Promise((resolve) => {
    if (job.status !== 'running') {
      resolve({ status: job.status, result: job.result, error: job.error });
      return;
    }
    const onEvent = (event) => {
      if (event.type === 'status' && event.jobId === job.id) {
        bus.off('event', onEvent);
        resolve({ status: event.status, result: getJob(job.id)?.result, error: event.error });
      }
    };
    bus.on('event', onEvent);
  });
  if (!timeoutMs) return wait;
  return Promise.race([
    wait,
    new Promise((resolve) => {
      setTimeout(() => {
        if (job.status === 'running') {
          parent?.emit(`[超时] ${label || job.title} 超过 ${Math.round(timeoutMs / 60000)} 分钟，已终止`, 'err');
          cancelJob(job.id);
        }
        resolve({ status: 'timeout', result: null, error: `超过 ${Math.round(timeoutMs / 60000)} 分钟未完成` });
      }, timeoutMs);
    }),
  ]);
}

/** 跑一次本地规则汇总（social：跨平台材料 → 关键词汇总；docs：文档批次 → 文件汇总） */
export function runLocalSummary({ mode, outFile, compareFile = '', docsDir = '', keyword = '', batch = '', refresh = [] }) {
  if (!fs.existsSync(TOOLS.summarizeLocal)) throw new Error(`缺少本地汇总脚本：${TOOLS.summarizeLocal}`);
  const args = [TOOLS.summarizeLocal, '--mode', mode, '--out', outFile];
  if (compareFile) args.push('--compare', compareFile);
  if (docsDir) args.push('--docs', docsDir);
  if (keyword) args.push('--keyword', keyword);
  if (batch) args.push('--batch', batch);
  return runProcess({
    kind: 'local-summary',
    title: `本地汇总（${mode === 'docs' ? '文件' : '关键词社媒'}）：${keyword || batch || path.basename(path.dirname(outFile))}`,
    command: pythonPath(),
    args,
    meta: { mode, outFile: relPath(outFile), engine: 'local', refresh },
    detect: [/\{"ok".*\}$/],
  });
}

/**
 * 统一入口：按配置决定用 AI 还是本地规则汇总。
 * @returns {Promise<{engine:'ai'|'local', content:string, meta:object}>}
 * @param opts.material AI 模式下要发送的材料文本（本地模式不需要）
 * @param opts.buildLocal () => Promise<{content:string, meta:object}> 本地模式的产出方式
 * @param opts.engine 'auto' | 'ai' | 'local'
 * 注意：本地模式下「生成方式」标注由 buildLocal 自己负责（本地汇总脚本会写进文件头）。
 */
export async function summarizeWithFallback({
  engine = 'auto', step = 'summary', job = null, signal = null,
  system = '', material = '',
  buildLocal = null, chatFn = null, label = '汇总', fallbackToLocal = true,
}) {
  const wantsLocal = engine === 'local';
  const status = wantsLocal ? { ok: false, reason: '按请求指定使用本地汇总' } : await aiStatus(step);

  const useLocal = async (reasonLine, level = 'warn') => {
    job?.emit(reasonLine, level);
    if (!buildLocal) throw new Error('本地汇总不可用（缺少 buildLocal）');
    const local = await buildLocal({ job, signal });
    return { engine: 'local', content: local.content, meta: local.meta || {} };
  };

  if (!status.ok) {
    return useLocal(`[引擎] 未启用 AI（${status.reason}）→ 使用本地规则汇总`);
  }

  job?.emit(`[引擎] 使用 AI 汇总（${status.provider.name}）｜${label}`, 'sys');
  try {
    const answer = await chatFn({
      step,
      job,
      signal,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: material },
      ],
    });
    return {
      engine: 'ai',
      content: `${aiBanner({ provider: answer.provider, model: answer.model })}\n\n${answer.content}`,
      meta: {
        model: answer.model, provider: answer.provider,
        tokensIn: answer.tokensIn, tokensOut: answer.tokensOut,
        elapsedMs: answer.elapsedMs, cost: answer.cost,
      },
    };
  } catch (err) {
    // AI 调用失败不能导致「没有任何汇总」：自动退回本地规则，保证产物一定存在
    if (!fallbackToLocal || !buildLocal) throw err;
    return useLocal(`[警告] AI 汇总失败：${err.message} → 自动改用本地规则汇总`, 'err');
  }
}
