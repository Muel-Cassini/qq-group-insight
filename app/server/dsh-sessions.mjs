// DSH 会话管理：定位本次 headless 运行产生的会话目录，并在总结完成后清理
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const DSH_HOME = process.env.DSH_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');

export function sessionsRoot() {
  return path.join(DSH_HOME, 'sessions');
}

/** 列出所有会话目录（不含文件） */
export function listSessions() {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const projectDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const projectPath = path.join(root, projectDir.name);
    for (const sessionDir of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue;
      const full = path.join(projectPath, sessionDir.name);
      let mtime = 0;
      let sizeKB = 0;
      try {
        const stat = fs.statSync(full);
        mtime = stat.mtimeMs;
        for (const file of fs.readdirSync(full)) {
          const fileStat = fs.statSync(path.join(full, file));
          sizeKB += fileStat.size / 1024;
        }
      } catch { /* 忽略无法读取的会话 */ }
      out.push({
        id: sessionDir.name,
        dir: full,
        project: projectDir.name,
        mtime,
        sizeKB: Number(sizeKB.toFixed(1)),
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 运行前快照：记录当前已存在的会话 id */
export function snapshotSessionIds() {
  return new Set(listSessions().map((item) => item.id));
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 按帧解码 DSH 的会话文件。
 * 实测：session.jsonl.zstd 是**多个独立 zstd 帧顺序拼接**（几百帧，每帧一段 JSONL），
 * zstdDecompressSync 只解第一帧、流式解压器也一样，因此必须自己按魔数切帧逐个解压。
 */
function decodeSessionBuffer(raw, { maxBytes = 48 * 1024 * 1024, maxFrames = 5000 } = {}) {
  const limit = Math.min(raw.length, maxBytes);
  const parts = [];
  let offset = 0;
  let frames = 0;
  while (offset < limit && frames < maxFrames) {
    const start = raw.indexOf(ZSTD_MAGIC, offset);
    if (start < 0) break;
    const next = raw.indexOf(ZSTD_MAGIC, start + 4);
    const end = next > 0 && next <= limit ? next : limit;
    try {
      parts.push(zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8'));
      frames += 1;
    } catch {
      // 帧被截断或损坏时跳过，继续找下一帧
    }
    offset = end;
  }
  return { text: parts.join(''), frames };
}

/** 读取会话全文（多帧 zstd → JSONL 文本） */
export function readSessionText(dir, opts = {}) {
  const file = path.join(dir, 'session.jsonl.zstd');
  if (!fs.existsSync(file)) return '';
  try {
    const raw = fs.readFileSync(file);
    return decodeSessionBuffer(raw, opts).text;
  } catch (err) {
    console.warn(`[dsh-sessions] 读取 ${dir} 失败：${err.message}`);
    return '';
  }
}

/** 会话统计信息：帧数、解压长度、是否命中关键字 */
export function sessionInfo(dir, markers = []) {
  const text = readSessionText(dir);
  const hits = markers.filter((marker) => marker && text.includes(marker));
  return { length: text.length, hits, matched: hits.length > 0 };
}

/** 会话里是否出现指定关键字（判定"是不是我们 app 触发的会话"） */
export function sessionMentions(dir, ...keywords) {
  const text = readSessionText(dir);
  if (!text) return false;
  return keywords.filter(Boolean).some((keyword) => text.includes(keyword));
}

/**
 * 删除「本次运行新产生」的会话。
 * @param {Set<string>} before 运行前的会话 id 快照
 * @param {object} opts
 * @param {string[]} [opts.markers] 会话内容需命中其中任意一个关键字才删除（避免误删他人会话）
 * @param {boolean} [opts.dryRun]
 */
export async function cleanupNewSessions(before, { markers = [], dryRun = false } = {}) {
  const after = listSessions();
  const created = after.filter((item) => !before.has(item.id));
  const deleted = [];
  const kept = [];
  for (const session of created) {
    const hit = markers.filter(Boolean).length
      ? sessionMentions(session.dir, ...markers)
      : true;
    if (!hit) {
      kept.push({ ...session, reason: '会话内容不含本次任务的标识，保留' });
      continue;
    }
    if (dryRun) {
      deleted.push({ ...session, dryRun: true });
      continue;
    }
    try {
      await fsp.rm(session.dir, { recursive: true, force: true });
      deleted.push(session);
    } catch (err) {
      kept.push({ ...session, reason: `删除失败：${err.message}` });
    }
  }
  return { created, deleted, kept };
}

/** 会话统计（供界面展示） */
export function sessionStats() {
  const all = listSessions();
  return {
    root: sessionsRoot(),
    count: all.length,
    newest: all.slice(0, 5),
    totalMB: Number((all.reduce((sum, item) => sum + item.sizeKB, 0) / 1024).toFixed(1)),
  };
}
