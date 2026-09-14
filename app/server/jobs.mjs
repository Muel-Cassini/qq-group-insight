// 任务与日志：所有耗时操作（脚本、采集、API 调用）都通过 Job 执行，日志实时推给前端
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { PROJECT_ROOT } from './paths.mjs';

export const jobs = new Map();
export const bus = new EventEmitter();
bus.setMaxListeners(0);

const MAX_LOG_LINES = 4000;

export function listJobs() {
  return [...jobs.values()].map((job) => ({
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    error: job.error,
    result: job.result,
    progress: job.progress,
    meta: job.meta,
    // 进程信息：用于界面显示"当前在跑什么进程"
    pid: job.pid,
    ppid: job.ppid,
    command: job.command,
    args: job.args,
    cwd: job.cwd,
    alive: Boolean(job.pid && job.status === 'running'),
    durationMs: (job.finishedAt || Date.now()) - job.createdAt,
  }));
}

/** 当前正在运行的任务（含进程信息） */
export function runningJobs() {
  return listJobs().filter((job) => job.status === 'running');
}

/** 查一个 PID 是否还活着（Windows: tasklist；其它平台: kill 0） */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function createJob({ kind, title, meta = {} }) {
  const job = {
    id: crypto.randomUUID(),
    kind,
    title,
    meta,
    status: 'running',
    createdAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    error: '',
    result: null,
    progress: null,
    logs: [],
    child: null,
    pid: null,
    ppid: process.pid,
    command: '',
    args: [],
    cwd: '',
    abort: null,
    emit(line, stream = 'out') {
      const entry = { t: Date.now(), stream, line: String(line).replace(/\r$/, '') };
      this.logs.push(entry);
      if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
      bus.emit('event', { type: 'log', jobId: this.id, ...entry });
    },
    setProgress(progress) {
      this.progress = progress;
      bus.emit('event', { type: 'progress', jobId: this.id, progress });
    },
    finish(status, payload = {}) {
      if (this.status !== 'running') return;
      this.status = status;
      this.finishedAt = Date.now();
      Object.assign(this, payload);
      bus.emit('event', {
        type: 'status',
        jobId: this.id,
        status,
        exitCode: this.exitCode,
        error: this.error,
        result: this.result,
        // 带上 meta，界面据此决定完成/失败后要刷新哪些列表
        meta: this.meta,
        // 供界面判断该不该弹错误提示（避免 cancelled 被当成失败来报）
        showError: status === 'failed',
      });
      // 收尾回调只执行一次（cancelled → failed 的二次 finish 不应重复触发清理等副作用）
      if (!this.onceFinished) {
        this.onceFinished = true;
        if (typeof this.onFinish === 'function') {
          try {
            this.onFinish();
          } catch { /* 收尾回调失败不影响任务状态 */ }
        }
      }
    },
  };
  jobs.set(job.id, job);
  bus.emit('event', { type: 'job', job: { id: job.id, kind, title, status: job.status, createdAt: job.createdAt } });
  return job;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return { ok: false, reason: '任务不存在或已结束' };
  job.emit('[系统] 收到取消请求，正在终止…', 'sys');
  try {
    if (job.abort) job.abort.abort();
    if (job.child && !job.child.killed) {
      // Windows 上子进程可能是 cmd/powershell 包装，用 taskkill 连子孙一起结束
      spawn('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  } catch (err) {
    job.emit(`[系统] 终止失败：${err.message}`, 'err');
  }
  // 让界面能明确区分"被取消"与"执行失败"
  job.finish('cancelled', { error: '任务被取消（已终止对应进程）' });
  return { ok: true };
}

/**
 * 运行一个子进程任务。
 * @param {object} opts
 * @param {string} opts.kind  任务类型（用于前端分组）
 * @param {string} opts.title 展示标题
 * @param {string} opts.command 可执行文件
 * @param {string[]} opts.args 参数
 * @param {string} [opts.cwd] 工作目录（默认项目根）
 * @param {object} [opts.env] 追加环境变量
 * @param {RegExp[]} [opts.detect] 命中即记录到 result.detects
 */
export function runProcess(opts) {
  const job = createJob({ kind: opts.kind, title: opts.title, meta: opts.meta || {} });
  const cwd = opts.cwd || PROJECT_ROOT;
  job.command = opts.command;
  job.args = opts.args;
  job.cwd = cwd;
  job.emit(`$ ${opts.command} ${opts.args.join(' ')}`, 'sys');
  job.emit(`[cwd] ${cwd}`, 'sys');

  let child;
  try {
    child = spawn(opts.command, opts.args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(opts.env || {}) },
      windowsHide: true,
    });
  } catch (err) {
    job.emit(`[错误] 无法启动进程：${err.message}`, 'err');
    job.finish('failed', { error: err.message });
    return job;
  }
  job.child = child;
  job.pid = child.pid || null;
  job.emit(`[进程] PID ${job.pid}｜工作目录 ${cwd}`, 'sys');
  bus.emit('event', { type: 'process', jobId: job.id, pid: job.pid, command: job.command, args: job.args, cwd });

  const detects = [];
  const handle = (stream) => (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      job.emit(line, stream);
      if (opts.detect) {
        for (const re of opts.detect) {
          const match = line.match(re);
          if (match) detects.push({ stream, line: line.slice(0, 500), groups: match.slice(1) });
        }
      }
    }
  };
  child.stdout.on('data', handle('out'));
  child.stderr.on('data', handle('err'));
  child.on('error', (err) => {
    job.emit(`[错误] ${err.message}`, 'err');
    job.finish('failed', { error: err.message });
  });
  child.on('close', (code) => {
    job.result = { ...(job.result || {}), detects };
    if (job.status === 'cancelled') return;
    job.finish(code === 0 ? 'done' : 'failed', { exitCode: code, error: code === 0 ? '' : `进程退出码 ${code}` });
    if (opts.onClose) {
      try {
        opts.onClose(code, job);
      } catch (err) {
        job.emit(`[错误] 收尾处理失败：${err.message}`, 'err');
      }
    }
  });
  return job;
}

/** 运行一个纯 JS 异步任务（API 调用、文件处理等） */
export function runTask({ kind, title, meta = {} }, fn) {
  const job = createJob({ kind, title, meta });
  const controller = new AbortController();
  job.abort = controller;
  (async () => {
    try {
      const result = await fn({ job, signal: controller.signal });
      if (job.status === 'cancelled') return;
      job.finish('done', { result: result ?? null, exitCode: 0 });
    } catch (err) {
      if (job.status === 'cancelled') return;
      job.emit(`[错误] ${err.message}`, 'err');
      job.finish('failed', { error: err.message });
    }
  })();
  return job;
}
