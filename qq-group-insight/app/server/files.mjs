// 用户提供文件（PDF/Word/Excel/文本等）：接收上传 → 提取文本 → 汇入总结材料
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, PATHS } from './paths.mjs';
import { projectPath, pythonPath, loadConfig, saveConfig } from './config.mjs';
import { runProcess, runTask } from './jobs.mjs';
import { chat, preview as aiPreview } from './ai.mjs';
import {
  toolPaths, runLocalSummary, summarizeWithFallback, waitJobWithTimeout, relPath, LOCAL_BANNER,
} from './local-summary.mjs';

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024; // 单文件 40MB
const BLOCKED_EXT = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.scr', '.msi', '.vbs', '.js', '.jar']);

const uploadsRoot = () => projectPath(PATHS.outUploads);

function safeName(name) {
  const base = path.basename(String(name || 'unnamed')).replace(/[\\/:*?"<>|]/g, '_').trim();
  return base || 'unnamed';
}

/** 保存上传的文件（base64），返回落盘信息 */
export async function saveUpload({ name, base64, subdir = '' }) {
  if (!name || !base64) throw new Error('缺少文件名或内容');
  const clean = safeName(name);
  const ext = path.extname(clean).toLowerCase();
  if (BLOCKED_EXT.has(ext)) throw new Error(`出于安全考虑，拒绝保存 ${ext} 类型文件`);
  const buffer = Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64');
  if (!buffer.length) throw new Error('文件内容为空');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB 上限（当前 ${(buffer.length / 1048576).toFixed(1)}MB）`);
  }
  const batchDir = path.join(uploadsRoot(), subdir || new Date().toISOString().slice(0, 10));
  await fsp.mkdir(batchDir, { recursive: true });
  // 重名时加序号，避免覆盖
  let target = path.join(batchDir, clean);
  let index = 1;
  while (fs.existsSync(target)) {
    const stem = path.basename(clean, ext);
    target = path.join(batchDir, `${stem}(${index})${ext}`);
    index += 1;
  }
  await fsp.writeFile(target, buffer);
  return {
    ok: true,
    name: path.basename(target),
    relPath: path.relative(PROJECT_ROOT, target).replace(/\\/g, '/'),
    sizeKB: Number((buffer.length / 1024).toFixed(1)),
    ext,
  };
}

/** 删除已上传文件（走回收站由上层决定；这里直接删上传目录内的文件） */
export async function deleteUpload(relPath) {
  const abs = path.isAbsolute(relPath) ? relPath : projectPath(relPath);
  const root = path.resolve(uploadsRoot());
  const resolved = path.resolve(abs);
  // 带分隔符比较：只 startsWith(root) 会放过同级的 uploadsXXX 目录
  if (resolved !== root && !resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
    throw new Error('只能删除上传目录内的文件');
  }
  await fsp.rm(abs, { force: true });
  return { ok: true, removed: path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/') };
}

/** 列出上传批次与文件 */
export async function listUploads() {
  const root = uploadsRoot();
  if (!fs.existsSync(root)) return [];
  const batches = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const dir = path.join(root, entry.name);
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile())
      .map((item) => {
        const full = path.join(dir, item.name);
        const stat = fs.statSync(full);
        return {
          name: item.name,
          relPath: path.relative(PROJECT_ROOT, full).replace(/\\/g, '/'),
          sizeKB: Number((stat.size / 1024).toFixed(1)),
          mtime: stat.mtime.toISOString(),
        };
      });
    const extractRoot = path.join(projectPath(PATHS.outDocs), entry.name);
    const filesJson = path.join(extractRoot, 'files.json');
    let extracted = null;
    if (fs.existsSync(filesJson)) {
      try {
        extracted = JSON.parse(fs.readFileSync(filesJson, 'utf8'));
      } catch { /* 忽略损坏的清单 */ }
    }
    batches.push({
      batch: entry.name,
      dir: path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/'),
      files,
      totalKB: Number((files.reduce((sum, item) => sum + item.sizeKB, 0)).toFixed(1)),
      extracted: extracted ? {
        total: extracted.total, ok: extracted.ok,
        relRoot: path.relative(PROJECT_ROOT, extractRoot).replace(/\\/g, '/'),
        files: extracted.files,
      } : null,
      mtime: files.length ? files.map((f) => f.mtime).sort().pop() : '',
    });
  }
  return batches.sort((a, b) => (a.batch < b.batch ? 1 : -1));
}

/** 对某个上传批次做文本提取 */
export async function startExtractUploads({ batch }) {
  const dir = path.join(uploadsRoot(), safeName(batch));
  if (!fs.existsSync(dir)) throw new Error(`上传批次不存在：${batch}`);
  const outDir = path.join(projectPath(PATHS.outDocs), safeName(batch));
  return runProcess({
    kind: 'extract-files',
    title: `提取文件文本：${batch}`,
    command: pythonPath(),
    args: [toolPaths().extractFiles, '--src', dir, '--out', outDir],
    meta: { batch, outDir: path.relative(PROJECT_ROOT, outDir).replace(/\\/g, '/'), refresh: ['uploads'] },
    detect: [/\{"total".*\}$/],
  });
}

/** 读取某个批次的提取结果全文（供预览与 AI 汇总） */
export function readExtracted(batch, { file = '', maxChars = 120000 } = {}) {
  const root = path.join(projectPath(PATHS.outDocs), safeName(batch));
  if (!fs.existsSync(root)) return { ok: false, error: '该批次还没有提取结果' };
  if (file) {
    const target = path.join(root, 'extracted', safeName(file));
    if (!fs.existsSync(target)) return { ok: false, error: `找不到提取文件：${file}` };
    const text = fs.readFileSync(target, 'utf8');
    return { ok: true, file, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  const combined = path.join(root, 'all-in-one.md');
  if (!fs.existsSync(combined)) return { ok: false, error: '该批次还没有 all-in-one.md，请先执行提取' };
  const text = fs.readFileSync(combined, 'utf8');
  return { ok: true, text: text.slice(0, maxChars), truncated: text.length > maxChars, relRoot: path.relative(PROJECT_ROOT, root).replace(/\\/g, '/') };
}

/**
 * 汇总用户提供的文件（可按批次合并）。
 * 配了 AI 服务 → 大模型汇总；没配或调用失败 → 本地规则汇总（同一命名、同一位置，只标生成方式）。
 */
export async function startDocSummary({ batches, style = '', focus = '', engine = 'auto' }) {
  const list = (Array.isArray(batches) ? batches : [batches]).filter(Boolean);
  if (!list.length) throw new Error('请至少选择一个上传批次');
  const config = await loadConfig();

  return runTask({
    kind: 'doc-summary',
    title: `总结用户文件：${list.join('、')}`,
    meta: { batches: list, engine, refresh: ['docs'] },
  }, async ({ job, signal }) => {
    const parts = [];
    const usableBatches = [];
    for (const batch of list) {
      const data = readExtracted(batch);
      if (!data.ok) {
        job.emit(`[跳过] ${batch}：${data.error}`, 'err');
        continue;
      }
      job.emit(`[读取] ${batch} → ${data.text.length} 字符`, 'sys');
      usableBatches.push(batch);
      parts.push(`\n\n================ 批次：${batch} ================\n${data.text}`);
    }
    if (!parts.length) throw new Error('选中的批次都没有可用的提取文本（可能还没提取，或文件是扫描件）');

    const material = parts.join('');
    const maxChars = Math.max(20000, Number(config.ai.maxCharsPerCall) || 24000) * 4;
    const prompt = [
      '你是文档分析助手。下面是把用户提供的文件（PDF/Word/Excel/文本等）提取出来的文本。',
      style ? `【风格要求】${style}` : '',
      focus ? `【重点关注】${focus}` : '',
      '要求：只依据材料；标注每条结论来自哪个文件；不确定的写「需核实」；不要编造。',
      '',
      '请按以下结构输出 Markdown：',
      '# 文件汇总报告',
      '## 一、总览（涉及哪些文件、各自主题、整体结论）',
      '## 二、关键信息（按主题归并，标注来源文件）',
      '## 三、时间/截止/行动项（如有）',
      '## 四、数据与结论（如有表格或数字，给出要点）',
      '## 五、待核实与缺口（材料里没有或看不清的部分）',
      '',
      `================ 材料开始（共 ${material.length} 字符）================`,
      material.slice(0, maxChars),
      '================ 材料结束 ================',
    ].filter(Boolean).join('\n');

    const outDir = projectPath(PATHS.outDocs);
    await fsp.mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const outFile = path.join(outDir, `文件汇总-${list[0]}${list.length > 1 ? `等${list.length}批` : ''}-${stamp}.md`);

    job.emit(`[材料] ${material.length} 字符，开始生成汇总…`, 'sys');
    const outcome = await summarizeWithFallback({
      engine,
      step: 'summary',
      job,
      signal,
      chatFn: chat,
      fallbackToLocal: true,
      label: '文件汇总',
      system: '你是严谨的文档分析助手。',
      material: prompt,
      buildLocal: () => buildLocalDocsSummary({ parentJob: job, batches: usableBatches, list }),
    });

    await fsp.writeFile(outFile, `${outcome.content}\n`, 'utf8');
    const rel = relPath(outFile);
    job.emit(`[完成] 汇总（${outcome.engine === 'ai' ? 'AI' : '本地规则'}）已写入 ${rel}`, 'sys');
    return {
      outFile: rel,
      batches: list,
      batchesUsed: usableBatches,
      engine: outcome.engine,
      chars: material.length,
      ...outcome.meta,
    };
  });
}

/**
 * 本地规则汇总（docs 模式）：逐批次跑一次本地汇总，再拼成一份总的汇总。
 * 每个批次的单独汇总写在 `artifacts/docs/<批次>/local-summary.md`，
 * 不放进 artifacts/docs 根目录，避免污染「文件汇总报告」列表。
 */
async function buildLocalDocsSummary({ parentJob, batches, list }) {
  const parts = [];
  const stats = [];
  for (const batch of batches) {
    const docsDir = path.join(projectPath(PATHS.outDocs), safeName(batch));
    const perBatch = path.join(docsDir, 'local-summary.md');
    const sub = runLocalSummary({
      mode: 'docs', outFile: perBatch, docsDir, batch, refresh: ['uploads'],
    });
    // eslint-disable-next-line no-await-in-loop
    const done = await waitJobWithTimeout(sub, {
      timeoutMs: 3 * 60 * 1000, job: parentJob, label: `本地汇总：${batch}`,
    });
    if (done.status !== 'done' || !fs.existsSync(perBatch)) {
      parts.push(`## ${batch}`, '', `（本地汇总失败：${done.error || done.status}）`, '');
      continue;
    }
    stats.push({ batch, file: relPath(perBatch) });
    parts.push(`## ${batch}`, '', bodyFromFirstSection(fs.readFileSync(perBatch, 'utf8')), '');
  }

  const header = [
    '# 文件汇总报告（本地规则版）', '',
    `- 批次：${list.join('、')} ｜ 参与汇总：${batches.length} 个批次`,
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    LOCAL_BANNER, '',
  ].join('\n');

  return { content: [header, ...parts].join('\n'), meta: { localFiles: stats } };
}

/** 去掉本地汇总文件自带的标题/元信息块，只保留正文小节（避免拼接后重复） */
function bodyFromFirstSection(markdown) {
  const index = String(markdown || '').indexOf('\n## ');
  return index >= 0 ? markdown.slice(index + 1).trim() : String(markdown || '').trim();
}

// ---------------------------------------------------------------- 提示词模板

function templateId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 已保存的「文件汇总」提示词模板 */
export async function listDocTemplates() {
  const config = await loadConfig();
  const items = ((config.prompts || {}).docSummary || []).filter((item) => item && item.name);
  return { ok: true, templates: items };
}

/** 保存一个模板（同名则覆盖，最多 30 个） */
export async function saveDocTemplate({ name, style = '', focus = '', id = '' }) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('模板名不能为空');
  const config = await loadConfig();
  const items = ((config.prompts || {}).docSummary || []).filter((item) => item && item.name);
  const next = items.filter((item) => item.id !== id && item.name !== clean);
  next.unshift({ id: id || templateId(), name: clean, style: String(style || ''), focus: String(focus || '') });
  await saveConfig({ prompts: { docSummary: next.slice(0, 30) } });
  return listDocTemplates();
}

/** 删除一个模板 */
export async function deleteDocTemplate(id) {
  const config = await loadConfig();
  const items = ((config.prompts || {}).docSummary || []).filter((item) => item && item.id !== id);
  await saveConfig({ prompts: { docSummary: items } });
  return listDocTemplates();
}

/** 发送前预估（文件汇总） */
export async function previewDocSummary({ batches = [], style = '', focus = '' }) {
  const list = (Array.isArray(batches) ? batches : [batches]).filter(Boolean);
  let chars = 0;
  const detail = [];
  for (const batch of list) {
    const data = readExtracted(batch);
    if (data.ok) {
      chars += data.text.length;
      detail.push({ batch, chars: data.text.length });
    } else {
      detail.push({ batch, chars: 0, error: data.error });
    }
  }
  const config = await loadConfig();
  const limit = Math.max(20000, Number(config.ai.maxCharsPerCall) || 24000) * 4;
  const base = await aiPreview('summary', 'x'.repeat(Math.min(chars, limit)), 2500);
  return { batches: list, detail, chars, sentChars: Math.min(chars, limit), ...base };
}

/** 已生成的文件汇总列表 */
export function listDocSummaries() {
  const dir = projectPath(PATHS.outDocs);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name.startsWith('文件汇总'))
    .map((entry) => {
      const stat = fs.statSync(path.join(dir, entry.name));
      return {
        name: entry.name,
        relFile: `${PATHS.outDocs}/${entry.name}`,
        sizeKB: Number((stat.size / 1024).toFixed(1)),
        mtime: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}
