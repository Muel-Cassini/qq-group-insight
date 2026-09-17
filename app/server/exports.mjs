// 导出管理：扫描 QCE 导出目录、读取元信息、归档 / 删除（回收站）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT, PATHS } from './paths.mjs';
import { projectPath, loadConfig } from './config.mjs';

const NAME_RE = /^group_(?<name>.+?)_(?<id>\d{5,})_(?<stamp>\d{8}_\d+)$/;

/**
 * 解析用户配置的目录：
 * - 空 → 用默认（项目内）
 * - 绝对路径 → 原样使用（支持把导出放在别的盘）
 * - 相对路径 → 相对项目根
 */
export function resolveConfiguredDir(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return projectPath(fallback);
  const normalized = raw.replace(/\//g, path.sep);
  return path.isAbsolute(normalized) ? path.normalize(normalized) : path.join(PROJECT_ROOT, normalized);
}

/**
 * 解析用户手填的「输出目录」（①页单条汇总用）。
 * - 空 → 返回空串，调用方回退到自动命名
 * - 绝对路径 → 原样使用（允许写到别的盘，与设置页的目录设置口径一致）
 * - 相对路径 → 必须落在项目根内；用 `..` 越界直接报错（否则一个手滑就把产物写到项目外）
 */
export function resolveOutputDir(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\//g, path.sep);
  if (path.isAbsolute(normalized)) return path.normalize(normalized);
  const root = path.resolve(PROJECT_ROOT);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('输出目录不能用 ../ 跑到项目外：请填项目内的相对路径，或直接填绝对路径');
  }
  return resolved;
}

/** 正在使用的导出目录（含来源说明，供界面展示） */
export async function exportsDirsInfo() {
  const config = await loadConfig();
  const dirs = config.paths || {};
  const manual = resolveConfiguredDir(dirs.exportsDir, PATHS.exports);
  const scheduled = resolveConfiguredDir(dirs.scheduledExportsDir, PATHS.scheduledExports);
  return [
    { kind: 'manual', label: '手动导出', dir: manual, custom: Boolean(String(dirs.exportsDir || '').trim()) },
    { kind: 'scheduled', label: '定时导出', dir: scheduled, custom: Boolean(String(dirs.scheduledExportsDir || '').trim()) },
  ];
}

/** 兼容旧调用：只返回 {kind, dir} */
export function exportsDirs() {
  return [
    { kind: 'manual', dir: projectPath(PATHS.exports) },
    { kind: 'scheduled', dir: projectPath(PATHS.scheduledExports) },
  ];
}

/** 目录是否存在、是否可读、里面有多少个导出文件 */
export function inspectDir(dir) {
  const exists = fs.existsSync(dir);
  if (!exists) return { exists: false, readable: false, exportFiles: 0, subdirs: 0 };
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return {
      exists: true,
      readable: true,
      exportFiles: entries.filter((e) => e.isFile() && /\.(json|jsonl|ndjson)$/i.test(e.name)).length,
      subdirs: entries.filter((e) => e.isDirectory()).length,
      hasResources: entries.some((e) => e.isDirectory() && e.name.toLowerCase() === 'resources'),
    };
  } catch (err) {
    return { exists: true, readable: false, error: err.message, exportFiles: 0, subdirs: 0 };
  }
}

function parseName(file) {
  const base = path.basename(file, path.extname(file));
  const match = base.match(NAME_RE);
  if (!match) return { name: base, groupId: '', stamp: '' };
  return { name: match.groups.name, groupId: match.groups.id, stamp: match.groups.stamp };
}

function stampToIso(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/.exec(stamp || '');
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 读取导出文件的头部信息（chatInfo / statistics），失败不影响列表展示 */
async function readHeader(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    const chat = data.chatInfo || {};
    const stats = data.statistics || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];
    return {
      chatName: chat.name || '',
      chatId: String(chat.peerUid || chat.groupId || ''),
      chatType: chat.type || 'group',
      totalMessages: stats.totalMessages ?? messages.length,
      timeRange: stats.timeRange || {},
      messageTypes: stats.messageTypes || {},
      exportedAt: stats.exportedAt || data.exportOptions?.exportedAt || '',
    };
  } catch {
    return null;
  }
}

function summaryDirs() {
  const root = projectPath(PATHS.outQq);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }));
}

function normalizeSummaryToken(value) {
  return String(value || '')
    .replace(/\.(json|jsonl|ndjson)$/i, '')       // 去掉导出文件扩展名
    .replace(/[-_]\d{8}[-_]\d{8}$/i, '')          // 去掉尾部日期区间
    .replace(/[-_]\d{8}[-_]\d{6,}$/i, '')         // 去掉尾部导出时间戳
    .replace(/[-_]?(all)$/i, '')                  // 去掉“无区间”后缀
    .replace(/[-_\s]+$/, '')
    .trim();
}

/** 把各种时间写法归一成 YYYY-MM-DD（与 server.mjs 的 pickDateRange 同一口径） */
function toDay(value) {
  if (typeof value !== 'string' || !value) return '';
  const match = value.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

/**
 * 从汇总目录名末尾解析出它覆盖的日期区间。
 * 目录名由 summaryTargetDir() 生成：`<群名>-<YYYYMMDD>-<YYYYMMDD>`；
 * 没有区间的（`<群名>-<14位时间戳>` 或 `-all`）返回 null → 视为覆盖该群全部记录。
 */
function parseSummaryRange(dirName) {
  const match = String(dirName || '').match(/(\d{8})[-_](\d{8})\s*$/);
  if (!match) return null;
  const toIso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return { from: toIso(match[1]), to: toIso(match[2]) };
}

/**
 * 判断某个导出是否已有对应的汇总目录。
 * 只靠"目录名以群名开头"不稳（汇总目录可能由文件名或时间区间生成），
 * 这里做归一化后双向匹配：群名 / 文件名（去扩展名）/ 群号。
 *
 * ★ 还要看**日期区间**：同一个群今天又导出一次时，旧的汇总并不意味着这次已经汇总过。
 *   以前只按群身份判，结果新导出的记录一进来就被标成「已汇总」，
 *   配合「隐藏已汇总」会让用户以为新记录压根没被扫到（实测踩过）。
 */
function matchSummary(summaries, { chatName, parsedName, groupId, range }) {
  const candidates = [chatName, parsedName]
    .filter(Boolean)
    .map(normalizeSummaryToken)
    .filter((s) => s.length >= 2);
  const exportFrom = toDay(range?.start);
  const exportTo = toDay(range?.end);

  /** 该汇总目录是否覆盖了这条导出的时间范围 */
  const coversRange = (summary) => {
    const covered = parseSummaryRange(summary.name);
    if (!covered) return true;                 // 目录名没写区间 → 当作覆盖全部
    if (!exportFrom || !exportTo) return true; // 导出没给区间 → 无法判断，保持宽松
    return exportFrom >= covered.from && exportTo <= covered.to;
  };

  return summaries.find((summary) => {
    const dirName = summary.name;
    const dirNorm = normalizeSummaryToken(dirName);
    let sameChat = false;
    for (const candidate of candidates) {
      if (dirName.startsWith(candidate) || dirNorm.startsWith(candidate) || candidate.startsWith(dirNorm)) { sameChat = true; break; }
    }
    if (!sameChat && groupId && (dirName.includes(String(groupId)) || dirNorm.includes(String(groupId)))) {
      sameChat = true;
    }
    return sameChat && coversRange(summary);
  }) || null;
}

/** 列出所有导出记录（含是否已汇总） */
export async function listExports() {
  const summaries = summaryDirs();
  const items = [];
  // 「手动导出目录」与「定时导出目录」可能被填成同一个路径（实测就有用户这么配）：
  // 不按绝对路径去重的话，每个文件会被列两遍，而且「汇总选中项」会把它汇总两遍。
  const seen = new Set();
  for (const { kind, label, dir, custom } of await exportsDirsInfo()) {
    if (!fs.existsSync(dir)) continue;
    const files = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      if (!/\.(json|jsonl|ndjson)$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const dedupeKey = path.resolve(full).toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const stat = await fsp.stat(full);
      const parsed = parseName(full);
      const header = entry.name.toLowerCase().endsWith('.json') ? await readHeader(full) : null;
      const relDir = path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/');
      const matched = matchSummary(summaries, {
        chatName: header?.chatName || '',
        parsedName: parsed.name,
        groupId: header?.chatId || parsed.groupId,
        range: header?.timeRange || null,
      });
      items.push({
        file: full,
        relFile: path.relative(PROJECT_ROOT, full).replace(/\\/g, '/'),
        dir: relDir,
        kind,
        name: header?.chatName || parsed.name,
        groupId: header?.chatId || parsed.groupId,
        exportedAt: stampToIso(parsed.stamp),
        sizeMB: Number((stat.size / 1048576).toFixed(2)),
        mtime: stat.mtime.toISOString(),
        messages: header?.totalMessages ?? null,
        timeRange: header?.timeRange || null,
        messageTypes: header?.messageTypes || null,
        summarized: Boolean(matched),
        summaryDir: matched ? path.relative(PROJECT_ROOT, matched.dir).replace(/\\/g, '/') : '',
      });
    }
  }
  items.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return items;
}

/** 已生成的汇总产物列表（用于预览与比对选择） */
export function listSummaries() {
  const items = [];
  for (const item of summaryDirs()) {
    try {
      const digestDir = path.join(item.dir, 'digest');
      const digests = fs.existsSync(digestDir)
        ? fs.readdirSync(digestDir).filter((f) => f.endsWith('.md')).sort()
        : [];
      const has = (file) => fs.existsSync(path.join(item.dir, file));
      let report = '';
      const reportFile = path.join(item.dir, '_report.md');
      if (fs.existsSync(reportFile)) report = fs.readFileSync(reportFile, 'utf8').slice(0, 4000);
      // 目录可能在遍历过程中被删除（例如重跑汇总 / 手动清理），这里必须容错，
      // 否则一次 statSync 失败会让整个 /api/summaries 报错，界面上表现为"读取汇总失败"
      const mtime = fs.statSync(item.dir).mtime.toISOString();
      // 汇总可能正在生成中（脚本先建目录、后写文件）：此时标记 building，
      // 界面据此显示"生成中"，避免误以为产物缺失
      const complete = has('normalized.jsonl') && has('_report.md');
      items.push({
        name: item.name,
        relDir: path.relative(PROJECT_ROOT, item.dir).replace(/\\/g, '/'),
        digests,
        files: {
          p1: has('p1-todo.md'),
          media: has('media-index.md'),
          normalized: has('normalized.jsonl'),
          aiReview: has('ai-review.jsonl'),
          report: has('_report.md'),
          overall: has('overall.md'),
        },
        building: !complete,
        report,
        mtime,
      });
    } catch (err) {
      console.warn(`[summaries] 跳过无法读取的目录 ${item.name}：${err.message}`);
    }
  }
  return items.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** 生成汇总输出目录名：<群名>-<起>-<止>；没有区间时用 <群名>-<导出时间戳> 避免覆盖 */
export function summaryTargetDir(name, dateFrom, dateTo, stamp = '') {
  const safe = String(name || '群聊')
    .replace(/\.(json|jsonl|ndjson)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || '群聊';
  if (dateFrom && dateTo) return path.join(PATHS.outQq, `${safe}-${dateFrom.replace(/-/g, '')}-${dateTo.replace(/-/g, '')}`);
  const suffix = stamp ? stamp.replace(/[^0-9]/g, '').slice(0, 14) : 'all';
  return path.join(PATHS.outQq, `${safe}-${suffix}`);
}

async function recycle(files) {
  const list = files.map((file) => `'${String(file).replace(/'/g, "''")}'`).join(',');
  const script = [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `$files = @(${list})`,
    'foreach ($f in $files) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f, "OnlyErrorDialogs", "SendToRecycleBin") }',
  ].join('; ');
  await new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))));
  });
}

/** 归档：移动到 data/qq-chat-exporter/archive/（跨盘时回退为复制+删除） */
export async function archiveExports(files) {
  const archiveRoot = projectPath(PATHS.exportsArchive);
  await fsp.mkdir(archiveRoot, { recursive: true });
  const moved = [];
  const failed = [];
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : projectPath(file);
    if (!fs.existsSync(abs)) { failed.push({ file, reason: '文件不存在' }); continue; }
    const target = path.join(archiveRoot, path.basename(abs));
    try {
      await fsp.rename(abs, target);
    } catch (err) {
      if (err.code === 'EXDEV') {
        // 导出来自其它盘时 rename 不可用，改为复制后删除
        await fsp.copyFile(abs, target);
        await fsp.rm(abs, { force: true });
      } else {
        failed.push({ file, reason: err.message });
        continue;
      }
    }
    moved.push({ from: path.relative(PROJECT_ROOT, abs), to: path.relative(PROJECT_ROOT, target) });
  }
  return { ok: true, moved, failed };
}

/** 删除：走回收站（可恢复） */
export async function deleteExports(files) {
  const abs = files.map((file) => (path.isAbsolute(file) ? file : projectPath(file))).filter((f) => fs.existsSync(f));
  if (!abs.length) return { ok: true, deleted: [] };
  await recycle(abs);
  return { ok: true, deleted: abs.map((f) => path.relative(PROJECT_ROOT, f)) };
}

/** 读取产物文件内容（只允许读 artifacts 下的文本文件） */
export async function readArtifact(relPath, { maxBytes = 400000 } = {}) {
  const abs = path.isAbsolute(relPath) ? relPath : projectPath(relPath);
  const artifactsRoot = projectPath('artifacts');
  const dataRoot = projectPath('data');
  const normalized = path.resolve(abs);
  // 比较时必须带分隔符：只 startsWith(root) 会放过同级的 artifactsXXX / dataXXX 目录
  const inside = (root) => normalized === root || normalized.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  if (!inside(artifactsRoot) && !inside(dataRoot)) {
    throw new Error('只允许读取 artifacts/ 或 data/ 下的文件');
  }
  const stat = await fsp.stat(normalized);
  if (stat.isDirectory()) throw new Error('这是一个目录');
  const handle = await fsp.open(normalized, 'r');
  try {
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return {
      path: path.relative(PROJECT_ROOT, normalized).replace(/\\/g, '/'),
      size: stat.size,
      truncated: stat.size > length,
      text: buffer.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}
